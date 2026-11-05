import { runErosion, type ErosionKind, type ErosionParams } from './erosion.ts';
import { resampleHoles, type LandscapeData, type Rect } from './data.ts';

// Sculpt-Operationen auf LandscapeData (reine Funktionen, ohne Editor/three).
// Koordinaten: Gitter (1 = ein Quad). Rechtecke für Höhen in Gitterpunkten, für Löcher in Quads.
// Aufrufer: Rechteck mit brushRect() holen → Undo-Recorder touch(rect) → Operation → data.changed(rect).

export type FalloffShape = 'smooth' | 'linear' | 'spherical' | 'tip';

export interface Brush {
  /** Mitte (Gitter) */
  x: number;
  z: number;
  /** Radius (Gitter) */
  radius: number;
  /** Anteil des Radius, über den die Wirkung abfällt (0 = harte Kante, 1 = ab der Mitte) */
  falloff: number;
  shape: FalloffShape;
  /** 0..2 (über 1: kräftiger als Standard) */
  strength: number;
}

/** Gewicht bei normiertem Abstand d (0 = Mitte, 1 = Rand) */
export function falloffWeight(d: number, falloff: number, shape: FalloffShape): number {
  if (d >= 1) return 0;
  const inner = 1 - falloff;
  if (d <= inner) return 1;
  const t = (d - inner) / Math.max(1e-6, falloff);
  switch (shape) {
    case 'linear':
      return 1 - t;
    case 'spherical':
      return Math.sqrt(Math.max(0, 1 - t * t));
    case 'tip':
      return 1 - Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    default:
      return 1 - t * t * (3 - 2 * t);
  }
}

/** betroffene Gitterpunkte eines Pinsels (geclippt), null = außerhalb */
export function brushRect(d: LandscapeData, b: Brush, pad = 0): Rect | null {
  const r = b.radius + pad;
  return d.clip({ x: Math.floor(b.x - r), y: Math.floor(b.z - r), w: Math.ceil(2 * r) + 2, h: Math.ceil(2 * r) + 2 });
}

function eachVertex(d: LandscapeData, b: Brush, r: Rect, fn: (i: number, ix: number, iz: number, w: number) => void): void {
  const inv = 1 / Math.max(1e-6, b.radius);
  for (let iz = r.y; iz < r.y + r.h; iz++) {
    const dz = (iz - b.z) * inv;
    for (let ix = r.x; ix < r.x + r.w; ix++) {
      const dx = (ix - b.x) * inv;
      const w = falloffWeight(Math.sqrt(dx * dx + dz * dz), b.falloff, b.shape);
      if (w > 0) fn(iz * d.VW + ix, ix, iz, w);
    }
  }
}

/** Anheben (sign 1) / Senken (sign −1); Geschwindigkeit wächst mit der Pinselgröße */
export function sculptRaise(d: LandscapeData, b: Brush, r: Rect, dt: number, sign: number): void {
  const radiusM = b.radius * d.quadSize;
  const rate = b.strength * (1.5 + radiusM * 0.25) * dt * sign;
  const hs = d.editHeights;
  eachVertex(d, b, r, (i, _x, _z, w) => {
    hs[i] += rate * w;
  });
}

