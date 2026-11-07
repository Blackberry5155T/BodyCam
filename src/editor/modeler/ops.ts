import * as THREE from 'three';
import { EditMesh, ek, ekA, ekB, polyNormal, remapVerts, weld } from './mesh.ts';

// Bearbeitungs-Operationen des Edit-Modus (Blender-ähnlich). Alle arbeiten direkt auf dem Netz und liefern
// die neue Auswahl zurück. Koordinaten sind lokal (Raum des Objekts).

export type SelMode = 'v' | 'e' | 'f';

/** Auswahl: immer vollständig abgeleitet (Punkte, Kanten, Flächen passen zueinander) */
export interface Selection {
  v: Set<number>;
  e: Set<number>;
  f: Set<number>;
}

export const emptySel = (): Selection => ({ v: new Set(), e: new Set(), f: new Set() });

export function selFromVerts(m: EditMesh, vs: Iterable<number>): Selection {
  const v = new Set(vs);
  const e = new Set<number>();
  const f = new Set<number>();
  m.faces.forEach((face, fi) => {
    let all = true;
    for (let i = 0; i < face.v.length; i++) {
      const a = face.v[i];
      const b = face.v[(i + 1) % face.v.length];
      if (v.has(a) && v.has(b)) e.add(ek(a, b));
      if (!v.has(a)) all = false;
    }
    if (all) f.add(fi);
  });
  for (const [a, b] of m.edges) if (v.has(a) && v.has(b)) e.add(ek(a, b));
  return { v, e, f };
}

export function selFromEdges(m: EditMesh, es: Iterable<number>): Selection {
  const e = new Set(es);
  const v = new Set<number>();
  for (const k of e) {
    v.add(ekA(k));
    v.add(ekB(k));
  }
  const f = new Set<number>();
  m.faces.forEach((face, fi) => {
    for (let i = 0; i < face.v.length; i++) if (!e.has(ek(face.v[i], face.v[(i + 1) % face.v.length]))) return;
    f.add(fi);
  });
  return { v, e, f };
}

export function selFromFaces(m: EditMesh, fs: Iterable<number>): Selection {
  const f = new Set(fs);
  const v = new Set<number>();
  const e = new Set<number>();
  for (const fi of f) {
    const face = m.faces[fi];
    if (!face) continue;
    for (let i = 0; i < face.v.length; i++) {
      v.add(face.v[i]);
      e.add(ek(face.v[i], face.v[(i + 1) % face.v.length]));
    }
  }
  return { v, e, f };
}

/** Auswahl im angegebenen Modus neu ableiten (nach Moduswechsel oder Operation) */
export function resel(m: EditMesh, s: Selection, mode: SelMode): Selection {
  const n = m.verts.length;
  if (mode === 'v') return selFromVerts(m, [...s.v].filter((i) => i < n));
  if (mode === 'e') {
    const all = new Set(m.allEdges());
    return selFromEdges(m, [...s.e].filter((k) => all.has(k)));
  }
  return selFromFaces(m, [...s.f].filter((i) => i < m.faces.length));
}

export function selectAll(m: EditMesh): Selection {
  return selFromVerts(
    m,
    m.verts.map((_, i) => i),
  );
}

export function invertSel(m: EditMesh, s: Selection, mode: SelMode): Selection {
  if (mode === 'v') return selFromVerts(m, m.verts.map((_, i) => i).filter((i) => !s.v.has(i)));
  if (mode === 'e') return selFromEdges(m, m.allEdges().filter((k) => !s.e.has(k)));
  return selFromFaces(m, m.faces.map((_, i) => i).filter((i) => !s.f.has(i)));
}

/** Alles, was mit der Auswahl verbunden ist */
export function selectLinked(m: EditMesh, seeds: Iterable<number>): Selection {
  const nb = m.vertNeighbors();
  const seen = new Set<number>();
  const stack = [...seeds];
  while (stack.length) {
    const v = stack.pop()!;
    if (seen.has(v)) continue;
    seen.add(v);
    for (const w of nb[v]) if (!seen.has(w)) stack.push(w);
  }
  return selFromVerts(m, seen);
}

/** Auswahl um einen Ring erweitern / verkleinern */
export function growSel(m: EditMesh, s: Selection, grow: boolean): Selection {
  const nb = m.vertNeighbors();
  if (grow) {
    const v = new Set(s.v);
    for (const i of s.v) for (const w of nb[i]) v.add(w);
    return selFromVerts(m, v);
  }
  const v = new Set<number>();
  for (const i of s.v) if ([...nb[i]].every((w) => s.v.has(w))) v.add(i);
  return selFromVerts(m, v);
}

// ---------- Schleifen & Ringe ----------

export interface Ring {
  /** Kanten des Rings, jeweils [a, b] mit a auf derselben Seite */
  edges: [number, number][];
  quads: number[];
  closed: boolean;
}

