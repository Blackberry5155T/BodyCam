import * as THREE from 'three';

// Brush-Formen (Einheitsgröße 1 × 1 × 1 um den Ursprung; die Objekt-Skalierung gibt die Maße in Metern).
// Jede Form ist geschlossen (für CSG) und in Flächen-Gruppen geteilt — eine Gruppe = eine Fläche, der im Editor
// ein eigenes Material zugewiesen werden kann. Läuft auch im Worker (nur three, kein DOM).

export type BrushShape = 'box' | 'cylinder' | 'wedge' | 'stairs' | 'sphere';

export const BRUSH_SHAPES: { value: BrushShape; label: string }[] = [
  { value: 'box', label: 'Quader' },
  { value: 'cylinder', label: 'Zylinder' },
  { value: 'wedge', label: 'Keil (Rampe)' },
  { value: 'stairs', label: 'Treppe' },
  { value: 'sphere', label: 'Kugel' },
];

/** Namen der Flächen-Gruppen je Form (Index = Gruppe) */
export const SHAPE_FACES: Record<BrushShape, string[]> = {
  box: ['Rechts (+X)', 'Links (−X)', 'Oben', 'Unten', 'Vorne (+Z)', 'Hinten (−Z)'],
  cylinder: ['Mantel', 'Oben', 'Unten'],
  wedge: ['Unten', 'Hinten', 'Schräge', 'Links', 'Rechts'],
  stairs: ['Seiten', 'Stufen', 'Rückseite / Boden'],
  sphere: ['Fläche'],
};

export interface ShapeParams {
  shape: BrushShape;
  /** Segmente (Zylinder, Kugel) */
  segments: number;
  /** Stufenzahl (Treppe) */
  steps: number;
}

export const isShape = (v: unknown): v is BrushShape => typeof v === 'string' && v in SHAPE_FACES;

/** Dreiecke mit Flächen-Gruppen sammeln (nicht indiziert, flache Normalen) */
class FaceBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private groups: { start: number; count: number; face: number }[] = [];

  /** konvexes Polygon (gegen den Uhrzeigersinn von außen gesehen) */
  poly(face: number, pts: THREE.Vector3[]): void {
    const n = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0])).normalize();
    for (let i = 1; i + 1 < pts.length; i++) this.tri(face, pts[0], pts[i], pts[i + 1], n);
  }

  tri(face: number, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3): void {
    const start = this.pos.length / 3;
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < 3; i++) this.nor.push(n.x, n.y, n.z);
    const last = this.groups[this.groups.length - 1];
    if (last && last.face === face && last.start + last.count === start) last.count += 3;
    else this.groups.push({ start, count: 3, face });
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    for (const gr of this.groups) g.addGroup(gr.start, gr.count, gr.face);
    return g;
  }
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Keil: Boden voll, steigt Richtung −Z auf die volle Höhe an (wie die Treppe) */
function wedge(): THREE.BufferGeometry {
  const f = new FaceBuilder();
  const h = 0.5;
  f.poly(0, [v(-h, -h, -h), v(h, -h, -h), v(h, -h, h), v(-h, -h, h)]);
  f.poly(1, [v(-h, -h, -h), v(-h, h, -h), v(h, h, -h), v(h, -h, -h)]);
  f.poly(2, [v(-h, -h, h), v(h, -h, h), v(h, h, -h), v(-h, h, -h)]);
  f.poly(3, [v(-h, -h, -h), v(-h, -h, h), v(-h, h, -h)]);
  f.poly(4, [v(h, -h, -h), v(h, h, -h), v(h, -h, h)]);
  return f.build();
}

/** Punkt im Polygon (gerade/ungerade Regel) */
function inside(poly: THREE.Vector2[], p: THREE.Vector2): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
  }
  return r;
}