/** Glätten: Box-Filter über eine Summentabelle; Kernel wächst mit dem Pinsel */
export function sculptSmooth(d: LandscapeData, b: Brush, r: Rect, dt: number): void {
  const k = Math.max(1, Math.round(b.radius * 0.12));
  const x0 = Math.max(0, r.x - k);
  const y0 = Math.max(0, r.y - k);
  const x1 = Math.min(d.VW, r.x + r.w + k);
  const y1 = Math.min(d.VH, r.y + r.h + k);
  const w = x1 - x0;
  const h = y1 - y0;
  const sat = new Float64Array((w + 1) * (h + 1));
  const hs = d.editHeights;
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += hs[(y0 + y) * d.VW + x0 + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const amt = Math.min(1, b.strength * dt * 12);
  const out = new Float32Array(r.w * r.h);
  eachVertex(d, b, r, (i, ix, iz, wt) => {
    const ax = Math.max(x0, ix - k) - x0;
    const ay = Math.max(y0, iz - k) - y0;
    const bx = Math.min(x1 - 1, ix + k) - x0 + 1;
    const by = Math.min(y1 - 1, iz + k) - y0 + 1;
    const sum = sat[by * (w + 1) + bx] - sat[ay * (w + 1) + bx] - sat[by * (w + 1) + ax] + sat[ay * (w + 1) + ax];
    const avg = sum / ((bx - ax) * (by - ay));
    out[(iz - r.y) * r.w + ix - r.x] = hs[i] + (avg - hs[i]) * amt * wt;
  });
  // Erst nach dem Filtern zurückschreiben (sonst wirkt der Filter richtungsabhängig)
  eachVertex(d, b, r, (i, ix, iz) => {
    hs[i] = out[(iz - r.y) * r.w + ix - r.x];
  });
}

export type FlattenMode = 'both' | 'raise' | 'lower';

/** Abflachen auf eine Zielhöhe (lokal, m) */
export function sculptFlatten(d: LandscapeData, b: Brush, r: Rect, dt: number, target: number, mode: FlattenMode): void {
  const amt = Math.min(1, b.strength * dt * 10);
  const hs = d.editHeights;
  eachVertex(d, b, r, (i, _x, _z, w) => {
    const diff = target - hs[i];
    if ((mode === 'raise' && diff < 0) || (mode === 'lower' && diff > 0)) return;
    hs[i] += diff * amt * w;
  });
}

// ---------- Noise ----------

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const e = hash2(ix + 1, iy + 1, seed);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}

/** fraktales Rauschen −1..1 */
export function fbm(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise(x, y, seed + o * 17) * 2 - 1) * amp;
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

export interface NoiseParams {
  /** Wellenlänge (m) */
  scale: number;
  /** Höhe (m) je Sekunde bei voller Stärke */
  amplitude: number;
  octaves: number;
  seed: number;
}

export function sculptNoise(d: LandscapeData, b: Brush, r: Rect, dt: number, p: NoiseParams): void {
  const f = d.quadSize / Math.max(0.1, p.scale);
  const rate = b.strength * p.amplitude * dt;
  const hs = d.editHeights;
  eachVertex(d, b, r, (i, ix, iz, w) => {
    hs[i] += fbm(ix * f, iz * f, p.octaves, p.seed) * rate * w;
  });
}

// ---------- Erosion (Pinsel) ----------

let erosionSeed = 1;

/** Erosion unter dem Pinsel: kleiner Ausschnitt synchron, Ergebnis mit dem Pinsel-Gewicht eingeblendet */
export function sculptErosion(d: LandscapeData, b: Brush, r: Rect, dt: number, kind: ErosionKind, p: ErosionParams): void {
  const w = r.w;
  const h = r.h;
  if (w < 6 || h < 6) return;
  const src = new Float32Array(w * h);
  for (let y = 0; y < h; y++) src.set(d.editHeights.subarray((r.y + y) * d.VW + r.x, (r.y + y) * d.VW + r.x + w), y * w);
  const work = src.slice();
  const k = Math.min(1, b.strength * dt * 6);
  runErosion(work, w, h, d.quadSize, kind, { ...p, droplets: p.droplets * k, thermalIterations: Math.max(1, Math.round(p.thermalIterations * k * 0.5)) }, erosionSeed++);
  const hs = d.editHeights;
  eachVertex(d, b, r, (i, ix, iz, wt) => {
    const j = (iz - r.y) * w + ix - r.x;
    hs[i] = src[j] + (work[j] - src[j]) * wt;
  });
}

// ---------- Löcher ----------

