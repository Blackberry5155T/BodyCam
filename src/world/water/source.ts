import * as THREE from 'three';
import { unzlibSync } from 'fflate';
import { MeshBVH } from 'three-mesh-bvh';
import type { AssetContext, AssetDef, AssetInstance, PropDef } from '../assets.ts';
import type { MapObjectData } from '../mapFormat.ts';
import { blobRef, browserBlobs, parseBlobRef } from '../blobStore.ts';
import { liveLandscapes } from '../landscape/render.ts';
import { particleWorld } from '../particleCollision.ts';
import { SOURCE_TYPE, bool, disposeTree, lookProps, num, readLook, str, waterHelper, waterMesh, type LookDefaults } from './asset.ts';
import { createWaterMaterial } from './material.ts';
import { registerWater, unregisterWater, type WaterBody, type WaterSample } from './registry.ts';
import { SIM_WET, decodeHeader, encodeState, type SimParams, type SimSource } from './shallow.ts';
import type { SimFrame, SimRequest, SimResponse } from './shallow.worker.ts';

// Wasserquelle (watersource): echte Flachwasser-Simulation auf dem Gelände (shallow.ts, im Web Worker).
// Die Quelle speist Wasser ein; es läuft bergab, folgt Flussbetten und Senken und bildet so Bäche, Flüsse und
// Seen. Gerechnet wird in einem rechteckigen Gebiet um die Quelle; am Rand fließt das Wasser ab.
//  - Editor: „Simulation berechnen“ tastet den Boden ab (Landscape-Höhen, andere Objekte per Raycast) und
//    rechnet den Vorlauf vor; der Zustand wird als Blob gespeichert (props.state).
//  - Spiel und Editor-Simulation (Alt+S): rechnet ab dem gespeicherten Zustand in Echtzeit weiter.
// Die Oberfläche ist ein Gitter mit dem normalen Wasser-Material; Spieler, Props und Spritzer fragen sie über
// die Wasser-Registry ab (Höhe, Strömung).

const MAX_CELLS = 90_000;

const SOURCE_LOOK: LookDefaults = { color: '#4f8a80', murk: 0.35, clarity: 2.5, foam: 0.55, waveHeight: 0.02, waveLength: 2.5 };

const SOURCE_PROPS: PropDef[] = [
  { key: 'rate', label: 'Zufluss (m³/s)', type: 'number', default: 1.5, min: 0.01, max: 200, step: 0.1, group: 'Quelle' },
  { key: 'radius', label: 'Quellradius (m)', type: 'number', default: 1, min: 0.2, max: 30, step: 0.1, group: 'Quelle' },
  { key: 'sizeX', label: 'Breite X (m)', type: 'number', default: 60, min: 4, max: 600, step: 1, group: 'Gebiet' },
  { key: 'sizeZ', label: 'Länge Z (m)', type: 'number', default: 60, min: 4, max: 600, step: 1, group: 'Gebiet' },
  { key: 'offsetX', label: 'Versatz X (m)', type: 'number', default: 0, min: -300, max: 300, step: 0.5, group: 'Gebiet' },
  { key: 'offsetZ', label: 'Versatz Z (m)', type: 'number', default: 0, min: -300, max: 300, step: 0.5, group: 'Gebiet' },
  { key: 'cell', label: 'Zellgröße (m)', type: 'number', default: 0.5, min: 0.2, max: 4, step: 0.05, group: 'Gebiet' },
  { key: 'duration', label: 'Vorlauf (s)', type: 'number', default: 90, min: 5, max: 1800, step: 5, group: 'Simulation' },
  { key: 'friction', label: 'Reibung', type: 'number', default: 0.3, min: 0, max: 1, step: 0.05, group: 'Simulation' },
  { key: 'loss', label: 'Versickerung (mm/s)', type: 'number', default: 0.2, min: 0, max: 20, step: 0.05, group: 'Simulation' },
  { key: 'live', label: 'Im Spiel weiterrechnen', type: 'bool', default: true, group: 'Simulation' },
  { key: 'bake', label: 'Simulation berechnen', type: 'action', default: '', group: 'Simulation' },
  { key: 'clear', label: 'Wasser entfernen', type: 'action', default: '', group: 'Simulation' },
  { key: 'state', label: 'Zustand', type: 'text', default: '', hidden: true },
  ...lookProps(SOURCE_LOOK),
];

