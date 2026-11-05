import * as THREE from 'three';
import type { LandscapeData } from '../landscape/data.ts';
import { liveLandscapes, type LandscapeRenderer } from '../landscape/render.ts';
import { foliageQuality } from './render.ts';
import { grassClearAt, onRoadZonesChanged } from '../splines/zones.ts';

// Layer-Gras: wächst automatisch rund um die Kamera, wo Landscape-Layer mit Gras-Art liegen (Gewicht aus
// Auto-Regeln + Splatmap). Wird nicht gespeichert, sondern in 16-m-Kacheln erzeugt (höchstens ein paar je Frame).
// Je Kachel ein InstancedBufferGeometry mit Büscheln aus drei Halmen; der Vertex-Shader baut die Halme,
// dünnt zur Sichtgrenze hin aus (Instanzen nach Rang sortiert → Zeichenanzahl je Kachel), biegt im Wind
// und weicht Spieler/NPCs aus (Spur der letzten Schritte richtet sich langsam wieder auf).

export interface GrassPreset {
  id: string;
  label: string;
  /** Halmhöhe (m) */
  height: number;
  /** Halmbreite unten (m) */
  width: number;
  base: string;
  tip: string;
  /** Faktor auf die Dichte */
  density: number;
}

export const GRASS_PRESETS: GrassPreset[] = [
  { id: 'wiese', label: 'Wiese', height: 0.45, width: 0.05, base: '#2c4a1a', tip: '#7c9c42', density: 1 },
  { id: 'kurz', label: 'Kurzes Gras', height: 0.2, width: 0.035, base: '#324f1d', tip: '#77a044', density: 1.3 },
  { id: 'hoch', label: 'Hohes Gras', height: 0.9, width: 0.06, base: '#36501e', tip: '#99a453', density: 0.7 },
  { id: 'trocken', label: 'Trockenes Gras', height: 0.5, width: 0.045, base: '#5f5a2c', tip: '#c4b067', density: 0.9 },
];

const PRESET_INDEX = new Map(GRASS_PRESETS.map((p, i) => [p.id, i]));
const NP = GRASS_PRESETS.length;

const TILE = 16;
/** Büschel je m² bei Dichte 1 und voller Qualität */
const BASE_DENSITY = 14;
/** Sichtweite des Grases bei Entfernungs-Faktor 1 */
const BASE_RANGE = 45;
/** Gras-Ausweicher (Spieler, NPCs, Spur) */
const BENDERS = 8;

let enabled = true;

/** Grafik-Einstellung „Gras“ */
export function setGrassEnabled(on: boolean): void {
  enabled = on;
  for (const f of fields.values()) f.group.visible = on;
}

export function grassEnabled(): boolean {
  return enabled;
}

// ---------- Material ----------

const U = {
  uGWind: { value: new THREE.Vector3() },
  uGTime: { value: 0 },
  uGRange: { value: BASE_RANGE },
  uGBend: { value: Array.from({ length: BENDERS }, () => new THREE.Vector4(0, -1e6, 0, 0)) },
  uGBase: { value: GRASS_PRESETS.map((p) => new THREE.Color(p.base)) },
  uGTip: { value: GRASS_PRESETS.map((p) => new THREE.Color(p.tip)) },
};

const VERT_HEAD = /* glsl */ `
attribute vec4 aPos;
attribute vec4 aShape;
uniform vec3 uGWind;
uniform float uGTime;
uniform float uGRange;
uniform vec4 uGBend[${BENDERS}];
uniform vec3 uGBase[${NP}];
uniform vec3 uGTip[${NP}];
varying vec3 vGCol;
`;

