import projectTextures from 'virtual:bodycam-textures';
import { classifyTexture, isDirectXNormal, setNameFromFiles, type TexChannel } from './textureFiles.ts';

// Textur-Sets für Landscape-Layer:
//  - Prozedural ("proc:gras" …): werden beim ersten Gebrauch erzeugt (kachelbar, 512 px, bei Bedarf hochskaliert)
//  - Projekt ("/assets/textures/<Name>"): Ordner unter public/assets/textures (Liste kommt vom Vite-Plugin)
//  - Importiert ("idb:<Name>"): im Editor hochgeladene Bilder, liegen in IndexedDB dieses Browsers
// Jedes Set liefert drei Bilder gleicher Größe: Albedo (sRGB, RGBA), Normale (RG, x/v) und ARM
// (R = Rauheit, G = Umgebungsverdeckung, B = Höhe für das Höhen-Blending der Layer).

export interface TexSetData {
  size: number;
  /** sRGB, RGBA8 */
  albedo: Uint8Array;
  /** Tangentenraum-Normale, RG8: x entlang u, y entlang v (Datenreihenfolge, Zeile 0 = v 0) */
  normal: Uint8Array;
  /** R Rauheit, G AO, B Höhe, A 255 */
  arm: Uint8Array;
}

export interface ProjectTextureSet {
  name: string;
  files: Partial<Record<TexChannel, string>>;
}

export const PROC_TEXTURES: { kind: string; label: string }[] = [
  { kind: 'gras', label: 'Gras' },
  { kind: 'erde', label: 'Erde' },
  { kind: 'fels', label: 'Fels' },
  { kind: 'kies', label: 'Kies' },
  { kind: 'schnee', label: 'Schnee' },
  { kind: 'sand', label: 'Sand' },
  { kind: 'asphalt', label: 'Asphalt' },
  { kind: 'schlamm', label: 'Schlamm' },
];

export function textureLabel(ref: string): string {
  if (ref.startsWith('proc:')) return PROC_TEXTURES.find((p) => p.kind === ref.slice(5))?.label ?? ref.slice(5);
  return ref.replace(/^idb:/, '').split('/').pop()!;
}

// =====================================================================================================
// Prozedurale Texturen
// =====================================================================================================

const PN = 512;

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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** kachelbares Value-Noise-fBm als N×N-Feld, 0..1; `cells` = Gitterzellen der ersten Oktave */
function fbm(cells: number, octaves: number, seed: number, persistence = 0.5, n = PN): Float32Array {
  const out = new Float32Array(n * n);
  const r = rng(seed);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const c = cells << o;
    if (c > n) break;
    const lat = new Float32Array(c * c);
    for (let i = 0; i < lat.length; i++) lat[i] = r();
    for (let y = 0; y < n; y++) {
      const fy = (y / n) * c;
      const y0 = Math.floor(fy);
      let ty = fy - y0;
      ty = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % c) * c;
      const r1 = ((y0 + 1) % c) * c;
      for (let x = 0; x < n; x++) {
        const fx = (x / n) * c;
        const x0 = Math.floor(fx);
        let tx = fx - x0;
        tx = tx * tx * (3 - 2 * tx);
        const x1 = (x0 + 1) % c;
        const a = lat[r0 + x0] + (lat[r0 + x1] - lat[r0 + x0]) * tx;
        const b = lat[r1 + x0] + (lat[r1 + x1] - lat[r1 + x0]) * tx;
        out[y * n + x] += (a + (b - a) * ty) * amp;
      }
    }
    total += amp;
    amp *= persistence;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** kachelbares Worley-Rauschen: Abstand zum nächsten (f1) und zweitnächsten Punkt (f2) in Zellen, Zell-Zufallswert */
function worley(cells: number, seed: number, jitter = 0.9, n = PN): { f1: Float32Array; f2: Float32Array; id: Float32Array } {
  const r = rng(seed);
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  const pv = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    px[i] = 0.5 + (r() - 0.5) * jitter;
    py[i] = 0.5 + (r() - 0.5) * jitter;
    pv[i] = r();
  }
  const f1 = new Float32Array(n * n);
  const f2 = new Float32Array(n * n);
  const id = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const fy = (y / n) * cells;
    const cy = Math.floor(fy);
    for (let x = 0; x < n; x++) {
      const fx = (x / n) * cells;
      const cx = Math.floor(fx);
      let d1 = 9;
      let d2 = 9;
      let v = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const gy = (cy + oy + cells) % cells;
        for (let ox = -1; ox <= 1; ox++) {
          const gx = (cx + ox + cells) % cells;
          const k = gy * cells + gx;
          const dx = cx + ox + px[k] - fx;
          const dy = cy + oy + py[k] - fy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            v = pv[k];
          } else if (d < d2) d2 = d;
        }
      }
      const i = y * n + x;
      f1[i] = d1;
      f2[i] = d2;
      id[i] = v;
    }
  }
  return { f1, f2, id };
}