interface Domain {
  nx: number;
  nz: number;
  cell: number;
  minX: number;
  minZ: number;
  key: string;
}

/** Rechengebiet: Rechteck um die Quelle (+ Versatz), Zellgröße so, dass höchstens MAX_CELLS Zellen entstehen */
function domainOf(o: MapObjectData, px: number, pz: number): Domain {
  const sx = THREE.MathUtils.clamp(num(o, 'sizeX', 60), 4, 600);
  const sz = THREE.MathUtils.clamp(num(o, 'sizeZ', 60), 4, 600);
  const cell = Math.max(THREE.MathUtils.clamp(num(o, 'cell', 0.5), 0.2, 4), Math.sqrt((sx * sz) / MAX_CELLS));
  const nx = Math.max(4, Math.round(sx / cell));
  const nz = Math.max(4, Math.round(sz / cell));
  const minX = px + num(o, 'offsetX', 0) - (nx * cell) / 2;
  const minZ = pz + num(o, 'offsetZ', 0) - (nz * cell) / 2;
  return { nx, nz, cell, minX, minZ, key: `${nx}|${nz}|${cell.toFixed(4)}|${minX.toFixed(3)}|${minZ.toFixed(3)}` };
}

/** Eigenschaften, die einen gespeicherten Zustand ungültig machen bzw. einen Neuaufbau brauchen (ohne props.state) */
function propsKey(o: MapObjectData): string {
  const p = { ...o.props };
  delete p.state;
  return JSON.stringify(p);
}

// ---------- Boden abtasten ----------

const _ray = new THREE.Ray();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();

interface GroundMesh {
  mesh: THREE.Mesh;
  bvh: MeshBVH;
  inv: THREE.Matrix4;
  box: THREE.Box3;
  side: THREE.Side;
}

/** sichtbar, kein Editor-Helfer, kein Wasser, kein simuliertes (bewegliches) Objekt */
function solidMesh(o: THREE.Object3D, stop: THREE.Object3D): boolean {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || !mesh.geometry?.attributes.position) return false;
  if (!mesh.layers.isEnabled(0)) return false;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (!mats.some((m) => m && m.visible && m.side !== THREE.BackSide)) return false;
  for (let c: THREE.Object3D | null = o; c && c !== stop; c = c.parent) {
    if (!c.visible || c.userData.editorHelper || c.userData.noPick) return false;
    const node = c.userData.mapNode as { data?: MapObjectData } | undefined;
    if (node?.data?.props.simulate === true) return false;
  }
  return true;
}

/**
 * Bodenhöhe je Zelle: höchste Fläche aus Landscapes (Höhenfeld, inkl. Löcher) und anderen Objekten (Raycast von
 * oben, BVH). Ohne Treffer: unendlicher Boden (y = 0), falls aktiv, sonst NaN (Wasser fällt in den Abgrund).
 */
