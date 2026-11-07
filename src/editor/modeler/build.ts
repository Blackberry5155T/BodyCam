import * as THREE from 'three';
import { getMaterial } from '../../world/materials.ts';
import type { EditMesh } from './mesh.ts';
import type { MatSlot } from './doc.ts';

// Aus dem Polygon-Netz eine BufferGeometry bauen: n-Ecken triangulieren, flache oder geglättete Normalen
// (mit Winkelgrenze), Box-UVs im Modellraum, Gruppen je Material-Slot. `triFace` ordnet jedes Dreieck
// seiner Fläche zu (für die Flächen-Auswahl per Raycast).

export interface Built {
  geometry: THREE.BufferGeometry;
  triFace: Int32Array;
}

const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Fläche in Dreiecke zerlegen (lokale Eckindizes 0..n-1), passend zur Flächennormale ausgerichtet */
export function triangulateFace(pts: THREE.Vector3[], normal: THREE.Vector3): number[] {
  const n = pts.length;
  if (n === 3) return [0, 1, 2];
  if (n === 4) {
    // konvexes Viereck: kürzere Diagonale; sonst die Diagonale, die innen liegt
    const d02 = pts[0].distanceToSquared(pts[2]);
    const d13 = pts[1].distanceToSquared(pts[3]);
    const ok02 = triFacing(pts[0], pts[1], pts[2], normal) && triFacing(pts[0], pts[2], pts[3], normal);
    const ok13 = triFacing(pts[1], pts[2], pts[3], normal) && triFacing(pts[1], pts[3], pts[0], normal);
    if (ok02 && (!ok13 || d02 <= d13)) return [0, 1, 2, 0, 2, 3];
    if (ok13) return [1, 2, 3, 1, 3, 0];
    return [0, 1, 2, 0, 2, 3];
  }
  // Projektion in die Flächenebene, dann Earcut
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(normal.x) > 0.9) u.set(0, 1, 0);
  u.sub(_n.copy(normal).multiplyScalar(normal.dot(u))).normalize();
  const w = new THREE.Vector3().crossVectors(normal, u);
  const contour = pts.map((p) => new THREE.Vector2(p.dot(u), p.dot(w)));
  let tris: number[][];
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    tris = [];
  }
  const out: number[] = [];
  if (tris.length !== n - 2) {
    // Notfall: Fächer
    for (let i = 1; i + 1 < n; i++) out.push(0, i, i + 1);
    return out;
  }
  for (const [a, b, c] of tris) {
    if (triFacing(pts[a], pts[b], pts[c], normal, -1)) out.push(a, b, c);
    else out.push(a, c, b);
  }
  return out;
}

function triFacing(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, n: THREE.Vector3, tol = 1e-9): boolean {
  _a.subVectors(b, a);
  _b.subVectors(c, a);
  return _c.crossVectors(_a, _b).dot(n) > tol;
}

/** Box-Projektion (wie bei den Level-Geometrie-Pinseln, 1 Kachel = 2 m bei Maßstab 1) */
export function boxUV(p: THREE.Vector3, n: THREE.Vector3, s: number, out: Float32Array, i: number): void {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  let u: number;
  let v: number;
  if (ax >= ay && ax >= az) {
    u = n.x > 0 ? -p.z : p.z;
    v = p.y;
  } else if (ay >= az) {
    u = p.x;
    v = n.y > 0 ? -p.z : p.z;
  } else {
    u = n.z > 0 ? p.x : -p.x;
    v = p.y;
  }
  out[i * 2] = u * s;
  out[i * 2 + 1] = v * s;
}

export interface BuildOptions {
  smooth: boolean;
  smoothAngle: number;
  /** Textur-Maßstab je Material-Slot */
  uvScale?: (slot: number) => number;
  /** Punkte für die UV-Projektion transformieren (z. B. Objekt-Skalierung), sonst lokal */
  uvMatrix?: THREE.Matrix4;
}