interface ProcOut {
  /** sRGB 0..1, RGB */
  col: Float32Array;
  h: Float32Array;
  rough: Float32Array;
  ao: Float32Array;
  /** Normalenstärke (Höhendifferenz 1 über ein Pixel → Neigung) */
  bump: number;
}

function newOut(bump: number): ProcOut {
  return { col: new Float32Array(PN * PN * 3), h: new Float32Array(PN * PN), rough: new Float32Array(PN * PN), ao: new Float32Array(PN * PN).fill(1), bump };
}

function setCol(o: ProcOut, i: number, r: number, g: number, b: number): void {
  o.col[i * 3] = r;
  o.col[i * 3 + 1] = g;
  o.col[i * 3 + 2] = b;
}

/** AO aus der Höhe: Vertiefungen gegenüber der Umgebung (grober Box-Blur) werden dunkler */
function aoFromHeight(o: ProcOut, radius: number, strength: number): void {
  const n = PN;
  const h = o.h;
  const tmp = new Float32Array(n * n);
  const blur = new Float32Array(n * n);
  const w = radius * 2 + 1;
  for (let y = 0; y < n; y++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) s += h[y * n + ((k + n) % n)];
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = s / w;
      s += h[y * n + ((x + radius + 1) % n)] - h[y * n + ((x - radius + n) % n)];
    }
  }
  for (let x = 0; x < n; x++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) s += tmp[((k + n) % n) * n + x];
    for (let y = 0; y < n; y++) {
      blur[y * n + x] = s / w;
      s += tmp[((y + radius + 1) % n) * n + x] - tmp[((y - radius + n) % n) * n + x];
    }
  }
  for (let i = 0; i < n * n; i++) o.ao[i] *= clamp01(1 - Math.max(0, blur[i] - h[i]) * strength);
}

/** Linie mit weichem Profil in die Felder stempeln (Grashalme); wickelt am Rand um */
function stroke(o: ProcOut, x0: number, y0: number, dx: number, dy: number, len: number, width: number, hgt: number, rgb: [number, number, number]): void {
  const n = PN;
  const steps = Math.ceil(len * 1.5);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + dx * len * t;
    const cy = y0 + dy * len * t;
    const wt = width * (1 - t * 0.7);
    const ht = hgt * (0.55 + 0.45 * t);
    const rr = Math.ceil(wt);
    for (let oy = -rr; oy <= rr; oy++) {
      for (let ox = -rr; ox <= rr; ox++) {
        const d = Math.sqrt(ox * ox + oy * oy) / Math.max(wt, 0.5);
        if (d > 1) continue;
        const x = ((Math.round(cx) + ox) % n + n) % n;
        const y = ((Math.round(cy) + oy) % n + n) % n;
        const i = y * n + x;
        const v = ht * (1 - d * d);
        if (v > o.h[i]) {
          o.h[i] = v;
          setCol(o, i, rgb[0] * (0.75 + 0.35 * t), rgb[1] * (0.75 + 0.35 * t), rgb[2] * (0.8 + 0.25 * t));
        }
      }
    }
  }
}