/** Kantenring über Vierecke (für Loop Cut und Ring-Auswahl) */
export function edgeRing(m: EditMesh, k: number, ef = m.edgeFaces()): Ring | null {
  const a0 = ekA(k);
  const b0 = ekB(k);
  const start = ef.get(k);
  if (!start?.length || start.length > 2) return null;
  const seenQuads = new Set<number>();
  const walk = (face: number) => {
    const edges: [number, number][] = [];
    const quads: number[] = [];
    let a = a0;
    let b = b0;
    let f: number | undefined = face;
    while (f !== undefined && !seenQuads.has(f)) {
      const fv = m.faces[f].v;
      if (fv.length !== 4) break;
      seenQuads.add(f);
      quads.push(f);
      const ia = fv.indexOf(a);
      const ib = fv.indexOf(b);
      const na = fv[(ia + 1) % 4] === b ? fv[(ia + 3) % 4] : fv[(ia + 1) % 4];
      const nb = fv[(ib + 1) % 4] === a ? fv[(ib + 3) % 4] : fv[(ib + 1) % 4];
      a = na;
      b = nb;
      if (ek(a, b) === k) return { edges, quads, closed: true };
      edges.push([a, b]);
      const fs: number[] = ef.get(ek(a, b)) ?? [];
      const cur: number = f;
      f = fs.length === 2 ? fs.find((x) => x !== cur) : undefined;
    }
    return { edges, quads, closed: false };
  };
  const r1 = walk(start[0]);
  if (r1.closed) return { edges: [[a0, b0], ...r1.edges], quads: r1.quads, closed: true };
  const r2 = start.length === 2 ? walk(start[1]) : { edges: [], quads: [], closed: false };
  return { edges: [...r2.edges.reverse(), [a0, b0], ...r1.edges], quads: [...r2.quads.reverse(), ...r1.quads], closed: false };
}

/** Kantenschleife (über Punkte mit 4 Kanten, wie Alt+Klick in Blender) */
export function edgeLoop(m: EditMesh, k: number): number[] {
  const ef = m.edgeFaces();
  const nb = m.vertNeighbors();
  const out = new Set<number>([k]);
  const step = (from: number, at: number) => {
    let prev = from;
    let cur = at;
    for (let guard = 0; guard < 100000; guard++) {
      if (nb[cur].size !== 4) return;
      const facesPrev = new Set(ef.get(ek(prev, cur)) ?? []);
      let next = -1;
      for (const w of nb[cur]) {
        if (w === prev) continue;
        const fs = ef.get(ek(cur, w)) ?? [];
        if (!fs.some((f) => facesPrev.has(f))) {
          next = w;
          break;
        }
      }
      if (next < 0) return;
      const nk = ek(cur, next);
      if (out.has(nk)) return;
      out.add(nk);
      prev = cur;
      cur = next;
    }
  };
  step(ekA(k), ekB(k));
  step(ekB(k), ekA(k));
  return [...out];
}

// ---------- Extrudieren ----------

export interface ExtrudeResult {
  sel: Selection;
  /** Richtung für das anschließende Verschieben (Flächen: gemittelte Normale), sonst null */
  normal: THREE.Vector3 | null;
}

export function extrude(m: EditMesh, s: Selection): ExtrudeResult | null {
  if (s.f.size) return extrudeFaces(m, [...s.f]);
  if (s.e.size) {
    const ef = m.edgeFaces();
    const map = new Map<number, number>();
    const nv = (v: number) => {
      let i = map.get(v);
      if (i === undefined) map.set(v, (i = m.addVert(m.verts[v])));
      return i;
    };
    const edges: number[] = [];
    for (const k of s.e) {
      const a = ekA(k);
      const b = ekB(k);
      const fs = ef.get(k);
      let mat = 0;
      let forward = true;
      if (fs?.length) {
        const f = m.faces[fs[0]];
        const i = f.v.indexOf(a);
        forward = f.v[(i + 1) % f.v.length] !== b;
        mat = f.m;
      }
      m.addFace(forward ? [a, b, nv(b), nv(a)] : [b, a, nv(a), nv(b)], mat);
      edges.push(ek(nv(a), nv(b)));
    }
    m.tidyEdges();
    return { sel: selFromEdges(m, edges), normal: null };
  }
  if (s.v.size) {
    const out: number[] = [];
    for (const v of s.v) {
      const n = m.addVert(m.verts[v]);
      m.edges.push([v, n]);
      out.push(n);
    }
    return { sel: selFromVerts(m, out), normal: null };
  }
  return null;
}

function extrudeFaces(m: EditMesh, F: number[]): ExtrudeResult {
  const fset = new Set(F);
  const ef = m.edgeFaces();
  const boundary: [number, number, number][] = [];
  for (const fi of F) {
    const v = m.faces[fi].v;
    for (let i = 0; i < v.length; i++) {
      const a = v[i];
      const b = v[(i + 1) % v.length];
      const inRegion = ef.get(ek(a, b))!.filter((x) => fset.has(x)).length;
      if (inRegion === 1) boundary.push([a, b, fi]);
    }
  }
  // Eigenständiges Stück (z. B. einzelne Ebene): Unterseite bleibt als geschlossener Körper stehen
  const isolated = boundary.length > 0 && boundary.every(([a, b]) => ef.get(ek(a, b))!.length === 1);
  const regionVerts = new Set(F.flatMap((fi) => m.faces[fi].v));
  const map = new Map<number, number>();
  for (const v of regionVerts) map.set(v, m.addVert(m.verts[v]));
  const keep = isolated ? F.map((fi) => ({ v: [...m.faces[fi].v].reverse(), m: m.faces[fi].m })) : [];
  for (const fi of F) m.faces[fi].v = m.faces[fi].v.map((v) => map.get(v)!);
  for (const [a, b, fi] of boundary) m.addFace([a, b, map.get(b)!, map.get(a)!], m.faces[fi].m);
  for (const k of keep) m.faces.push(k);
  const normal = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const fi of F) normal.add(m.faceNormal(fi, n, false));
  if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
  normal.normalize();
  m.dropUnused(regionVerts);
  return { sel: selFromFaces(m, F), normal };
}

