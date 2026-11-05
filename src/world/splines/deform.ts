import * as THREE from 'three';
import type { HeightDeform, LandscapeData } from '../landscape/data.ts';
import { liveLandscapes } from '../landscape/render.ts';

// Straßen formen das Gelände (nur im Editor): Jede Straße meldet hier eine Quelle an; updateDeforms() (jeden
// Frame) rechnet für jede Landscape unter der Straße eine Verformung und setzt sie an den Landscape-Daten.
// Ändert sich die Straße (neue Version) oder wird die Landscape verschoben, wird neu gerechnet; verschwindet
// die Straße, kommt das gemalte Gelände zurück. Gespeichert wird das fertige Gelände (das Spiel rechnet nichts).

export interface DeformSource {
  /** neue Version = neu rechnen */
  version: number;
  /** Reihenfolge (spätere gewinnen bei Überschneidung) */
  order: number;
  /** Hülle in Welt-XZ */
  box: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Verformung für eine Landscape (origin = Welt-Position der Landscape-Mitte) */
  build(d: LandscapeData, origin: THREE.Vector3): HeightDeform | null;
}

const sources = new Map<string, DeformSource>();
let nextOrder = 1;
let nextKey = 1;

/** Quelle anmelden; liefert den Schlüssel */
export function addDeformSource(src: Omit<DeformSource, 'order'>): { key: string; source: DeformSource } {
  const key = `road${nextKey++}`;
  const source: DeformSource = { ...src, order: nextOrder++ };
  sources.set(key, source);
  return { key, source };
}

export function removeDeformSource(key: string): void {
  sources.delete(key);
}

interface Applied {
  version: number;
  ox: number;
  oy: number;
  oz: number;
}
const applied = new WeakMap<LandscapeData, Map<string, Applied>>();
const _o = new THREE.Vector3();

/** Jeden Frame (Editor): Verformungen an den Landscapes nachführen */
export function updateDeforms(): void {
  for (const ls of liveLandscapes()) {
    const d = ls.data;
    ls.mesh.updateWorldMatrix(true, false);
    const o = _o.setFromMatrixPosition(ls.mesh.matrixWorld);
    let m = applied.get(d);
    const first = !m;
    if (!m) {
      m = new Map();
      applied.set(d, m);
    }
    for (const key of [...m.keys()])
      if (!sources.has(key)) {
        d.setDeform(key, null);
        m.delete(key);
      }
    const hx = d.sizeX / 2;
    const hz = d.sizeZ / 2;
    for (const [key, src] of sources) {
      const a = m.get(key);
      if (a && a.version === src.version && a.ox === o.x && a.oy === o.y && a.oz === o.z) continue;
      const b = src.box;
      const over = b.maxX >= o.x - hx && b.minX <= o.x + hx && b.maxZ >= o.z - hz && b.minZ <= o.z + hz;
      const def = over ? src.build(d, o) : null;
      if (def) {
        def.order = src.order;
        d.setDeform(key, def);
      } else if (d.deforms.has(key)) d.setDeform(key, null);
      m.set(key, { version: src.version, ox: o.x, oy: o.y, oz: o.z });
    }
    // geladene Basis-Höhen ohne passende Straße (z. B. Straße gelöscht und nicht gespeichert): gemaltes Gelände
    if (first && d.base && d.deforms.size === 0) d.clearDeforms();
  }
}

const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * Straßen-Verformung: Mittellinie (Welt) mit halber Breite je Stützstelle. Innerhalb der Breite wird das Gelände
 * auf `lower` unter die Mittellinie gezogen, über `shoulder` Meter (Böschung) weich ins Gelände übergeblendet.
 */
export function roadDeform(d: LandscapeData, origin: THREE.Vector3, line: THREE.Vector3[], half: number[], shoulder: number, lower: number): HeightDeform | null {
  const n = line.length;
  if (n < 2) return null;
  const q = d.quadSize;
  let maxHalf = 0;
  for (const h of half) maxHalf = Math.max(maxHalf, h);
  const pad = maxHalf + shoulder + q;
  // lokale Mittellinie
  const lx = new Float32Array(n);
  const ly = new Float32Array(n);
  const lz = new Float32Array(n);
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    lx[i] = line[i].x - origin.x;
    ly[i] = line[i].y - origin.y;
    lz[i] = line[i].z - origin.z;
    x0 = Math.min(x0, lx[i]);
    x1 = Math.max(x1, lx[i]);
    z0 = Math.min(z0, lz[i]);
    z1 = Math.max(z1, lz[i]);
  }
  const rect = d.clip({
    x: Math.floor(d.toGridX(x0 - pad)),
    y: Math.floor(d.toGridZ(z0 - pad)),
    w: Math.ceil(d.toGridX(x1 + pad)) - Math.floor(d.toGridX(x0 - pad)) + 1,
    h: Math.ceil(d.toGridZ(z1 + pad)) - Math.floor(d.toGridZ(z0 - pad)) + 1,
  });
  if (!rect) return null;
  // Speicher begrenzen (sehr lange Straßen über riesige Landscapes)
  if (rect.w * rect.h > 64e6) return null;
  const size = rect.w * rect.h;
  const target = new Float32Array(size);
  const weight = new Float32Array(size);
  const dist = new Float32Array(size).fill(Infinity);
  for (let i = 0; i < n - 1; i++) {
    const ax = lx[i];
    const az = lz[i];
    const vx = lx[i + 1] - ax;
    const vz = lz[i + 1] - az;
    const len2 = vx * vx + vz * vz;
    const r = Math.max(half[i], half[i + 1]) + shoulder + q;
    const gx0 = Math.max(rect.x, Math.floor(d.toGridX(Math.min(ax, ax + vx) - r)));
    const gx1 = Math.min(rect.x + rect.w - 1, Math.ceil(d.toGridX(Math.max(ax, ax + vx) + r)));
    const gz0 = Math.max(rect.y, Math.floor(d.toGridZ(Math.min(az, az + vz) - r)));
    const gz1 = Math.min(rect.y + rect.h - 1, Math.ceil(d.toGridZ(Math.max(az, az + vz) + r)));
    for (let gz = gz0; gz <= gz1; gz++) {
      const pz = d.fromGridZ(gz);
      const row = (gz - rect.y) * rect.w - rect.x;
      for (let gx = gx0; gx <= gx1; gx++) {
        const px = d.fromGridX(gx);
        let u = len2 > 1e-9 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = px - (ax + vx * u);
        const dz = pz - (az + vz * u);
        const dd = Math.sqrt(dx * dx + dz * dz) - (half[i] * (1 - u) + half[i + 1] * u);
        const j = row + gx;
        if (dd < dist[j]) {
          dist[j] = dd;
          target[j] = ly[i] * (1 - u) + ly[i + 1] * u - lower;
        }
      }
    }
  }
  let any = false;
  for (let j = 0; j < size; j++) {
    const dd = dist[j];
    const w = dd <= 0 ? 1 : shoulder > 0 && dd < shoulder ? 1 - smooth(dd / shoulder) : 0;
    weight[j] = w;
    if (w > 0) any = true;
  }
  return any ? { rect, target, weight, order: 0 } : null;
}