function genGras(): ProcOut {
  const o = newOut(5);
  const base = fbm(4, 5, 11);
  const patch = fbm(8, 3, 12);
  const n = PN;
  for (let i = 0; i < n * n; i++) {
    // Boden zwischen den Halmen: dunkle Erde/Moos
    const b = base[i];
    setCol(o, i, 0.2 + 0.08 * b, 0.21 + 0.08 * b, 0.1 + 0.04 * b);
    o.h[i] = 0.05 * b;
    o.rough[i] = 0.95;
  }
  const r = rng(13);
  const blades = Math.round((n * n) / 22);
  for (let k = 0; k < blades; k++) {
    const x = r() * n;
    const y = r() * n;
    const i = (Math.floor(y) % n) * n + (Math.floor(x) % n);
    const ang = r() * Math.PI * 2;
    const dry = clamp01(patch[i] * 1.6 - 0.45 + (r() - 0.5) * 0.4);
    const lum = 0.75 + r() * 0.5;
    const rgb: [number, number, number] = [mix(0.27, 0.55, dry) * lum, mix(0.4, 0.5, dry) * lum, mix(0.13, 0.22, dry) * lum];
    stroke(o, x, y, Math.cos(ang), Math.sin(ang), 5 + r() * 10, 0.9 + r() * 0.9, 0.3 + r() * 0.7, rgb);
  }
  for (let i = 0; i < n * n; i++) o.rough[i] = mix(0.95, 0.78, o.h[i]);
  aoFromHeight(o, 3, 1.6);
  return o;
}

function genErde(): ProcOut {
  const o = newOut(4);
  const a = fbm(4, 6, 21, 0.55);
  const fine = fbm(64, 2, 22);
  const peb = worley(40, 23, 0.95);
  const n = PN;
  for (let i = 0; i < n * n; i++) {
    const pr = peb.id[i] > 0.72 ? 1 - sstep(0.18, 0.32, peb.f1[i]) : 0;
    const h = a[i] * 0.45 + fine[i] * 0.15 + pr * (0.35 + 0.2 * peb.id[i]);
    o.h[i] = h;
    const c = 0.8 + 0.35 * a[i] + 0.15 * (fine[i] - 0.5);
    let r = 0.36 * c;
    let g = 0.27 * c;
    let b = 0.19 * c;
    if (pr > 0) {
      const s = 0.42 + 0.25 * peb.id[i];
      r = mix(r, s, pr);
      g = mix(g, s * 0.93, pr);
      b = mix(b, s * 0.85, pr);
    }
    setCol(o, i, r, g, b);
    o.rough[i] = mix(0.93, 0.8, pr);
  }
  aoFromHeight(o, 4, 2);
  return o;
}

function genFels(): ProcOut {
  const o = newOut(7);
  const a = fbm(3, 7, 31, 0.55);
  const ridge = fbm(6, 5, 32, 0.5);
  const warp = fbm(2, 3, 33);
  const cr = worley(7, 34, 1);
  const fine = fbm(48, 3, 35);
  const n = PN;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const rd = 1 - Math.abs(ridge[i] * 2 - 1);
      // Schichtung: ganzzahlige Frequenz → kachelbar
      const strata = Math.sin((y / n) * Math.PI * 2 * 9 + warp[i] * 9) * 0.5 + 0.5;
      const crack = 1 - sstep(0.0, 0.06, cr.f2[i] - cr.f1[i]);
      const h = a[i] * 0.5 + rd * rd * 0.3 + strata * 0.12 + fine[i] * 0.08 - crack * 0.35;
      o.h[i] = h;
      const c = 0.72 + 0.45 * a[i] + 0.1 * strata - 0.25 * crack;
      const warm = clamp01(warp[i] * 1.4 - 0.3);
      setCol(o, i, (0.44 + 0.06 * warm) * c, (0.43 + 0.02 * warm) * c, (0.41 - 0.03 * warm) * c);
      o.rough[i] = 0.72 + 0.18 * fine[i] + crack * 0.08;
    }
  }
  aoFromHeight(o, 6, 2.5);
  return o;
}

function genKies(): ProcOut {
  const o = newOut(6);
  const big = worley(26, 41, 0.85);
  const small = worley(52, 42, 0.9);
  const tone = fbm(4, 3, 43);
  const n = PN;
  for (let i = 0; i < n * n; i++) {
    const e1 = big.f2[i] - big.f1[i];
    const e2 = small.f2[i] - small.f1[i];
    const s1 = sstep(0.02, 0.3, e1);
    const s2 = sstep(0.03, 0.3, e2) * 0.6;
    const useBig = s1 > s2 * 0.9;
    const s = useBig ? s1 : s2;
    const id = useBig ? big.id[i] : small.id[i];
    o.h[i] = Math.sqrt(s) * (useBig ? 1 : 0.65);
    const g = 0.38 + 0.32 * id + 0.08 * tone[i];
    const gap = 1 - s;
    const warm = id > 0.6 ? 0.04 : -0.02;
    setCol(o, i, mix(g + warm, 0.18, gap * 0.9), mix(g, 0.16, gap * 0.9), mix(g - warm, 0.13, gap * 0.9));
    o.rough[i] = 0.68 + 0.2 * gap;
  }
  aoFromHeight(o, 3, 2.2);
  return o;
}