function sampleGround(world: THREE.Object3D, self: THREE.Object3D, d: Domain, top: number): Float32Array {
  world.updateMatrixWorld(true);
  const lands = [...liveLandscapes()].filter((r) => r.mesh.visible);
  const landMeshes = new Set<THREE.Object3D>(lands.map((r) => r.mesh));
  const landInv = lands.map((r) => new THREE.Matrix4().copy(r.mesh.matrixWorld).invert());
  const maxX = d.minX + d.nx * d.cell;
  const maxZ = d.minZ + d.nz * d.cell;
  const meshes: GroundMesh[] = [];
  const visit = (o: THREE.Object3D) => {
    if (o === self || landMeshes.has(o) || !o.visible || o.userData.editorHelper) return;
    if (solidMesh(o, world)) {
      const mesh = o as THREE.Mesh;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = _box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
      if (box.max.x >= d.minX && box.min.x <= maxX && box.max.z >= d.minZ && box.min.z <= maxZ && box.min.y < top) {
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        meshes.push({ mesh, bvh: new MeshBVH(mesh.geometry, { indirect: true }), inv: new THREE.Matrix4().copy(mesh.matrixWorld).invert(), box: box.clone(), side: mat?.side ?? THREE.FrontSide });
      }
    }
    for (const c of o.children) visit(c);
  };
  for (const c of world.children) visit(c);

  const plane = particleWorld.groundPlane;
  const g = new Float32Array(d.nx * d.nz);
  for (let iz = 0; iz < d.nz; iz++) {
    const z = d.minZ + (iz + 0.5) * d.cell;
    for (let ix = 0; ix < d.nx; ix++) {
      const x = d.minX + (ix + 0.5) * d.cell;
      let h = -Infinity;
      for (let k = 0; k < lands.length; k++) {
        _v.set(x, 0, z).applyMatrix4(landInv[k]);
        const lh = lands[k].data.heightAt(_v.x, _v.z);
        if (lh === null) continue;
        _v.y = lh;
        _v.applyMatrix4(lands[k].mesh.matrixWorld);
        if (_v.y > h) h = _v.y;
      }
      for (const m of meshes) {
        if (x < m.box.min.x || x > m.box.max.x || z < m.box.min.z || z > m.box.max.z || m.box.max.y <= h) continue;
        _ray.origin.set(x, top, z);
        _ray.direction.set(0, -1, 0);
        _ray.applyMatrix4(m.inv);
        const hit = m.bvh.raycastFirst(_ray, THREE.DoubleSide);
        if (!hit) continue;
        const y = _v.copy(hit.point).applyMatrix4(m.mesh.matrixWorld).y;
        if (y > h) h = y;
      }
      if (plane) h = Math.max(h, 0);
      g[iz * d.nx + ix] = Number.isFinite(h) ? h : NaN;
    }
  }
  return g;
}

// ---------- Zustand (Blob) ----------

/** entpackte Zustände je Blob-Verweis (Editor: Neuaufbau/Undo ohne erneutes Laden) */
const rawCache = new Map<string, Uint8Array>();

async function loadRaw(ref: string, ctx: AssetContext): Promise<Uint8Array | null> {
  const hit = rawCache.get(ref);
  if (hit) return hit;
  const id = parseBlobRef(ref);
  if (!id || !ctx.blobs) return null;
  const bytes = await ctx.blobs.get(id);
  if (!bytes) return null;
  try {
    const raw = unzlibSync(bytes);
    if (ctx.editor) rawCache.set(ref, raw);
    return raw;
  } catch {
    return null;
  }
}

interface SimArrays {
  ground: Float32Array;
  depth: Float32Array;
  vx: Float32Array;
  vz: Float32Array;
  time: number;
}

/** Felder aus einem Zustand lesen, falls er zum Gebiet passt */
function readArrays(raw: Uint8Array, d: Domain): SimArrays | null {
  const h = decodeHeader(raw);
  if (!h || h.nx !== d.nx || h.nz !== d.nz || Math.abs(h.cell - d.cell) > 1e-4 || Math.abs(h.minX - d.minX) > 1e-3 || Math.abs(h.minZ - d.minZ) > 1e-3) return null;
  const n = d.nx * d.nz;
  const body = new Float32Array(raw.slice(64).buffer);
  return { ground: body.slice(0, n), depth: body.slice(n, n * 2), vx: body.slice(n * 6, n * 7), vz: body.slice(n * 7, n * 8), time: h.time };
}

// ---------- Abgerundete Wasserkante ----------

let maskA = new Float32Array(0);
let maskB = new Float32Array(0);
let maskC = new Float32Array(0);

