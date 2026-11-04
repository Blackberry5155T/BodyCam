import * as THREE from 'three';
import type { Collider, HeightfieldCollider } from './collision.ts';

// Kollision für CPU-Partikel (Feuer, Rauch, Funken) gegen die Map-Collider.
// Bewusst ohne Rapier: analytische Tests Kugel ↔ Box / gedrehte Box / Zylinder / Höhenfeld. Das läuft
// damit auch im Editor (dort gibt es keine Physik-Welt) und kostet pro Partikel nur ein paar Vergleiche:
// jeder Effekt sammelt periodisch nur die Collider rund um seine Partikel (Hülle + Rand).
// Dreiecksnetze (Landscape-Komponenten mit Löchern) werden ignoriert.

const enum Kind {
  Box,
  Cyl,
  Height,
}

interface Shape {
  kind: Kind;
  /** achsenparallele Hülle (Welt) */
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  /** Box/Zylinder: Mitte, Halbachsen (Zylinder: hx = Radius, hy = halbe Höhe) */
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  /** Rotation der Box (Spalten = lokale Achsen in Welt, column-major wie Matrix3), null = achsenparallel */
  m: Float32Array | null;
  hf: HeightfieldCollider | null;
}

/** Quelle der Collider (Spiel: level.colliders, Editor: aus den Knoten gesammelt) */
export const particleWorld = {
  colliders: [] as readonly Collider[],
  /** unsichtbarer Boden bei y = 0 */
  groundPlane: false,
};

const shapeCache = new WeakMap<Collider, Shape | null>();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3(0, 1, 0);

function boxShape(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, q: THREE.Quaternion | null): Shape {
  let m: Float32Array | null = null;
  let ex = hx, ey = hy, ez = hz;
  if (q) {
    const e = _m4.makeRotationFromQuaternion(q).elements;
    m = new Float32Array([e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]]);
    // Hülle: |R| · h (Zeile r, Spalte c = m[c * 3 + r])
    ex = Math.abs(m[0]) * hx + Math.abs(m[3]) * hy + Math.abs(m[6]) * hz;
    ey = Math.abs(m[1]) * hx + Math.abs(m[4]) * hy + Math.abs(m[7]) * hz;
    ez = Math.abs(m[2]) * hx + Math.abs(m[5]) * hy + Math.abs(m[8]) * hz;
  }
  return { kind: Kind.Box, x0: cx - ex, y0: cy - ey, z0: cz - ez, x1: cx + ex, y1: cy + ey, z1: cz + ez, cx, cy, cz, hx, hy, hz, m, hf: null };
}