// ---------- Inset ----------

export function inset(m: EditMesh, F: number[], thickness: number, depth: number, individual: boolean): Selection {
  if (individual) for (const fi of F) insetRegion(m, [fi], thickness, depth);
  else insetRegion(m, F, thickness, depth);
  return selFromFaces(m, F);
}

function insetRegion(m: EditMesh, F: number[], t: number, depth: number): void {
  const fset = new Set(F);
  const ef = m.edgeFaces();
  const boundary: [number, number, number][] = [];
  for (const fi of F) {
    const v = m.faces[fi].v;
    for (let i = 0; i < v.length; i++) {
      const a = v[i];
      const b = v[(i + 1) % v.length];
      if (ef.get(ek(a, b))!.filter((x) => fset.has(x)).length === 1) boundary.push([a, b, fi]);
    }
  }
  if (!boundary.length) return;
  const dirs = new Map<number, THREE.Vector3[]>();
  const n = new THREE.Vector3();
  for (const [a, b, fi] of boundary) {
    m.faceNormal(fi, n);
    const e = m.verts[b].clone().sub(m.verts[a]).normalize();
    const inward = n.clone().cross(e).normalize();
    for (const v of [a, b]) {
      const l = dirs.get(v);
      if (l) l.push(inward);
      else dirs.set(v, [inward]);
    }
  }
  const map = new Map<number, number>();
  for (const [v, ds] of dirs) {
    const sum = new THREE.Vector3();
    for (const d of ds) sum.add(d);
    const dir = sum.lengthSq() < 1e-10 ? ds[0].clone() : sum.normalize();
    const cos = Math.max(0.2, dir.dot(ds[0]));
    map.set(v, m.addVert(m.verts[v].clone().addScaledVector(dir, t / cos)));
  }
  for (const fi of F) m.faces[fi].v = m.faces[fi].v.map((v) => map.get(v) ?? v);
  for (const [a, b, fi] of boundary) m.addFace([a, b, map.get(b)!, map.get(a)!], m.faces[fi].m);
  if (Math.abs(depth) > 1e-9) {
    const normal = new THREE.Vector3();
    for (const fi of F) normal.add(m.faceNormal(fi, n, false));
    normal.normalize();
    const moved = new Set(F.flatMap((fi) => m.faces[fi].v));
    for (const v of moved) m.verts[v].addScaledVector(normal, depth);
  }
}

// ---------- Bevel (Fase, 1 Segment) ----------

