import type { SurfaceId } from '../surfaces.ts';

// Landscape-Layer (wie Paint Layers im UE5-Landscape-Material): je Layer eine Textur, Kachelgröße, Farbton,
// Oberflächentyp und optional eine Auto-Regel (Neigung, Höhe, Krümmung, Rauschen).
// Gemalte Gewichte liegen in der Splatmap (8 Kanäle, `ch`), Auto-Regeln gelten dort, wo nichts gemalt ist.
// Reihenfolge: Index 0 = Basis (füllt alles, was keine Regel abdeckt); höhere Indizes liegen darüber.

export const MAX_LAYERS = 8;

export interface LayerAuto {
  on: boolean;
  /** Neigung in Grad (0 = flach, 90 = senkrecht) */
  slopeMin: number;
  slopeMax: number;
  /** Höhe in Metern relativ zur Landscape */
  heightMin: number;
  heightMax: number;
  /** -1 = nur in Mulden/Tälern, 0 = egal, 1 = nur auf Kuppen/Graten */
  curv: number;
  /** weicher Übergang 0..1 */
  soft: number;
  /** Rauschen am Rand 0..1 (bricht gerade Grenzen auf) */
  noise: number;
}

export interface LandscapeLayer {
  id: string;
  name: string;
  /** Splatmap-Kanal 0..7 (bleibt beim Umsortieren gleich) */
  ch: number;
  /** "proc:<art>", "/assets/textures/<name>" oder "idb:<name>" */
  texture: string;
  /** Kachelgröße in Metern */
  tile: number;
  /** Farbton (multipliziert) */
  tint: string;
  /** Faktor auf die Rauheit */
  rough: number;
  /** Stärke der Normal-Map */
  normal: number;
  surface: SurfaceId;
  auto: LayerAuto;
  /** Layer-Gras: wächst automatisch rund um die Kamera nach Layer-Gewicht (wird nicht gespeichert) */
  grass: LayerGrass;
}

export interface LayerGrass {
  /** Gras-Art (foliage/grass.ts, GRASS_PRESETS) oder '' = keins */
  type: string;
  /** 0..1 Dichte */
  density: number;
}

export const NO_GRASS: LayerGrass = { type: '', density: 0.7 };

export const NO_AUTO: LayerAuto = { on: false, slopeMin: 0, slopeMax: 90, heightMin: -10000, heightMax: 10000, curv: 0, soft: 0.3, noise: 0.3 };

let counter = 0;
export function layerId(): string {
  return `L${Date.now().toString(36)}${(counter++).toString(36)}`;
}

export function makeLayer(ch: number, name: string, texture: string, surface: SurfaceId, tile: number, auto: Partial<LayerAuto> | null = null): LandscapeLayer {
  return {
    id: layerId(),
    name,
    ch,
    texture,
    tile,
    tint: '#ffffff',
    rough: 1,
    normal: 1,
    surface,
    auto: auto ? { ...NO_AUTO, on: true, ...auto } : { ...NO_AUTO },
    grass: { ...NO_GRASS },
  };
}

/** Standard-Layer neuer Landscapes: Gras als Basis, Erde an mittleren Hängen, Fels an steilen, Kies zum Malen */
export function defaultLayers(rockSlope = 38): LandscapeLayer[] {
  const gras = makeLayer(0, 'Gras', 'proc:gras', 'gras', 3);
  gras.grass = { type: 'wiese', density: 0.8 };
  return [
    gras,
    makeLayer(1, 'Erde', 'proc:erde', 'erde', 3, { slopeMin: Math.max(5, rockSlope - 16), slopeMax: rockSlope + 2, soft: 0.45, noise: 0.6 }),
    makeLayer(2, 'Fels', 'proc:fels', 'fels', 7, { slopeMin: rockSlope - 2, soft: 0.25, noise: 0.45 }),
    makeLayer(3, 'Kies', 'proc:kies', 'kies', 2),
  ];
}