function toShape(c: Collider): Shape | null {
  let s = shapeCache.get(c);
  if (s !== undefined) return s;
  switch (c.type) {
    case 'box':
      s = boxShape((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2, (c.max.x - c.min.x) / 2, (c.max.y - c.min.y) / 2, (c.max.z - c.min.z) / 2, null);
      break;
    case 'obox':
      s = boxShape(c.center.x, c.center.y, c.center.z, c.half.x, c.half.y, c.half.z, Math.abs(c.yaw) < 1e-5 ? null : _q.setFromAxisAngle(_axis, c.yaw));
      break;
    case 'rbox':
      s = boxShape(c.center.x, c.center.y, c.center.z, c.half.x, c.half.y, c.half.z, c.quat);
      break;
    case 'cylinder': {
      const hy = (c.maxY - c.minY) / 2;
      s = {
        kind: Kind.Cyl,
        x0: c.center.x - c.radius,
        y0: c.minY,
        z0: c.center.y - c.radius,
        x1: c.center.x + c.radius,
        y1: c.maxY,
        z1: c.center.y + c.radius,
        cx: c.center.x,
        cy: c.minY + hy,
        cz: c.center.y,
        hx: c.radius,
        hy,
        hz: c.radius,
        m: null,
        hf: null,
      };
      break;
    }
    case 'heightfield':
      s = {
        kind: Kind.Height,
        x0: c.center.x - c.sizeX / 2,
        y0: c.minY - 1.5,
        z0: c.center.z - c.sizeZ / 2,
        x1: c.center.x + c.sizeX / 2,
        y1: c.maxY,
        z1: c.center.z + c.sizeZ / 2,
        cx: c.center.x,
        cy: c.center.y,
        cz: c.center.z,
        hx: c.sizeX / 2,
        hy: 0,
        hz: c.sizeZ / 2,
        m: null,
        hf: c,
      };
      break;
    default:
      s = null;
  }
  shapeCache.set(c, s);
  return s;
}

/** liegt p klar im Inneren (Emitter steckt im Objekt, z. B. Feuer in einer Tonne → Objekt ignorieren) */
function contains(s: Shape, x: number, y: number, z: number): boolean {
  const inset = 0.03;
  if (s.kind === Kind.Height) return false;
  if (s.kind === Kind.Cyl) return Math.hypot(x - s.cx, z - s.cz) < s.hx - inset && Math.abs(y - s.cy) < s.hy - inset;
  const dx = x - s.cx, dy = y - s.cy, dz = z - s.cz;
  const m = s.m;
  const lx = m ? m[0] * dx + m[1] * dy + m[2] * dz : dx;
  const ly = m ? m[3] * dx + m[4] * dy + m[5] * dz : dy;
  const lz = m ? m[6] * dx + m[7] * dy + m[8] * dz : dz;
  return Math.abs(lx) < s.hx - inset && Math.abs(ly) < s.hy - inset && Math.abs(lz) < s.hz - inset;
}

/** Box-Form eines Colliders (Mitte, Halbachsen, Rotation: Spalten = lokale Achsen in Welt, column-major) */
export interface BoxShape {
  /** achsenparallele Hülle */
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly m: Float32Array | null;
}

/** Box-förmige Collider in einem Bereich (Zylinder als umschließende Box, Höhenfelder ausgelassen) –
 *  für die Verdeckung von Lichtkegeln. skipInside: Boxen, die diesen Punkt enthalten, auslassen. */
export function boxesInRegion(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, skipInside?: THREE.Vector3): BoxShape[] {
  const out: BoxShape[] = [];
  for (const c of particleWorld.colliders) {
    const s = toShape(c);
    if (!s || s.kind === Kind.Height) continue;
    if (s.x1 < x0 || s.x0 > x1 || s.y1 < y0 || s.y0 > y1 || s.z1 < z0 || s.z0 > z1) continue;
    if (skipInside && contains(s, skipInside.x, skipInside.y, skipInside.z)) continue;
    out.push(s);
  }
  return out;
}

/** Wird die Strecke a → b von einer der Boxen verdeckt? Zählt nur eine echte Durchquerung (> minLen),
 *  damit Licht bündig an einer Fläche (Deckenlampe) oder Punkte direkt an Wänden nicht verdunkelt werden. */
export function segmentBlocked(ax: number, ay: number, az: number, bx: number, by: number, bz: number, boxes: readonly BoxShape[], minLen = 0.03): boolean {
  const sx0 = Math.min(ax, bx), sy0 = Math.min(ay, by), sz0 = Math.min(az, bz);
  const sx1 = Math.max(ax, bx), sy1 = Math.max(ay, by), sz1 = Math.max(az, bz);
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  if (len <= minLen) return false;
  outer: for (let k = 0; k < boxes.length; k++) {
    const s = boxes[k];
    if (sx1 < s.x0 || sx0 > s.x1 || sy1 < s.y0 || sy0 > s.y1 || sz1 < s.z0 || sz0 > s.z1) continue;
    const m = s.m;
    const pax = ax - s.cx, pay = ay - s.cy, paz = az - s.cz;
    const pbx = bx - s.cx, pby = by - s.cy, pbz = bz - s.cz;
    let en = 0, ex = 1;
    for (let c = 0; c < 3; c++) {
      // Koordinate entlang der lokalen Achse c (Spalte c von m)
      let oa: number, ob: number;
      if (m) {
        const i = c * 3;
        oa = m[i] * pax + m[i + 1] * pay + m[i + 2] * paz;
        ob = m[i] * pbx + m[i + 1] * pby + m[i + 2] * pbz;
      } else {
        oa = c === 0 ? pax : c === 1 ? pay : paz;
        ob = c === 0 ? pbx : c === 1 ? pby : pbz;
      }
      const h = c === 0 ? s.hx : c === 1 ? s.hy : s.hz;
      const d = ob - oa;
      if (Math.abs(d) < 1e-9) {
        if (Math.abs(oa) > h) continue outer;
        continue;
      }
      let t0 = (-h - oa) / d, t1 = (h - oa) / d;
      if (t0 > t1) {
        const tmp = t0;
        t0 = t1;
        t1 = tmp;
      }
      if (t0 > en) en = t0;
      if (t1 < ex) ex = t1;
      if (en >= ex) continue outer;
    }
    if ((ex - en) * len > minLen) return true;
  }
  return false;
}

/** Merkt sich die Collider-Liste und meldet, ob sie sich seitdem geändert hat (Länge oder Einträge) */
export class ColliderWatch {
  private list: readonly Collider[] | null = null;
  private snap: Collider[] = [];
  changed(): boolean {
    const l = particleWorld.colliders;
    let diff = l !== this.list || l.length !== this.snap.length;
    if (!diff) {
      for (let i = 0; i < l.length; i++) {
        if (l[i] !== this.snap[i]) {
          diff = true;
          break;
        }
      }
    }
    if (diff) {
      this.list = l;
      this.snap = l.slice();
    }
    return diff;
  }
}

// Ergebnis der Einzeltests (Position und Normale), vermeidet Allokationen
let PX = 0, PY = 0, PZ = 0, NX = 0, NY = 0, NZ = 0;

function pushBox(s: Shape, r: number): boolean {
  const dx = PX - s.cx, dy = PY - s.cy, dz = PZ - s.cz;
  const m = s.m;
  let lx = m ? m[0] * dx + m[1] * dy + m[2] * dz : dx;
  let ly = m ? m[3] * dx + m[4] * dy + m[5] * dz : dy;
  let lz = m ? m[6] * dx + m[7] * dy + m[8] * dz : dz;
  const qx = Math.max(-s.hx, Math.min(s.hx, lx));
  const qy = Math.max(-s.hy, Math.min(s.hy, ly));
  const qz = Math.max(-s.hz, Math.min(s.hz, lz));
  const ox = lx - qx, oy = ly - qy, oz = lz - qz;
  const d2 = ox * ox + oy * oy + oz * oz;
  let nx = 0, ny = 0, nz = 0;
  if (d2 > 1e-12) {
    if (d2 >= r * r) return false;
    const d = Math.sqrt(d2);
    nx = ox / d;
    ny = oy / d;
    nz = oz / d;
    lx = qx + nx * r;
    ly = qy + ny * r;
    lz = qz + nz * r;
  } else {
    // Mittelpunkt steckt in der Box: über die nächste Seite hinaus
    const px = s.hx - Math.abs(lx), py = s.hy - Math.abs(ly), pz = s.hz - Math.abs(lz);
    if (px <= py && px <= pz) {
      nx = lx < 0 ? -1 : 1;
      lx = nx * (s.hx + r);
    } else if (py <= pz) {
      ny = ly < 0 ? -1 : 1;
      ly = ny * (s.hy + r);
    } else {
      nz = lz < 0 ? -1 : 1;
      lz = nz * (s.hz + r);
    }
  }
  if (m) {
    PX = s.cx + m[0] * lx + m[3] * ly + m[6] * lz;
    PY = s.cy + m[1] * lx + m[4] * ly + m[7] * lz;
    PZ = s.cz + m[2] * lx + m[5] * ly + m[8] * lz;
    NX = m[0] * nx + m[3] * ny + m[6] * nz;
    NY = m[1] * nx + m[4] * ny + m[7] * nz;
    NZ = m[2] * nx + m[5] * ny + m[8] * nz;
  } else {
    PX = s.cx + lx;
    PY = s.cy + ly;
    PZ = s.cz + lz;
    NX = nx;
    NY = ny;
    NZ = nz;
  }
  return true;
}

function pushCylinder(s: Shape, r: number): boolean {
  const dx = PX - s.cx, dz = PZ - s.cz;
  const rd = Math.hypot(dx, dz);
  const R = s.hx;
  const qx = rd > R ? s.cx + (dx / rd) * R : PX;
  const qz = rd > R ? s.cz + (dz / rd) * R : PZ;
  const qy = Math.max(s.cy - s.hy, Math.min(s.cy + s.hy, PY));
  const ox = PX - qx, oy = PY - qy, oz = PZ - qz;
  const d2 = ox * ox + oy * oy + oz * oz;
  if (d2 > 1e-12) {
    if (d2 >= r * r) return false;
    const d = Math.sqrt(d2);
    NX = ox / d;
    NY = oy / d;
    NZ = oz / d;
    PX = qx + NX * r;
    PY = qy + NY * r;
    PZ = qz + NZ * r;
    return true;
  }
  const pr = R - rd, pt = s.cy + s.hy - PY, pb = PY - (s.cy - s.hy);
  if (pr <= pt && pr <= pb) {
    const ux = rd > 1e-5 ? dx / rd : 1, uz = rd > 1e-5 ? dz / rd : 0;
    NX = ux;
    NY = 0;
    NZ = uz;
    PX = s.cx + ux * (R + r);
    PZ = s.cz + uz * (R + r);
  } else if (pt <= pb) {
    NX = NZ = 0;
    NY = 1;
    PY = s.cy + s.hy + r;
  } else {
    NX = NZ = 0;
    NY = -1;
    PY = s.cy - s.hy - r;
  }
  return true;
}

function pushHeightfield(s: Shape, r: number): boolean {
  const hf = s.hf!;
  const cw = hf.sizeX / hf.cols, ch = hf.sizeZ / hf.rows;
  const fx = (PX - s.x0) / cw, fz = (PZ - s.z0) / ch;
  if (fx < 0 || fz < 0 || fx > hf.cols || fz > hf.rows) return false;
  const ix = Math.min(hf.cols - 1, Math.floor(fx)), iz = Math.min(hf.rows - 1, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz;
  // Höhen spaltenweise: h[x · (rows + 1) + z]
  const R1 = hf.rows + 1;
  const H = hf.heights;
  const h00 = H[ix * R1 + iz], h10 = H[(ix + 1) * R1 + iz], h01 = H[ix * R1 + iz + 1], h11 = H[(ix + 1) * R1 + iz + 1];
  const h = s.cy + (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  // deutlich darunter (Höhle, Tunnel) → keine Kollision
  if (PY - r >= h || PY < h - 1.5) return false;
  PY = h + r;
  const gx = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) / cw;
  const gz = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) / ch;
  const l = Math.hypot(gx, 1, gz);
  NX = -gx / l;
  NY = 1 / l;
  NZ = -gz / l;
  return true;
}

/** Geschwindigkeit an einer Kontaktnormalen auflösen: Anteil in die Wand → abprallen (bounce), tangential bremsen */
export function collideVelocity(v: Float32Array, i: number, n: THREE.Vector3, bounce: number, friction: number): void {
  const vn = v[i] * n.x + v[i + 1] * n.y + v[i + 2] * n.z;
  if (vn < 0) {
    const k = (1 + bounce) * vn;
    v[i] -= k * n.x;
    v[i + 1] -= k * n.y;
    v[i + 2] -= k * n.z;
  }
  if (friction > 0) {
    const vn2 = v[i] * n.x + v[i + 1] * n.y + v[i + 2] * n.z;
    const f = 1 - friction;
    v[i] = vn2 * n.x + (v[i] - vn2 * n.x) * f;
    v[i + 1] = vn2 * n.y + (v[i + 1] - vn2 * n.y) * f;
    v[i + 2] = vn2 * n.z + (v[i + 2] - vn2 * n.z) * f;
  }
}

const REFRESH = 0.3; // s
const MARGIN = 1.8; // m um die Partikelhülle

/** Collider-Ausschnitt für einen Effekt. Pro Frame: refresh() einmal, dann track()/resolve() je Partikel. */
export class ParticleCollider {
  private shapes: Shape[] = [];
  private ground = false;
  private timer = Infinity;
  private lastList: readonly Collider[] | null = null;
  private lastLen = -1;
  // Hülle der Partikel (aktueller und letzter Frame)
  private bx0 = Infinity;
  private by0 = Infinity;
  private bz0 = Infinity;
  private bx1 = -Infinity;
  private by1 = -Infinity;
  private bz1 = -Infinity;
  private px0 = 0;
  private py0 = 0;
  private pz0 = 0;
  private px1 = 0;
  private py1 = 0;
  private pz1 = 0;

  /** true, wenn überhaupt etwas zum Kollidieren da ist */
  get active(): boolean {
    return this.shapes.length > 0 || this.ground;
  }

  /** Vor der Simulation aufrufen. emitter/reach: Bereich, in dem neue Partikel entstehen */
  refresh(dt: number, emitter: THREE.Vector3, reach: number): void {
    // Hülle des letzten Frames übernehmen (inkl. Emitterbereich)
    this.px0 = Math.min(this.bx0, emitter.x - reach);
    this.py0 = Math.min(this.by0, emitter.y - reach);
    this.pz0 = Math.min(this.bz0, emitter.z - reach);
    this.px1 = Math.max(this.bx1, emitter.x + reach);
    this.py1 = Math.max(this.by1, emitter.y + reach);
    this.pz1 = Math.max(this.bz1, emitter.z + reach);
    this.bx0 = this.by0 = this.bz0 = Infinity;
    this.bx1 = this.by1 = this.bz1 = -Infinity;

    const list = particleWorld.colliders;
    this.ground = particleWorld.groundPlane;
    this.timer += dt;
    if (this.timer < REFRESH && list === this.lastList && list.length === this.lastLen) return;
    this.timer = 0;
    this.lastList = list;
    this.lastLen = list.length;
    const x0 = this.px0 - MARGIN, y0 = this.py0 - MARGIN, z0 = this.pz0 - MARGIN;
    const x1 = this.px1 + MARGIN, y1 = this.py1 + MARGIN, z1 = this.pz1 + MARGIN;
    this.shapes.length = 0;
    for (const c of list) {
      const s = toShape(c);
      if (!s) continue;
      if (s.x1 < x0 || s.x0 > x1 || s.y1 < y0 || s.y0 > y1 || s.z1 < z0 || s.z0 > z1) continue;
      if (contains(s, emitter.x, emitter.y, emitter.z)) continue;
      this.shapes.push(s);
    }
  }

  /** Partikelposition für die Hülle (nächster refresh) merken */
  track(x: number, y: number, z: number): void {
    if (x < this.bx0) this.bx0 = x;
    if (y < this.by0) this.by0 = y;
    if (z < this.bz0) this.bz0 = z;
    if (x > this.bx1) this.bx1 = x;
    if (y > this.by1) this.by1 = y;
    if (z > this.bz1) this.bz1 = z;
  }

  /** Kugel (p[i..i+2], Radius r) aus der Geometrie schieben. Schreibt die Position zurück und die
   *  gemittelte Kontaktnormale nach n; false = kein Kontakt. */
  resolve(p: Float32Array, i: number, r: number, n: THREE.Vector3): boolean {
    PX = p[i];
    PY = p[i + 1];
    PZ = p[i + 2];
    let sx = 0, sy = 0, sz = 0;
    let hit = false;
    for (let k = 0; k < this.shapes.length; k++) {
      const s = this.shapes[k];
      if (PX + r < s.x0 || PX - r > s.x1 || PY + r < s.y0 || PY - r > s.y1 || PZ + r < s.z0 || PZ - r > s.z1) continue;
      const c = s.kind === Kind.Box ? pushBox(s, r) : s.kind === Kind.Cyl ? pushCylinder(s, r) : pushHeightfield(s, r);
      if (!c) continue;
      hit = true;
      sx += NX;
      sy += NY;
      sz += NZ;
    }
    if (this.ground && PY - r < 0 && PY > -1.5) {
      PY = r;
      sy += 1;
      hit = true;
    }
    if (!hit) return false;
    p[i] = PX;
    p[i + 1] = PY;
    p[i + 2] = PZ;
    const l = Math.hypot(sx, sy, sz);
    if (l > 1e-6) n.set(sx / l, sy / l, sz / l);
    else n.set(0, 1, 0);
    return true;
  }
}