export function bevel(m: EditMesh, edges: Iterable<number>, w: number): Selection {
  const ef = m.edgeFaces();
  const B = new Set<number>();
  for (const k of edges) if (ef.get(k)?.length === 2) B.add(k);
  if (!B.size || w <= 0) return emptySel();
  const bv = new Set<number>();
  for (const k of B) {
    bv.add(ekA(k));
    bv.add(ekB(k));
  }
  const vf = m.vertFaces();
  const onEdge = new Map<string, number>();
  const repl = new Map<string, number[]>();
  const dir = (from: number, to: number) => m.verts[to].clone().sub(m.verts[from]);
  const slide = (v: number, o: number, dist: number) => {
    const key = `${v}:${o}`;
    let i = onEdge.get(key);
    if (i === undefined) {
      const d = dir(v, o);
      const len = d.length();
      i = m.addVert(m.verts[v].clone().addScaledVector(d.divideScalar(len || 1), Math.min(dist, len * 0.45)));
      onEdge.set(key, i);
    }
    return i;
  };
  for (const v of bv) {
    const deferred: number[] = [];
    for (const fi of vf[v]) {
      const f = m.faces[fi].v;
      const n = f.length;
      const i = f.indexOf(v);
      const p = f[(i - 1 + n) % n];
      const nx = f[(i + 1) % n];
      const bp = B.has(ek(v, p));
      const bn = B.has(ek(v, nx));
      const up = dir(v, p);
      const un = dir(v, nx);
      const lp = up.length();
      const ln = un.length();
      up.normalize();
      un.normalize();
      const sin = Math.max(0.15, up.clone().cross(un).length());
      const key = `${v}:${fi}`;
      if (bp && bn) {
        const d = Math.min(w / sin, lp * 0.45, ln * 0.45);
        repl.set(key, [m.addVert(m.verts[v].clone().addScaledVector(up, d).addScaledVector(un, d))]);
      } else if (bn) repl.set(key, [slide(v, p, w / sin)]);
      else if (bp) repl.set(key, [slide(v, nx, w / sin)]);
      else deferred.push(fi);
    }
    for (const fi of deferred) {
      const f = m.faces[fi].v;
      const n = f.length;
      const i = f.indexOf(v);
      const a = onEdge.get(`${v}:${f[(i - 1 + n) % n]}`) ?? v;
      const b = onEdge.get(`${v}:${f[(i + 1) % n]}`) ?? v;
      repl.set(`${v}:${fi}`, a === b ? [a] : [a, b]);
    }
  }
  const oldFaces = m.faces.map((f) => ({ v: [...f.v], m: f.m }));
  m.faces = m.faces.map((f, fi) => ({ v: f.v.flatMap((v) => repl.get(`${v}:${fi}`) ?? [v]), m: f.m }));
  const added: number[] = [];
  const n1 = new THREE.Vector3();
  const n2 = new THREE.Vector3();
  const pn = new THREE.Vector3();
  const addOriented = (pts: number[], ref: THREE.Vector3, mat: number) => {
    const clean = pts.filter((p, i) => p !== pts[(i + 1) % pts.length]);
    if (clean.length < 3 || new Set(clean).size !== clean.length) return;
    polyNormal(clean.map((i) => m.verts[i]), pn);
    if (pn.dot(ref) < 0) clean.reverse();
    added.push(m.addFace(clean, mat));
  };
  // Bänder entlang der Kanten
  for (const k of B) {
    const a = ekA(k);
    const b = ekB(k);
    const [f1, f2] = ef.get(k)!;
    const A1 = repl.get(`${a}:${f1}`)![0];
    const B1 = repl.get(`${b}:${f1}`)![0];
    const A2 = repl.get(`${a}:${f2}`)![0];
    const B2 = repl.get(`${b}:${f2}`)![0];
    polyNormal(oldFaces[f1].v.map((i) => m.verts[i]), n1);
    polyNormal(oldFaces[f2].v.map((i) => m.verts[i]), n2);
    addOriented([A1, B1, B2, A2], n1.add(n2), oldFaces[f1].m);
  }
  // Ecken, an denen mehrere Kanten zusammenlaufen
  for (const v of bv) {
    const fan = fanAround(oldFaces, ef, v, vf[v]);
    if (!fan) continue;
    const pts: number[] = [];
    for (const fi of fan) for (const p of repl.get(`${v}:${fi}`) ?? []) if (pts[pts.length - 1] !== p) pts.push(p);
    while (pts.length > 1 && pts[0] === pts[pts.length - 1]) pts.pop();
    if (new Set(pts).size < 3) continue;
    const ref = new THREE.Vector3();
    for (const fi of fan) ref.add(polyNormal(oldFaces[fi].v.map((i) => m.verts[i]), n1));
    addOriented(pts, ref, oldFaces[fan[0]].m);
  }
  m.validate();
  m.dropUnused(bv);
  return selFromFaces(m, added.filter((i) => i < m.faces.length));
}

/** Flächen rund um einen Punkt in Reihenfolge (null bei offenem Rand) */
function fanAround(faces: { v: number[] }[], ef: Map<number, number[]>, v: number, around: number[]): number[] | null {
  if (!around.length) return null;
  const out: number[] = [];
  let cur = around[0];
  for (let guard = 0; guard <= around.length; guard++) {
    out.push(cur);
    const f = faces[cur].v;
    const nx = f[(f.indexOf(v) + 1) % f.length];
    const fs = ef.get(ek(v, nx)) ?? [];
    if (fs.length !== 2) return null;
    const next = fs[0] === cur ? fs[1] : fs[0];
    if (next === around[0]) return out.length === around.length ? out : null;
    cur = next;
  }
  return null;
}

// ---------- Loop Cut ----------

export function loopCut(m: EditMesh, ring: Ring, cuts: number, factor: number): Selection {
  cuts = Math.max(1, Math.round(cuts));
  const pts = new Map<number, { a: number; list: number[] }>();
  for (const [a, b] of ring.edges) {
    const list: number[] = [];
    for (let c = 1; c <= cuts; c++) {
      const t = cuts === 1 ? factor : c / (cuts + 1);
      list.push(m.addVert(m.verts[a].clone().lerp(m.verts[b], t)));
    }
    pts.set(ek(a, b), { a, list });
  }
  const along = (x: number, y: number) => {
    const p = pts.get(ek(x, y))!;
    return p.a === x ? p.list : [...p.list].reverse();
  };
  const quadSet = new Set(ring.quads);
  const newFaces: { v: number[]; m: number }[] = [];
  const newEdges: number[] = [];
  m.faces.forEach((f, fi) => {
    const fv = f.v;
    if (quadSet.has(fi)) {
      let r = 0;
      while (r < 4 && !(pts.has(ek(fv[r], fv[(r + 1) % 4])) && pts.has(ek(fv[(r + 2) % 4], fv[(r + 3) % 4])))) r++;
      if (r < 4) {
        const [q0, q1, q2, q3] = [fv[r], fv[(r + 1) % 4], fv[(r + 2) % 4], fv[(r + 3) % 4]];
        const s1 = [q0, ...along(q0, q1), q1];
        const s2 = [q3, ...along(q3, q2), q2];
        for (let k = 0; k + 1 < s1.length; k++) {
          newFaces.push({ v: [s1[k], s1[k + 1], s2[k + 1], s2[k]], m: f.m });
          if (k > 0) newEdges.push(ek(s1[k], s2[k]));
        }
        return;
      }
    }
    const out: number[] = [];
    for (let i = 0; i < fv.length; i++) {
      const a = fv[i];
      const b = fv[(i + 1) % fv.length];
      out.push(a);
      if (pts.has(ek(a, b))) out.push(...along(a, b));
    }
    newFaces.push({ v: out, m: f.m });
  });
  m.faces = newFaces;
  return selFromEdges(m, newEdges);
}