function genSchnee(): ProcOut {
  const o = newOut(2.5);
  const a = fbm(4, 6, 51, 0.55);
  const fine = fbm(96, 2, 52);
  const r = rng(53);
  const n = PN;
  for (let i = 0; i < n * n; i++) {
    o.h[i] = a[i] * 0.85 + fine[i] * 0.15;
    const c = 0.88 + 0.08 * a[i];
    setCol(o, i, c * 0.95, c * 0.97, c);
    o.rough[i] = 0.62 + 0.15 * fine[i];
    // vereinzeltes Glitzern
    if (r() > 0.9985) o.rough[i] = 0.25;
  }
  aoFromHeight(o, 8, 1.2);
  return o;
}

function genSand(): ProcOut {
  const o = newOut(3.5);
  const warp = fbm(3, 4, 61);
  const a = fbm(6, 4, 62);
  const grain = fbm(128, 1, 63);
  const n = PN;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // Rippel quer zur Windrichtung, ganzzahlige Frequenz in x und y
      const ph = ((x * 5 + y * 11) / n + warp[i] * 1.5) * Math.PI * 2;
      const rip = Math.pow(Math.sin(ph) * 0.5 + 0.5, 1.6);
      o.h[i] = rip * 0.55 + a[i] * 0.35 + grain[i] * 0.1;
      const c = 0.9 + 0.12 * a[i] + 0.06 * (grain[i] - 0.5) - 0.05 * (1 - rip);
      setCol(o, i, 0.74 * c, 0.64 * c, 0.48 * c);
      o.rough[i] = 0.9;
    }
  }
  aoFromHeight(o, 4, 1);
  return o;
}

function genAsphalt(): ProcOut {
  const o = newOut(3);
  const stones = worley(96, 71, 0.9);
  const a = fbm(4, 4, 72);
  const fine = fbm(128, 2, 73);
  const n = PN;
  for (let i = 0; i < n * n; i++) {
    const s = sstep(0.05, 0.35, stones.f2[i] - stones.f1[i]);
    const light = stones.id[i] > 0.82 ? s : 0;
    o.h[i] = s * 0.6 + fine[i] * 0.3 + a[i] * 0.1;
    const c = 0.2 + 0.05 * a[i] + 0.05 * fine[i] + light * 0.22;
    setCol(o, i, c, c, c * 1.02);
    o.rough[i] = 0.88 - 0.12 * s;
  }
  aoFromHeight(o, 2, 2.5);
  return o;
}

function genSchlamm(): ProcOut {
  const o = newOut(3);
  const a = fbm(3, 6, 81, 0.55);
  const b = fbm(10, 3, 82);
  const n = PN;
  for (let i = 0; i < n * n; i++) {
    const h = a[i] * 0.7 + b[i] * 0.3;
    o.h[i] = h;
    // Senken: nass, glatt, dunkler
    const wet = 1 - sstep(0.35, 0.5, h);
    const c = 0.75 + 0.3 * b[i];
    setCol(o, i, 0.27 * c * (1 - wet * 0.3), 0.21 * c * (1 - wet * 0.32), 0.15 * c * (1 - wet * 0.3));
    o.rough[i] = mix(0.78, 0.25, wet);
  }
  aoFromHeight(o, 5, 1.5);
  return o;
}

const GENERATORS: Record<string, () => ProcOut> = {
  gras: genGras,
  erde: genErde,
  fels: genFels,
  kies: genKies,
  schnee: genSchnee,
  sand: genSand,
  asphalt: genAsphalt,
  schlamm: genSchlamm,
};

