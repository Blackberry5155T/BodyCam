import * as THREE from 'three';
import type { SplineSample } from './curve.ts';

// Geometrie entlang von Splines: Straßenband, Fahrbahnmarkierungen, extrudierte Profile (Leitplanke, Mauer,
// Zaun), Röhren (Kabel, Rohre) und Dreiecksnetze für die Kollision. Alles in lokalen Koordinaten des Objekts.

/** Seitlicher Versatz einer Stützstelle: frac · halbe Breite · w + delta (m) */
export interface Lateral {
  frac: number;
  delta: number;
}

const lat = (s: SplineSample, half: number, l: Lateral) => l.frac * half * s.w + l.delta;

/**
 * Straßenband: 5 Spalten über die Breite + Schürze an beiden Rändern (verdeckt Spalten zum Gelände).
 * UV in Metern / texScale (u quer, v entlang).
 */
export function roadGeometry(samples: SplineSample[], half: number, texScale: number, skirt = 0.5): THREE.BufferGeometry {
  const cols: { l: Lateral; down: number }[] = [
    { l: { frac: -1, delta: -0.04 }, down: skirt },
    { l: { frac: -1, delta: 0 }, down: 0 },
    { l: { frac: -0.5, delta: 0 }, down: 0 },
    { l: { frac: 0, delta: 0 }, down: 0 },
    { l: { frac: 0.5, delta: 0 }, down: 0 },
    { l: { frac: 1, delta: 0 }, down: 0 },
    { l: { frac: 1, delta: 0.04 }, down: skirt },
  ];
  const C = cols.length;
  const n = samples.length;
  const pos = new Float32Array(n * C * 3);
  const uv = new Float32Array(n * C * 2);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    for (let c = 0; c < C; c++) {
      const col = cols[c];
      const x = lat(s, half, col.l);
      v.copy(s.pos).addScaledVector(s.right, x).addScaledVector(s.up, -col.down);
      const k = i * C + c;
      pos.set([v.x, v.y, v.z], k * 3);
      uv[k * 2] = (x + (col.down ? Math.sign(x) * col.down : 0)) / texScale;
      uv[k * 2 + 1] = s.s / texScale;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++)
    for (let c = 0; c < C - 1; c++) {
      const a = i * C + c;
      const b = a + 1;
      const cc = a + C;
      const d = cc + 1;
      idx.push(a, b, cc, b, d, cc);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export interface Strip {
  l: Lateral;
  width: number;
  /** gestrichelt: [Strich, Lücke] in m */
  dash?: [number, number];
}

/** Markierungsstreifen (leicht über der Fahrbahn) */
export function stripGeometry(samples: SplineSample[], half: number, strips: Strip[], lift = 0.012): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const idx: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const corner = (s: SplineSample, x: number, out: THREE.Vector3) => out.copy(s.pos).addScaledVector(s.right, x).addScaledVector(s.up, lift);
  for (const st of strips) {
    for (let i = 0; i < samples.length - 1; i++) {
      const s0 = samples[i];
      const s1 = samples[i + 1];
      if (st.dash) {
        const period = st.dash[0] + st.dash[1];
        const mid = (s0.s + s1.s) / 2;
        if (mid % period > st.dash[0]) continue;
      }
      const base = pos.length / 3;
      for (const s of [s0, s1]) {
        const x = lat(s, half, st.l);
        corner(s, x - st.width / 2, a);
        corner(s, x + st.width / 2, b);
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Profilpunkt: x seitlich (rechts), y nach oben; `l` = seitlicher Bezug (Straßenrand) */
export interface ProfilePoint {
  x: number;
  y: number;
}

export interface ExtrudeOptions {
  /** seitlicher Bezug des Profils (Standard: Mittellinie) */
  l?: Lateral;
  half?: number;
  /** Profil geschlossen (letzter → erster Punkt) */
  closed?: boolean;
  /** Endkappen (nur geschlossene, konvexe Profile) */
  caps?: boolean;
  /** Textur-Kachel (m) */
  texScale?: number;
  /** harte Kanten zwischen Profil-Abschnitten (Mauer) statt glatt (Rohr) */
  hard?: boolean;
}

/**
 * Profil entlang der Stützstellen extrudieren. UV: u entlang des Profils, v entlang der Kurve (m / texScale).
 * Mit `hard` bekommt jeder Profil-Abschnitt eigene Vertices (scharfe Kanten).
 */
export function extrudeProfile(samples: SplineSample[], profile: ProfilePoint[], o: ExtrudeOptions = {}): THREE.BufferGeometry {
  const half = o.half ?? 0;
  const l = o.l ?? { frac: 0, delta: 0 };
  const ts = o.texScale ?? 1;
  const P = profile.length;
  const edges = o.closed ? P : P - 1;
  // Profil-Abschnitte → Spalten
  const cols: { x: number; y: number; u: number }[][] = [];
  let u = 0;
  if (o.hard) {
    for (let e = 0; e < edges; e++) {
      const p0 = profile[e];
      const p1 = profile[(e + 1) % P];
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      cols.push([
        { x: p0.x, y: p0.y, u },
        { x: p1.x, y: p1.y, u: u + len },
      ]);
      u += len;
    }
  } else {
    const col: { x: number; y: number; u: number }[] = [];
    for (let e = 0; e <= edges; e++) {
      const p = profile[e % P];
      if (e > 0) {
        const q = profile[e - 1];
        u += Math.hypot(p.x - q.x, p.y - q.y);
      }
      col.push({ x: p.x, y: p.y, u });
    }
    cols.push(col);
  }
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  const n = samples.length;
  for (const col of cols) {
    const base = pos.length / 3;
    const C = col.length;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const off = lat(s, half, l);
      for (const c of col) {
        v.copy(s.pos).addScaledVector(s.right, off + c.x).addScaledVector(s.up, c.y);
        pos.push(v.x, v.y, v.z);
        uv.push(c.u / ts, s.s / ts);
      }
    }
    for (let i = 0; i < n - 1; i++)
      for (let c = 0; c < C - 1; c++) {
        const a = base + i * C + c;
        const b = a + 1;
        const cc = a + C;
        const d = cc + 1;
        // Profil gegen den Uhrzeigersinn (von hinten gesehen) → Außenseite
        idx.push(a, cc, b, b, cc, d);
      }
  }
  if (o.caps && o.closed && n > 1) {
    for (const [s, flip] of [
      [samples[0], true],
      [samples[n - 1], false],
    ] as const) {
      const base = pos.length / 3;
      const off = lat(s, half, l);
      for (const p of profile) {
        v.copy(s.pos).addScaledVector(s.right, off + p.x).addScaledVector(s.up, p.y);
        pos.push(v.x, v.y, v.z);
        uv.push(p.x / ts, p.y / ts);
      }
      for (let k = 1; k < P - 1; k++) {
        if (flip) idx.push(base, base + k, base + k + 1);
        else idx.push(base, base + k + 1, base + k);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Röhre entlang einer Polylinie (Parallel-Transport, kein Verdrehen an senkrechten Stellen) */
export function tubeGeometry(pts: THREE.Vector3[], radius: number, radial: number, texScale = 1): THREE.BufferGeometry {
  const n = pts.length;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  if (n < 2) return new THREE.BufferGeometry();
  const tan = new THREE.Vector3();
  const prevTan = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const bin = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const d = new THREE.Vector3();
  let s = 0;
  for (let i = 0; i < n; i++) {
    tan.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]);
    if (tan.lengthSq() < 1e-12) tan.copy(prevTan.lengthSq() ? prevTan : new THREE.Vector3(0, 0, 1));
    tan.normalize();
    if (i === 0) {
      // Start-Normale: möglichst „oben“
      nrm.set(0, 1, 0);
      if (Math.abs(tan.dot(nrm)) > 0.9) nrm.set(1, 0, 0);
      nrm.addScaledVector(tan, -tan.dot(nrm)).normalize();
    } else {
      q.setFromUnitVectors(prevTan, tan);
      nrm.applyQuaternion(q);
      nrm.addScaledVector(tan, -tan.dot(nrm)).normalize();
      s += pts[i].distanceTo(pts[i - 1]);
    }
    bin.crossVectors(tan, nrm);
    for (let r = 0; r <= radial; r++) {
      const a = (r / radial) * Math.PI * 2;
      d.copy(nrm).multiplyScalar(Math.cos(a)).addScaledVector(bin, Math.sin(a));
      pos.push(pts[i].x + d.x * radius, pts[i].y + d.y * radius, pts[i].z + d.z * radius);
      nor.push(d.x, d.y, d.z);
      uv.push(r / radial, s / texScale);
    }
    prevTan.copy(tan);
  }
  const R = radial + 1;
  for (let i = 0; i < n - 1; i++)
    for (let r = 0; r < radial; r++) {
      const a = i * R + r;
      const b = a + 1;
      const c = a + R;
      const e = c + 1;
      idx.push(a, b, c, b, e, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Dreiecksnetz einer Geometrie in Weltkoordinaten (für TrimeshCollider) */
export function worldTrimesh(g: THREE.BufferGeometry, m: THREE.Matrix4): { vertices: Float32Array; indices: Uint32Array; minY: number; maxY: number } | null {
  const p = g.getAttribute('position');
  const ix = g.getIndex();
  if (!p || !ix || !ix.count) return null;
  const vertices = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(m);
    vertices[i * 3] = v.x;
    vertices[i * 3 + 1] = v.y;
    vertices[i * 3 + 2] = v.z;
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  return { vertices, indices: new Uint32Array(ix.array), minY, maxY };
}

/** Rahmen an Bogenlänge s (lineare Interpolation zwischen Stützstellen) */
export function frameAt(samples: SplineSample[], s: number, out: { pos: THREE.Vector3; tan: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 }): void {
  const n = samples.length;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (samples[m].s <= s) lo = m;
    else hi = m;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.s - a.s;
  const f = span > 1e-9 ? Math.min(1, Math.max(0, (s - a.s) / span)) : 0;
  out.pos.lerpVectors(a.pos, b.pos, f);
  // außerhalb (Modell länger als Kurve): geradeaus weiter
  if (s < samples[0].s) out.pos.addScaledVector(samples[0].tan, s - samples[0].s);
  else if (s > samples[n - 1].s) out.pos.addScaledVector(samples[n - 1].tan, s - samples[n - 1].s);
  out.tan.lerpVectors(a.tan, b.tan, f).normalize();
  out.right.lerpVectors(a.right, b.right, f).normalize();
  out.up.lerpVectors(a.up, b.up, f).normalize();
}