// ---------- Unterteilen ----------

export function subdivide(m: EditMesh, F: number[]): Selection {
  const fset = new Set(F);
  const mids = new Map<number, number>();
  const mid = (a: number, b: number) => {
    const k = ek(a, b);
    let i = mids.get(k);
    if (i === undefined) mids.set(k, (i = m.addVert(m.verts[a].clone().lerp(m.verts[b], 0.5))));
    return i;
  };
  const created: { v: number[]; m: number }[] = [];
  for (const fi of F) {
    const v = m.faces[fi].v;
    const mat = m.faces[fi].m;
    const n = v.length;
    if (n === 3) {
      const [a, b, c] = v;
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      created.push({ v: [a, ab, ca], m: mat }, { v: [ab, b, bc], m: mat }, { v: [ca, bc, c], m: mat }, { v: [ab, bc, ca], m: mat });
    } else {
      const c = m.addVert(m.faceCenter(fi));
      for (let i = 0; i < n; i++) created.push({ v: [v[i], mid(v[i], v[(i + 1) % n]), c, mid(v[(i - 1 + n) % n], v[i])], m: mat });
    }
  }
  const keep: { v: number[]; m: number }[] = [];
  m.faces.forEach((f, fi) => {
    if (fset.has(fi)) return;
    const out: number[] = [];
    for (let i = 0; i < f.v.length; i++) {
      out.push(f.v[i]);
      const k = ek(f.v[i], f.v[(i + 1) % f.v.length]);
      if (mids.has(k)) out.push(mids.get(k)!);
    }
    keep.push({ v: out, m: f.m });
  });
  m.faces = [...keep, ...created];
  return selFromFaces(
    m,
    created.map((_, i) => keep.length + i),
  );
}

/** Catmull-Clark-Unterteilung des ganzen Netzes (Subdivision Surface anwenden) */
export function catmullClark(m: EditMesh): void {
  const ef = m.edgeFaces();
  const fp = m.faces.map((_, fi) => m.faceCenter(fi));
  const out = new EditMesh();
  const nb = m.vertNeighbors();
  // Punkte
  const vf = m.vertFaces();
  const vIdx = m.verts.map((p, v) => {
    const faces = vf[v];
    const edges = [...nb[v]];
    const boundaryN = edges.filter((w) => (ef.get(ek(v, w))?.length ?? 0) === 1);
    if (!faces.length) return out.addVert(p);
    if (boundaryN.length === 2) {
      return out.addVert(p.clone().multiplyScalar(6).add(m.verts[boundaryN[0]]).add(m.verts[boundaryN[1]]).divideScalar(8));
    }
    if (boundaryN.length) return out.addVert(p);
    const n = faces.length;
    const Q = new THREE.Vector3();
    for (const f of faces) Q.add(fp[f]);
    Q.divideScalar(n);
    const R = new THREE.Vector3();
    for (const w of edges) R.add(p.clone().add(m.verts[w]).multiplyScalar(0.5));
    R.divideScalar(edges.length);
    return out.addVert(Q.add(R.multiplyScalar(2)).add(p.clone().multiplyScalar(n - 3)).divideScalar(n));
  });
  const fIdx = fp.map((p) => out.addVert(p));
  const eIdx = new Map<number, number>();
  for (const [k, fs] of ef) {
    const a = m.verts[ekA(k)];
    const b = m.verts[ekB(k)];
    const p = a.clone().add(b);
    if (fs.length === 2) p.add(fp[fs[0]]).add(fp[fs[1]]).divideScalar(4);
    else p.multiplyScalar(0.5);
    eIdx.set(k, out.addVert(p));
  }
  m.faces.forEach((f, fi) => {
    const v = f.v;
    const n = v.length;
    for (let i = 0; i < n; i++) {
      out.addFace([vIdx[v[i]], eIdx.get(ek(v[i], v[(i + 1) % n]))!, fIdx[fi], eIdx.get(ek(v[(i - 1 + n) % n], v[i]))!], f.m);
    }
  });
  for (const [a, b] of m.edges) out.edges.push([vIdx[a], vIdx[b]]);
  m.verts = out.verts;
  m.faces = out.faces;
  m.edges = out.edges;
  m.dropUnused(m.verts.map((_, i) => i));
}

// ---------- Löschen & Auflösen ----------

export function deleteVerts(m: EditMesh, vs: Set<number>): void {
  m.faces = m.faces.filter((f) => !f.v.some((v) => vs.has(v)));
  m.edges = m.edges.filter(([a, b]) => !vs.has(a) && !vs.has(b));
  m.compact((i) => vs.has(i));
}