/** betroffene Loch-Zellen eines Pinsels */
export function brushHoleRect(d: LandscapeData, b: Brush): Rect | null {
  const s = d.holeSub;
  const r = b.radius;
  return d.clip({ x: Math.floor((b.x - r) * s), y: Math.floor((b.z - r) * s), w: Math.ceil(2 * r * s) + 2, h: Math.ceil(2 * r * s) + 2 }, d.HW, d.HH);
}

/** Loch-Zellen setzen/entfernen, deren Mitte im Pinsel liegt (Rechteck in Zellen) */
export function paintHoles(d: LandscapeData, b: Brush, r: Rect, set: boolean): void {
  const s = d.holeSub;
  // kleinster Pinsel trifft immer mindestens die Zelle unter dem Cursor
  const inv = 1 / Math.max(0.5 / s, b.radius);
  const HW = d.HW;
  for (let cz = r.y; cz < r.y + r.h; cz++) {
    for (let cx = r.x; cx < r.x + r.w; cx++) {
      const dx = ((cx + 0.5) / s - b.x) * inv;
      const dz = ((cz + 0.5) / s - b.z) * inv;
      if (dx * dx + dz * dz <= 1) d.holes[cz * HW + cx] = set ? 1 : 0;
    }
  }
}

// ---------- Rampe ----------

export interface Ramp {
  /** Gitterkoordinaten + Höhe (lokal, m) der Endpunkte */
  ax: number;
  az: number;
  ah: number;
  bx: number;
  bz: number;
  bh: number;
  /** volle Breite (Gitter) */
  width: number;
  /** zusätzlicher Übergang seitlich, Anteil der halben Breite */
  falloff: number;
}

export function rampRect(d: LandscapeData, r: Ramp): Rect | null {
  const pad = (r.width / 2) * (1 + r.falloff) + 1;
  const x0 = Math.min(r.ax, r.bx) - pad;
  const z0 = Math.min(r.az, r.bz) - pad;
  const x1 = Math.max(r.ax, r.bx) + pad;
  const z1 = Math.max(r.az, r.bz) + pad;
  return d.clip({ x: Math.floor(x0), y: Math.floor(z0), w: Math.ceil(x1 - x0) + 1, h: Math.ceil(z1 - z0) + 1 });
}

export function applyRamp(d: LandscapeData, ramp: Ramp, rect: Rect): void {
  const ex = ramp.bx - ramp.ax;
  const ez = ramp.bz - ramp.az;
  const len2 = Math.max(1e-6, ex * ex + ez * ez);
  const half = ramp.width / 2;
  const outer = half * (1 + ramp.falloff);
  const hs = d.editHeights;
  for (let iz = rect.y; iz < rect.y + rect.h; iz++) {
    for (let ix = rect.x; ix < rect.x + rect.w; ix++) {
      const px = ix - ramp.ax;
      const pz = iz - ramp.az;
      const tRaw = (px * ex + pz * ez) / len2;
      const t = Math.min(1, Math.max(0, tRaw));
      const dist = Math.hypot(px - ex * t, pz - ez * t);
      if (dist >= outer) continue;
      // Abstand zur Strecke (hinter den Endpunkten radial) → Enden laufen ebenfalls weich aus
      const w = dist <= half ? 1 : 1 - smooth((dist - half) / Math.max(1e-6, outer - half));
      const s = smooth(t);
      const target = ramp.ah + (ramp.bh - ramp.ah) * (t * 0.5 + s * 0.5);
      const i = iz * d.VW + ix;
      hs[i] += (target - hs[i]) * w;
    }
  }
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

// ---------- Region ----------

export interface RegionCopy {
  w: number;
  h: number;
  heights: Float32Array;
  /** Loch-Zellen ((w−1)·sub × (h−1)·sub) */
  holes: Uint8Array;
  /** Loch-Auflösung der Quelle */
  sub: number;
  /** Höhe in der Mitte (für relatives Einfügen) */
  base: number;
}

export function copyRegion(d: LandscapeData, r: Rect): RegionCopy {
  const heights = new Float32Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) heights.set(d.editHeights.subarray((r.y + y) * d.VW + r.x, (r.y + y) * d.VW + r.x + r.w), y * r.w);
  const sub = d.holeSub;
  const cw = Math.max(0, r.w - 1) * sub;
  const ch = Math.max(0, r.h - 1) * sub;
  const holes = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const src = (r.y * sub + y) * d.HW + r.x * sub;
    holes.set(d.holes.subarray(src, src + cw), y * cw);
  }
  return { w: r.w, h: r.h, heights, holes, sub, base: heights[(r.h >> 1) * r.w + (r.w >> 1)] };
}