const VERT_BODY = /* glsl */ `
float gT = position.y;
float gIdx = position.z;
float gRank = aPos.w;
vec3 gW0 = (modelMatrix * vec4(aPos.xyz, 1.0)).xyz;
float gDist = distance(cameraPosition, gW0);
float gKeep = clamp(1.0 - (gDist - uGRange * 0.3) / (uGRange * 0.7), 0.0, 1.0);
float gGrow = clamp((gKeep - gRank) / 0.08, 0.0, 1.0);
float gRnd = fract(sin(gIdx * 12.9898 + gRank * 7919.0) * 43758.5453);
float gH = aShape.x * gGrow * (0.75 + 0.5 * gRnd);
// weiter weg weniger, dafür breitere Halme (Deckung bleibt ähnlich)
float gWid = aShape.y * min(2.5, inversesqrt(max(gKeep, 0.16)));
float gA = aShape.z + gIdx * 2.0944;
vec2 gAcross = vec2(cos(gA), sin(gA));
vec2 gFace = vec2(-gAcross.y, gAcross.x);
float gLean = 0.2 + 0.35 * fract(gRank * 131.0 + gIdx * 0.37);
vec3 transformed = aPos.xyz;
transformed.xz += gFace * (0.07 * (gIdx - 1.0)) + gAcross * (position.x * gWid) + gFace * (gLean * gT * gT * gH);
transformed.y += gT * gH * (1.0 - 0.15 * gLean);
// Wind
float gPh = dot(gW0.xz, vec2(0.13, 0.11));
float gGust = 0.55 + 0.45 * sin(uGTime * 1.3 + gPh) * sin(uGTime * 0.41 + gPh * 1.9);
float gFlut = 0.15 * sin(uGTime * 6.1 + gPh * 4.0 + gIdx * 2.0);
vec2 gWd = uGWind.xz * (0.035 * gT * gT * gH * (gGust + gFlut));
// Ausweichen
vec2 gBd = vec2(0.0);
float gBf = 0.0;
for (int i = 0; i < ${BENDERS}; i++) {
  vec4 b = uGBend[i];
  vec2 dd = gW0.xz - b.xz;
  float dl = length(dd);
  float f = b.w * (1.0 - smoothstep(0.15, 0.9, dl)) * step(abs(gW0.y - b.y), 1.6);
  gBd += dd / max(dl, 0.05) * f;
  gBf = max(gBf, f);
}
transformed.xz += gWd + gBd * (gT * gH * 0.8);
transformed.y -= (length(gWd) * 0.35 + gBf * 0.55 * gH) * gT;
int gP = int(aShape.w + 0.5);
vGCol = mix(uGBase[gP], uGTip[gP], gT) * mix(0.55, 1.0, gT) * (0.85 + 0.3 * fract(gRank * 977.0));
`;

let material: THREE.MeshStandardMaterial | null = null;

function grassMaterial(): THREE.MeshStandardMaterial {
  if (material) return material;
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
  m.userData.noWeather = true;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGCol;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vGCol;')
      // beide Seiten wie die Oberseite beleuchten (Normale zeigt nach oben)
      // (ohne normal-Attribut setzt three FLAT_SHADED, vNormal gibt es dann nicht)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);');
  };
  m.customProgramCacheKey = () => 'layer-grass';
  return (material = m);
}

/** Büschel aus drei Halmen: x = quer (mit Verjüngung), y = 0..1 Höhe, z = Halm-Index */
let tuft: { position: THREE.BufferAttribute; index: THREE.BufferAttribute } | null = null;