export function deleteEdges(m: EditMesh, es: Set<number>): void {
  const touched = new Set<number>();
  for (const k of es) {
    touched.add(ekA(k));
    touched.add(ekB(k));
  }
  m.faces = m.faces.filter((f) => {
    for (let i = 0; i < f.v.length; i++) if (es.has(ek(f.v[i], f.v[(i + 1) % f.v.length]))) return false;
    return true;
  });
  m.edges = m.edges.filter(([a, b]) => !es.has(ek(a, b)));
  m.dropUnused(touched);
}

export function deleteFaces(m: EditMesh, fs: Set<number>): void {
  const touched = new Set<number>();
  for (const fi of fs) for (const v of m.faces[fi]?.v ?? []) touched.add(v);
  m.faces = m.faces.filter((_, i) => !fs.has(i));
  m.dropUnused(touched);
}

/** Flächengruppen durch ihren Umriss ersetzen (Auflösen, Polygonisieren). Gruppen mit Löchern bleiben. */
function mergeFaceGroups(m: EditMesh, groups: number[][]): number[] {
  const remove = new Set<number>();
  const created: { v: number[]; m: number }[] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const half = new Set<string>();
    for (const fi of g) {
      const v = m.faces[fi].v;
      for (let i = 0; i < v.length; i++) half.add(`${v[i]}>${v[(i + 1) % v.length]}`);
    }
    const next = new Map<number, number>();
    let ok = true;
    let count = 0;
    for (const fi of g) {
      const v = m.faces[fi].v;
      for (let i = 0; i < v.length; i++) {
        const a = v[i];
        const b = v[(i + 1) % v.length];
        if (half.has(`${b}>${a}`)) continue; // innere Kante
        if (next.has(a)) ok = false;
        next.set(a, b);
        count++;
      }
    }
    if (!ok || count < 3) continue;
    const start = next.keys().next().value as number;
    const loop: number[] = [];
    let cur = start;
    for (let guard = 0; guard <= count; guard++) {
      loop.push(cur);
      cur = next.get(cur)!;
      if (cur === start || cur === undefined) break;
    }
    if (cur !== start || loop.length !== count) continue;
    for (const fi of g) remove.add(fi);
    created.push({ v: loop, m: m.faces[g[0]].m });
  }
  if (!created.length) return [];
  const keep = m.faces.filter((_, i) => !remove.has(i));
  m.faces = [...keep, ...created];
  return created.map((_, i) => keep.length + i);
}

