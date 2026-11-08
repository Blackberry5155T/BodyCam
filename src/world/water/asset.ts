import * as THREE from 'three';
import type { AssetContext, AssetDef, AssetInstance, PropDef } from '../assets.ts';
import type { MapObjectData, PropValue } from '../mapFormat.ts';
import { SplineCurve, parsePoints, type SplineSample } from '../splines/curve.ts';
import { addDeformSource, removeDeformSource, riverDeform, type DeformSource } from '../splines/deform.ts';
import { WATER_LAYER, createWaterMaterial } from './material.ts';
import { insidePolygon, registerWater, unregisterWater, type WaterBody, type WaterKind, type WaterLook, type WaterSample } from './registry.ts';
import { makeWaves, type WaveSet } from './waves.ts';

// Wasser-Assets (Phase 6, wie UE5 Water Body Lake/River/Ocean):
//  - waterlake:  See — geschlossene Umriss-Spline, flache Fläche auf Objekthöhe (Wasserhöhe = Position Y)
//  - waterriver: Fluss — Spline mit Breite je Punkt, Strömung in Kurvenrichtung, gräbt im Editor sein Bett
//  - waterocean: Meer — unendliche Fläche auf Objekthöhe mit Gerstner-Wellen, folgt der Kamera
// Punkte stehen als JSON in props.points (lokal zur Objektposition); bearbeitet werden sie im Wasser-Modus.

export const LAKE_TYPE = 'waterlake';
export const RIVER_TYPE = 'waterriver';
export const OCEAN_TYPE = 'waterocean';
/** Wasserquelle mit Flachwasser-Simulation (source.ts) */
export const SOURCE_TYPE = 'watersource';
export const WATER_TYPES = new Set([LAKE_TYPE, RIVER_TYPE, OCEAN_TYPE, SOURCE_TYPE]);

export const num = (o: MapObjectData, k: string, d: number) => (typeof o.props[k] === 'number' && Number.isFinite(o.props[k]) ? (o.props[k] as number) : d);
export const bool = (o: MapObjectData, k: string, d: boolean) => (typeof o.props[k] === 'boolean' ? (o.props[k] as boolean) : d);
export const str = (o: MapObjectData, k: string, d: string) => (typeof o.props[k] === 'string' && o.props[k] ? (o.props[k] as string) : d);

const POINTS: PropDef = { key: 'points', label: 'Punkte', type: 'text', default: '[]', hidden: true };

export interface LookDefaults {
  color: string;
  murk: number;
  clarity: number;
  foam: number;
  waveHeight: number;
  waveLength: number;
}

export function lookProps(d: LookDefaults): PropDef[] {
  return [
    { key: 'color', label: 'Farbe', type: 'color', default: d.color, group: 'Wasser' },
    { key: 'murk', label: 'Trübung', type: 'number', default: d.murk, min: 0, max: 1, step: 0.05, group: 'Wasser' },
    { key: 'clarity', label: 'Sichttiefe (m)', type: 'number', default: d.clarity, min: 0.2, max: 60, step: 0.1, group: 'Wasser' },
    { key: 'foam', label: 'Schaum', type: 'number', default: d.foam, min: 0, max: 1, step: 0.05, group: 'Wasser' },
    { key: 'waveHeight', label: 'Wellenhöhe (m)', type: 'number', default: d.waveHeight, min: 0, max: 8, step: 0.01, group: 'Wellen' },
    { key: 'waveLength', label: 'Wellenlänge (m)', type: 'number', default: d.waveLength, min: 0.5, max: 200, step: 0.5, group: 'Wellen' },
    { key: 'waveDir', label: 'Richtung (°)', type: 'number', default: 30, min: -360, max: 360, step: 1, group: 'Wellen' },
  ];
}

export function readLook(o: MapObjectData, d: LookDefaults): { look: WaterLook; waves: WaveSet; dir: number } {
  const dir = num(o, 'waveDir', 30);
  return {
    look: {
      color: new THREE.Color(str(o, 'color', d.color)),
      murk: THREE.MathUtils.clamp(num(o, 'murk', d.murk), 0, 1),
      clarity: Math.max(0.2, num(o, 'clarity', d.clarity)),
      foam: THREE.MathUtils.clamp(num(o, 'foam', d.foam), 0, 1),
    },
    waves: makeWaves(num(o, 'waveHeight', d.waveHeight), num(o, 'waveLength', d.waveLength), dir),
    dir,
  };
}