function packProc(o: ProcOut): TexSetData {
  const n = PN;
  const albedo = new Uint8Array(n * n * 4);
  const normal = new Uint8Array(n * n * 2);
  const arm = new Uint8Array(n * n * 4);
  // Höhe auf 0..1 normieren
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of o.h) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      albedo[i * 4] = Math.round(clamp01(o.col[i * 3]) * 255);
      albedo[i * 4 + 1] = Math.round(clamp01(o.col[i * 3 + 1]) * 255);
      albedo[i * 4 + 2] = Math.round(clamp01(o.col[i * 3 + 2]) * 255);
      albedo[i * 4 + 3] = 255;
      const hx = (o.h[y * n + ((x + 1) % n)] - o.h[y * n + ((x - 1 + n) % n)]) * 0.5 * o.bump / span;
      const hy = (o.h[((y + 1) % n) * n + x] - o.h[((y - 1 + n) % n) * n + x]) * 0.5 * o.bump / span;
      const l = Math.sqrt(hx * hx + hy * hy + 1);
      normal[i * 2] = Math.round((-hx / l * 0.5 + 0.5) * 255);
      normal[i * 2 + 1] = Math.round((-hy / l * 0.5 + 0.5) * 255);
      arm[i * 4] = Math.round(clamp01(o.rough[i]) * 255);
      arm[i * 4 + 1] = Math.round(clamp01(o.ao[i]) * 255);
      arm[i * 4 + 2] = Math.round(((o.h[i] - lo) / span) * 255);
      arm[i * 4 + 3] = 255;
    }
  }
  return { size: n, albedo, normal, arm };
}

/** Bild bilinear (kachelnd) auf eine andere Größe bringen */
function resample(src: Uint8Array, n: number, comps: number, m: number): Uint8Array {
  if (n === m) return src;
  const out = new Uint8Array(m * m * comps);
  const s = n / m;
  for (let y = 0; y < m; y++) {
    const fy = (y + 0.5) * s - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const ra = ((y0 % n) + n) % n;
    const rb = (ra + 1) % n;
    for (let x = 0; x < m; x++) {
      const fx = (x + 0.5) * s - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const ca = ((x0 % n) + n) % n;
      const cb = (ca + 1) % n;
      for (let c = 0; c < comps; c++) {
        const a = src[(ra * n + ca) * comps + c] * (1 - tx) + src[(ra * n + cb) * comps + c] * tx;
        const b = src[(rb * n + ca) * comps + c] * (1 - tx) + src[(rb * n + cb) * comps + c] * tx;
        out[(y * m + x) * comps + c] = Math.round(a * (1 - ty) + b * ty);
      }
    }
  }
  return out;
}

function resampleSet(d: TexSetData, size: number): TexSetData {
  if (d.size === size) return d;
  return { size, albedo: resample(d.albedo, d.size, 4, size), normal: resample(d.normal, d.size, 2, size), arm: resample(d.arm, d.size, 4, size) };
}

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));
const procCache = new Map<string, Promise<TexSetData>>();

/** Prozedurale Sets nacheinander erzeugen (nicht alle im selben Frame) */
let procQueue: Promise<unknown> = Promise.resolve();

function procSet(kind: string): Promise<TexSetData> {
  let p = procCache.get(kind);
  if (!p) {
    const gen = GENERATORS[kind] ?? GENERATORS.erde;
    p = procQueue.then(async () => {
      await yieldFrame();
      return packProc(gen());
    });
    procQueue = p;
    procCache.set(kind, p);
  }
  return p;
}

// =====================================================================================================
// Eigene Bilder laden
// =====================================================================================================

async function decode(src: Blob, size: number): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(src, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high', colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return g.getImageData(0, 0, size, size).data;
}