export function buildGeometry(m: EditMesh, o: BuildOptions): Built {
  const normals = m.faces.map((_, i) => m.faceNormal(i));
  const order = m.faces.map((_, i) => i).sort((a, b) => m.faces[a].m - m.faces[b].m || a - b);
  let corners = 0;
  let tris = 0;
  for (const f of m.faces) {
    corners += f.v.length;
    tris += f.v.length - 2;
  }
  const pos = new Float32Array(corners * 3);
  const nor = new Float32Array(corners * 3);
  const uv = new Float32Array(corners * 2);
  const index: number[] = [];
  const triFace = new Int32Array(tris);
  const geo = new THREE.BufferGeometry();
  // Glättung: Flächen je Punkt
  const vf = o.smooth ? m.vertFaces() : null;
  const cosLimit = Math.cos(THREE.MathUtils.degToRad(Math.min(180, Math.max(0, o.smoothAngle))));
  const areas = o.smooth ? m.faces.map((_, i) => m.faceNormal(i, new THREE.Vector3(), false).length()) : null;
  const tmp = new THREE.Vector3();
  const uvp = new THREE.Vector3();
  const uvn = new THREE.Vector3();
  const nm = o.uvMatrix ? new THREE.Matrix3().getNormalMatrix(o.uvMatrix) : null;
  let ci = 0;
  let ti = 0;
  let groupStart = 0;
  let groupMat = -1;
  for (const fi of order) {
    const f = m.faces[fi];
    if (f.m !== groupMat) {
      if (groupMat >= 0 && index.length > groupStart) geo.addGroup(groupStart, index.length - groupStart, groupMat);
      groupStart = index.length;
      groupMat = f.m;
    }
    const n = normals[fi];
    const base = ci;
    const s = 0.5 * (o.uvScale?.(f.m) ?? 1);
    uvn.copy(n);
    if (nm) uvn.applyMatrix3(nm).normalize();
    for (const v of f.v) {
      const p = m.verts[v];
      pos[ci * 3] = p.x;
      pos[ci * 3 + 1] = p.y;
      pos[ci * 3 + 2] = p.z;
      let cn = n;
      if (vf && areas) {
        tmp.set(0, 0, 0);
        for (const g of vf[v]) if (g === fi || normals[g].dot(n) >= cosLimit - 1e-6) tmp.addScaledVector(normals[g], Math.max(1e-6, areas[g]));
        cn = tmp.lengthSq() > 1e-12 ? tmp.normalize() : n;
      }
      nor[ci * 3] = cn.x;
      nor[ci * 3 + 1] = cn.y;
      nor[ci * 3 + 2] = cn.z;
      uvp.copy(p);
      if (o.uvMatrix) uvp.applyMatrix4(o.uvMatrix);
      boxUV(uvp, uvn, s, uv, ci);
      ci++;
    }
    const local = triangulateFace(
      f.v.map((v) => m.verts[v]),
      n.lengthSq() > 0.5 ? n : _n.set(0, 1, 0),
    );
    for (let i = 0; i < local.length; i += 3) {
      index.push(base + local[i], base + local[i + 1], base + local[i + 2]);
      triFace[ti++] = fi;
    }
  }
  if (groupMat >= 0 && index.length > groupStart) geo.addGroup(groupStart, index.length - groupStart, groupMat);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index.length > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geometry: geo, triFace };
}

/** Material eines Slots (geteilt; zum Verändern erst klonen) */
export function slotMaterial(s: MatSlot): THREE.MeshStandardMaterial {
  return getMaterial({ material: s.material, color: s.color, roughness: s.roughness, metalness: s.metalness });
}

/** Schlichtes Material für die interne Speicherung (ohne Texturen; beim Laden durch das echte ersetzt) */
export function exportPlaceholder(s: MatSlot): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: s.material === 'farbe' || s.material === 'metall' ? s.color : '#9a9a9a', roughness: s.roughness ?? 0.75, metalness: s.metalness ?? 0 });
  mat.name = s.name;
  mat.userData.bcMat = { material: s.material, color: s.color, roughness: s.roughness, metalness: s.metalness, uvScale: s.uvScale };
  return mat;
}