/** Treppe: n Stufen, steigt Richtung −Z an; Profil in der YZ-Ebene, entlang X extrudiert */
function stairs(n: number): THREE.BufferGeometry {
  const f = new FaceBuilder();
  const h = 0.5;
  // Profil (z, y) von vorne unten über die Stufen nach hinten oben, dann hinten herunter
  const prof: THREE.Vector2[] = [new THREE.Vector2(h, -h)];
  for (let i = 0; i < n; i++) {
    const z0 = h - i / n;
    const y1 = -h + (i + 1) / n;
    prof.push(new THREE.Vector2(z0, y1), new THREE.Vector2(z0 - 1 / n, y1));
  }
  prof.push(new THREE.Vector2(-h, -h));
  // Seiten: Profil triangulieren (Shape in (z, y))
  const tris = THREE.ShapeUtils.triangulateShape(prof, []);
  const nx = v(1, 0, 0);
  const nnx = v(-1, 0, 0);
  for (const [a, b, c] of tris) {
    const A = prof[a];
    const B = prof[b];
    const C = prof[c];
    // Winkel prüfen: Normale +X braucht (z, y)-Umlauf im Uhrzeigersinn von +X gesehen
    const pa = v(h, A.y, A.x);
    const pb = v(h, B.y, B.x);
    const pc = v(h, C.y, C.x);
    const nrm = new THREE.Vector3().subVectors(pb, pa).cross(new THREE.Vector3().subVectors(pc, pa));
    if (nrm.x > 0) f.tri(0, pa, pb, pc, nx);
    else f.tri(0, pa, pc, pb, nx);
    const qa = v(-h, A.y, A.x);
    const qb = v(-h, B.y, B.x);
    const qc = v(-h, C.y, C.x);
    if (nrm.x > 0) f.tri(0, qa, qc, qb, nnx);
    else f.tri(0, qa, qb, qc, nnx);
  }
  // Mantel: jede Profilkante als Rechteck entlang X
  for (let i = 0; i < prof.length; i++) {
    const a = prof[i];
    const b = prof[(i + 1) % prof.length];
    const back = i >= prof.length - 2; // Rückseite + Boden
    const quad = [v(-h, a.y, a.x), v(h, a.y, a.x), v(h, b.y, b.x), v(-h, b.y, b.x)];
    // Normale muss nach außen zeigen: Punkt knapp vor der Kante darf nicht im Profil liegen
    const n = new THREE.Vector3().subVectors(quad[1], quad[0]).cross(new THREE.Vector3().subVectors(quad[2], quad[0])).normalize();
    const probe = new THREE.Vector2((a.x + b.x) / 2 + n.z * 1e-3, (a.y + b.y) / 2 + n.y * 1e-3);
    if (inside(prof, probe)) quad.reverse();
    f.poly(back ? 2 : 1, quad);
  }
  return f.build();
}

/** Geometrie einer Form (Einheitsgröße), mit position + normal und einer Gruppe je Fläche */
export function shapeGeometry(p: ShapeParams): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  const seg = Math.max(3, Math.min(96, Math.round(p.segments)));
  switch (p.shape) {
    case 'cylinder':
      g = new THREE.CylinderGeometry(0.5, 0.5, 1, seg, 1);
      break;
    case 'sphere':
      g = new THREE.SphereGeometry(0.5, seg, Math.max(2, Math.round(seg / 2)));
      g.clearGroups();
      g.addGroup(0, g.index ? g.index.count : g.attributes.position.count, 0);
      break;
    case 'wedge':
      g = wedge();
      break;
    case 'stairs':
      g = stairs(Math.max(1, Math.min(64, Math.round(p.steps))));
      break;
    default:
      g = new THREE.BoxGeometry(1, 1, 1);
  }
  g.deleteAttribute('uv');
  return g;
}

/** Drahtgitter-Kanten einer Form (Editor) */
export function shapeEdges(p: ShapeParams): THREE.BufferGeometry {
  const g = shapeGeometry({ ...p, segments: Math.min(p.segments, 24) });
  const e = new THREE.EdgesGeometry(g, 20);
  g.dispose();
  return e;
}