/** Quelle je Kanal → Set; fehlende Kanäle bekommen neutrale Werte (Höhe aus der Helligkeit) */
async function buildFromImages(src: Partial<Record<TexChannel, Blob>>, dxNormal: boolean, size: number): Promise<TexSetData> {
  const n = size;
  const px = n * n;
  const albedo = new Uint8Array(px * 4);
  const normal = new Uint8Array(px * 2);
  const arm = new Uint8Array(px * 4);
  const load = (b: Blob | undefined) => (b ? decode(b, n).catch(() => null) : Promise.resolve(null));
  const [alb, nrm, rgh, ao, hgt, armImg] = await Promise.all([load(src.albedo), load(src.normal), load(src.rough), load(src.ao), load(src.height), load(src.arm)]);
  for (let i = 0; i < px; i++) {
    if (alb) {
      albedo[i * 4] = alb[i * 4];
      albedo[i * 4 + 1] = alb[i * 4 + 1];
      albedo[i * 4 + 2] = alb[i * 4 + 2];
    } else albedo[i * 4] = albedo[i * 4 + 1] = albedo[i * 4 + 2] = 128;
    albedo[i * 4 + 3] = 255;
    if (nrm) {
      normal[i * 2] = nrm[i * 4];
      // OpenGL-Normalen: Grün zeigt im Bild nach oben, Datenzeilen laufen nach unten → umdrehen
      normal[i * 2 + 1] = dxNormal ? nrm[i * 4 + 1] : 255 - nrm[i * 4 + 1];
    } else normal[i * 2] = normal[i * 2 + 1] = 128;
    arm[i * 4] = rgh ? rgh[i * 4] : armImg ? armImg[i * 4 + 1] : 210;
    arm[i * 4 + 1] = ao ? ao[i * 4] : armImg ? armImg[i * 4] : 255;
    arm[i * 4 + 3] = 255;
  }
  if (hgt) {
    for (let i = 0; i < px; i++) arm[i * 4 + 2] = hgt[i * 4];
  } else {
    // keine Höhen-Map: Helligkeit der Albedo, auf mittleren Kontrast gestreckt
    const lum = new Float32Array(px);
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < px; i++) {
      const l = albedo[i * 4] * 0.3 + albedo[i * 4 + 1] * 0.59 + albedo[i * 4 + 2] * 0.11;
      lum[i] = l;
      sum += l;
      sq += l * l;
    }
    const mean = sum / px;
    const sd = Math.sqrt(Math.max(1, sq / px - mean * mean));
    for (let i = 0; i < px; i++) arm[i * 4 + 2] = Math.round(clamp01(0.5 + ((lum[i] - mean) / sd) * 0.22) * 255);
  }
  return { size: n, albedo, normal, arm };
}

// =====================================================================================================
// IndexedDB (importierte Sets)
// =====================================================================================================

const DB_NAME = 'bodycam-textures';
const STORE = 'sets';