const LAKE_LOOK: LookDefaults = { color: '#3f8a8c', murk: 0.25, clarity: 4, foam: 0.4, waveHeight: 0.1, waveLength: 5 };
const RIVER_LOOK: LookDefaults = { color: '#5a8a6e', murk: 0.4, clarity: 2.5, foam: 0.5, waveHeight: 0.03, waveLength: 3 };
const OCEAN_LOOK: LookDefaults = { color: '#2a6f8f', murk: 0.08, clarity: 14, foam: 0.6, waveHeight: 1.2, waveLength: 26 };

// ---------- Editor-Helfer ----------

export const HELPER_COLOR = '#4fc3f7';

/** Umriss/Mittellinie + Punkte (nur Editor); `pick` = unsichtbare Fläche zum Anklicken */
export function waterHelper(line: THREE.Vector3[], ctrl: THREE.Vector3[], pick: THREE.BufferGeometry | null, closed: boolean): THREE.Object3D {
  const g = new THREE.Group();
  if (line.length > 1) {
    const pts = line.map((p) => p.clone().add(new THREE.Vector3(0, 0.08, 0)));
    if (closed) pts.push(pts[0].clone());
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: HELPER_COLOR, transparent: true, opacity: 0.85, depthTest: false, toneMapped: false }));
    l.renderOrder = 5;
    g.add(l);
  }
  if (ctrl.length) {
    const geo = new THREE.BufferGeometry().setFromPoints(ctrl.map((p) => p.clone().add(new THREE.Vector3(0, 0.08, 0))));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: HELPER_COLOR, size: 7, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }));
    pts.renderOrder = 6;
    pts.userData.noPick = true;
    g.add(pts);
  }
  if (pick) {
    // Mesh.raycast prüft material.visible nicht → anklickbar, aber unsichtbar
    const m = new THREE.Mesh(pick, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
    m.userData.noWeather = true;
    m.userData.noShot = true;
    g.add(m);
  }
  g.traverse((c) => (c.userData.editorHelper = true));
  return g;
}

export function disposeTree(o: THREE.Object3D | undefined): void {
  o?.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) mat.dispose();
  });
}

export function waterMesh(geo: THREE.BufferGeometry, mat: THREE.Material, extra: number): THREE.Mesh {
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius += extra;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.layers.set(WATER_LAYER);
  mesh.userData.noWeather = true;
  mesh.userData.noPick = true;
  mesh.userData.noShot = true;
  mesh.name = 'Wasser';
  return mesh;
}

// ---------- See ----------

const LAKE_PROPS: PropDef[] = [POINTS, ...lookProps(LAKE_LOOK)];

/** Gitter innerhalb eines Umrisses: Zellen mit mindestens einem Punkt innen, äußere Punkte auf den Rand gezogen */
function lakeGeometry(xs: Float64Array, zs: Float64Array): THREE.BufferGeometry | null {
  const n = xs.length;
  if (n < 3) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, xs[i]);
    x1 = Math.max(x1, xs[i]);
    z0 = Math.min(z0, zs[i]);
    z1 = Math.max(z1, zs[i]);
  }
  const cell = Math.max(0.75, Math.max(x1 - x0, z1 - z0) / 220);
  const nx = Math.ceil((x1 - x0) / cell) + 1;
  const nz = Math.ceil((z1 - z0) / cell) + 1;
  const W = nx + 1;
  const inside = new Uint8Array(W * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) inside[j * W + i] = insidePolygon(xs, zs, x0 + i * cell, z0 + j * cell) ? 1 : 0;
  const remap = new Int32Array(W * (nz + 1)).fill(-1);
  const pos: number[] = [];
  const fade: number[] = [];
  const idx: number[] = [];
  const nearest = (px: number, pz: number, out: number[]) => {
    let best = Infinity;
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const vx = xs[a] - xs[b];
      const vz = zs[a] - zs[b];
      const l2 = vx * vx + vz * vz;
      let u = l2 > 1e-9 ? ((px - xs[b]) * vx + (pz - zs[b]) * vz) / l2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = xs[b] + vx * u;
      const qz = zs[b] + vz * u;
      const d = (px - qx) ** 2 + (pz - qz) ** 2;
      if (d < best) {
        best = d;
        out[0] = qx;
        out[1] = qz;
      }
    }
    return Math.sqrt(best);
  };
  const q = [0, 0];
  const vert = (i: number, j: number) => {
    const k = j * W + i;
    if (remap[k] >= 0) return remap[k];
    const px = x0 + i * cell;
    const pz = z0 + j * cell;
    const d = nearest(px, pz, q);
    remap[k] = pos.length / 3;
    if (inside[k]) {
      pos.push(px, 0, pz);
      fade.push(0.25 + 0.75 * Math.min(1, d / 4));
    } else {
      pos.push(q[0], 0, q[1]);
      fade.push(0.25);
    }
    return remap[k];
  };
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * W + i;
      if (!(inside[a] | inside[a + 1] | inside[a + W] | inside[a + W + 1])) continue;
      const v00 = vert(i, j);
      const v10 = vert(i + 1, j);
      const v01 = vert(i, j + 1);
      const v11 = vert(i + 1, j + 1);
      idx.push(v00, v01, v10, v10, v01, v11);
    }
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  geo.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
  geo.setIndex(idx);
  return geo;
}

