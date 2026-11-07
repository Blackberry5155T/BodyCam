import * as THREE from 'three';
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { shapeGeometry, type ShapeParams } from './shapes.ts';

// CSG-Verrechnung (three-bvh-csg). Läuft im Worker (csg.worker.ts); dieselbe Funktion geht zur Not auch direkt.
// Eingabe: Gruppen („Cluster“) sich überlappender Brushes in Outliner-Reihenfolge, je Brush Form + Weltmatrix.
// Ausgabe: je Brush die Dreiecke, die von ihm stammen (Weltkoordinaten), getrennt nach Fläche.
// Addieren-Brushes liefern ihre Außenflächen, Abziehen-Brushes die Innenflächen der Löcher, die sie schneiden,
// Schnitt-Brushes behalten nur das, was in ihnen liegt.

export type BrushOp = 'add' | 'subtract' | 'intersect';

export interface BrushJob extends ShapeParams {
  id: string;
  op: BrushOp;
  /** Weltmatrix (16 Werte, Spalten zuerst) */
  matrix: number[];
}

export interface ClusterJob {
  key: string;
  brushes: BrushJob[];
}

export interface FacePart {
  face: number;
  /** Weltkoordinaten, je Dreieck 9 Werte */
  pos: Float32Array;
  nor: Float32Array;
}

export interface BrushPart {
  id: string;
  faces: FacePart[];
}

export interface ClusterResult {
  key: string;
  parts: BrushPart[];
  ms: number;
  error?: string;
}

export interface CsgRequest {
  job: number;
  clusters: ClusterJob[];
}

export interface CsgResponse {
  job: number;
  clusters: ClusterResult[];
}

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];
evaluator.useGroups = true;

interface Slot {
  brush: number;
  face: number;
}

function makeBrush(b: BrushJob, index: number): Brush {
  const geo = shapeGeometry(b);
  const faces = Math.max(1, ...geo.groups.map((g) => (g.materialIndex ?? 0) + 1));
  const mats: THREE.Material[] = [];
  for (let f = 0; f < faces; f++) {
    const m = new THREE.MeshBasicMaterial();
    m.userData.slot = { brush: index, face: f } satisfies Slot;
    mats.push(m);
  }
  const brush = new Brush(geo, mats);
  new THREE.Matrix4().fromArray(b.matrix).decompose(brush.position, brush.quaternion, brush.scale);
  brush.updateMatrixWorld(true);
  return brush;
}

/** Spiegelnde Matrix (negative Skalierung) dreht die Flächen um */
const mirrored = (m: number[]) => new THREE.Matrix4().fromArray(m).determinant() < 0;

/** Ergebnis-Geometrie (Welt) nach Herkunft (Brush, Fläche) aufteilen */
function split(geo: THREE.BufferGeometry, materials: THREE.Material[], jobs: BrushJob[]): BrushPart[] {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const index = geo.index;
  const buckets = new Map<string, { brush: number; face: number; pos: number[]; nor: number[] }>();
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
  for (const g of groups) {
    const slot = materials[g.materialIndex ?? 0]?.userData.slot as Slot | undefined;
    if (!slot) continue;
    const k = `${slot.brush}:${slot.face}`;
    let bk = buckets.get(k);
    if (!bk) buckets.set(k, (bk = { brush: slot.brush, face: slot.face, pos: [], nor: [] }));
    const end = Math.min(g.start + g.count, index ? index.count : pos.count);
    for (let i = g.start; i < end; i++) {
      const vi = index ? index.getX(i) : i;
      bk.pos.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      bk.nor.push(nor.getX(vi), nor.getY(vi), nor.getZ(vi));
    }
  }
  const parts = new Map<number, BrushPart>();
  for (const bk of buckets.values()) {
    if (!bk.pos.length) continue;
    let part = parts.get(bk.brush);
    if (!part) parts.set(bk.brush, (part = { id: jobs[bk.brush].id, faces: [] }));
    part.faces.push({ face: bk.face, pos: new Float32Array(bk.pos), nor: new Float32Array(bk.nor) });
  }
  return [...parts.values()];
}

/** Ein Cluster verrechnen */
export function evaluateCluster(c: ClusterJob): ClusterResult {
  const t0 = performance.now();
  const brushes = c.brushes.map(makeBrush);
  try {
    let acc: Brush | null = null;
    for (let i = 0; i < brushes.length; i++) {
      const b = brushes[i];
      if (mirrored(c.brushes[i].matrix)) {
        // gespiegelte Brushes: Dreiecke umdrehen, damit innen/außen stimmt
        const idx = b.geometry.index;
        if (idx) for (let t = 0; t < idx.count; t += 3) { const x = idx.getX(t + 1); idx.setX(t + 1, idx.getX(t + 2)); idx.setX(t + 2, x); }
        else {
          const p = b.geometry.attributes.position;
          const n = b.geometry.attributes.normal;
          for (let t = 0; t < p.count; t += 3) for (const a of [p, n]) for (let k = 0; k < 3; k++) { const x = a.getComponent(t + 1, k); a.setComponent(t + 1, k, a.getComponent(t + 2, k)); a.setComponent(t + 2, k, x); }
        }
      }
      const op = c.brushes[i].op;
      if (op === 'subtract' || op === 'intersect') {
        if (acc) acc = evaluator.evaluate(acc, b, op === 'subtract' ? SUBTRACTION : INTERSECTION);
      } else {
        acc = acc ? evaluator.evaluate(acc, b, ADDITION) : b;
      }
    }
    let parts: BrushPart[] = [];
    if (acc) {
      // Ergebnis liegt im lokalen Raum des ersten Brushes → in Weltkoordinaten umrechnen
      const own = brushes.includes(acc);
      const g = (own ? acc.geometry.clone() : acc.geometry).applyMatrix4(acc.matrixWorld);
      parts = split(g, acc.material as THREE.Material[], c.brushes);
      g.dispose();
    }
    return { key: c.key, parts, ms: performance.now() - t0 };
  } catch (err) {
    return { key: c.key, parts: [], ms: performance.now() - t0, error: (err as Error).message };
  } finally {
    for (const b of brushes) {
      b.geometry.dispose();
      b.disposeCacheData();
    }
  }
}