function tuftGeometry(): NonNullable<typeof tuft> {
  if (tuft) return tuft;
  const pos: number[] = [];
  const idx: number[] = [];
  const rows: [number, number][] = [
    [0, 1],
    [0.4, 0.85],
    [0.75, 0.5],
  ];
  for (let b = 0; b < 3; b++) {
    const base = pos.length / 3;
    for (const [t, w] of rows) pos.push(-0.5 * w, t, b, 0.5 * w, t, b);
    pos.push(0, 1, b);
    for (let r = 0; r < 2; r++) {
      const a = base + r * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    idx.push(base + 4, base + 5, base + 6);
  }
  return (tuft = { position: new THREE.Float32BufferAttribute(pos, 3), index: new THREE.Uint16BufferAttribute(idx, 1) });
}

// ---------- Kacheln ----------

interface Tile {
  tx: number;
  tz: number;
  mesh: THREE.Mesh | null;
  ranks: Float32Array;
  minY: number;
  maxY: number;
  dirty: boolean;
}

const tkey = (tx: number, tz: number) => (tx + 32768) * 65536 + (tz + 32768);

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const S = 17;
const _g = Array.from({ length: NP }, () => new Float32Array(S * S));
const _inv = new THREE.Matrix4();
const _cam = new THREE.Vector3();
const noRaycast = () => {};
const _org = new THREE.Vector3();

class GrassField {
  readonly group = new THREE.Group();
  private tiles = new Map<number, Tile>();
  private off: () => void;
  private offZones: () => void;
  private sig = '';

  constructor(readonly ls: LandscapeRenderer) {
    this.group.name = 'Layer-Gras';
    this.group.userData.noWeather = true;
    this.group.userData.noPick = true;
    this.group.userData.noOutline = true;
    this.group.visible = enabled;
    ls.mesh.add(this.group);
    this.off = ls.data.onChange((r, kind) => {
      const d = ls.data;
      if (kind === 'layers') return this.dirtyAll();
      // Rechteck → Gitterpunkte
      let gx0 = r.x;
      let gz0 = r.y;
      let gx1 = r.x + r.w;
      let gz1 = r.y + r.h;
      if (kind === 'holes') {
        gx0 /= d.holeSub;
        gx1 /= d.holeSub;
        gz0 /= d.holeSub;
        gz1 /= d.holeSub;
      } else if (kind === 'grass') {
        const k = d.splatDiv;
        gx0 *= k;
        gx1 *= k;
        gz0 *= k;
        gz1 *= k;
      } else if (kind === 'splat') {
        const k = d.splatDiv;
        const sh = d.SH;
        // zwei Ebenen übereinander: Rechteck über die Grenze → ganze Höhe
        if (Math.floor(r.y / sh) !== Math.floor((r.y + r.h - 1) / sh)) {
          gz0 = 0;
          gz1 = d.H;
        } else {
          gz0 = (r.y % sh) * k;
          gz1 = gz0 + r.h * k;
        }
        gx0 *= k;
        gx1 *= k;
      }
      this.dirtyBox(d.fromGridX(gx0) - 1, d.fromGridZ(gz0) - 1, d.fromGridX(gx1) + 1, d.fromGridZ(gz1) + 1);
    });
    // Straßen (Welt) entfernen Gras darunter
    this.offZones = onRoadZonesChanged((b) => {
      const o = this.origin();
      this.dirtyBox(b.minX - o.x - 1, b.minZ - o.z - 1, b.maxX - o.x + 1, b.maxZ - o.z + 1);
    });
  }

  /** Welt-Position der Landscape (Landscapes sind nicht gedreht/skaliert: Welt = lokal + Position) */
  private origin(): THREE.Vector3 {
    this.ls.mesh.updateWorldMatrix(true, false);
    return _org.setFromMatrixPosition(this.ls.mesh.matrixWorld);
  }

  private dirtyAll(): void {
    for (const t of this.tiles.values()) t.dirty = true;
  }

  private dirtyBox(x0: number, z0: number, x1: number, z1: number): void {
    for (const t of this.tiles.values()) {
      const ax = t.tx * TILE;
      const az = t.tz * TILE;
      if (ax <= x1 && ax + TILE >= x0 && az <= z1 && az + TILE >= z0) t.dirty = true;
    }
  }

  /** Abstand (lokal) zur Kachel, Höhe über die Min/Max-Grenzen */
  private dist(t: Tile, cam: THREE.Vector3): number {
    const dx = Math.max(t.tx * TILE - cam.x, 0, cam.x - (t.tx + 1) * TILE);
    const dz = Math.max(t.tz * TILE - cam.z, 0, cam.z - (t.tz + 1) * TILE);
    const dy = Math.max(t.minY - cam.y, 0, cam.y - t.maxY - 1);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Kacheln verwalten (höchstens eine neue je Aufruf, im Rahmen des Zeitbudgets) */
  update(range: number, budget: { left: number; until: number }): void {
    const sig = `${foliageQuality.density}|${range}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.dirtyAll();
    }
    const mesh = this.ls.mesh;
    mesh.updateWorldMatrix(true, false);
    _inv.copy(mesh.matrixWorld).invert();
    const cam = _cam.copy(camPos).applyMatrix4(_inv);
    const d = this.ls.data;
    const hx = d.sizeX / 2;
    const hz = d.sizeZ / 2;
    // weg mit fernen Kacheln
    for (const [k, t] of this.tiles)
      if (this.dist(t, cam) > range + TILE * 1.5) {
        this.drop(t);
        this.tiles.delete(k);
      }
    // fehlende/veraltete: die nächste zuerst
    let best: { tx: number; tz: number; d: number } | null = null;
    const tx0 = Math.floor(Math.max(-hx, cam.x - range) / TILE);
    const tx1 = Math.floor(Math.min(hx - 0.001, cam.x + range) / TILE);
    const tz0 = Math.floor(Math.max(-hz, cam.z - range) / TILE);
    const tz1 = Math.floor(Math.min(hz - 0.001, cam.z + range) / TILE);
    if (tx1 - tx0 > 64 || tz1 - tz0 > 64) return;
    for (let tz = tz0; tz <= tz1; tz++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.tiles.get(tkey(tx, tz));
        if (t && !t.dirty) continue;
        const dx = Math.max(tx * TILE - cam.x, 0, cam.x - (tx + 1) * TILE);
        const dz = Math.max(tz * TILE - cam.z, 0, cam.z - (tz + 1) * TILE);
        let dd = Math.sqrt(dx * dx + dz * dz);
        if (t) dd = this.dist(t, cam);
        else {
          const h = d.heightAt(Math.min(hx, Math.max(-hx, cam.x)), Math.min(hz, Math.max(-hz, cam.z)));
          // grob über der Höhe des Bodens an der Kamera
          if (h !== null) dd = Math.hypot(dd, Math.max(0, cam.y - h - 2));
        }
        if (dd > range) continue;
        if (!best || dd < best.d) best = { tx, tz, d: dd };
      }
    while (best && budget.left > 0 && performance.now() < budget.until) {
      budget.left--;
      this.build(best.tx, best.tz);
      best = null;
    }
    // Zeichenanzahl je Kachel (nach Rang sortiert)
    for (const t of this.tiles.values()) {
      if (!t.mesh) continue;
      const dist = this.dist(t, cam);
      const keep = Math.min(1, Math.max(0, 1 - (dist - range * 0.3) / (range * 0.7))) + 0.02;
      const r = t.ranks;
      let lo = 0;
      let hi = r.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (r[m] < keep) lo = m + 1;
        else hi = m;
      }
      (t.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = lo;
      t.mesh.visible = lo > 0;
    }
  }

  private drop(t: Tile): void {
    if (!t.mesh) return;
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    t.mesh = null;
  }

  private build(tx: number, tz: number): void {
    const d: LandscapeData = this.ls.data;
    const k = tkey(tx, tz);
    const old = this.tiles.get(k);
    if (old) this.drop(old);
    const x0 = tx * TILE;
    const z0 = tz * TILE;
    const step = TILE / (S - 1);
    const org = this.origin();
    const ox = org.x;
    const oz = org.z;
    // Gras-Gewicht je Art an 17×17 Stützstellen
    for (const g of _g) g.fill(0);
    const L = d.layers;
    const gi = L.map((l) => (l.grass.type ? PRESET_INDEX.get(l.grass.type) ?? -1 : -1));
    let any = false;
    let minY = Infinity;
    let maxY = -Infinity;
    if (gi.some((p) => p >= 0))
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) {
          const x = x0 + i * step;
          const z = z0 + j * step;
          const gx = d.toGridX(x);
          const gz = d.toGridZ(z);
          if (gx < 0 || gz < 0 || gx > d.W || gz > d.H) continue;
          // im Foliage-Modus radiertes Gras
          let keep = d.grassAt(gx, gz);
          // unter Straßen kein Gras
          if (keep > 0) keep *= 1 - grassClearAt(x + ox, z + oz);
          if (keep <= 0) continue;
          const w = d.layerWeights(gx, gz);
          for (let l = 0; l < L.length; l++) {
            const p = gi[l];
            if (p < 0 || w[l] <= 0) continue;
            _g[p][j * S + i] += w[l] * keep * L[l].grass.density * GRASS_PRESETS[p].density;
            any = true;
          }
        }
    const tile: Tile = { tx, tz, mesh: null, ranks: new Float32Array(0), minY: 0, maxY: 0, dirty: false };
    this.tiles.set(k, tile);
    // Höhenbereich auch ohne Gras merken (Abstand)
    for (let j = 0; j < S; j += 4)
      for (let i = 0; i < S; i += 4) {
        const h = d.heightAt(Math.min(d.sizeX / 2, x0 + i * step), Math.min(d.sizeZ / 2, z0 + j * step));
        if (h === null) continue;
        minY = Math.min(minY, h);
        maxY = Math.max(maxY, h);
      }
    tile.minY = Number.isFinite(minY) ? minY : 0;
    tile.maxY = Number.isFinite(maxY) ? maxY : 0;
    if (!any) return;

    const N = Math.round(TILE * TILE * BASE_DENSITY * foliageQuality.density);
    const rnd = mulberry(k * 2654435761);
    const pos = new Float32Array(N * 4);
    const shape = new Float32Array(N * 4);
    const ranks = new Float32Array(N);
    const gp = new Float32Array(NP);
    let n = 0;
    for (let c = 0; c < N; c++) {
      const u = rnd() * (S - 1);
      const v = rnd() * (S - 1);
      const keep = rnd();
      const pick = rnd();
      const yaw = rnd() * Math.PI * 2;
      const hs = rnd();
      const ws = rnd();
      const i = Math.min(S - 2, Math.floor(u));
      const j = Math.min(S - 2, Math.floor(v));
      const fx = u - i;
      const fz = v - j;
      let total = 0;
      for (let p = 0; p < NP; p++) {
        const g = _g[p];
        const a = j * S + i;
        const val = (g[a] * (1 - fx) + g[a + 1] * fx) * (1 - fz) + (g[a + S] * (1 - fx) + g[a + S + 1] * fx) * fz;
        gp[p] = val;
        total += val;
      }
      if (keep >= Math.min(1, total)) continue;
      let p = 0;
      let acc = gp[0];
      const target = pick * total;
      while (p < NP - 1 && acc < target) acc += gp[++p];
      const x = x0 + u * step;
      const z = z0 + v * step;
      const y = d.heightAt(x, z);
      if (y === null) continue;
      const pr = GRASS_PRESETS[p];
      // Halmhöhe folgt dem Gewicht (Ränder niedriger)
      const fill = Math.min(1, total / pr.density);
      pos[n * 4] = x;
      pos[n * 4 + 1] = y - 0.02;
      pos[n * 4 + 2] = z;
      pos[n * 4 + 3] = c / N;
      shape[n * 4] = pr.height * (0.7 + 0.6 * hs) * (0.55 + 0.45 * fill);
      shape[n * 4 + 1] = pr.width * (0.8 + 0.4 * ws);
      shape[n * 4 + 2] = yaw;
      shape[n * 4 + 3] = p;
      ranks[n] = c / N;
      n++;
    }
    if (!n) return;
    const tg = tuftGeometry();
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(tg.index);
    geo.setAttribute('position', tg.position);
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos.slice(0, n * 4), 4));
    geo.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape.slice(0, n * 4), 4));
    geo.instanceCount = n;
    const cy = (tile.minY + tile.maxY) / 2;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(x0 + TILE / 2, cy, z0 + TILE / 2), TILE * 0.75 + (tile.maxY - tile.minY) / 2 + 1.5);
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(x0, tile.minY - 0.5, z0), new THREE.Vector3(x0 + TILE, tile.maxY + 1.5, z0 + TILE));
    const m = new THREE.Mesh(geo, grassMaterial());
    m.receiveShadow = true;
    m.castShadow = false;
    m.raycast = noRaycast;
    m.userData.noPick = true;
    m.userData.noOutline = true;
    m.userData.noShot = true;
    m.userData.noWeather = true;
    m.name = 'Gras';
    m.matrixAutoUpdate = false;
    this.group.add(m);
    tile.mesh = m;
    tile.ranks = ranks.slice(0, n);
  }

  /** Anzahl Büschel (Statistik) */
  count(): number {
    let n = 0;
    for (const t of this.tiles.values()) if (t.mesh) n += (t.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
    return n;
  }

  dispose(): void {
    this.off();
    this.offZones();
    for (const t of this.tiles.values()) this.drop(t);
    this.tiles.clear();
    this.group.removeFromParent();
  }
}

// ---------- global ----------

const fields = new Map<LandscapeRenderer, GrassField>();
const camPos = new THREE.Vector3();

interface TrailPoint {
  p: THREE.Vector3;
  age: number;
}
const trail: TrailPoint[] = [];
const TRAIL = BENDERS - 3;
const TRAIL_LIFE = 2.5;

/**
 * Jeden Frame vor dem Rendern: Kacheln nachführen, Wind und Ausweicher setzen.
 * `benders`: Fußpunkte (Welt) von Spieler und NPCs in der Nähe — der erste hinterlässt eine Spur.
 */
export function updateGrass(camera: THREE.Camera, dt: number, wind: THREE.Vector3, benders: readonly THREE.Vector3[] = []): void {
  U.uGWind.value.copy(wind);
  U.uGTime.value += dt;
  const range = BASE_RANGE * foliageQuality.distance;
  U.uGRange.value = range;
  // Spur des ersten Ausweichers
  for (const t of trail) t.age += dt;
  while (trail.length && trail[0].age > TRAIL_LIFE) trail.shift();
  const lead = benders[0];
  if (lead && (!trail.length || trail[trail.length - 1].p.distanceToSquared(lead) > 0.45 * 0.45)) {
    trail.push({ p: lead.clone(), age: 0 });
    if (trail.length > TRAIL) trail.shift();
  }
  const bv = U.uGBend.value;
  let b = 0;
  for (let i = 0; i < benders.length && b < BENDERS - TRAIL; i++) bv[b++].set(benders[i].x, benders[i].y, benders[i].z, 1);
  for (let i = trail.length - 1; i >= 0 && b < BENDERS; i--) {
    const t = trail[i];
    bv[b++].set(t.p.x, t.p.y, t.p.z, 0.85 * (1 - t.age / TRAIL_LIFE) ** 2);
  }
  for (; b < BENDERS; b++) bv[b].set(0, -1e6, 0, 0);

  // Felder zu den Landscapes in der Szene
  const seen = new Set<LandscapeRenderer>();
  for (const ls of liveLandscapes()) {
    seen.add(ls);
    if (!fields.has(ls)) fields.set(ls, new GrassField(ls));
  }
  for (const [ls, f] of fields)
    if (!seen.has(ls) || f.group.parent !== ls.mesh) {
      f.dispose();
      fields.delete(ls);
    }
  if (!enabled) return;
  camera.updateMatrixWorld();
  camPos.setFromMatrixPosition(camera.matrixWorld);
  const budget = { left: 4, until: performance.now() + 2 };
  for (const f of fields.values()) f.update(range, budget);
}

/** gezeichnete Gras-Büschel (Statistik) */
export function grassCount(): number {
  let n = 0;
  if (enabled) for (const f of fields.values()) n += f.count();
  return n;
}

/** alles verwerfen (Map-Wechsel) */
export function resetGrass(): void {
  for (const f of fields.values()) f.dispose();
  fields.clear();
  trail.length = 0;
}