function groupsByUnion(n: number, pairs: [number, number][]): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b] of pairs) parent[find(a)] = find(b);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const l = groups.get(r);
    if (l) l.push(i);
    else groups.set(r, [i]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export function dissolveEdges(m: EditMesh, es: Set<number>): Selection {
  const ef = m.edgeFaces();
  const pairs: [number, number][] = [];
  for (const k of es) {
    const fs = ef.get(k);
    if (fs?.length === 2) pairs.push([fs[0], fs[1]]);
  }
  m.edges = m.edges.filter(([a, b]) => !es.has(ek(a, b)));
  const created = mergeFaceGroups(m, groupsByUnion(m.faces.length, pairs));
  const touched = new Set<number>();
  for (const k of es) {
    touched.add(ekA(k));
    touched.add(ekB(k));
  }
  m.dropUnused(touched);
  return selFromFaces(m, created.filter((i) => i < m.faces.length));
}

export function dissolveVerts(m: EditMesh, vs: Set<number>): void {
  for (const v of vs) {
    const nb = new Set<number>();
    const around: number[] = [];
    m.faces.forEach((f, fi) => {
      const i = f.v.indexOf(v);
      if (i < 0) return;
      around.push(fi);
      nb.add(f.v[(i + 1) % f.v.length]);
      nb.add(f.v[(i - 1 + f.v.length) % f.v.length]);
    });
    for (const [a, b] of m.edges) {
      if (a === v) nb.add(b);
      if (b === v) nb.add(a);
    }
    if (nb.size > 2 && around.length > 1) {
      const pairs: [number, number][] = [];
      for (let i = 1; i < around.length; i++) pairs.push([around[0], around[i]]);
      mergeFaceGroups(m, [around]);
    }
    for (const f of m.faces) {
      const i = f.v.indexOf(v);
      if (i >= 0 && f.v.length > 3) f.v.splice(i, 1);
    }
    // lose Kanten durch den Punkt verbinden
    const loose = m.edges.filter(([a, b]) => a === v || b === v).map(([a, b]) => (a === v ? b : a));
    m.edges = m.edges.filter(([a, b]) => a !== v && b !== v);
    if (loose.length === 2) m.edges.push([loose[0], loose[1]]);
  }
  m.validate();
  m.dropUnused(vs);
}

/** Koplanare, benachbarte Dreiecke/Flächen mit gleichem Material zu n-Ecken verschmelzen */
export function polygonize(m: EditMesh, cosTol = 0.99995, distTol = 1e-4): void {
  const ef = m.edgeFaces();
  const n = m.faces.map((_, i) => m.faceNormal(i));
  const d = m.faces.map((f, i) => n[i].dot(m.verts[f.v[0]]));
  const pairs: [number, number][] = [];
  for (const fs of ef.values()) {
    if (fs.length !== 2) continue;
    const [a, b] = fs;
    if (m.faces[a].m === m.faces[b].m && n[a].dot(n[b]) > cosTol && Math.abs(d[a] - d[b]) < distTol) pairs.push([a, b]);
  }
  mergeFaceGroups(m, groupsByUnion(m.faces.length, pairs));
}

// ---------- Füllen, Zusammenführen ----------

export function fill(m: EditMesh, s: Selection, viewDir: THREE.Vector3, mat: number): Selection | null {
  const S = [...s.v];
  if (S.length === 2) {
    const k = ek(S[0], S[1]);
    if (!m.allEdges().includes(k)) m.edges.push([S[0], S[1]]);
    return selFromVerts(m, S);
  }
  if (S.length < 3) return null;
  const ef = m.edgeFaces();
  // Randschleife aus gewählten Rand-/losen Kanten?
  const adj = new Map<number, number[]>();
  for (const k of s.e) {
    if ((ef.get(k)?.length ?? 0) > 1) continue;
    const a = ekA(k);
    const b = ekB(k);
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }
  let order: number[] | null = null;
  if (adj.size === S.length && [...adj.values()].every((l) => l.length === 2)) {
    const loop = [S[0]];
    let prev = -1;
    let cur = S[0];
    for (let guard = 0; guard < S.length; guard++) {
      const l: number[] = adj.get(cur)!;
      const nx: number = l[0] === prev ? l[1] : l[0];
      if (nx === S[0]) break;
      loop.push(nx);
      prev = cur;
      cur = nx;
    }
    if (loop.length === S.length) order = loop;
  }
  if (!order) order = sortAroundCenter(m, S);
  // Ausrichtung passend zu Nachbarflächen, sonst zur Kamera
  let decided = false;
  for (let i = 0; i < order.length && !decided; i++) {
    const a = order[i];
    const b = order[(i + 1) % order.length];
    for (const fi of ef.get(ek(a, b)) ?? []) {
      const f = m.faces[fi].v;
      const j = f.indexOf(a);
      if (f[(j + 1) % f.length] === b) order.reverse();
      decided = true;
      break;
    }
  }
  if (!decided && polyNormal(order.map((i) => m.verts[i])).dot(viewDir) > 0) order.reverse();
  const fi = m.addFace(order, mat);
  m.tidyEdges();
  return selFromFaces(m, [fi]);
}

function sortAroundCenter(m: EditMesh, S: number[]): number[] {
  const c = new THREE.Vector3();
  for (const i of S) c.add(m.verts[i]);
  c.divideScalar(S.length);
  const sortBy = (n: THREE.Vector3) => {
    const u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(n.dot(u)) > 0.9) u.set(0, 1, 0);
    u.sub(n.clone().multiplyScalar(n.dot(u))).normalize();
    const w = n.clone().cross(u);
    return [...S].sort((a, b) => {
      const pa = m.verts[a].clone().sub(c);
      const pb = m.verts[b].clone().sub(c);
      return Math.atan2(pa.dot(w), pa.dot(u)) - Math.atan2(pb.dot(w), pb.dot(u));
    });
  };
  let best = S;
  let bestArea = -1;
  for (const n of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
    const o = sortBy(n);
    const a = polyNormal(o.map((i) => m.verts[i]), new THREE.Vector3(), false).length();
    if (a > bestArea) {
      bestArea = a;
      best = o;
    }
  }
  const n = polyNormal(best.map((i) => m.verts[i]));
  return n.lengthSq() > 0.5 ? sortBy(n) : best;
}

/** Ausgewählte Punkte an einer Stelle zusammenführen */
export function mergeAt(m: EditMesh, vs: Set<number>, at: THREE.Vector3): Selection {
  if (vs.size < 2) return selFromVerts(m, vs);
  const target = Math.min(...vs);
  m.verts[target].copy(at);
  const map = new Int32Array(m.verts.length);
  for (let i = 0; i < map.length; i++) map[i] = vs.has(i) ? target : i;
  remapVerts(m, map);
  const nt = target - [...vs].filter((v) => v < target).length;
  return selFromVerts(m, [nt]);
}

/** Punkte nach Abstand zusammenführen; liefert die Anzahl entfernter Punkte */
export function mergeByDistance(m: EditMesh, vs: Set<number>, eps: number): number {
  return weld(m, eps, vs);
}

// ---------- Normalen ----------

export function flipFaces(m: EditMesh, fs: Iterable<number>): void {
  for (const fi of fs) m.faces[fi]?.v.reverse();
}

