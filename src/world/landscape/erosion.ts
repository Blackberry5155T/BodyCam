// Erosion auf einem Höhenraster (w × h Gitterpunkte, Abstand q Meter).
// Läuft im Pinsel direkt (kleine Bereiche) und für Regionen/ganze Landschaften im Web Worker (erosion.worker.ts).
// Intern wird in „Zellen-Einheiten“ gerechnet (Höhe / q), damit das Ergebnis nicht von der Quad-Größe abhängt.

export interface ErosionParams {
  /** hydraulisch: Tropfen je Gitterpunkt (0.02 … 2) */
  droplets: number;
  /** hydraulisch: Abtrag-Stärke 0..1 */
  erode: number;
  /** hydraulisch: Ablagerung 0..1 */
  deposit: number;
  /** hydraulisch: Sediment-Kapazität */
  capacity: number;
  /** thermisch: Durchgänge */
  thermalIterations: number;
  /** thermisch: Schüttwinkel (°): steiler rutscht ab */
  talus: number;
  /** thermisch: Anteil, der je Durchgang abrutscht */
  thermalRate: number;
}

export type ErosionKind = 'hydraulic' | 'thermal' | 'both';

export const DEFAULT_EROSION: ErosionParams = {
  droplets: 0.25,
  erode: 0.3,
  deposit: 0.3,
  capacity: 4,
  thermalIterations: 30,
  talus: 33,
  thermalRate: 0.5,
};

/** einfacher, reproduzierbarer Zufall (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ERODE_RADIUS = 2;

/** Gewichte des Abtrag-Pinsels (Radius 2 Zellen) */
function brushOffsets(): { dx: Int8Array; dy: Int8Array; w: Float32Array } {
  const dx: number[] = [];
  const dy: number[] = [];
  const w: number[] = [];
  let sum = 0;
  for (let y = -ERODE_RADIUS; y <= ERODE_RADIUS; y++)
    for (let x = -ERODE_RADIUS; x <= ERODE_RADIUS; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d > ERODE_RADIUS) continue;
      const k = 1 - d / (ERODE_RADIUS + 0.5);
      dx.push(x);
      dy.push(y);
      w.push(k);
      sum += k;
    }
  return { dx: Int8Array.from(dx), dy: Int8Array.from(dy), w: Float32Array.from(w.map((v) => v / sum)) };
}

/**
 * Hydraulische Erosion mit Wassertropfen (bekanntes Partikel-Verfahren):
 * Tropfen fließen bergab, nehmen bei Gefälle Sediment auf und lagern es in Senken/bei Kapazitätsgrenze ab.
 * `heights` wird direkt geändert (Meter); `progress` wird gelegentlich mit 0..1 aufgerufen.
 */