/** Box-Unschärfe mit Radius `r` (getrennt in X und Z) von `src` nach `dst`; Rand = Randwert. `dst` darf `src` sein. */
function boxBlur(src: Float32Array, dst: Float32Array, tmp: Float32Array, nx: number, nz: number, r: number): void {
  const k = 1 / (2 * r + 1);
  for (let iz = 0; iz < nz; iz++) {
    const row = iz * nx;
    for (let ix = 0; ix < nx; ix++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += src[row + Math.min(Math.max(ix + d, 0), nx - 1)];
      tmp[row + ix] = s * k;
    }
  }
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[Math.min(Math.max(iz + d, 0), nz - 1) * nx + ix];
      dst[iz * nx + ix] = s * k;
    }
  }
}

/**
 * Kanten-Maske je Gitterpunkt, der Shader schneidet bei 0.5. Grundlage ist die weichgezeichnete Nässe (3 × 3er-Box ≈
 * Gauß mit Radius 3 Zellen): gerade Ufer bleiben, wo sie sind, Ecken und Zellen-Treppen werden rund, Buchten füllen
 * sich. Damit schmale Rinnsale (1–2 Zellen) dabei nicht verschwinden, bleiben nasse Punkte mit dünner Umgebung
 * (5 × 5-Mittel < 0.45) immer sichtbar.
 */
function edgeMask(depth: Float32Array, nx: number, nz: number, out: Float32Array): void {
  const n = nx * nz;
  if (maskA.length < n) {
    maskA = new Float32Array(n);
    maskB = new Float32Array(n);
    maskC = new Float32Array(n);
  }
  const wide = maskA;
  const thin = maskB;
  const tmp = maskC;
  for (let i = 0; i < n; i++) out[i] = depth[i] > SIM_WET ? 1 : 0;
  boxBlur(out, wide, tmp, nx, nz, 1);
  boxBlur(wide, wide, tmp, nx, nz, 1);
  boxBlur(wide, wide, tmp, nx, nz, 1);
  boxBlur(out, thin, tmp, nx, nz, 2);
  for (let i = 0; i < n; i++) {
    const w = wide[i];
    out[i] = out[i] > 0 && thin[i] < 0.45 ? Math.max(w, 0.55) : w;
  }
}

// ---------- Asset ----------

