import * as THREE from 'three';
import type { PropValue } from '../mapFormat.ts';

// Spline-Kurven (Straßen, Leitplanken, Kabel …). Punkte liegen lokal zur Objektposition (Objekte ohne
// Drehung/Skalierung). Zwischen den Punkten: kubische Hermite-Kurve; Tangenten automatisch (Catmull-Rom) oder
// von Hand. Abgetastet wird gleichmäßig nach Bogenlänge, die Kontrollpunkte selbst sind immer Stützstellen.
// Kabel hängen stattdessen geradlinig mit parabelförmigem Durchhang zwischen den Punkten.

export type V3 = [number, number, number];

export interface SplinePoint {
  /** Position (lokal) */
  p: V3;
  /** Tangente von Hand (lokal, Länge = Stärke); fehlt = automatisch */
  t?: V3;
  /** Breiten-Faktor (Straße: × Breite) */
  w?: number;
  /** Querneigung (Grad) */
  roll?: number;
  /** Kabel: hängt an diesem Objekt (ID) … */
  a?: string;
  /** … mit diesem Versatz im lokalen Raum des Objekts */
  o?: V3;
}

export interface SplineSample {
  /** Position (lokal) */
  pos: THREE.Vector3;
  /** Richtung (Einheitsvektor) */
  tan: THREE.Vector3;
  /** rechts / oben (mit Querneigung) */
  right: THREE.Vector3;
  up: THREE.Vector3;
  /** Bogenlänge ab Start (m) */
  s: number;
  /** Breiten-Faktor */
  w: number;
  /** Kontrollpunkt-Index, falls die Stützstelle genau auf einem liegt */
  ctrl: number;
}

const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Punkte aus der Prop (JSON); ungültige Einträge werden übersprungen */
export function parsePoints(v: PropValue | undefined): SplinePoint[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const raw = JSON.parse(v) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: SplinePoint[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object' || !isV3((r as SplinePoint).p)) continue;
      const q = r as SplinePoint;
      const pt: SplinePoint = { p: [q.p[0], q.p[1], q.p[2]] };
      if (isV3(q.t)) pt.t = [q.t[0], q.t[1], q.t[2]];
      if (typeof q.w === 'number' && q.w > 0) pt.w = q.w;
      if (typeof q.roll === 'number' && q.roll) pt.roll = q.roll;
      if (typeof q.a === 'string' && q.a) {
        pt.a = q.a;
        if (isV3(q.o)) pt.o = [q.o[0], q.o[1], q.o[2]];
      }
      out.push(pt);
    }
    return out;
  } catch {
    return [];
  }
}