/** Flächen einheitlich ausrichten und nach außen drehen (je zusammenhängendem Teil) */
export function recalcNormals(m: EditMesh, only?: Set<number>, inside = false): void {
  const ef = m.edgeFaces();
  const seen = new Uint8Array(m.faces.length);
  const consider = (fi: number) => !only || only.has(fi);
  for (let s = 0; s < m.faces.length; s++) {
    if (seen[s] || !consider(s)) continue;
    const comp: number[] = [];
    const queue = [s];
    seen[s] = 1;
    while (queue.length) {
      const fi = queue.pop()!;
      comp.push(fi);
      const v = m.faces[fi].v;
      for (let i = 0; i < v.length; i++) {
        const a = v[i];
        const b = v[(i + 1) % v.length];
        for (const g of ef.get(ek(a, b)) ?? []) {
          if (g === fi || seen[g] || !consider(g)) continue;
          const gv = m.faces[g].v;
          const j = gv.indexOf(a);
          if (gv[(j + 1) % gv.length] === b) gv.reverse();
          seen[g] = 1;
          queue.push(g);
        }
      }
    }
    // Vorzeichen des Volumens bezogen auf den Schwerpunkt
    const c = new THREE.Vector3();
    let cnt = 0;
    for (const fi of comp) for (const v of m.faces[fi].v) (c.add(m.verts[v]), cnt++);
    c.divideScalar(Math.max(1, cnt));
    let vol = 0;
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    for (const fi of comp) {
      const v = m.faces[fi].v;
      p0.copy(m.verts[v[0]]).sub(c);
      for (let i = 1; i + 1 < v.length; i++) {
        p1.copy(m.verts[v[i]]).sub(c);
        p2.copy(m.verts[v[i + 1]]).sub(c);
        vol += p0.dot(p1.cross(p2));
      }
    }
    if (vol < 0 !== inside) for (const fi of comp) m.faces[fi].v.reverse();
  }
}

// ---------- Duplizieren, Trennen, Spiegeln ----------

export function duplicate(m: EditMesh, s: Selection): Selection {
  const map = new Map<number, number>();
  const nv = (v: number) => {
    let i = map.get(v);
    if (i === undefined) map.set(v, (i = m.addVert(m.verts[v])));
    return i;
  };
  for (const fi of s.f) m.addFace(m.faces[fi].v.map(nv), m.faces[fi].m);
  const ef = m.edgeFaces();
  for (const k of s.e) {
    const fs = ef.get(k) ?? [];
    if (fs.some((f) => s.f.has(f))) continue;
    m.edges.push([nv(ekA(k)), nv(ekB(k))]);
  }
  for (const v of s.v) nv(v);
  return selFromVerts(m, map.values());
}

/** Ausgewählte Flächen als eigenes Netz herauslösen */
export function separate(m: EditMesh, s: Selection): EditMesh | null {
  if (!s.f.size && !s.e.size) return null;
  const out = new EditMesh();
  const map = new Map<number, number>();
  const nv = (v: number) => {
    let i = map.get(v);
    if (i === undefined) map.set(v, (i = out.addVert(m.verts[v])));
    return i;
  };
  for (const fi of s.f) out.addFace(m.faces[fi].v.map(nv), m.faces[fi].m);
  const looseSel = m.edges.filter(([a, b]) => s.e.has(ek(a, b)));
  for (const [a, b] of looseSel) out.edges.push([nv(a), nv(b)]);
  deleteFaces(m, s.f);
  const loose = new Set(looseSel.map(([a, b]) => ek(a, b)));
  m.edges = m.edges.filter(([a, b]) => !loose.has(ek(a, b)));
  m.dropUnused(looseSel.flat());
  return out;
}

/** Ganzes Netz an einer Achse (lokaler Nullpunkt) spiegeln und mit dem Original verbinden */
export function mirrorMerge(m: EditMesh, axis: 0 | 1 | 2, eps = 1e-4): void {
  const copy = m.clone();
  const s = new THREE.Vector3(1, 1, 1).setComponent(axis, -1);
  copy.applyMatrix(new THREE.Matrix4().makeScale(s.x, s.y, s.z));
  const off = m.append(copy);
  const plane = new Set<number>();
  m.verts.forEach((p, i) => {
    if (Math.abs(p.getComponent(axis)) <= eps) {
      p.setComponent(axis, 0);
      plane.add(i);
    }
  });
  void off;
  weld(m, eps, plane);
  // doppelte Flächen in der Spiegelebene entfernen (Innenflächen)
  const count = new Map<string, number[]>();
  m.faces.forEach((f, i) => {
    const key = [...f.v].sort((a, b) => a - b).join(',');
    count.set(key, [...(count.get(key) ?? []), i]);
  });
  const drop = new Set<number>();
  for (const l of count.values()) if (l.length > 1) for (const i of l) drop.add(i);
  if (drop.size) m.faces = m.faces.filter((_, i) => !drop.has(i));
}

/** Auswahl an einer Achse durch `center` spiegeln (Punkte gespiegelt, gewählte Flächen umgedreht) */
export function mirrorSelection(m: EditMesh, s: Selection, axis: 0 | 1 | 2, center: THREE.Vector3): void {
  const c = center.getComponent(axis);
  for (const v of s.v) m.verts[v].setComponent(axis, 2 * c - m.verts[v].getComponent(axis));
  for (const fi of s.f) m.faces[fi].v.reverse();
}

/** Mittelpunkt (Median) der gewählten Punkte */
export function selCenter(m: EditMesh, s: Selection, out = new THREE.Vector3()): THREE.Vector3 {
  out.set(0, 0, 0);
  if (!s.v.size) return out;
  for (const v of s.v) out.add(m.verts[v]);
  return out.divideScalar(s.v.size);
}