interface StoredSet {
  files: Partial<Record<TexChannel, Blob>>;
  dx: boolean;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// =====================================================================================================
// Laden mit Cache
// =====================================================================================================

const setCache = new Map<string, Promise<TexSetData>>();
let projectSets: ProjectTextureSet[] = projectTextures;

const fetchBlob = (url: string) => fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${url}: ${r.status}`))));

const invalidated = new Set<() => void>();

/** Sets wurden neu importiert/geändert (Renderer lädt betroffene Layer neu) */
export function onTexturesInvalidated(fn: () => void): () => void {
  invalidated.add(fn);
  return () => invalidated.delete(fn);
}

function invalidate(): void {
  for (const fn of invalidated) fn();
}

/** Textur-Set in der gewünschten Größe (zwischengespeichert); unbekannte Referenzen → prozedurale Erde */
export function loadTextureSet(ref: string, size: number): Promise<TexSetData> {
  const key = `${ref}@${size}`;
  let p = setCache.get(key);
  if (!p) {
    p = (async () => {
      if (ref.startsWith('proc:')) return resampleSet(await procSet(ref.slice(5)), size);
      if (ref.startsWith('idb:')) {
        const s = await tx<StoredSet | undefined>('readonly', (st) => st.get(ref.slice(4)));
        if (!s) throw new Error(`Textur ${ref} ist in diesem Browser nicht vorhanden`);
        return buildFromImages(s.files, s.dx, size);
      }
      const name = ref.replace(/^\/assets\/textures\//, '');
      const set = projectSets.find((s) => s.name === name);
      if (!set) throw new Error(`Textur-Set ${name} nicht gefunden (public/assets/textures)`);
      const blobs: Partial<Record<TexChannel, Blob>> = {};
      await Promise.all(
        Object.entries(set.files).map(async ([ch, url]) => {
          blobs[ch as TexChannel] = await fetchBlob(url!);
        }),
      );
      return buildFromImages(blobs, !!set.files.normal && isDirectXNormal(set.files.normal), size);
    })().catch(async (e) => {
      console.warn(e);
      setCache.delete(key);
      return resampleSet(await procSet('erde'), size);
    });
    setCache.set(key, p);
  }
  return p;
}

// =====================================================================================================
// Bibliothek (Content Browser, Details-Panel)
// =====================================================================================================

export interface TextureEntry {
  ref: string;
  label: string;
  group: 'proc' | 'project' | 'idb';
}

class TextureLibrary {
  imported: string[] = [];
  private listeners = new Set<() => void>();
  private pickers = new Set<(ref: string) => void>();
  private thumbs = new Map<string, Promise<string>>();

  constructor() {
    void this.refresh();
    import.meta.hot?.on('bodycam:textures', (list: ProjectTextureSet[]) => {
      projectSets = list;
      for (const k of [...setCache.keys()]) if (k.startsWith('/assets/')) setCache.delete(k);
      this.thumbs.clear();
      this.emit();
      invalidate();
    });
  }

  get project(): ProjectTextureSet[] {
    return projectSets;
  }

  entries(): TextureEntry[] {
    return [
      ...PROC_TEXTURES.map((p) => ({ ref: `proc:${p.kind}`, label: p.label, group: 'proc' as const })),
      ...projectSets.map((s) => ({ ref: `/assets/textures/${s.name}`, label: s.name, group: 'project' as const })),
      ...this.imported.map((r) => ({ ref: r, label: textureLabel(r), group: 'idb' as const })),
    ];
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Content Browser: Set ausgewählt (Doppelklick) → z. B. dem aktiven Layer zuweisen */
  onPick(fn: (ref: string) => void): () => void {
    this.pickers.add(fn);
    return () => this.pickers.delete(fn);
  }

  /** true, wenn jemand die Auswahl übernommen hat */
  pick(ref: string): boolean {
    for (const fn of this.pickers) fn(ref);
    return this.pickers.size > 0;
  }

  async refresh(): Promise<void> {
    try {
      const keys = await tx('readonly', (s) => s.getAllKeys());
      this.imported = keys.map((k) => `idb:${String(k)}`).sort();
    } catch {
      this.imported = [];
    }
    this.emit();
  }

  /** Bilder eines Sets (Albedo, Normal, …) im Browser speichern */
  async import(files: File[]): Promise<string> {
    const imgs = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
    if (!imgs.length) throw new Error('Bitte Bilddateien wählen (PNG, JPG oder WebP).');
    const set: StoredSet = { files: {}, dx: false };
    for (const f of [...imgs].sort((a, b) => a.name.localeCompare(b.name))) {
      const ch = classifyTexture(f.name);
      if (!ch) continue;
      if (ch === 'normal') {
        if (set.files.normal && !set.dx) continue; // OpenGL-Variante behalten
        set.dx = isDirectXNormal(f.name);
        set.files.normal = f;
      } else if (!set.files[ch]) set.files[ch] = f;
    }
    if (!set.files.albedo && !set.files.normal) throw new Error('Keine Albedo- oder Normal-Map erkannt (Dateinamen wie *_albedo.png, *_normal.png).');
    const name = setNameFromFiles(imgs.map((f) => f.name)).replace(/[^\w.\- ]/g, '_');
    await tx('readwrite', (s) => s.put(set, name));
    const ref = `idb:${name}`;
    for (const k of [...setCache.keys()]) if (k.startsWith(ref + '@')) setCache.delete(k);
    this.thumbs.delete(ref);
    await this.refresh();
    invalidate();
    return ref;
  }

  async remove(ref: string): Promise<void> {
    await tx('readwrite', (s) => s.delete(ref.slice(4)));
    this.thumbs.delete(ref);
    await this.refresh();
  }

  /** Vorschaubild (URL) */
  thumbnail(ref: string): Promise<string> {
    let p = this.thumbs.get(ref);
    if (!p) {
      p = (async () => {
        if (ref.startsWith('/assets/')) {
          const s = projectSets.find((x) => `/assets/textures/${x.name}` === ref);
          if (s?.files.albedo) return s.files.albedo;
        }
        if (ref.startsWith('idb:')) {
          const s = await tx<StoredSet | undefined>('readonly', (st) => st.get(ref.slice(4)));
          if (s?.files.albedo) return URL.createObjectURL(s.files.albedo);
        }
        const d = resampleSet(await loadTextureSet(ref, PN), 128);
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d')!;
        const img = g.createImageData(128, 128);
        img.data.set(d.albedo);
        g.putImageData(img, 0, 0);
        return c.toDataURL();
      })();
      this.thumbs.set(ref, p);
    }
    return p;
  }
}

let lib: TextureLibrary | null = null;

/** Textur-Bibliothek (wird beim ersten Zugriff angelegt) */
export function textureLibrary(): TextureLibrary {
  return (lib ??= new TextureLibrary());
}