/** Punkte als Prop-Wert (gerundet, damit das Map-JSON klein bleibt) */
export function stringifyPoints(pts: SplinePoint[]): string {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const v = (a: V3): V3 => [r(a[0]), r(a[1]), r(a[2])];
  return JSON.stringify(
    pts.map((p) => {
      const o: SplinePoint = { p: v(p.p) };
      if (p.t) o.t = v(p.t);
      if (p.w !== undefined && p.w !== 1) o.w = r(p.w);
      if (p.roll) o.roll = r(p.roll);
      if (p.a) {
        o.a = p.a;
        if (p.o) o.o = v(p.o);
      }
      return o;
    }),
  );
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ta = new THREE.Vector3();
const _tb = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

export class SplineCurve {
  readonly pts: SplinePoint[];
  readonly closed: boolean;

  constructor(pts: SplinePoint[], closed = false) {
    this.pts = pts;
    this.closed = closed && pts.length > 2;
  }

  get segments(): number {
    const n = this.pts.length;
    return n < 2 ? 0 : this.closed ? n : n - 1;
  }

  private P(i: number, out: THREE.Vector3): THREE.Vector3 {
    const n = this.pts.length;
    const p = this.pts[this.closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))].p;
    return out.set(p[0], p[1], p[2]);
  }

  /** Tangente am Punkt i (Hermite-Ableitung, Länge ≈ Segmentlänge) */
  tangent(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    const n = this.pts.length;
    const idx = this.closed ? ((i % n) + n) % n : i;
    const t = this.pts[idx]?.t;
    if (t) return out.set(t[0], t[1], t[2]);
    if (n < 2) return out.set(0, 0, 1);
    if (!this.closed && idx === 0) return this.P(1, out).sub(this.P(0, _a));
    if (!this.closed && idx === n - 1) return this.P(n - 1, out).sub(this.P(n - 2, _a));
    return this.P(idx + 1, out).sub(this.P(idx - 1, _a)).multiplyScalar(0.5);
  }

  /** Position auf Segment `seg` bei u ∈ [0, 1] */
  point(seg: number, u: number, out = new THREE.Vector3()): THREE.Vector3 {
    const p0 = this.P(seg, _a);
    const p1 = this.P(seg + 1, _b);
    const m0 = this.tangent(seg, _ta);
    const m1 = this.tangent(seg + 1, _tb);
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    return out.set(
      h00 * p0.x + h10 * m0.x + h01 * p1.x + h11 * m1.x,
      h00 * p0.y + h10 * m0.y + h01 * p1.y + h11 * m1.y,
      h00 * p0.z + h10 * m0.z + h01 * p1.z + h11 * m1.z,
    );
  }

  /** Ableitung auf Segment `seg` bei u */
  deriv(seg: number, u: number, out = new THREE.Vector3()): THREE.Vector3 {
    const p0 = this.P(seg, _a);
    const p1 = this.P(seg + 1, _b);
    const m0 = this.tangent(seg, _ta);
    const m1 = this.tangent(seg + 1, _tb);
    const u2 = u * u;
    const d00 = 6 * u2 - 6 * u;
    const d10 = 3 * u2 - 4 * u + 1;
    const d01 = -6 * u2 + 6 * u;
    const d11 = 3 * u2 - 2 * u;
    return out.set(
      d00 * p0.x + d10 * m0.x + d01 * p1.x + d11 * m1.x,
      d00 * p0.y + d10 * m0.y + d01 * p1.y + d11 * m1.y,
      d00 * p0.z + d10 * m0.z + d01 * p1.z + d11 * m1.z,
    );
  }

  /** Bogenlänge eines Segments + Tabelle u → s (32 Schritte) */
  private table(seg: number): Float32Array {
    const N = 32;
    const t = new Float32Array(N + 1);
    const prev = this.point(seg, 0, new THREE.Vector3());
    const cur = new THREE.Vector3();
    for (let i = 1; i <= N; i++) {
      this.point(seg, i / N, cur);
      t[i] = t[i - 1] + cur.distanceTo(prev);
      prev.copy(cur);
    }
    return t;
  }

  /** Gesamtlänge (m) */
  length(): number {
    let s = 0;
    for (let i = 0; i < this.segments; i++) {
      const t = this.table(i);
      s += t[t.length - 1];
    }
    return s;
  }

  /** Stützstellen im Abstand ≈ step (m), Kontrollpunkte eingeschlossen */
  sample(step: number): SplineSample[] {
    const out: SplineSample[] = [];
    const n = this.pts.length;
    if (n === 0) return out;
    if (n === 1) {
      const p = this.pts[0];
      out.push({ pos: new THREE.Vector3(...p.p), tan: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(1, 0, 0), up: Y.clone(), s: 0, w: p.w ?? 1, ctrl: 0 });
      return out;
    }
    let s0 = 0;
    for (let seg = 0; seg < this.segments; seg++) {
      const tab = this.table(seg);
      const len = tab[tab.length - 1];
      const k = Math.max(1, Math.ceil(len / Math.max(0.05, step)));
      const pa = this.pts[seg % n];
      const pb = this.pts[(seg + 1) % n];
      for (let j = seg === 0 ? 0 : 1; j <= k; j++) {
        // u zur Bogenlänge j/k · len
        const target = (j / k) * len;
        let lo = 0;
        while (lo < tab.length - 2 && tab[lo + 1] < target) lo++;
        const span = tab[lo + 1] - tab[lo];
        const u = Math.min(1, (lo + (span > 1e-9 ? (target - tab[lo]) / span : 0)) / (tab.length - 1));
        const f = u * u * (3 - 2 * u);
        const pos = this.point(seg, u, new THREE.Vector3());
        const tan = this.deriv(seg, u, new THREE.Vector3());
        if (tan.lengthSq() < 1e-10) tan.subVectors(this.P(seg + 1, _b), this.P(seg, _a));
        tan.normalize();
        const roll = THREE.MathUtils.degToRad((pa.roll ?? 0) * (1 - f) + (pb.roll ?? 0) * f);
        const { right, up } = frame(tan, roll);
        const ctrl = j === 0 ? seg : j === k ? (seg + 1) % n : -1;
        out.push({ pos, tan, right, up, s: s0 + target, w: (pa.w ?? 1) * (1 - f) + (pb.w ?? 1) * f, ctrl });
      }
      s0 += len;
    }
    return out;
  }

  /** nächster Punkt auf der Kurve zu p (lokal): Segment, u, Abstand */
  nearest(p: THREE.Vector3, steps = 24): { seg: number; u: number; dist: number; pos: THREE.Vector3 } | null {
    let best: { seg: number; u: number; dist: number; pos: THREE.Vector3 } | null = null;
    const q = new THREE.Vector3();
    for (let seg = 0; seg < this.segments; seg++)
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        this.point(seg, u, q);
        const d = q.distanceTo(p);
        if (!best || d < best.dist) best = { seg, u, dist: d, pos: q.clone() };
      }
    return best;
  }
}

