import * as THREE from 'three';

// Prozedurale, kachelbare PBR-Texturen (Albedo + Normal + Roughness) aus Canvas.
// Konvention: eine Textur deckt 2m x 2m Weltfläche ab (siehe applyWorldUV in level.ts).

type RGB = [number, number, number];

export interface PBRSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

const SIZE = 512;

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) => smooth(clamp01((v - a) / (b - a)));

// Kachelbares fraktales Value-Noise, Ergebnis ~0..1
function valueNoise(cellsX: number, cellsY: number, octaves: number, seed: number, persistence = 0.5): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  const rand = mulberry32(seed);
  let amp = 1;
  let total = 0;
  let cx = cellsX;
  let cy = cellsY;
  for (let o = 0; o < octaves; o++) {
    const grid = new Float32Array(cx * cy);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    for (let y = 0; y < SIZE; y++) {
      const gy = (y / SIZE) * cy;
      const y0 = Math.floor(gy);
      const ty = smooth(gy - y0);
      const y1 = (y0 + 1) % cy;
      for (let x = 0; x < SIZE; x++) {
        const gx = (x / SIZE) * cx;
        const x0 = Math.floor(gx);
        const tx = smooth(gx - x0);
        const x1 = (x0 + 1) % cx;
        const a = grid[y0 * cx + x0];
        const b = grid[y0 * cx + x1];
        const c = grid[y1 * cx + x0];
        const d = grid[y1 * cx + x1];
        out[y * SIZE + x] += (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty) * amp;
      }
    }
    total += amp;
    amp *= persistence;
    cx *= 2;
    cy *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function canvasTexture(fill: (i: number) => RGB, isColor: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const [r, g, b] = fill(i);
    img.data[i * 4] = r * 255;
    img.data[i * 4 + 1] = g * 255;
    img.data[i * 4 + 2] = b * 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return tex;
}

function normalFromHeight(h: Float32Array, strength: number): THREE.CanvasTexture {
  return canvasTexture((i) => {
    const x = i % SIZE;
    const y = (i / SIZE) | 0;
    const l = h[y * SIZE + ((x - 1 + SIZE) % SIZE)];
    const r = h[y * SIZE + ((x + 1) % SIZE)];
    const up = h[((y - 1 + SIZE) % SIZE) * SIZE + x];
    const down = h[((y + 1) % SIZE) * SIZE + x];
    const nx = (l - r) * strength;
    const ny = (down - up) * strength;
    const len = Math.hypot(nx, ny, 1);
    return [(nx / len) * 0.5 + 0.5, (ny / len) * 0.5 + 0.5, 1 / len * 0.5 + 0.5];
  }, false);
}

function build(albedo: Float32Array, height: Float32Array, rough: Float32Array, normalStrength: number): PBRSet {
  return {
    map: canvasTexture((i) => [albedo[i * 3], albedo[i * 3 + 1], albedo[i * 3 + 2]], true),
    normalMap: normalFromHeight(height, normalStrength),
    roughnessMap: canvasTexture((i) => {
      const v = clamp01(rough[i]);
      return [v, v, v];
    }, false),
  };
}

// Ausgewaschener Beton mit Poren, Flecken und optionalen Schalungsfugen (alle 1m)
export function concrete(seed: number, tint: RGB, opts: { seams?: boolean; roughness?: number } = {}): PBRSet {
  const base = opts.roughness ?? 0.88;
  const h = valueNoise(4, 4, 7, seed, 0.55);
  const stains = valueNoise(2, 3, 4, seed + 1);
  const streaks = valueNoise(24, 2, 3, seed + 2); // vertikale Laufspuren
  const rand = mulberry32(seed + 3);
  const pits = new Float32Array(SIZE * SIZE);
  for (let k = 0; k < 2200; k++) {
    const px = (rand() * SIZE) | 0;
    const py = (rand() * SIZE) | 0;
    const rad = rand() < 0.85 ? 1 : 2;
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++)
        pits[((py + dy + SIZE) % SIZE) * SIZE + ((px + dx + SIZE) % SIZE)] = 1;
  }

  const albedo = new Float32Array(SIZE * SIZE * 3);
  const height = new Float32Array(SIZE * SIZE);
  const rough = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const y = (i / SIZE) | 0;
    let seam = 0;
    if (opts.seams) {
      const d = Math.min(y % (SIZE / 2), SIZE / 2 - (y % (SIZE / 2)));
      seam = d < 2 ? 1 : d < 4 ? 0.4 : 0;
    }
    const stain = smoothstep(0.48, 0.72, stains[i]);
    const streak = smoothstep(0.55, 0.8, streaks[i]) * 0.5;
    let shade = 0.78 + (h[i] - 0.5) * 0.7;
    shade *= 1 - stain * 0.28 - streak * 0.15 - pits[i] * 0.35 - seam * 0.35;
    albedo[i * 3] = tint[0] * shade;
    albedo[i * 3 + 1] = tint[1] * shade;
    albedo[i * 3 + 2] = tint[2] * shade;
    height[i] = h[i] - pits[i] * 0.25 - seam * 0.5;
    rough[i] = base + (h[i] - 0.5) * 0.2 - stain * 0.12 + pits[i] * 0.1;
  }
  return build(albedo, height, rough, 6);
}