function createSource(data: MapObjectData, ctx: AssetContext): AssetInstance {
  let o = data;
  const object = new THREE.Group();
  const { look, waves, dir } = readLook(o, SOURCE_LOOK);
  // Simulationswasser ist oft nur Zentimeter tief — Uferschaum nur am äußersten Rand
  const mat = createWaterMaterial({ look, waves, waveFar: 120, detailScale: 3, detailStrength: 0.55, windDir: dir, shoreFoam: 0.03 + look.foam * 0.08, edgeClip: true });
  const key = propsKey(o);

  let root: THREE.Object3D | null = null;
  let dom: Domain | null = null;
  let arrays: SimArrays | null = null;
  /** Verweis, aus dem `arrays` stammt ('' = selbst abgetastet/leer) */
  let arraysRef = '';
  let raw: Uint8Array | null = null;
  let rawRef = '';
  let mesh: THREE.Mesh | null = null;
  let geo: THREE.BufferGeometry | null = null;
  let meshDirty = false;
  let registered = false;
  let disposed = false;

  let worker: Worker | null = null;
  let busy = false;
  let acc = 0;
  let spare: SimFrame | undefined;
  let bake: { resolve: (r: { bytes: Uint8Array; time: number; volume: number; wet: number }) => void; reject: (e: Error) => void; progress: (f: number, text?: string) => void } | null = null;

  // Zustand laden (Spiel wartet über `ready` darauf)
  const loadState = async (ref: string) => {
    const r = ref ? await loadRaw(ref, ctx) : null;
    if (disposed) return;
    raw = r;
    rawRef = ref;
    applyRaw();
  };
  const ready = loadState(str(o, 'state', ''));

  const body: WaterBody = {
    kind: 'sim',
    level: 0,
    box: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    waves,
    look,
    sample(x, z, out: WaterSample) {
      if (!arrays || !dom) return false;
      const { ground, depth, vx, vz } = arrays;
      const fx = (x - dom.minX) / dom.cell - 0.5;
      const fz = (z - dom.minZ) / dom.cell - 0.5;
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      const tx = fx - ix;
      const tz = fz - iz;
      let D = 0;
      let S = 0;
      let W = 0;
      let FX = 0;
      let FZ = 0;
      for (let k = 0; k < 4; k++) {
        const cx = ix + (k & 1);
        const cz = iz + (k >> 1);
        if (cx < 0 || cz < 0 || cx >= dom.nx || cz >= dom.nz) continue;
        const w = (k & 1 ? tx : 1 - tx) * (k >> 1 ? tz : 1 - tz);
        const i = cz * dom.nx + cx;
        const d = depth[i];
        D += w * d;
        FX += w * vx[i];
        FZ += w * vz[i];
        if (d > SIM_WET) {
          S += w * (ground[i] + d);
          W += w;
        }
      }
      if (D < 0.02 || W < 1e-4) return false;
      out.base = S / W;
      out.flowX = FX;
      out.flowZ = FZ;
      out.fade = Math.min(1, D / 0.6);
      return true;
    },
  };

  const params = (): SimParams => ({ friction: THREE.MathUtils.clamp(num(o, 'friction', 0.3), 0, 1), loss: Math.max(0, num(o, 'loss', 0.2)) / 1000 });
  const sources = (): SimSource[] => {
    if (!dom || !root) return [];
    const p = root.getWorldPosition(_v);
    return [{ x: (p.x - dom.minX) / dom.cell, z: (p.z - dom.minZ) / dom.cell, r: Math.max(0.2, num(o, 'radius', 1)) / dom.cell, rate: Math.max(0, num(o, 'rate', 1.5)) }];
  };

  /** geladenen Zustand übernehmen, wenn er zum Gebiet passt */
  function applyRaw(): void {
    if (!dom || bake) return;
    const a = raw ? readArrays(raw, dom) : null;
    if (a) {
      setArrays(a, rawRef);
      if (worker) startWorker(); // Editor-Simulation läuft: ab dem neuen Zustand weiter
    } else if (arraysRef || !worker) {
      // passt nicht (Quelle verschoben, Gebiet geändert) oder entfernt
      clearArrays();
    }
  }

  function setArrays(a: SimArrays, ref: string): void {
    arrays = a;
    arraysRef = ref;
    meshDirty = true;
    if (!registered && dom) {
      registerWater(body);
      registered = true;
    }
  }

  function clearArrays(): void {
    arrays = null;
    arraysRef = '';
    if (registered) unregisterWater(body);
    registered = false;
    if (mesh) mesh.visible = false;
  }

  function stopWorker(): void {
    worker?.terminate();
    worker = null;
    busy = false;
    acc = 0;
    spare = undefined;
  }

  function newWorker(): Worker {
    const w = new Worker(new URL('./shallow.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<SimResponse>) => {
      if (w !== worker || disposed) return;
      const m = e.data;
      switch (m.type) {
        case 'frame': {
          if (arrays && arrays.depth.length === m.depth.length) {
            spare = { depth: arrays.depth, vx: arrays.vx, vz: arrays.vz };
            arrays.depth = m.depth;
            arrays.vx = m.vx;
            arrays.vz = m.vz;
            arrays.time = m.time;
            meshDirty = true;
            if (!registered) {
              registerWater(body);
              registered = true;
            }
          }
          busy = false;
          break;
        }
        case 'progress':
          bake?.progress(m.f, `${Math.round(m.time)} s gerechnet · ${m.volume.toFixed(0)} m³ Wasser`);
          break;
        case 'baked':
          bake?.resolve(m);
          break;
        case 'error':
          console.warn('Wasser-Simulation:', m.message);
          bake?.reject(new Error(m.message));
          break;
      }
    };
    w.onerror = (e) => {
      console.warn('Wasser-Simulation:', e.message);
      bake?.reject(new Error(e.message || 'Worker-Fehler'));
    };
    return w;
  }

  /** Worker mit dem aktuellen Zustand (oder frisch abgetastetem, trockenem Boden) starten */
  function startWorker(): void {
    if (!dom || !root) return;
    stopWorker();
    worker = newWorker();
    const n = dom.nx * dom.nz;
    if (!arrays) {
      const ground = sampleGround(root.parent ?? root, root, dom, root.getWorldPosition(_v).y + 200);
      setArrays({ ground, depth: new Float32Array(n), vx: new Float32Array(n), vz: new Float32Array(n), time: 0 }, '');
    }
    const a = arrays!;
    // gespeicherter Zustand enthält auch die Abflüsse → nahtlos weiter; sonst ab Tiefe/Geschwindigkeit
    const state = raw && arraysRef && arraysRef === rawRef ? raw.slice() : encodeState({ ...dom, time: a.time }, a.ground, a.depth, a.vx, a.vz);
    const msg: SimRequest = { type: 'init', nx: dom.nx, nz: dom.nz, cell: dom.cell, minX: dom.minX, minZ: dom.minZ, state, sources: sources(), params: params() };
    worker.postMessage(msg, [state.buffer]);
    busy = true; // init antwortet mit einem Frame
  }

  // ---------- Oberfläche ----------

  function ensureMesh(d: Domain): void {
    if (geo && geo.userData.key === d.key) return;
    if (mesh) {
      object.remove(mesh);
      geo?.dispose();
    }
    const n = d.nx * d.nz;
    geo = new THREE.BufferGeometry();
    geo.userData.key = d.key;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) nrm[i * 3 + 1] = 1;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array((d.nx - 1) * (d.nz - 1) * 6), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere();
    mesh = waterMesh(geo, mat, 0);
    mesh.name = 'Wasser (simuliert)';
    object.add(mesh);
  }

  function rebuildMesh(): void {
    meshDirty = false;
    if (!dom || !root || !arrays) return;
    ensureMesh(dom);
    const g = geo!;
    const { nx, nz, cell, minX, minZ } = dom;
    const rp = root.getWorldPosition(new THREE.Vector3());
    const { ground, depth, vx, vz } = arrays;
    const pos = g.attributes.position.array as Float32Array;
    const flow = g.attributes.aFlow.array as Float32Array;
    const fade = g.attributes.aFade.array as Float32Array;
    const edge = g.attributes.aEdge.array as Float32Array;
    const idx = g.index!.array as Uint32Array;
    edgeMask(depth, nx, nz, edge);
    let y0 = Infinity;
    let y1 = -Infinity;
    let sumY = 0;
    let wet = 0;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        const d = depth[i];
        const b = ground[i];
        let y: number;
        if (d > SIM_WET) {
          y = b + d;
          sumY += y;
          wet++;
        } else {
          // trockene Randzelle: auf Höhe der nassen Nachbarn, aber unter dem Boden → Wasserkante schneidet das Gelände
          let s = 0;
          let c = 0;
          for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++) {
              const x2 = ix + dx;
              const z2 = iz + dz;
              if ((dx || dz) && x2 >= 0 && z2 >= 0 && x2 < nx && z2 < nz) {
                const j = z2 * nx + x2;
                if (depth[j] > SIM_WET) {
                  s += ground[j] + depth[j];
                  c++;
                }
              }
            }
          // knapp über dem Boden: auf flachem Grund schneidet die abgerundete Kante (aEdge), am Hang das Gelände
          if (c) y = Number.isFinite(b) ? Math.min(s / c, b + 0.01) : s / c;
          else y = Number.isFinite(b) ? b - 0.1 : rp.y;
        }
        pos[i * 3] = minX + (ix + 0.5) * cell - rp.x;
        pos[i * 3 + 1] = y - rp.y;
        pos[i * 3 + 2] = minZ + (iz + 0.5) * cell - rp.z;
        const wetV = d > SIM_WET;
        flow[i * 2] = wetV ? vx[i] : 0;
        flow[i * 2 + 1] = wetV ? vz[i] : 0;
        fade[i] = THREE.MathUtils.smoothstep(d, 0, 0.4);
        if (wetV) {
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    }
    // Vierecke mit mindestens einer nassen Ecke
    let k = 0;
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = iz * nx + ix;
        const b = a + 1;
        const c = a + nx;
        const e = c + 1;
        if (depth[a] <= SIM_WET && depth[b] <= SIM_WET && depth[c] <= SIM_WET && depth[e] <= SIM_WET) continue;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = c;
        idx[k++] = e;
      }
    }
    g.setDrawRange(0, k);
    g.attributes.position.needsUpdate = true;
    g.attributes.aFlow.needsUpdate = true;
    g.attributes.aFade.needsUpdate = true;
    g.attributes.aEdge.needsUpdate = true;
    g.index!.needsUpdate = true;
    if (wet) {
      body.level = sumY / wet;
      const cx = minX + (nx * cell) / 2 - rp.x;
      const cz = minZ + (nz * cell) / 2 - rp.z;
      g.boundingSphere!.center.set(cx, (y0 + y1) / 2 - rp.y, cz);
      g.boundingSphere!.radius = Math.hypot(nx * cell, nz * cell, y1 - y0) / 2 + waves.maxAmp * 2 + 0.5;
    }
    mesh!.visible = k > 0;
  }

  // ---------- Editor-Helfer: Gebiet + Quelle ----------

  let helper: THREE.Object3D | undefined;
  if (ctx.editor) {
    const d0 = domainOf(o, 0, 0);
    const x0 = d0.minX;
    const z0 = d0.minZ;
    const x1 = x0 + d0.nx * d0.cell;
    const z1 = z0 + d0.nz * d0.cell;
    const rect = [new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 0, z0), new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x0, 0, z1)];
    const r = Math.max(0.2, num(o, 'radius', 1));
    helper = waterHelper(rect, [new THREE.Vector3()], new THREE.CircleGeometry(Math.max(0.8, r), 24).rotateX(-Math.PI / 2), true);
    // Quellring + senkrechter Strich
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i <= 32; i++) ring.push(new THREE.Vector3(Math.cos((i / 32) * Math.PI * 2) * r, 0.08, Math.sin((i / 32) * Math.PI * 2) * r));
    const lm = new THREE.LineBasicMaterial({ color: '#9be7ff', transparent: true, opacity: 0.95, depthTest: false, toneMapped: false });
    const ringL = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), lm);
    const stick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1.6, 0)]), lm);
    for (const l of [ringL, stick]) {
      l.renderOrder = 5;
      l.userData.editorHelper = true;
      helper.add(l);
    }
  }

  return {
    object,
    helper,
    ready: ready.catch(() => undefined),
    onTransform(r) {
      root = r;
      const p = r.getWorldPosition(new THREE.Vector3());
      const d = domainOf(o, p.x, p.z);
      body.box.minX = d.minX;
      body.box.minZ = d.minZ;
      body.box.maxX = d.minX + d.nx * d.cell;
      body.box.maxZ = d.minZ + d.nz * d.cell;
      if (dom && dom.key === d.key) {
        meshDirty = true; // nur Höhe verschoben
        return;
      }
      dom = d;
      if (!bake) stopWorker();
      clearArrays();
      applyRaw();
    },
    update(dt, _t, live) {
      if (disposed || !dom) return;
      const run = live && bool(o, 'live', true) && !bake;
      if (run) {
        if (!worker) startWorker();
        acc += dt;
        if (worker && !busy) {
          const msg: SimRequest = { type: 'step', dt: acc, reuse: spare };
          if (spare) worker.postMessage(msg, [spare.depth.buffer, spare.vx.buffer, spare.vz.buffer]);
          else worker.postMessage(msg);
          spare = undefined;
          busy = true;
          acc = 0;
        }
      } else if (worker && !bake && ctx.editor) {
        // Editor-Simulation beendet: zurück zum gespeicherten Zustand
        stopWorker();
        if (arraysRef !== rawRef || !raw) clearArrays();
        applyRaw();
      }
      if (meshDirty) rebuildMesh();
    },
    updateProps(next) {
      if (propsKey(next) !== key) return false;
      o = next;
      const ref = str(o, 'state', '');
      if (ref !== rawRef) void loadState(ref);
      return true;
    },
    async action(name, progress) {
      if (name === 'clear') {
        stopWorker();
        clearArrays();
        return { state: '' };
      }
      if (name !== 'bake' || !dom || !root) return;
      if (bake) throw new Error('Simulation läuft bereits');
      progress(0, 'Boden wird abgetastet …');
      await new Promise((r) => setTimeout(r, 30));
      const n = dom.nx * dom.nz;
      const ground = sampleGround(root.parent ?? root, root, dom, root.getWorldPosition(_v).y + 200);
      let dry = 0;
      for (let i = 0; i < n; i++) if (!Number.isFinite(ground[i])) dry++;
      stopWorker();
      setArrays({ ground, depth: new Float32Array(n), vx: new Float32Array(n), vz: new Float32Array(n), time: 0 }, '');
      const w = (worker = newWorker());
      const seconds = THREE.MathUtils.clamp(num(o, 'duration', 90), 1, 3600);
      const t0 = performance.now();
      try {
        const result = await new Promise<{ bytes: Uint8Array; time: number; volume: number; wet: number }>((resolve, reject) => {
          bake = { resolve, reject, progress };
          const init: SimRequest = { type: 'init', nx: dom!.nx, nz: dom!.nz, cell: dom!.cell, minX: dom!.minX, minZ: dom!.minZ, ground: ground.slice(), sources: sources(), params: params() };
          w.postMessage(init, [init.ground!.buffer]);
          w.postMessage({ type: 'bake', seconds, reset: true } satisfies SimRequest);
        });
        const r = unzlibSync(result.bytes);
        const id = await browserBlobs.put(result.bytes);
        const ref = blobRef(id);
        rawCache.set(ref, r);
        raw = r;
        rawRef = ref;
        const a = readArrays(r, dom);
        if (a) setArrays(a, ref);
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        progress(1, `${Math.round(result.time)} s in ${secs} s gerechnet · ${result.volume.toFixed(0)} m³ Wasser · ${((result.wet / n) * 100).toFixed(0)} % des Gebiets nass${dry ? ` · ${dry} Zellen ohne Boden` : ''}`);
        return { state: ref };
      } finally {
        bake = null;
        if (worker === w) stopWorker();
      }
    },
    dispose() {
      disposed = true;
      stopWorker();
      bake?.reject(new Error('Objekt wurde neu aufgebaut'));
      if (registered) unregisterWater(body);
      disposeTree(object);
      disposeTree(helper);
    },
  };
}

