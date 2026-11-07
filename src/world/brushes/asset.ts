import * as THREE from 'three';
import type { AssetContext, AssetDef, AssetInstance, PropDef } from '../assets.ts';
import type { Collider } from '../collision.ts';
import type { MapObjectData, PropValue, Vec3 } from '../mapFormat.ts';
import { MATERIAL_OPTIONS, defaultColorFor, getMaterial, type MaterialParams } from '../materials.ts';
import { parseBlobRef } from '../blobStore.ts';
import type { SurfaceId } from '../surfaces.ts';
import type { BrushOp, BrushPart } from './csg.ts';
import { BRUSH_SHAPES, SHAPE_FACES, isShape, shapeEdges, type BrushShape, type ShapeParams } from './shapes.ts';
import { markBrushesDirty, registerBrush, unregisterBrush, type LiveBrush } from './manager.ts';

// Geometry-Brushes (Phase 5, wie UE5 BSP-Brushes):
//  - brush:      Form (Quader, Zylinder, Keil, Treppe, Kugel) + Modus Addieren / Abziehen / Schnitt. Die Objekt-Skalierung
//                gibt die Maße in Metern. Alle Brushes werden in Outliner-Reihenfolge verrechnet (manager.ts, Worker);
//                jeder Brush zeigt seinen Anteil am Ergebnis (Abziehen-Brushes die Innenflächen ihrer Löcher).
//                Material pro Fläche (props.faces), Welt-UVs, Trimesh-Kollision.
//  - staticmesh: „gebackene“ Brushes (In statisches Mesh umwandeln): feste Dreiecke aus einem Blob, keine CSG mehr.

export const BRUSH_TYPE = 'brush';
export const STATICMESH_TYPE = 'staticmesh';

const num = (o: MapObjectData, k: string, d: number) => (typeof o.props[k] === 'number' && Number.isFinite(o.props[k]) ? (o.props[k] as number) : d);
const bool = (o: MapObjectData, k: string, d: boolean) => (typeof o.props[k] === 'boolean' ? (o.props[k] as boolean) : d);
const str = (o: MapObjectData, k: string, d: string) => (typeof o.props[k] === 'string' && o.props[k] ? (o.props[k] as string) : d);

export const BRUSH_OPS: { value: BrushOp; label: string }[] = [
  { value: 'add', label: 'Addieren' },
  { value: 'subtract', label: 'Abziehen' },
  { value: 'intersect', label: 'Schnitt' },
];
const isOp = (v: unknown): v is BrushOp => v === 'add' || v === 'subtract' || v === 'intersect';

export const brushOp = (o: MapObjectData): BrushOp => (isOp(o.props.op) ? o.props.op : 'add');
export const brushShape = (o: MapObjectData): BrushShape => (isShape(o.props.shape) ? o.props.shape : 'box');

const BRUSH_PROPS: PropDef[] = [
  { key: 'shape', label: 'Form', type: 'select', default: 'box', options: BRUSH_SHAPES, group: 'Brush' },
  { key: 'op', label: 'Modus', type: 'select', default: 'add', options: BRUSH_OPS, group: 'Brush' },
  { key: 'segments', label: 'Segmente (Zylinder, Kugel)', type: 'number', default: 24, min: 3, max: 96, step: 1, group: 'Brush' },
  { key: 'stepHeight', label: 'Stufenhöhe (Treppe, m)', type: 'number', default: 0.18, min: 0.05, max: 1, step: 0.01, group: 'Brush' },
  { key: 'material', label: 'Material', type: 'select', default: 'wand_beton', options: MATERIAL_OPTIONS, group: 'Material' },
  { key: 'color', label: 'Farbe / Tönung', type: 'color', default: '#ffffff', group: 'Material' },
  { key: 'roughness', label: 'Rauheit (einfarbig)', type: 'number', default: 0.75, min: 0, max: 1, step: 0.05, group: 'Material' },
  { key: 'metalness', label: 'Metall (einfarbig)', type: 'number', default: 0, min: 0, max: 1, step: 0.05, group: 'Material' },
  { key: 'uvScale', label: 'Textur-Skalierung', type: 'number', default: 1, min: 0.05, max: 20, step: 0.1, group: 'Material' },
  { key: 'faces', label: 'Flächen-Materialien', type: 'text', default: '{}', hidden: true },
  { key: 'castShadow', label: 'Wirft Schatten', type: 'bool', default: true, group: 'Rendering' },
  { key: 'collision', label: 'Kollision', type: 'bool', default: true, group: 'Physik' },
];