function createLake(o: MapObjectData, ctx: AssetContext): AssetInstance {
  const object = new THREE.Group();
  const pts = parsePoints(o.props.points);
  const { look, waves, dir } = readLook(o, LAKE_LOOK);
  const curve = new SplineCurve(pts, true);
  let extent = 0;
  for (const p of pts) extent = Math.max(extent, Math.abs(p.p[0]), Math.abs(p.p[2]));
  const samples = pts.length >= 3 ? curve.sample(Math.max(0.5, extent / 150)) : [];
  // flach: Umriss liegt auf Objekthöhe
  const xs = new Float64Array(samples.map((s) => s.pos.x));
  const zs = new Float64Array(samples.map((s) => s.pos.z));
  const geo = lakeGeometry(xs, zs);
  const mat = createWaterMaterial({ look, waves, waveFar: 250, detailScale: 5, detailStrength: 0.3, windDir: dir });
  if (geo) object.add(waterMesh(geo, mat, waves.maxAmp * 2 + 1));

  // Welt-Umriss für Abfragen
  const wx = new Float64Array(xs.length);
  const wz = new Float64Array(zs.length);
  const body: WaterBody = {
    kind: 'lake',
    level: 0,
    box: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    waves,
    look,
    sample(x, z, out: WaterSample) {
      if (!insidePolygon(wx, wz, x, z)) return false;
      out.base = body.level;
      out.flowX = 0;
      out.flowZ = 0;
      return true;
    },
  };
  const helper = ctx.editor
    ? waterHelper(
        samples.map((s) => new THREE.Vector3(s.pos.x, 0, s.pos.z)),
        pts.map((p) => new THREE.Vector3(p.p[0], 0, p.p[2])),
        geo,
        true,
      )
    : undefined;
  return {
    object,
    helper,
    onTransform(root) {
      const p = root.getWorldPosition(new THREE.Vector3());
      body.level = p.y;
      const b = body.box;
      b.minX = b.minZ = Infinity;
      b.maxX = b.maxZ = -Infinity;
      for (let i = 0; i < xs.length; i++) {
        wx[i] = xs[i] + p.x;
        wz[i] = zs[i] + p.z;
        b.minX = Math.min(b.minX, wx[i]);
        b.maxX = Math.max(b.maxX, wx[i]);
        b.minZ = Math.min(b.minZ, wz[i]);
        b.maxZ = Math.max(b.maxZ, wz[i]);
      }
      if (geo && xs.length >= 3) registerWater(body);
    },
    dispose() {
      unregisterWater(body);
      disposeTree(object);
      disposeTree(helper);
    },
  };
}

// ---------- Fluss ----------