export const SOURCE_ASSETS: Record<string, AssetDef> = {
  [SOURCE_TYPE]: { label: 'Wasserquelle', category: 'Wasser', fixedRotation: true, fixedScale: true, props: SOURCE_PROPS, create: createSource },
};

/** Status-Zeile für das Wasser-Panel: gespeicherter Zustand (Zeit) oder Hinweis */
export function sourceStateNote(o: MapObjectData): string {
  const ref = str(o, 'state', '');
  const raw = ref ? rawCache.get(ref) : undefined;
  const h = raw ? decodeHeader(raw) : null;
  if (!ref) return 'Noch nicht berechnet: „Simulation berechnen“ lässt das Wasser von der Quelle aus über das Gelände laufen.';
  if (!h) return 'Berechneter Zustand gespeichert.';
  const d = domainOf(o, o.pos[0], o.pos[2]);
  const fits = h.nx === d.nx && h.nz === d.nz && Math.abs(h.cell - d.cell) < 1e-4 && Math.abs(h.minX - d.minX) < 1e-3 && Math.abs(h.minZ - d.minZ) < 1e-3;
  if (!fits) return 'Veraltet: Quelle oder Gebiet wurde geändert — „Simulation berechnen“ erneut ausführen.';
  return `Berechnet: ${Math.round(h.time)} s · Gitter ${h.nx} × ${h.nz} (${h.cell.toFixed(2)} m). Nach Verschieben oder Gebiets-Änderung neu berechnen.`;
}

