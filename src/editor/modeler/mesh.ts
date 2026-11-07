import * as THREE from 'three';

// Polygon-Netz des Modelers (wie Blenders Edit-Mesh, ohne Half-Edge-Struktur):
// Punkte, Flächen als Punktlisten (n-Ecken, gegen den Uhrzeigersinn von außen gesehen) mit Material-Slot,
// dazu lose Kanten (ohne Fläche). Kanten werden bei Bedarf aus den Flächen abgeleitet.

export interface MFace {
  v: number[];
  /** Material-Slot */
  m: number;
}

export interface MeshJSON {
  /** Punkte, je 3 Werte */
  v: number[];
  /** Flächen: Punktindizes */
  f: number[][];
  /** Material-Slot je Fläche */
  m: number[];
  /** lose Kanten, je 2 Werte */
  e?: number[];
}

/** Kanten-Schlüssel (ungerichtet) */
const K = 4194304; // 2^22 Punkte
export const ek = (a: number, b: number): number => (a < b ? a * K + b : b * K + a);
export const ekA = (k: number): number => Math.floor(k / K);
export const ekB = (k: number): number => k % K;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class EditMesh {
  verts: THREE.Vector3[] = [];
  faces: MFace[] = [];
  /** lose Kanten */
  edges: [number, number][] = [];

  clone(): EditMesh {
    const m = new EditMesh();
    m.verts = this.verts.map((v) => v.clone());
    m.faces = this.faces.map((f) => ({ v: [...f.v], m: f.m }));
    m.edges = this.edges.map(([a, b]) => [a, b]);
    return m;
  }

  toJSON(): MeshJSON {
    const r = (x: number) => Math.round(x * 1e5) / 1e5;
    const out: MeshJSON = { v: this.verts.flatMap((p) => [r(p.x), r(p.y), r(p.z)]), f: this.faces.map((f) => f.v), m: this.faces.map((f) => f.m) };
    if (this.edges.length) out.e = this.edges.flat();
    return out;
  }

  static fromJSON(j: MeshJSON): EditMesh {
    const m = new EditMesh();
    for (let i = 0; i + 2 < j.v.length; i += 3) m.verts.push(new THREE.Vector3(j.v[i], j.v[i + 1], j.v[i + 2]));
    m.faces = j.f.map((v, i) => ({ v: [...v], m: j.m?.[i] ?? 0 }));
    for (let i = 0; i + 1 < (j.e?.length ?? 0); i += 2) m.edges.push([j.e![i], j.e![i + 1]]);
    m.validate();
    return m;
  }

  addVert(x: number | THREE.Vector3, y = 0, z = 0): number {
    this.verts.push(typeof x === 'number' ? new THREE.Vector3(x, y, z) : x.clone());
    return this.verts.length - 1;
  }

  addFace(v: number[], m = 0): number {
    this.faces.push({ v, m });
    return this.faces.length - 1;
  }

  /** Ungültige Indizes, doppelte Punkte in Flächen, entartete Flächen entfernen */
  validate(): void {
    const n = this.verts.length;
    this.faces = this.faces
      .map((f) => {
        const v: number[] = [];
        for (const i of f.v) if (i >= 0 && i < n && v[v.length - 1] !== i) v.push(i);
        while (v.length > 1 && v[0] === v[v.length - 1]) v.pop();
        return { v, m: f.m };
      })
      .filter((f) => f.v.length >= 3 && new Set(f.v).size === f.v.length);
    this.tidyEdges();
  }

  /** Lose Kanten, die doppelt sind oder schon zu einer Fläche gehören, entfernen */
  tidyEdges(): void {
    if (!this.edges.length) return;
    const faceEdges = new Set<number>();
    for (const f of this.faces) for (let i = 0; i < f.v.length; i++) faceEdges.add(ek(f.v[i], f.v[(i + 1) % f.v.length]));
    const seen = new Set<number>();
    const n = this.verts.length;
    this.edges = this.edges.filter(([a, b]) => {
      if (a === b || a < 0 || b < 0 || a >= n || b >= n) return false;
      const k = ek(a, b);
      if (faceEdges.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ---------- Topologie ----------

  /** Kante → Flächen, die sie benutzen */
  edgeFaces(): Map<number, number[]> {
    const map = new Map<number, number[]>();
    this.faces.forEach((f, fi) => {
      for (let i = 0; i < f.v.length; i++) {
        const k = ek(f.v[i], f.v[(i + 1) % f.v.length]);
        const l = map.get(k);
        if (l) l.push(fi);
        else map.set(k, [fi]);
      }
    });
    return map;
  }

  /** Alle Kanten (aus Flächen + lose) */
  allEdges(): number[] {
    const set = new Set<number>();
    for (const f of this.faces) for (let i = 0; i < f.v.length; i++) set.add(ek(f.v[i], f.v[(i + 1) % f.v.length]));
    for (const [a, b] of this.edges) set.add(ek(a, b));
    return [...set];
  }

  /** Punkt → Flächen */
  vertFaces(): number[][] {
    const out: number[][] = this.verts.map(() => []);
    this.faces.forEach((f, fi) => {
      for (const v of f.v) out[v].push(fi);
    });
    return out;
  }

  /** Punkt → Nachbarpunkte (über Kanten) */
  vertNeighbors(): Set<number>[] {
    const out = this.verts.map(() => new Set<number>());
    for (const k of this.allEdges()) {
      out[ekA(k)].add(ekB(k));
      out[ekB(k)].add(ekA(k));
    }
    return out;
  }

  /** Flächennormale (Newell, normiert); Länge vor dem Normieren = doppelte Fläche */
  faceNormal(fi: number, out = new THREE.Vector3(), normalize = true): THREE.Vector3 {
    return polyNormal(this.faces[fi].v.map((i) => this.verts[i]), out, normalize);
  }

  faceCenter(fi: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = this.faces[fi].v;
    out.set(0, 0, 0);
    for (const i of f) out.add(this.verts[i]);
    return out.divideScalar(f.length);
  }

  /** Benutzte Punkte (Flächen + lose Kanten) */
  usedVerts(): Uint8Array {
    const used = new Uint8Array(this.verts.length);
    for (const f of this.faces) for (const v of f.v) used[v] = 1;
    for (const [a, b] of this.edges) used[a] = used[b] = 1;
    return used;
  }

  /**
   * Punkte entfernen und Indizes neu vergeben. `remove(i)` entscheidet je Punkt.
   * Liefert alt → neu (-1 = entfernt).
   */
  compact(remove: (i: number) => boolean): Int32Array {
    const map = new Int32Array(this.verts.length).fill(-1);
    const verts: THREE.Vector3[] = [];
    this.verts.forEach((p, i) => {
      if (remove(i)) return;
      map[i] = verts.length;
      verts.push(p);
    });
    this.verts = verts;
    this.faces = this.faces.filter((f) => f.v.every((v) => map[v] >= 0)).map((f) => ({ v: f.v.map((v) => map[v]), m: f.m }));
    this.edges = this.edges.filter(([a, b]) => map[a] >= 0 && map[b] >= 0).map(([a, b]) => [map[a], map[b]]);
    return map;
  }

  /** Punkte ohne Fläche/Kante entfernen, die in `candidates` stehen */
  dropUnused(candidates: Iterable<number>): Int32Array {
    const used = this.usedVerts();
    const drop = new Set<number>();
    for (const v of candidates) if (!used[v]) drop.add(v);
    return this.compact((i) => drop.has(i));
  }

  bounds(out = new THREE.Box3()): THREE.Box3 {
    out.makeEmpty();
    for (const p of this.verts) out.expandByPoint(p);
    return out;
  }

  /** Alle Punkte transformieren (spiegelnde Matrix dreht die Flächen um) */
  applyMatrix(m: THREE.Matrix4): void {
    for (const p of this.verts) p.applyMatrix4(m);
    if (m.determinant() < 0) for (const f of this.faces) f.v.reverse();
  }

  /** Anderes Netz anhängen; liefert den Index-Versatz */
  append(other: EditMesh, matOffset = 0): number {
    const off = this.verts.length;
    for (const p of other.verts) this.verts.push(p.clone());
    for (const f of other.faces) this.faces.push({ v: f.v.map((v) => v + off), m: f.m + matOffset });
    for (const [a, b] of other.edges) this.edges.push([a + off, b + off]);
    return off;
  }

  get triangleCount(): number {
    let n = 0;
    for (const f of this.faces) n += f.v.length - 2;
    return n;
  }
}

export function polyNormal(pts: THREE.Vector3[], out = new THREE.Vector3(), normalize = true): THREE.Vector3 {
  out.set(0, 0, 0);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.x += (a.y - b.y) * (a.z + b.z);
    out.y += (a.z - b.z) * (a.x + b.x);
    out.z += (a.x - b.x) * (a.y + b.y);
  }
  return normalize ? out.normalize() : out;
}

/** Kantenlänge */
export function edgeLength(m: EditMesh, k: number): number {
  return _a.copy(m.verts[ekA(k)]).distanceTo(_b.copy(m.verts[ekB(k)]));
}

// ---------- Grundkörper ----------

export type PrimitiveKind = 'cube' | 'plane' | 'grid' | 'circle' | 'cylinder' | 'cone' | 'sphere' | 'icosphere' | 'torus';

export interface PrimitiveParams {
  size: number;
  /** Zylinder/Kegel/Kreis/Kugel/Torus: Segmente rundherum */
  segments: number;
  /** Kugel: Ringe · Torus: Segmente des Rohrs · Raster: Unterteilungen */
  rings: number;
  /** Zylinder/Kegel: Höhe */
  height: number;
  /** Kegel: oberer Radius · Torus: Rohr-Radius */
  radius2: number;
  /** Kreis/Zylinder/Kegel: Deckel füllen */
  fill: boolean;
}

export const PRIMITIVES: { kind: PrimitiveKind; label: string; icon: string }[] = [
  { kind: 'cube', label: 'Würfel', icon: 'cube' },
  { kind: 'plane', label: 'Ebene', icon: 'plane' },
  { kind: 'grid', label: 'Raster', icon: 'grid' },
  { kind: 'circle', label: 'Kreis', icon: 'circle' },
  { kind: 'cylinder', label: 'Zylinder', icon: 'cylinder' },
  { kind: 'cone', label: 'Kegel', icon: 'cone' },
  { kind: 'sphere', label: 'UV-Kugel', icon: 'sphere' },
  { kind: 'icosphere', label: 'Ico-Kugel', icon: 'sphere' },
  { kind: 'torus', label: 'Torus', icon: 'torus' },
];

export function primitiveDefaults(kind: PrimitiveKind): PrimitiveParams {
  const d: PrimitiveParams = { size: 1, segments: 32, rings: 16, height: 1, radius2: 0, fill: true };
  if (kind === 'cylinder') d.segments = 24;
  if (kind === 'cone') d.segments = 24;
  if (kind === 'grid') d.rings = 10;
  if (kind === 'icosphere') d.rings = 2;
  if (kind === 'torus') {
    d.segments = 32;
    d.rings = 12;
    d.radius2 = 0.25;
  }
  return d;
}

/** Halbe Höhe des Grundkörpers (zum Aufsetzen auf den Boden) */
export function primitiveHalfHeight(kind: PrimitiveKind, p: PrimitiveParams): number {
  switch (kind) {
    case 'plane':
    case 'grid':
    case 'circle':
      return 0;
    case 'cylinder':
    case 'cone':
      return p.height / 2;
    case 'torus':
      return p.radius2 * p.size;
    default:
      return p.size / 2;
  }
}

/** Grundkörper um den Nullpunkt (Größe = Kantenlänge bzw. Durchmesser) */
export function makePrimitive(kind: PrimitiveKind, p: PrimitiveParams, mat = 0): EditMesh {
  const m = new EditMesh();
  const h = p.size / 2;
  const seg = Math.max(3, Math.round(p.segments));
  const ring = (y: number, r: number) => {
    const out: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      out.push(m.addVert(Math.cos(a) * r, y, -Math.sin(a) * r));
    }
    return out;
  };
  switch (kind) {
    case 'cube': {
      for (let i = 0; i < 8; i++) m.addVert(i & 1 ? h : -h, i & 2 ? h : -h, i & 4 ? h : -h);
      for (const f of [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]]) m.addFace(f, mat);
      break;
    }
    case 'plane':
    case 'grid': {
      const n = kind === 'plane' ? 1 : Math.max(1, Math.round(p.rings));
      for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) m.addVert(-h + (x / n) * p.size, 0, -h + (z / n) * p.size);
      for (let z = 0; z < n; z++)
        for (let x = 0; x < n; x++) {
          const i = z * (n + 1) + x;
          m.addFace([i, i + n + 1, i + n + 2, i + 1], mat);
        }
      break;
    }
    case 'circle': {
      const r = ring(0, h);
      if (p.fill) m.addFace(r, mat);
      else for (let i = 0; i < seg; i++) m.edges.push([r[i], r[(i + 1) % seg]]);
      break;
    }
    case 'cylinder':
    case 'cone': {
      const hh = p.height / 2;
      const r2 = kind === 'cone' ? p.radius2 * h : h;
      const bottom = ring(-hh, h);
      if (r2 > 1e-5) {
        const top = ring(hh, r2);
        for (let i = 0; i < seg; i++) {
          const j = (i + 1) % seg;
          m.addFace([bottom[i], bottom[j], top[j], top[i]], mat);
        }
        if (p.fill) m.addFace([...top], mat);
      } else {
        const apex = m.addVert(0, hh, 0);
        for (let i = 0; i < seg; i++) m.addFace([bottom[i], bottom[(i + 1) % seg], apex], mat);
      }
      if (p.fill) m.addFace([...bottom].reverse(), mat);
      break;
    }
    case 'sphere': {
      const rings = Math.max(3, Math.round(p.rings));
      const top = m.addVert(0, h, 0);
      const rows: number[][] = [];
      for (let r = 1; r < rings; r++) {
        const phi = (r / rings) * Math.PI;
        rows.push(ring(Math.cos(phi) * h, Math.sin(phi) * h));
      }
      const bot = m.addVert(0, -h, 0);
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        m.addFace([top, rows[0][i], rows[0][j]], mat);
        for (let r = 0; r + 1 < rows.length; r++) m.addFace([rows[r][i], rows[r + 1][i], rows[r + 1][j], rows[r][j]], mat);
        m.addFace([rows[rows.length - 1][i], bot, rows[rows.length - 1][j]], mat);
      }
      break;
    }
    case 'icosphere': {
      const ico = new THREE.IcosahedronGeometry(h, Math.max(0, Math.min(5, Math.round(p.rings) - 1)));
      const tmp = new EditMesh();
      const pos = ico.attributes.position;
      for (let i = 0; i < pos.count; i += 3) {
        const a = tmp.addVert(pos.getX(i), pos.getY(i), pos.getZ(i));
        tmp.addVert(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
        tmp.addVert(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
        tmp.addFace([a, a + 1, a + 2], mat);
      }
      ico.dispose();
      weld(tmp, 1e-5);
      return tmp;
    }
    case 'torus': {
      const R = h;
      const r = p.radius2 * p.size;
      const tube = Math.max(3, Math.round(p.rings));
      const idx: number[][] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const row: number[] = [];
        for (let j = 0; j < tube; j++) {
          const b = (j / tube) * Math.PI * 2;
          const d = R + Math.cos(b) * r;
          row.push(m.addVert(Math.cos(a) * d, Math.sin(b) * r, -Math.sin(a) * d));
        }
        idx.push(row);
      }
      for (let i = 0; i < seg; i++)
        for (let j = 0; j < tube; j++) {
          const i2 = (i + 1) % seg;
          const j2 = (j + 1) % tube;
          m.addFace([idx[i][j], idx[i2][j], idx[i2][j2], idx[i][j2]], mat);
        }
      // Ausrichtung prüfen: Normale zeigt vom Rohr-Mittelkreis weg
      orientAgainst(m, (c) => {
        const l = Math.hypot(c.x, c.z) || 1;
        return new THREE.Vector3((c.x / l) * R, 0, (c.z / l) * R);
      });
      return m;
    }
  }
  if (kind === 'plane' || kind === 'grid' || kind === 'circle') {
    // nach oben zeigen
    for (let i = 0; i < m.faces.length; i++) if (m.faceNormal(i, _a).y < 0) m.faces[i].v.reverse();
  } else orientAgainst(m, () => new THREE.Vector3());
  return m;
}