const RIVER_PROPS: PropDef[] = [
  POINTS,
  { key: 'width', label: 'Breite (m)', type: 'number', default: 8, min: 0.5, max: 200, step: 0.5, group: 'Fluss' },
  { key: 'flow', label: 'Strömung (m/s)', type: 'number', default: 1.2, min: 0, max: 8, step: 0.1, group: 'Fluss' },
  ...lookProps(RIVER_LOOK),
  { key: 'carve', label: 'Gelände anpassen', type: 'bool', default: true, group: 'Gelände' },
  { key: 'depth', label: 'Tiefe (m)', type: 'number', default: 1.8, min: 0.1, max: 30, step: 0.1, group: 'Gelände' },
  { key: 'bank', label: 'Böschung (m)', type: 'number', default: 5, min: 0, max: 60, step: 0.5, group: 'Gelände' },
  { key: 'step', label: 'Auflösung (m)', type: 'number', default: 1, min: 0.25, max: 8, step: 0.25, group: 'Spline' },
];

const ACROSS = 8;

function riverGeometry(samples: SplineSample[], half: number[], flow: number): THREE.BufferGeometry | null {
  if (samples.length < 2) return null;
  const pos: number[] = [];
  const nrm: number[] = [];
  const fl: number[] = [];
  const fade: number[] = [];
  const idx: number[] = [];
  samples.forEach((s, i) => {
    const tx = s.tan.x;
    const tz = s.tan.z;
    const tl = Math.hypot(tx, tz) || 1;
    for (let j = 0; j <= ACROSS; j++) {
      const t = -1 + (2 * j) / ACROSS;
      pos.push(s.pos.x + s.right.x * t * half[i], s.pos.y, s.pos.z + s.right.z * t * half[i]);
      nrm.push(0, 1, 0);
      const k = flow * (1 - 0.6 * t * t);
      fl.push((tx / tl) * k, (tz / tl) * k);
      fade.push(1 - 0.75 * t * t);
    }
    if (i > 0) {
      const a = (i - 1) * (ACROSS + 1);
      const b = i * (ACROSS + 1);
      for (let j = 0; j < ACROSS; j++) idx.push(a + j, b + j, a + j + 1, a + j + 1, b + j, b + j + 1);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(fl, 2));
  geo.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
  geo.setIndex(idx);
  return geo;
}

function createRiver(o: MapObjectData, ctx: AssetContext): AssetInstance {
  const object = new THREE.Group();
  const pts = parsePoints(o.props.points);
  const { look, waves, dir } = readLook(o, RIVER_LOOK);
  const curve = new SplineCurve(pts, false);
  const samples = pts.length >= 2 ? curve.sample(num(o, 'step', 1)) : [];
  const halfW = Math.max(0.25, num(o, 'width', 8) / 2);
  const flow = Math.max(0, num(o, 'flow', 1.2));
  const half = samples.map((s) => halfW * s.w);
  const geo = riverGeometry(samples, half, flow);
  const mat = createWaterMaterial({ look, waves, waveFar: 200, detailScale: 4, detailStrength: 0.4, windDir: dir });
  if (geo) object.add(waterMesh(geo, mat, waves.maxAmp * 2 + 1));

  // Welt-Mittellinie für Abfragen
  const n = samples.length;
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const cz = new Float64Array(n);
  const dx = new Float64Array(n);
  const dz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = samples[i].tan;
    const l = Math.hypot(t.x, t.z) || 1;
    dx[i] = t.x / l;
    dz[i] = t.z / l;
  }
  const body: WaterBody = {
    kind: 'river',
    level: 0,
    box: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    waves,
    look,
    sample(x, z, out: WaterSample) {
      let best = Infinity;
      let found = false;
      for (let i = 0; i < n - 1; i++) {
        const ax = cx[i];
        const az = cz[i];
        const vx = cx[i + 1] - ax;
        const vz = cz[i + 1] - az;
        const l2 = vx * vx + vz * vz;
        let u = l2 > 1e-9 ? ((x - ax) * vx + (z - az) * vz) / l2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const ex = x - (ax + vx * u);
        const ez = z - (az + vz * u);
        const d2 = ex * ex + ez * ez;
        if (d2 >= best) continue;
        const h = half[i] * (1 - u) + half[i + 1] * u;
        if (d2 > h * h) continue;
        best = d2;
        found = true;
        const t = Math.sqrt(d2) / h;
        const k = flow * (1 - 0.6 * t * t);
        out.base = cy[i] * (1 - u) + cy[i + 1] * u;
        const fx = dx[i] * (1 - u) + dx[i + 1] * u;
        const fz = dz[i] * (1 - u) + dz[i + 1] * u;
        const fl = Math.hypot(fx, fz) || 1;
        out.flowX = (fx / fl) * k;
        out.flowZ = (fz / fl) * k;
        out.fade = 1 - 0.75 * t * t;
      }
      return found;
    },
  };

  const origin = new THREE.Vector3();
  let placed = false;
  let deform: { key: string; source: DeformSource } | null = null;
  const refresh = () => {
    if (n < 2) return;
    const b = body.box;
    b.minX = b.minZ = Infinity;
    b.maxX = b.maxZ = -Infinity;
    let sumY = 0;
    const line: THREE.Vector3[] = [];
    let maxHalf = 0;
    for (let i = 0; i < n; i++) {
      const p = samples[i].pos;
      cx[i] = p.x + origin.x;
      cy[i] = p.y + origin.y;
      cz[i] = p.z + origin.z;
      sumY += cy[i];
      maxHalf = Math.max(maxHalf, half[i]);
      line.push(new THREE.Vector3(cx[i], cy[i], cz[i]));
    }
    for (let i = 0; i < n; i++) {
      b.minX = Math.min(b.minX, cx[i] - maxHalf);
      b.maxX = Math.max(b.maxX, cx[i] + maxHalf);
      b.minZ = Math.min(b.minZ, cz[i] - maxHalf);
      b.maxZ = Math.max(b.maxZ, cz[i] + maxHalf);
    }
    body.level = sumY / n;
    registerWater(body);
    if (!ctx.editor || !bool(o, 'carve', true)) return;
    const bank = num(o, 'bank', 5);
    const depth = num(o, 'depth', 1.8);
    const dbox = { minX: b.minX - bank, maxX: b.maxX + bank, minZ: b.minZ - bank, maxZ: b.maxZ + bank };
    const build: DeformSource['build'] = (d, lo) => riverDeform(d, lo, line, half, bank, depth);
    if (!deform) deform = addDeformSource({ version: 1, box: dbox, build });
    else {
      deform.source.version++;
      deform.source.box = dbox;
      deform.source.build = build;
    }
  };

  const helper = ctx.editor
    ? waterHelper(
        samples.map((s) => s.pos),
        pts.map((p) => new THREE.Vector3(...p.p)),
        geo,
        false,
      )
    : undefined;
  return {
    object,
    helper,
    onTransform(root) {
      const p = root.getWorldPosition(new THREE.Vector3());
      if (placed && p.equals(origin)) return;
      placed = true;
      origin.copy(p);
      refresh();
    },
    dispose() {
      unregisterWater(body);
      if (deform) removeDeformSource(deform.key);
      disposeTree(object);
      disposeTree(helper);
    },
  };
}

// ---------- Meer ----------

const OCEAN_PROPS: PropDef[] = [...lookProps(OCEAN_LOOK), { key: 'radius', label: 'Sichtweite (m)', type: 'number', default: 4000, min: 200, max: 20000, step: 100, group: 'Meer' }];

/** Radiales Gitter um die Kamera: Ringabstand wächst mit dem Radius (gleich feine Darstellung auf dem Bildschirm) */
function oceanGeometry(radius: number): THREE.BufferGeometry {
  const seg = 128;
  const r0 = 0.6;
  const qf = 1 + (2 * Math.PI) / seg;
  const rings: number[] = [0];
  for (let r = r0; r < radius; r *= qf) rings.push(r);
  rings.push(radius);
  const pos: number[] = [];
  const nrm: number[] = [];
  const fade: number[] = [];
  const idx: number[] = [];
  pos.push(0, 0, 0);
  nrm.push(0, 1, 0);
  fade.push(1);
  for (let i = 1; i < rings.length; i++)
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * rings[i], 0, Math.sin(a) * rings[i]);
      nrm.push(0, 1, 0);
      fade.push(1);
    }
  for (let j = 0; j < seg; j++) idx.push(0, 1 + ((j + 1) % seg), 1 + j);
  for (let i = 1; i < rings.length - 1; i++) {
    const a = 1 + (i - 1) * seg;
    const b = 1 + i * seg;
    for (let j = 0; j < seg; j++) {
      const j1 = (j + 1) % seg;
      idx.push(a + j, a + j1, b + j, b + j, a + j1, b + j1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aFlow', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  geo.setAttribute('aFade', new THREE.Float32BufferAttribute(fade, 1));
  geo.setIndex(idx);
  return geo;
}

function createOcean(o: MapObjectData, ctx: AssetContext): AssetInstance {
  const object = new THREE.Group();
  const { look, waves, dir } = readLook(o, OCEAN_LOOK);
  const radius = Math.max(200, num(o, 'radius', 4000));
  const mat = createWaterMaterial({ look, waves, waveFar: Math.min(900, radius * 0.4), detailScale: 9, detailStrength: 0.45, windDir: dir });
  const mesh = waterMesh(oceanGeometry(radius), mat, 0);
  mesh.frustumCulled = false;
  object.add(mesh);
  let root: THREE.Object3D | null = null;
  const body: WaterBody = {
    kind: 'ocean',
    level: 0,
    box: { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity },
    waves,
    look,
    sample(_x, _z, out: WaterSample) {
      out.base = body.level;
      out.flowX = 0;
      out.flowZ = 0;
      return true;
    },
    beforeRender(cam) {
      if (!root) return;
      // in ganzen Metern mitwandern (Wellen rechnen in Weltkoordinaten, daher kein Mitschwimmen)
      mesh.position.set(Math.round(cam.x - root.position.x), 0, Math.round(cam.z - root.position.z));
      mesh.updateMatrixWorld();
    },
  };
  let helper: THREE.Object3D | undefined;
  if (ctx.editor) {
    const s = 12;
    const ring = [new THREE.Vector3(-s, 0, -s), new THREE.Vector3(s, 0, -s), new THREE.Vector3(s, 0, s), new THREE.Vector3(-s, 0, s)];
    const pick = new THREE.PlaneGeometry(2 * s, 2 * s).rotateX(-Math.PI / 2);
    helper = waterHelper(ring, [], pick, true);
  }
  return {
    object,
    helper,
    onTransform(r) {
      root = r;
      body.level = r.getWorldPosition(new THREE.Vector3()).y;
      registerWater(body);
    },
    dispose() {
      unregisterWater(body);
      disposeTree(object);
      disposeTree(helper);
    },
  };
}

export const WATER_ASSETS: Record<string, AssetDef> = {
  [LAKE_TYPE]: { label: 'See', category: 'Wasser', fixedRotation: true, fixedScale: true, props: LAKE_PROPS, create: createLake },
  [RIVER_TYPE]: { label: 'Fluss', category: 'Wasser', fixedRotation: true, fixedScale: true, props: RIVER_PROPS, create: createRiver },
  [OCEAN_TYPE]: { label: 'Meer', category: 'Wasser', fixedRotation: true, fixedScale: true, unique: true, props: OCEAN_PROPS, create: createOcean },
};

/** Vorgaben der „Neu“-Knöpfe im Wasser-Modus */
export const WATER_PRESETS: { id: string; label: string; type: string; icon: string; props: Record<string, PropValue> }[] = [
  { id: 'lake', label: 'See', type: LAKE_TYPE, icon: 'lake', props: {} },
  { id: 'pond', label: 'Teich (trüb)', type: LAKE_TYPE, icon: 'lake', props: { color: '#4d6b3c', murk: 0.7, clarity: 1, waveHeight: 0.04 } },
  { id: 'river', label: 'Fluss', type: RIVER_TYPE, icon: 'river', props: {} },
  { id: 'creek', label: 'Bach', type: RIVER_TYPE, icon: 'river', props: { width: 2.5, flow: 1.6, depth: 0.5, bank: 2, color: '#6b8f73', clarity: 1.5 } },
  { id: 'ocean', label: 'Meer', type: OCEAN_TYPE, icon: 'ocean', props: {} },
  { id: 'source', label: 'Wasserquelle', type: SOURCE_TYPE, icon: 'spring', props: {} },
];

/** Ab dieser Punktzahl ist ein Wasser-Objekt gültig (Meer und Quelle brauchen keine Punkte) */
export function waterMinPoints(type: string): number {
  return type === LAKE_TYPE ? 3 : type === RIVER_TYPE ? 2 : 0;
}

export type { WaterKind };