export function hydraulicErosion(heights: Float32Array, w: number, h: number, q: number, p: ErosionParams, seed = 1, progress?: (f: number) => void): void {
  if (w < 4 || h < 4) return;
  const inv = 1 / q;
  for (let i = 0; i < heights.length; i++) heights[i] *= inv;
  const brush = brushOffsets();
  const random = rng(seed);
  const count = Math.max(1, Math.round(w * h * p.droplets));
  const inertia = 0.05;
  const gravity = 4;
  const evaporate = 0.02;
  const minSlope = 0.01;
  const maxSteps = 48;
  const erode = p.erode;
  const deposit = p.deposit;
  const capacityK = p.capacity;
  const report = Math.max(1, Math.floor(count / 50));

  // Höhe + Gradient bilinear an (x, y)
  let gx = 0;
  let gy = 0;
  const sample = (x: number, y: number): number => {
    const ix = x | 0;
    const iy = y | 0;
    const fx = x - ix;
    const fy = y - iy;
    const i = iy * w + ix;
    const a = heights[i];
    const b = heights[i + 1];
    const c = heights[i + w];
    const d = heights[i + w + 1];
    gx = (b - a) * (1 - fy) + (d - c) * fy;
    gy = (c - a) * (1 - fx) + (d - b) * fx;
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };

  for (let n = 0; n < count; n++) {
    let x = 1 + random() * (w - 3);
    let y = 1 + random() * (h - 3);
    let dirX = 0;
    let dirY = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;
    for (let step = 0; step < maxSteps; step++) {
      const ix = x | 0;
      const iy = y | 0;
      const fx = x - ix;
      const fy = y - iy;
      const hOld = sample(x, y);
      dirX = dirX * inertia - gx * (1 - inertia);
      dirY = dirY * inertia - gy * (1 - inertia);
      const len = Math.hypot(dirX, dirY);
      if (len < 1e-6) break;
      dirX /= len;
      dirY /= len;
      x += dirX;
      y += dirY;
      if (x < 1 || y < 1 || x >= w - 2 || y >= h - 2) break;
      const hNew = sample(x, y);
      const dh = hNew - hOld;
      const capacity = Math.max(-dh, minSlope) * speed * water * capacityK;
      const i = iy * w + ix;
      if (sediment > capacity || dh > 0) {
        // Ablagern (bergauf: Senke füllen, höchstens bis zur Höhe des Hindernisses)
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * deposit;
        sediment -= amount;
        heights[i] += amount * (1 - fx) * (1 - fy);
        heights[i + 1] += amount * fx * (1 - fy);
        heights[i + w] += amount * (1 - fx) * fy;
        heights[i + w + 1] += amount * fx * fy;
      } else {
        // Abtragen über einen kleinen Pinsel (vermeidet Löcher), nie tiefer als das Gefälle
        const amount = Math.min((capacity - sediment) * erode, -dh);
        for (let k = 0; k < brush.w.length; k++) {
          const bx = ix + brush.dx[k];
          const by = iy + brush.dy[k];
          if (bx < 0 || by < 0 || bx >= w || by >= h) continue;
          const j = by * w + bx;
          const take = amount * brush.w[k];
          heights[j] -= take;
          sediment += take;
        }
      }
      speed = Math.min(12, Math.sqrt(Math.max(0, speed * speed - dh * gravity)));
      water *= 1 - evaporate;
      if (water < 0.01) break;
    }
    if (progress && n % report === 0) progress(n / count);
  }
  for (let i = 0; i < heights.length; i++) heights[i] *= q;
}

/**
 * Thermische Erosion: Material rutscht ab, wo das Gefälle zum Nachbarn den Schüttwinkel übersteigt.
 * Glättet Kanten, bildet Schutthalden am Fuß von Klippen.
 */
export function thermalErosion(heights: Float32Array, w: number, h: number, q: number, p: ErosionParams, progress?: (f: number) => void): void {
  const talus = Math.tan((p.talus * Math.PI) / 180) * q;
  const talusDiag = talus * Math.SQRT2;
  const rate = Math.min(0.5, Math.max(0, p.thermalRate) * 0.5);
  const delta = new Float32Array(heights.length);
  const iters = Math.max(1, Math.round(p.thermalIterations));
  const ox = [1, -1, 0, 0, 1, 1, -1, -1];
  const oy = [0, 0, 1, -1, 1, -1, 1, -1];
  for (let it = 0; it < iters; it++) {
    delta.fill(0);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const hc = heights[i];
        let total = 0;
        let maxD = 0;
        // Überschuss zu allen tieferen Nachbarn
        for (let k = 0; k < 8; k++) {
          const d = hc - heights[i + oy[k] * w + ox[k]] - (k < 4 ? talus : talusDiag);
          if (d > 0) {
            total += d;
            if (d > maxD) maxD = d;
          }
        }
        if (total <= 0) continue;
        const move = maxD * rate;
        delta[i] -= move;
        for (let k = 0; k < 8; k++) {
          const j = i + oy[k] * w + ox[k];
          const d = hc - heights[j] - (k < 4 ? talus : talusDiag);
          if (d > 0) delta[j] += (move * d) / total;
        }
      }
    }
    for (let i = 0; i < heights.length; i++) heights[i] += delta[i];
    progress?.((it + 1) / iters);
  }
}

export function runErosion(heights: Float32Array, w: number, h: number, q: number, kind: ErosionKind, p: ErosionParams, seed = 1, progress?: (f: number) => void): void {
  if (kind === 'thermal') thermalErosion(heights, w, h, q, p, progress);
  else if (kind === 'hydraulic') hydraulicErosion(heights, w, h, q, p, seed, progress);
  else {
    hydraulicErosion(heights, w, h, q, p, seed, (f) => progress?.(f * 0.75));
    thermalErosion(heights, w, h, q, p, (f) => progress?.(0.75 + f * 0.25));
  }
}