/** Flächen so drehen, dass ihre Normale von `inner(Mittelpunkt)` weg zeigt (konvexe Grundkörper) */
function orientAgainst(m: EditMesh, inner: (c: THREE.Vector3) => THREE.Vector3): void {
  const n = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < m.faces.length; i++) {
    m.faceNormal(i, n);
    m.faceCenter(i, c);
    if (n.dot(c.clone().sub(inner(c))) < 0) m.faces[i].v.reverse();
  }
}

/** Punkte mit (fast) gleicher Lage zusammenführen; liefert die Anzahl entfernter Punkte */
export function weld(m: EditMesh, eps: number, only?: Set<number>): number {
  const map = new Int32Array(m.verts.length);
  for (let i = 0; i < map.length; i++) map[i] = i;
  const grid = new Map<string, number[]>();
  const inv = 1 / Math.max(eps, 1e-9);
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  let removed = 0;
  m.verts.forEach((p, i) => {
    if (only && !only.has(i)) return;
    const gx = Math.floor(p.x * inv);
    const gy = Math.floor(p.y * inv);
    const gz = Math.floor(p.z * inv);
    for (let dx = -1; dx <= 1 && map[i] === i; dx++)
      for (let dy = -1; dy <= 1 && map[i] === i; dy++)
        for (let dz = -1; dz <= 1 && map[i] === i; dz++) {
          for (const j of grid.get(key(gx + dx, gy + dy, gz + dz)) ?? []) {
            if (m.verts[j].distanceToSquared(p) <= eps * eps) {
              map[i] = j;
              removed++;
              break;
            }
          }
        }
    if (map[i] === i) {
      const k = key(gx, gy, gz);
      const l = grid.get(k);
      if (l) l.push(i);
      else grid.set(k, [i]);
    }
  });
  if (!removed) return 0;
  remapVerts(m, map);
  return removed;
}

/** Punkte umleiten (map[i] = Ziel), entartete Flächen entfernen, verwaiste Punkte löschen */
export function remapVerts(m: EditMesh, map: Int32Array): void {
  m.faces = m.faces.map((f) => ({ v: f.v.map((v) => map[v]), m: f.m }));
  m.edges = m.edges.map(([a, b]) => [map[a], map[b]]);
  m.validate();
  const dropped = new Set<number>();
  for (let i = 0; i < map.length; i++) if (map[i] !== i) dropped.add(i);
  m.compact((i) => dropped.has(i));
}