/** Material-Überschreibung einer Fläche (leere Felder = Brush-Material) */
export interface FaceOverride {
  material?: string;
  color?: string;
  uvScale?: number;
}

export function parseFaces(o: MapObjectData): Record<string, FaceOverride> {
  try {
    const v = JSON.parse(typeof o.props.faces === 'string' ? o.props.faces : '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, FaceOverride>) : {};
  } catch {
    return {};
  }
}

export const stringifyFaces = (f: Record<string, FaceOverride>) => JSON.stringify(f);

/** Fertiges Material einer Fläche */
export interface FaceMaterial extends MaterialParams {
  uvScale: number;
}

export function faceMaterial(o: MapObjectData, face: number, faces = parseFaces(o)): FaceMaterial {
  const f = faces[String(face)] ?? {};
  const material = f.material || str(o, 'material', 'wand_beton');
  const color = f.color || (f.material ? defaultColorFor(f.material) : str(o, 'color', '#ffffff'));
  return {
    material,
    color,
    roughness: num(o, 'roughness', 0.75),
    metalness: num(o, 'metalness', 0),
    uvScale: f.uvScale && f.uvScale > 0 ? f.uvScale : num(o, 'uvScale', 1),
  };
}

const surfaceFor = (material: string): SurfaceId => (material === 'holz' ? 'holz' : 'beton');

/** Stufenzahl aus Höhe und Stufenhöhe */
export function stairSteps(o: MapObjectData, height: number): number {
  return Math.max(1, Math.min(64, Math.round(Math.abs(height) / Math.max(0.05, num(o, 'stepHeight', 0.18)))));
}

// ---------- Hilfen: Welt-UVs, Trimesh ----------

/** Box-Projektion wie worldUV in assets.ts (1 Textur = 2 m) */
function projectUV(px: number, py: number, pz: number, nx: number, ny: number, nz: number, s: number, out: Float32Array, i: number): void {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let u: number;
  let v: number;
  if (ax >= ay && ax >= az) {
    u = nx > 0 ? -pz : pz;
    v = py;
  } else if (ay >= az) {
    u = px;
    v = ny > 0 ? -pz : pz;
  } else {
    u = nz > 0 ? px : -px;
    v = py;
  }
  out[i * 2] = u * s;
  out[i * 2 + 1] = v * s;
}

/** Nicht indizierte Dreiecke eines Meshes als Trimesh in Weltkoordinaten */
function meshTrimesh(mesh: THREE.Mesh): Collider | null {
  const p = mesh.geometry.getAttribute('position');
  if (!p || p.count < 3) return null;
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const vertices = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(m);
    vertices[i * 3] = v.x;
    vertices[i * 3 + 1] = v.y;
    vertices[i * 3 + 2] = v.z;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const indices = new Uint32Array(p.count);
  for (let i = 0; i < p.count; i++) indices[i] = i;
  return { type: 'trimesh', vertices, indices, minY, maxY };
}

function disposeMeshes(group: THREE.Object3D): void {
  for (const c of [...group.children]) {
    group.remove(c);
    (c as THREE.Mesh).geometry?.dispose();
  }
}

// ---------- Editor-Drahtgitter ----------

const HELPER_COLORS: Record<BrushOp, string> = { add: '#4da3ff', subtract: '#ffb347', intersect: '#c48cff' };

function brushHelper(p: ShapeParams, op: BrushOp): THREE.LineSegments {
  const mat = new THREE.LineBasicMaterial({ color: HELPER_COLORS[op], transparent: true, opacity: op === 'add' ? 0.5 : 0.9, depthTest: false, toneMapped: false });
  const l = new THREE.LineSegments(shapeEdges(p), mat);
  l.renderOrder = 4;
  l.userData.editorHelper = true;
  l.userData.noWeather = true;
  return l;
}

// ---------- Brush ----------

const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();

function createBrush(o: MapObjectData, ctx: AssetContext): AssetInstance {
  const object = new THREE.Group();
  object.name = 'brush';
  const shape = brushShape(o);
  const op = brushOp(o);
  const segments = Math.round(num(o, 'segments', 24));
  const castShadow = bool(o, 'castShadow', true);
  const collision = bool(o, 'collision', true);
  const faces = parseFaces(o);
  let meshes: THREE.Mesh[] = [];
  let root: THREE.Object3D | null = null;
  let steps = stairSteps(o, o.scale[1]);
  let disposed = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  const helper = ctx.editor ? brushHelper({ shape, segments, steps }, op) : undefined;

  /** Ergebnis-Dreiecke (Welt) in Meshes je Material umbauen (lokal zum Brush) */
  const build = (part: BrushPart | null, jobMatrix: THREE.Matrix4) => {
    disposeMeshes(object);
    meshes = [];
    if (!part || disposed) return;
    const inv = jobMatrix.clone().invert();
    const nm = new THREE.Matrix3().getNormalMatrix(inv);
    const groups = new Map<string, { mat: FaceMaterial; parts: typeof part.faces }>();
    for (const f of part.faces) {
      const mat = faceMaterial(o, f.face, faces);
      const key = JSON.stringify(mat);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { mat, parts: [] }));
      g.parts.push(f);
    }
    const n = new THREE.Vector3();
    for (const g of groups.values()) {
      const count = g.parts.reduce((s, f) => s + f.pos.length / 3, 0);
      if (!count) continue;
      const pos = new Float32Array(count * 3);
      const nor = new Float32Array(count * 3);
      const uv = new Float32Array(count * 2);
      const faceOf = new Uint8Array(count / 3);
      const s = 0.5 * g.mat.uvScale;
      let vi = 0;
      for (const f of g.parts) {
        for (let i = 0; i < f.pos.length; i += 3, vi++) {
          const wx = f.pos[i];
          const wy = f.pos[i + 1];
          const wz = f.pos[i + 2];
          projectUV(wx, wy, wz, f.nor[i], f.nor[i + 1], f.nor[i + 2], s, uv, vi);
          _p.set(wx, wy, wz).applyMatrix4(inv).toArray(pos, vi * 3);
          n.set(f.nor[i], f.nor[i + 1], f.nor[i + 2]).applyMatrix3(nm).normalize().toArray(nor, vi * 3);
          if (vi % 3 === 0) faceOf[vi / 3] = f.face;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const { uvScale: _u, ...params } = g.mat;
      const mesh = new THREE.Mesh(geo, getMaterial(params, ctx.anisotropy));
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.userData.foliageSurface = surfaceFor(g.mat.material);
      mesh.userData.brushFaces = faceOf;
      mesh.userData.brushMat = g.mat;
      object.add(mesh);
      meshes.push(mesh);
    }
  };

  const liveBrush: LiveBrush = {
    mapId: o.id,
    state() {
      if (!root) return null;
      return { shape, segments, steps, op, matrix: root.matrixWorld };
    },
    apply(part, jobMatrix) {
      build(part, jobMatrix);
      resolveReady();
    },
  };

  return {
    object,
    helper,
    ready,
    get colorables() {
      return meshes;
    },
    onTransform(r) {
      if (disposed) return;
      const first = !root;
      root = r;
      r.updateMatrixWorld(true);
      if (shape === 'stairs') {
        r.matrixWorld.decompose(_p, _q, _s);
        const n = stairSteps(o, _s.y);
        if (n !== steps) {
          steps = n;
          if (helper) {
            helper.geometry.dispose();
            helper.geometry = shapeEdges({ shape, segments, steps });
          }
        }
      }
      if (first) registerBrush(liveBrush);
      else markBrushesDirty();
    },
    colliders() {
      if (!collision) return [];
      const out: Collider[] = [];
      for (const m of meshes) {
        const c = meshTrimesh(m);
        if (c) out.push(c);
      }
      return out;
    },
    dispose() {
      disposed = true;
      unregisterBrush(liveBrush);
      disposeMeshes(object);
      meshes = [];
      if (helper) {
        helper.geometry.dispose();
        (helper.material as THREE.Material).dispose();
      }
      resolveReady();
    },
  };
}

// ---------- Statisches Mesh (gebackene Brushes) ----------

/** Ein Material-Teil des gebackenen Meshes; im Blob liegen je Teil pos (n×3), nor (n×3), uv (n×2) als float32 */
export interface BakedPart {
  mat: MaterialParams;
  surface: SurfaceId;
  /** Anzahl Eckpunkte */
  n: number;
}

const STATICMESH_PROPS: PropDef[] = [
  { key: 'mesh', label: 'Geometrie', type: 'text', default: '', hidden: true },
  { key: 'parts', label: 'Teile', type: 'text', default: '[]', hidden: true },
  { key: 'castShadow', label: 'Wirft Schatten', type: 'bool', default: true, group: 'Rendering' },
  { key: 'collision', label: 'Kollision', type: 'bool', default: true, group: 'Physik' },
];

/** Meshes (lokal zu `origin`) in Blob-Bytes + Teile-Liste umwandeln */
export function encodeBaked(meshes: THREE.Mesh[], origin: THREE.Vector3): { bytes: Uint8Array; parts: BakedPart[] } {
  const byMat = new Map<string, { mat: FaceMaterial; pos: number[]; nor: number[]; uv: number[] }>();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const mat = m.userData.brushMat as FaceMaterial | undefined;
    if (!mat) continue;
    m.updateWorldMatrix(true, false);
    nm.getNormalMatrix(m.matrixWorld);
    const key = JSON.stringify(mat);
    let e = byMat.get(key);
    if (!e) byMat.set(key, (e = { mat, pos: [], nor: [], uv: [] }));
    const g = m.geometry;
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const uv = g.attributes.uv;
    // gespiegelte Brushes: Dreiecke umdrehen, damit sie in Weltkoordinaten richtig herum liegen
    const flip = m.matrixWorld.determinant() < 0;
    for (let t = 0; t < p.count; t += 3) {
      for (const k of flip ? [0, 2, 1] : [0, 1, 2]) {
        const i = t + k;
        v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).sub(origin);
        e.pos.push(v.x, v.y, v.z);
        v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
        e.nor.push(v.x, v.y, v.z);
        e.uv.push(uv.getX(i), uv.getY(i));
      }
    }
  }
  const parts: BakedPart[] = [];
  const chunks: number[][] = [];
  for (const e of byMat.values()) {
    const { uvScale: _u, ...mat } = e.mat;
    parts.push({ mat, surface: surfaceFor(mat.material), n: e.pos.length / 3 });
    chunks.push(e.pos, e.nor, e.uv);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const f = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    f.set(c, off);
    off += c.length;
  }
  return { bytes: new Uint8Array(f.buffer), parts };
}