/** Layer aus JSON lesen (fehlerhafte Einträge werden ergänzt/verworfen) */
export function parseLayers(json: unknown): LandscapeLayer[] | null {
  if (typeof json !== 'string' || !json) return null;
  try {
    const raw = JSON.parse(json) as Partial<LandscapeLayer>[];
    if (!Array.isArray(raw)) return null;
    const used = new Set<number>();
    const out: LandscapeLayer[] = [];
    for (const l of raw.slice(0, MAX_LAYERS)) {
      if (!l || typeof l !== 'object') continue;
      let ch = typeof l.ch === 'number' ? l.ch : -1;
      if (ch < 0 || ch >= MAX_LAYERS || used.has(ch)) ch = freeChannel(used);
      used.add(ch);
      out.push({
        id: typeof l.id === 'string' ? l.id : layerId(),
        name: typeof l.name === 'string' ? l.name : 'Layer',
        ch,
        texture: typeof l.texture === 'string' ? l.texture : 'proc:erde',
        tile: typeof l.tile === 'number' && l.tile > 0 ? l.tile : 3,
        tint: typeof l.tint === 'string' ? l.tint : '#ffffff',
        rough: typeof l.rough === 'number' ? l.rough : 1,
        normal: typeof l.normal === 'number' ? l.normal : 1,
        surface: (typeof l.surface === 'string' ? l.surface : 'erde') as SurfaceId,
        auto: { ...NO_AUTO, ...(l.auto ?? {}) },
        grass: {
          type: typeof l.grass?.type === 'string' ? l.grass.type : '',
          density: typeof l.grass?.density === 'number' ? Math.min(1, Math.max(0, l.grass.density)) : NO_GRASS.density,
        },
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export function freeChannel(used: Set<number>): number {
  for (let c = 0; c < MAX_LAYERS; c++) if (!used.has(c)) return c;
  return -1;
}

export function cloneLayers(l: LandscapeLayer[]): LandscapeLayer[] {
  return l.map((x) => ({ ...x, auto: { ...x.auto }, grass: { ...x.grass } }));
}

// ---------- Auto-Regel (gleiche Formeln wie im Shader, render.ts) ----------

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

/** Abdeckung 0..1 einer Auto-Regel; slope in Grad, height in m, curv > 0 = Kuppe, noise 0..1 */
export function autoCoverage(a: LayerAuto, slope: number, height: number, curv: number, noise: number): number {
  if (!a.on) return 0;
  const n = (noise - 0.5) * a.noise;
  const s = slope + n * 30;
  const hgt = height + n * 25;
  const ss = 1 + a.soft * 14;
  const hs = 0.5 + a.soft * 20;
  let c = a.slopeMin > 0.5 ? sstep(a.slopeMin - ss, a.slopeMin + ss, s) : 1;
  if (a.slopeMax < 89.5) c *= 1 - sstep(a.slopeMax - ss, a.slopeMax + ss, s);
  if (a.heightMin > -9999) c *= sstep(a.heightMin - hs, a.heightMin + hs, hgt);
  if (a.heightMax < 9999) c *= 1 - sstep(a.heightMax - hs, a.heightMax + hs, hgt);
  if (a.curv !== 0) {
    const k = Math.max(-1, Math.min(1, curv * 6)) * Math.sign(a.curv) + n * 0.6;
    c *= 1 + (sstep(-0.15, 0.35, k) - 1) * Math.abs(a.curv);
  }
  return c;
}

// ---------- Rauschen (identisch im Shader: lsHashU / lsVNoise in render.ts) ----------

function hashU(x: number, y: number): number {
  let h = (Math.imul(x | 0, 1597334677) ^ Math.imul(y | 0, -482951495)) >>> 0; // 3812015801 als int32
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function vnoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  let fx = x - ix;
  let fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = hashU(ix, iz);
  const b = hashU(ix + 1, iz);
  const c = hashU(ix, iz + 1);
  const d = hashU(ix + 1, iz + 1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

/** Rand-Rauschen der Auto-Regeln (0..1) an Position p (m, ab der Landscape-Ecke) */
export function autoNoise(px: number, pz: number): number {
  return vnoise(px / 7, pz / 7) * 0.65 + vnoise(px / 2.3 + 17, pz / 2.3 + 5) * 0.35;
}