// Industrie-Bodenfliesen 1m x 1m mit Fugen und Schmutz; leicht glänzend
export function floorTiles(seed: number): PBRSet {
  const grime = valueNoise(4, 4, 6, seed);
  const fine = valueNoise(32, 32, 3, seed + 1);
  const rand = mulberry32(seed + 2);
  const tileTint = [0, 1, 2, 3].map(() => 0.88 + rand() * 0.2);
  const tile = SIZE / 2;
  const albedo = new Float32Array(SIZE * SIZE * 3);
  const height = new Float32Array(SIZE * SIZE);
  const rough = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const x = i % SIZE;
    const y = (i / SIZE) | 0;
    const lx = x % tile;
    const ly = y % tile;
    const edge = Math.min(lx, ly, tile - 1 - lx, tile - 1 - ly);
    const grout = edge < 2 ? 1 : edge < 4 ? 0.5 : 0;
    const t = tileTint[((y / tile) | 0) * 2 + ((x / tile) | 0)];
    const dirt = smoothstep(0.4, 0.75, grime[i]);
    const shade = (0.7 + fine[i] * 0.2) * t * (1 - dirt * 0.4) * (1 - grout * 0.6);
    albedo[i * 3] = 0.42 * shade;
    albedo[i * 3 + 1] = 0.44 * shade;
    albedo[i * 3 + 2] = 0.42 * shade;
    height[i] = 0.6 + fine[i] * 0.08 - grout * 0.6;
    rough[i] = 0.42 + dirt * 0.45 + grout * 0.5 + (fine[i] - 0.5) * 0.1;
  }
  return build(albedo, height, rough, 5);
}

// Holzbretter (0.25m) mit Maserung und Spalten
export function woodPlanks(seed: number): PBRSet {
  const grain = valueNoise(2, 24, 5, seed);
  const blotch = valueNoise(4, 4, 4, seed + 1);
  const rand = mulberry32(seed + 2);
  const plank = SIZE / 8;
  const plankRand = Array.from({ length: 8 }, () => rand());
  const albedo = new Float32Array(SIZE * SIZE * 3);
  const height = new Float32Array(SIZE * SIZE);
  const rough = new Float32Array(SIZE * SIZE);
  const light: RGB = [0.5, 0.36, 0.22];
  const dark: RGB = [0.27, 0.17, 0.09];
  for (let i = 0; i < SIZE * SIZE; i++) {
    const y = (i / SIZE) | 0;
    const p = (y / plank) | 0;
    const ly = y % plank;
    const gap = ly < 2 ? 1 : ly < 3 ? 0.4 : 0;
    const ring = Math.sin((grain[i] * 14 + plankRand[p] * 6) * Math.PI) * 0.5 + 0.5;
    const tone = (0.8 + plankRand[p] * 0.35) * (0.85 + blotch[i] * 0.3) * (1 - gap * 0.8);
    for (let c = 0; c < 3; c++) albedo[i * 3 + c] = (dark[c] + (light[c] - dark[c]) * ring) * tone;
    height[i] = ring * 0.15 - gap * 0.6;
    rough[i] = 0.7 + ring * 0.15 + gap * 0.2;
  }
  return build(albedo, height, rough, 4);
}

export function withRepeat(set: PBRSet, rx: number, ry: number): PBRSet {
  const c = (t: THREE.Texture) => {
    const n = t.clone();
    n.repeat.set(rx, ry);
    n.needsUpdate = true;
    return n;
  };
  return { map: c(set.map), normalMap: c(set.normalMap), roughnessMap: c(set.roughnessMap) };
}

export function pbrMaterial(set: PBRSet, anisotropy: number, extra: THREE.MeshStandardMaterialParameters = {}) {
  for (const t of [set.map, set.normalMap, set.roughnessMap]) t.anisotropy = anisotropy;
  return new THREE.MeshStandardMaterial({
    map: set.map,
    normalMap: set.normalMap,
    roughnessMap: set.roughnessMap,
    roughness: 1,
    metalness: 0,
    ...extra,
  });
}