/** Kopie mit linker oberer Ecke bei (x0, y0) einsetzen; offset wird auf alle Höhen addiert */
export function pasteRegion(d: LandscapeData, c: RegionCopy, x0: number, y0: number, offset: number, withHoles: boolean): void {
  for (let y = 0; y < c.h; y++) {
    const iz = y0 + y;
    if (iz < 0 || iz > d.H) continue;
    for (let x = 0; x < c.w; x++) {
      const ix = x0 + x;
      if (ix < 0 || ix > d.W) continue;
      d.editHeights[iz * d.VW + ix] = c.heights[y * c.w + x] + offset;
    }
  }
  if (!withHoles) return;
  // Kopie in die Loch-Auflösung des Ziels umrechnen
  const s = d.holeSub;
  const cw = (c.w - 1) * s;
  const ch = (c.h - 1) * s;
  const holes = c.sub === s ? c.holes : resampleHoles(c.holes, (c.w - 1) * c.sub, (c.h - 1) * c.sub, c.sub, s);
  const HW = d.HW;
  for (let y = 0; y < ch; y++) {
    const cz = y0 * s + y;
    if (cz < 0 || cz >= d.HH) continue;
    for (let x = 0; x < cw; x++) {
      const cx = x0 * s + x;
      if (cx >= 0 && cx < HW) d.holes[cz * HW + cx] = holes[y * cw + x];
    }
  }
}

export function mirrorCopy(c: RegionCopy, axis: 'x' | 'z'): RegionCopy {
  const heights = new Float32Array(c.heights.length);
  for (let y = 0; y < c.h; y++)
    for (let x = 0; x < c.w; x++) {
      const sx = axis === 'x' ? c.w - 1 - x : x;
      const sy = axis === 'z' ? c.h - 1 - y : y;
      heights[y * c.w + x] = c.heights[sy * c.w + sx];
    }
  const qw = (c.w - 1) * c.sub;
  const qh = (c.h - 1) * c.sub;
  const holes = new Uint8Array(c.holes.length);
  for (let y = 0; y < qh; y++)
    for (let x = 0; x < qw; x++) {
      const sx = axis === 'x' ? qw - 1 - x : x;
      const sy = axis === 'z' ? qh - 1 - y : y;
      holes[y * qw + x] = c.holes[sy * qw + sx];
    }
  return { ...c, heights, holes };
}

/** 90° im Uhrzeigersinn (von oben gesehen, +X rechts, +Z unten) */
export function rotateCopy(c: RegionCopy): RegionCopy {
  const w = c.h;
  const h = c.w;
  const heights = new Float32Array(c.heights.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) heights[y * w + x] = c.heights[(c.h - 1 - x) * c.w + y];
  // Loch-Zellen: Quelle scw × sch → Ziel sch × scw
  const scw = (c.w - 1) * c.sub;
  const sch = (c.h - 1) * c.sub;
  const holes = new Uint8Array(c.holes.length);
  for (let y = 0; y < scw; y++) for (let x = 0; x < sch; x++) holes[y * sch + x] = c.holes[(sch - 1 - x) * scw + y];
  return { w, h, heights, holes, sub: c.sub, base: c.base };
}