/** rechts/oben zu einer Richtung (Welt-Y als Bezug) mit Querneigung */
export function frame(tan: THREE.Vector3, roll = 0): { right: THREE.Vector3; up: THREE.Vector3 } {
  const right = new THREE.Vector3().crossVectors(tan, Y);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(right, tan).normalize();
  if (roll) {
    right.applyAxisAngle(tan, roll);
    up.applyAxisAngle(tan, roll);
  }
  return { right, up };
}

/**
 * Kabel: gerade zwischen den Punkten mit Durchhang (Anteil der waagrechten Spannweite, z. B. 0.03 = 3 %).
 * Liefert Stützstellen (lokal) im Abstand ≈ step.
 */
export function sampleCable(pts: SplinePoint[], sag: number, step: number, closed = false): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const n = pts.length;
  if (n < 2) return n ? [new THREE.Vector3(...pts[0].p)] : out;
  const segs = closed && n > 2 ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = new THREE.Vector3(...pts[i].p);
    const b = new THREE.Vector3(...pts[(i + 1) % n].p);
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const len = a.distanceTo(b);
    const k = Math.max(2, Math.ceil(len / step));
    const drop = sag * span;
    for (let j = i === 0 ? 0 : 1; j <= k; j++) {
      const u = j / k;
      const p = a.clone().lerp(b, u);
      p.y -= drop * 4 * u * (1 - u);
      out.push(p);
    }
  }
  return out;
}

/** Richtungen und Bogenlängen einer Polylinie (für Röhren) */
export function polylineFrames(pts: THREE.Vector3[]): SplineSample[] {
  const out: SplineSample[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const tan = new THREE.Vector3().subVectors(next, prev);
    if (tan.lengthSq() < 1e-12) tan.set(0, 0, 1);
    tan.normalize();
    if (i > 0) s += pts[i].distanceTo(pts[i - 1]);
    const { right, up } = frame(tan);
    out.push({ pos: pts[i], tan, right, up, s, w: 1, ctrl: -1 });
  }
  return out;
}