function parseParts(o: MapObjectData): BakedPart[] {
  try {
    const v = JSON.parse(str(o, 'parts', '[]')) as unknown;
    return Array.isArray(v) ? (v as BakedPart[]) : [];
  } catch {
    return [];
  }
}

function createStaticMesh(o: MapObjectData, ctx: AssetContext): AssetInstance {
  const object = new THREE.Group();
  object.name = 'staticmesh';
  const meshes: THREE.Mesh[] = [];
  const parts = parseParts(o);
  const id = parseBlobRef(o.props.mesh);
  let disposed = false;
  const ready = (async () => {
    if (!id || !ctx.blobs) return;
    const bytes = await ctx.blobs.get(id);
    if (!bytes || disposed) return;
    const all = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    let off = 0;
    for (const p of parts) {
      const n = p.n;
      if (off + n * 8 > all.length) break;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(all.slice(off, off + n * 3), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(all.slice(off + n * 3, off + n * 6), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(all.slice(off + n * 6, off + n * 8), 2));
      off += n * 8;
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, getMaterial(p.mat, ctx.anisotropy));
      mesh.castShadow = bool(o, 'castShadow', true);
      mesh.receiveShadow = true;
      mesh.userData.foliageSurface = p.surface;
      object.add(mesh);
      meshes.push(mesh);
    }
  })().catch((e) => console.error('Statisches Mesh:', e));
  return {
    object,
    ready,
    colorables: meshes,
    colliders() {
      if (!bool(o, 'collision', true)) return [];
      const out: Collider[] = [];
      for (const m of meshes) {
        const c = meshTrimesh(m);
        if (c) out.push(c);
      }
      return out;
    },
    dispose() {
      disposed = true;
      for (const m of meshes) m.geometry.dispose();
    },
  };
}

// ---------- Registrierung ----------

export const BRUSH_ASSETS: Record<string, AssetDef> = {
  [BRUSH_TYPE]: { label: 'Geometry-Brush', category: 'Brushes', props: BRUSH_PROPS, create: createBrush },
  [STATICMESH_TYPE]: { label: 'Statisches Mesh', category: 'Brushes', fixedScale: true, props: STATICMESH_PROPS, create: createStaticMesh },
};

export interface BrushPreset {
  id: string;
  label: string;
  icon: string;
  scale: Vec3;
  rot?: Vec3;
  props: Record<string, PropValue>;
}

/** Vorgaben im Modeling-Modus und im Content Browser */
export const BRUSH_PRESETS: BrushPreset[] = [
  { id: 'brush-box', label: 'Quader', icon: 'cube', scale: [4, 3, 4], props: { shape: 'box' } },
  { id: 'brush-wall', label: 'Wand', icon: 'wall', scale: [4, 3, 0.3], props: { shape: 'box' } },
  { id: 'brush-floor', label: 'Boden', icon: 'floor', scale: [6, 0.2, 6], props: { shape: 'box', material: 'bodenfliesen' } },
  { id: 'brush-cylinder', label: 'Zylinder', icon: 'cylinder', scale: [2, 3, 2], props: { shape: 'cylinder' } },
  { id: 'brush-wedge', label: 'Rampe', icon: 'wedge', scale: [2, 1, 3], props: { shape: 'wedge' } },
  { id: 'brush-stairs', label: 'Treppe', icon: 'stairs', scale: [1.5, 1.8, 3], props: { shape: 'stairs' } },
  { id: 'brush-sphere', label: 'Kugel', icon: 'sphere', scale: [2, 2, 2], props: { shape: 'sphere' } },
  { id: 'brush-door', label: 'Türloch', icon: 'door', scale: [1, 2.1, 1], props: { shape: 'box', op: 'subtract' } },
  { id: 'brush-window', label: 'Fensterloch', icon: 'window', scale: [1.2, 1, 1], props: { shape: 'box', op: 'subtract' } },
  { id: 'brush-tunnel', label: 'Tunnel (rund)', icon: 'cylinder', scale: [3, 8, 3], rot: [90, 0, 0], props: { shape: 'cylinder', op: 'subtract' } },
];

/** Namen der Flächen eines Brushes */
export const faceNames = (o: MapObjectData) => SHAPE_FACES[brushShape(o)];
