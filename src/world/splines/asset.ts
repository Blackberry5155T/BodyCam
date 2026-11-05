import * as THREE from 'three';
import type { AssetContext, AssetDef, AssetInstance, PropDef } from '../assets.ts';
import type { Collider } from '../collision.ts';
import type { MapObjectData, PropValue } from '../mapFormat.ts';
import { MATERIAL_OPTIONS, getMaterial } from '../materials.ts';
import { loadModel } from '../modelStore.ts';
import { loadTextureSet } from '../landscape/textures.ts';
import type { SurfaceId } from '../surfaces.ts';
import { SplineCurve, parsePoints, sampleCable, type SplineSample } from './curve.ts';
import { extrudeProfile, frameAt, roadGeometry, stripGeometry, tubeGeometry, worldTrimesh, type ProfilePoint, type Strip } from './geometry.ts';
import { addDeformSource, removeDeformSource, roadDeform, type DeformSource } from './deform.ts';
import { makeRoadZone, setRoadZone } from './zones.ts';

// Spline-Assets (Phase 4, wie UE5 Landscape-Splines / Spline-Mesh):
//  - road:       Straße/Weg, formt im Editor das Gelände (nicht-destruktiv), Markierungen, Bordsteine, Kollision
//  - splinemesh: Profil entlang der Kurve (Leitplanke, Zaun, Mauer) oder ein 3D-Modell, das der Kurve folgt
//  - cable:      Kabel mit Durchhang oder Rohr
// Die Punkte stehen als JSON in props.points (lokal zur Objektposition); bearbeitet werden sie im Splines-Modus.
// Kabel-Punkte können an Objekten hängen (Masten): der Editor zieht sie beim Verschieben nach.

export const ROAD_TYPE = 'road';
export const SPLINEMESH_TYPE = 'splinemesh';
export const CABLE_TYPE = 'cable';
export const SPLINE_TYPES = new Set([ROAD_TYPE, SPLINEMESH_TYPE, CABLE_TYPE]);

const num = (o: MapObjectData, k: string, d: number) => (typeof o.props[k] === 'number' && Number.isFinite(o.props[k]) ? (o.props[k] as number) : d);
const bool = (o: MapObjectData, k: string, d: boolean) => (typeof o.props[k] === 'boolean' ? (o.props[k] as boolean) : d);
const str = (o: MapObjectData, k: string, d: string) => (typeof o.props[k] === 'string' && o.props[k] ? (o.props[k] as string) : d);

const POINTS: PropDef = { key: 'points', label: 'Punkte', type: 'text', default: '[]', hidden: true };
const CLOSED: PropDef = { key: 'closed', label: 'Geschlossen (Ring)', type: 'bool', default: false, group: 'Spline' };

// ---------- Editor-Helfer ----------

const HELPER_COLORS: Record<string, string> = { [ROAD_TYPE]: '#ffb347', [SPLINEMESH_TYPE]: '#7fd0ff', [CABLE_TYPE]: '#d58cff' };

/** Kurve + Punkte als Linie (nur Editor) */
function splineHelper(type: string, line: THREE.Vector3[], ctrl: THREE.Vector3[]): THREE.Object3D {
  const g = new THREE.Group();
  const color = HELPER_COLORS[type] ?? '#ffffff';
  if (line.length > 1) {
    const geo = new THREE.BufferGeometry().setFromPoints(line.map((p) => p.clone().add(new THREE.Vector3(0, 0.06, 0))));
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false, toneMapped: false }));
    l.renderOrder = 5;
    g.add(l);
  }
  if (ctrl.length) {
    const geo = new THREE.BufferGeometry().setFromPoints(ctrl.map((p) => p.clone().add(new THREE.Vector3(0, 0.06, 0))));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }));
    pts.renderOrder = 6;
    pts.userData.noPick = true;
    g.add(pts);
  }
  g.traverse((c) => (c.userData.editorHelper = true));
  return g;
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) if (!mat.userData.shared) mat.dispose();
  });
}

// ---------- Straßen-Texturen (aus den Landscape-Textur-Sets) ----------

interface RoadTex {
  map: THREE.DataTexture;
  normal: THREE.DataTexture;
  /** R = AO, G = Rauheit (wie MeshStandardMaterial erwartet) */
  orm: THREE.DataTexture;
}
const roadTexCache = new Map<string, Promise<RoadTex>>();

function dataTex(data: Uint8Array, size: number, srgb: boolean, aniso: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function roadTextures(ref: string, aniso: number): Promise<RoadTex> {
  let p = roadTexCache.get(ref);
  if (!p) {
    p = loadTextureSet(ref, 512).then((set) => {
      const n = set.size * set.size;
      const nrm = new Uint8Array(n * 4);
      const orm = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const x = set.normal[i * 2] / 127.5 - 1;
        const y = set.normal[i * 2 + 1] / 127.5 - 1;
        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
        nrm[i * 4] = set.normal[i * 2];
        nrm[i * 4 + 1] = set.normal[i * 2 + 1];
        nrm[i * 4 + 2] = Math.round(z * 127.5 + 127.5);
        nrm[i * 4 + 3] = 255;
        orm[i * 4] = set.arm[i * 4 + 1];
        orm[i * 4 + 1] = set.arm[i * 4];
        orm[i * 4 + 2] = 0;
        orm[i * 4 + 3] = 255;
      }
      return { map: dataTex(set.albedo, set.size, true, aniso), normal: dataTex(nrm, set.size, false, aniso), orm: dataTex(orm, set.size, false, aniso) };
    });
    roadTexCache.set(ref, p);
  }
  return p;
}

const ROAD_SURFACES: { value: string; label: string; surface: SurfaceId; base: string }[] = [
  { value: 'asphalt', label: 'Asphalt', surface: 'asphalt', base: '#3b3c3e' },
  { value: 'kies', label: 'Kies / Schotter', surface: 'kies', base: '#8a8378' },
  { value: 'erde', label: 'Erde (Feldweg)', surface: 'erde', base: '#5e4a36' },
  { value: 'sand', label: 'Sand', surface: 'sand', base: '#b9a27a' },
  { value: 'schlamm', label: 'Schlamm', surface: 'schlamm', base: '#4a3b2c' },
];

// ---------- Straße ----------

const CURB_W = 0.22;

const ROAD_PROPS: PropDef[] = [
  POINTS,
  CLOSED,
  { key: 'width', label: 'Breite (m)', type: 'number', default: 7, min: 0.5, max: 60, step: 0.5, group: 'Straße' },
  { key: 'surface', label: 'Belag', type: 'select', default: 'asphalt', options: ROAD_SURFACES.map((s) => ({ value: s.value, label: s.label })), group: 'Straße' },
  { key: 'tint', label: 'Tönung', type: 'color', default: '#ffffff', group: 'Straße' },
  { key: 'texScale', label: 'Textur-Kachel (m)', type: 'number', default: 4, min: 0.25, max: 50, step: 0.25, group: 'Straße' },
  {
    key: 'markings',
    label: 'Mittellinie',
    type: 'select',
    default: 'dashed',
    options: [
      { value: 'none', label: 'Keine' },
      { value: 'dashed', label: 'Gestrichelt' },
      { value: 'solid', label: 'Durchgezogen' },
      { value: 'double', label: 'Doppelt' },
    ],
    group: 'Markierung',
  },
  { key: 'edgeLines', label: 'Randlinien', type: 'bool', default: true, group: 'Markierung' },
  { key: 'lineColor', label: 'Farbe', type: 'color', default: '#e6e4dc', group: 'Markierung' },
  { key: 'curbs', label: 'Bordsteine', type: 'bool', default: false, group: 'Bordstein' },
  { key: 'curbHeight', label: 'Bordstein-Höhe (m)', type: 'number', default: 0.12, min: 0.02, max: 0.5, step: 0.01, group: 'Bordstein' },
  { key: 'deform', label: 'Gelände anpassen', type: 'bool', default: true, group: 'Gelände' },
  { key: 'shoulder', label: 'Böschung (m)', type: 'number', default: 4, min: 0, max: 50, step: 0.5, group: 'Gelände' },
  { key: 'lower', label: 'Gelände unter Straße (m)', type: 'number', default: 0.06, min: 0, max: 2, step: 0.01, group: 'Gelände' },
  { key: 'clearGrass', label: 'Gras entfernen', type: 'bool', default: true, group: 'Gelände' },
  { key: 'collision', label: 'Kollision', type: 'bool', default: true, group: 'Physik' },
  { key: 'step', label: 'Auflösung (m)', type: 'number', default: 1, min: 0.25, max: 8, step: 0.25, group: 'Spline' },
];

function createRoad(o: MapObjectData, ctx: AssetContext): AssetInstance {
  const object = new THREE.Group();
  const pts = parsePoints(o.props.points);
  const curve = new SplineCurve(pts, bool(o, 'closed', false));
  const samples = curve.sample(num(o, 'step', 1));
  const half = Math.max(0.25, num(o, 'width', 7) / 2);
  const surf = ROAD_SURFACES.find((s) => s.value === str(o, 'surface', 'asphalt')) ?? ROAD_SURFACES[0];
  const curbs = bool(o, 'curbs', false);
  const curbH = num(o, 'curbHeight', 0.12);
  const texScale = Math.max(0.25, num(o, 'texScale', 4));
  let disposed = false;
  const collGeos: THREE.BufferGeometry[] = [];

  if (samples.length >= 2) {
    const mat = new THREE.MeshStandardMaterial({ color: surf.base, roughness: 0.9, metalness: 0 });
    const tint = str(o, 'tint', '#ffffff');
    void roadTextures(`proc:${surf.value}`, ctx.anisotropy).then((t) => {
      if (disposed) return;
      mat.map = t.map;
      mat.normalMap = t.normal;
      mat.roughnessMap = t.orm;
      mat.aoMap = t.orm;
      mat.roughness = 1;
      mat.color.set(tint);
      mat.needsUpdate = true;
    });
    const geo = roadGeometry(samples, half, texScale);
    const road = new THREE.Mesh(geo, mat);
    road.receiveShadow = true;
    road.userData.foliageSurface = surf.surface;
    object.add(road);
    collGeos.push(geo);

    // Markierungen
    const strips: Strip[] = [];
    const m = str(o, 'markings', 'dashed');
    if (m === 'dashed') strips.push({ l: { frac: 0, delta: 0 }, width: 0.12, dash: [3, 6] });
    else if (m === 'solid') strips.push({ l: { frac: 0, delta: 0 }, width: 0.12 });
    else if (m === 'double') strips.push({ l: { frac: 0, delta: -0.1 }, width: 0.1 }, { l: { frac: 0, delta: 0.1 }, width: 0.1 });
    if (bool(o, 'edgeLines', true) && half > 1.5) strips.push({ l: { frac: -1, delta: 0.3 }, width: 0.15 }, { l: { frac: 1, delta: -0.3 }, width: 0.15 });
    const sg = strips.length ? stripGeometry(samples, half, strips) : null;
    if (sg) {
      const lm = new THREE.MeshStandardMaterial({ color: str(o, 'lineColor', '#e6e4dc'), roughness: 0.65, metalness: 0 });
      const lines = new THREE.Mesh(sg, lm);
      lines.receiveShadow = true;
      lines.userData.foliageSurface = surf.surface;
      object.add(lines);
    }

    // Bordsteine
    if (curbs) {
      const cm = getMaterial({ material: 'beton_dunkel', color: '#d8d8d8' }, ctx.anisotropy);
      const right: ProfilePoint[] = [
        { x: 0, y: -0.15 },
        { x: CURB_W, y: -0.15 },
        { x: CURB_W, y: curbH },
        { x: 0, y: curbH },
      ];
      const left: ProfilePoint[] = [
        { x: 0, y: -0.15 },
        { x: 0, y: curbH },
        { x: -CURB_W, y: curbH },
        { x: -CURB_W, y: -0.15 },
      ];
      for (const [prof, frac] of [
        [right, 1],
        [left, -1],
      ] as const) {
        const g = extrudeProfile(samples, prof, { l: { frac, delta: 0 }, half, closed: true, caps: !curve.closed, hard: true, texScale: 1 });
        const c = new THREE.Mesh(g, cm);
        c.castShadow = true;
        c.receiveShadow = true;
        c.userData.foliageSurface = 'beton';
        object.add(c);
        collGeos.push(g);
      }
    }
  }

  // Welt-Mittellinie (Gelände, Gras, Schritte)
  const origin = new THREE.Vector3();
  let placed = false;
  const halfs = samples.map((s) => half * s.w + (curbs ? CURB_W : 0) + 0.15);
  const zoneKey = `road:${o.id}:${Math.random().toString(36).slice(2)}`;
  let deform: { key: string; source: DeformSource } | null = null;
  const worldLine = () => samples.map((s) => s.pos.clone().add(origin));
  const refresh = () => {
    if (samples.length < 2) return;
    const line = worldLine();
    setRoadZone(zoneKey, makeRoadZone(line, halfs, 0.6, surf.surface, bool(o, 'clearGrass', true)));
    if (!ctx.editor || !bool(o, 'deform', true)) return;
    const shoulder = num(o, 'shoulder', 4);
    const lower = num(o, 'lower', 0.06);
    let maxHalf = 0;
    for (const h of halfs) maxHalf = Math.max(maxHalf, h);
    const pad = maxHalf + shoulder;
    const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const p of line) {
      box.minX = Math.min(box.minX, p.x - pad);
      box.maxX = Math.max(box.maxX, p.x + pad);
      box.minZ = Math.min(box.minZ, p.z - pad);
      box.maxZ = Math.max(box.maxZ, p.z + pad);
    }
    const build: DeformSource['build'] = (d, lo) => roadDeform(d, lo, line, halfs, shoulder, lower);
    if (!deform) deform = addDeformSource({ version: 1, box, build });
    else {
      deform.source.version++;
      deform.source.box = box;
      deform.source.build = build;
    }
  };

  return {
    object,
    helper: ctx.editor
      ? splineHelper(
          ROAD_TYPE,
          samples.map((s) => s.pos),
          pts.map((p) => new THREE.Vector3(...p.p)),
        )
      : undefined,
    onTransform(root) {
      const p = root.getWorldPosition(new THREE.Vector3());
      if (placed && p.equals(origin)) return;
      placed = true;
      origin.copy(p);
      refresh();
    },
    colliders(root) {
      if (!bool(o, 'collision', true)) return [];
      root.updateMatrixWorld(true);
      const out: Collider[] = [];
      for (const g of collGeos) {
        const t = worldTrimesh(g, root.matrixWorld);
        if (t) out.push({ type: 'trimesh', ...t });
      }
      return out;
    },
    dispose() {
      disposed = true;
      setRoadZone(zoneKey, null);
      if (deform) removeDeformSource(deform.key);
      disposeTree(object);
    },
  };
}

// ---------- Spline-Mesh (Leitplanke, Zaun, Mauer, Modell) ----------

const SPLINEMESH_PROPS: PropDef[] = [
  POINTS,
  CLOSED,
  {
    key: 'profile',
    label: 'Art',
    type: 'select',
    default: 'leitplanke',
    options: [
      { value: 'leitplanke', label: 'Leitplanke' },
      { value: 'zaun', label: 'Maschendrahtzaun' },
      { value: 'mauer', label: 'Mauer' },
      { value: 'modell', label: '3D-Modell entlang der Kurve' },
    ],
    group: 'Mesh',
  },
  { key: 'offset', label: 'Seitlicher Versatz (m)', type: 'number', default: 0, step: 0.05, group: 'Mesh' },
  { key: 'height', label: 'Höhe (Zaun/Mauer, m)', type: 'number', default: 2, min: 0.2, max: 20, step: 0.1, group: 'Mesh' },
  { key: 'thickness', label: 'Dicke (Mauer, m)', type: 'number', default: 0.3, min: 0.05, max: 5, step: 0.05, group: 'Mesh' },
  { key: 'spacing', label: 'Pfostenabstand (m)', type: 'number', default: 2, min: 0.5, max: 20, step: 0.25, group: 'Mesh' },
  { key: 'material', label: 'Material (Mauer)', type: 'select', default: 'wand_beton', options: MATERIAL_OPTIONS, group: 'Mesh' },
  { key: 'color', label: 'Farbe', type: 'color', default: '#ffffff', group: 'Mesh' },
  { key: 'model', label: 'Modell', type: 'model', default: '', group: 'Modell' },
  { key: 'collision', label: 'Kollision', type: 'bool', default: true, group: 'Physik' },
  { key: 'castShadow', label: 'Wirft Schatten', type: 'bool', default: true, group: 'Rendering' },
];

/** Leitplanke: Schutzplanke mit W-Profil (Mitte 0,6 m über Grund), Pfosten dahinter */
const W_BEAM: ProfilePoint[] = [
  { x: 0.12, y: 0.445 },
  { x: 0.16, y: 0.47 },
  { x: 0.2, y: 0.51 },
  { x: 0.16, y: 0.56 },
  { x: 0.13, y: 0.6 },
  { x: 0.16, y: 0.64 },
  { x: 0.2, y: 0.69 },
  { x: 0.16, y: 0.73 },
  { x: 0.12, y: 0.755 },
];

let chainTex: THREE.CanvasTexture | null = null;
/** Maschendraht (Rauten, Alpha) — eine Kachel = 0,4 m */
function chainLink(): THREE.CanvasTexture {
  if (chainTex) return chainTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3;
  const n = 6;
  for (let i = -n; i <= n * 2; i++) {
    const x = (i * 128) / n;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 128, 128);
    g.moveTo(x, 128);
    g.lineTo(x + 128, 0);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  chainTex = t;
  return t;
}

/** Pfosten senkrecht entlang der Kurve */
function posts(samples: SplineSample[], spacing: number, offset: number, geo: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh {
  const total = samples[samples.length - 1].s;
  const count = Math.max(2, Math.floor(total / spacing) + 1);
  const step = total / (count - 1);
  const im = new THREE.InstancedMesh(geo, mat, count);
  const f = { pos: new THREE.Vector3(), tan: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
  const m = new THREE.Matrix4();
  const r = new THREE.Vector3();
  const z = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < count; i++) {
    frameAt(samples, i * step, f);
    r.set(f.right.x, 0, f.right.z);
    if (r.lengthSq() < 1e-8) r.set(1, 0, 0);
    r.normalize();
    z.crossVectors(r, Y);
    m.makeBasis(r, Y, z);
    m.setPosition(f.pos.x + r.x * offset, f.pos.y, f.pos.z + r.z * offset);
    im.setMatrixAt(i, m);
  }
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  return im;
}

function createSplineMesh(o: MapObjectData, ctx: AssetContext): AssetInstance {
  const object = new THREE.Group();
  const pts = parsePoints(o.props.points);
  const curve = new SplineCurve(pts, bool(o, 'closed', false));
  const kind = str(o, 'profile', 'leitplanke');
  const samples = curve.sample(kind === 'modell' ? 0.25 : 0.5);
  const offset = num(o, 'offset', 0);
  const l = { frac: 0, delta: offset };
  const height = Math.max(0.2, num(o, 'height', 2));
  const color = str(o, 'color', '#ffffff');
  const cast = bool(o, 'castShadow', true);
  const spacing = Math.max(0.5, num(o, 'spacing', 2));
  /** Kollisions-Profil (x seitlich, y oben) */
  let coll: ProfilePoint[] | null = null;
  let disposed = false;
  let ready: Promise<void> | undefined;
  const add = (m: THREE.Mesh) => {
    m.castShadow = cast;
    m.receiveShadow = true;
    object.add(m);
  };
  const box = (x0: number, x1: number, y0: number, y1: number): ProfilePoint[] => [
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: x0, y: y0 },
  ];

  if (samples.length >= 2) {
    if (kind === 'leitplanke') {
      const metal = new THREE.MeshStandardMaterial({ color: new THREE.Color('#a9b0b4').multiply(new THREE.Color(color)), roughness: 0.38, metalness: 0.75, side: THREE.DoubleSide });
      add(new THREE.Mesh(extrudeProfile(samples, W_BEAM, { l }), metal));
      const post = new THREE.BoxGeometry(0.1, 1.1, 0.06).translate(0, 0.25, 0);
      const pm = posts(samples, spacing, offset, post, metal);
      pm.castShadow = cast;
      object.add(pm);
      coll = box(offset - 0.06, offset + 0.21, -0.1, 0.8);
    } else if (kind === 'zaun') {
      const steel = new THREE.MeshStandardMaterial({ color: new THREE.Color('#8e9497').multiply(new THREE.Color(color)), roughness: 0.45, metalness: 0.7 });
      const pole = new THREE.CylinderGeometry(0.03, 0.03, height + 0.3, 8).translate(0, (height + 0.3) / 2 - 0.3, 0);
      const pm = posts(samples, spacing, offset, pole, steel);
      pm.castShadow = cast;
      object.add(pm);
      const ring: ProfilePoint[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ring.push({ x: Math.cos(a) * 0.02, y: height + Math.sin(a) * 0.02 });
      }
      add(new THREE.Mesh(extrudeProfile(samples, ring, { l, closed: true }), steel));
      const wire = new THREE.MeshStandardMaterial({ color: new THREE.Color('#9aa0a2').multiply(new THREE.Color(color)), roughness: 0.5, metalness: 0.6, alphaMap: chainLink(), alphaTest: 0.5, side: THREE.DoubleSide });
      wire.transparent = false;
      const panel = new THREE.Mesh(
        extrudeProfile(
          samples,
          [
            { x: 0, y: 0.04 },
            { x: 0, y: height - 0.02 },
          ],
          { l, texScale: 0.4 },
        ),
        wire,
      );
      add(panel);
      coll = box(offset - 0.05, offset + 0.05, -0.1, height);
    } else if (kind === 'mauer') {
      const t = Math.max(0.05, num(o, 'thickness', 0.3));
      const prof = box(offset - t / 2, offset + t / 2, -0.3, height);
      const mat = getMaterial({ material: str(o, 'material', 'wand_beton'), color, side: THREE.FrontSide }, ctx.anisotropy);
      const m = new THREE.Mesh(extrudeProfile(samples, prof, { closed: true, caps: !curve.closed, hard: true, texScale: 2 }), mat);
      m.userData.foliageSurface = 'beton';
      add(m);
      coll = prof;
    } else if (kind === 'modell') {
      const ref = str(o, 'model', '');
      if (ref)
        ready = loadModel(ref).then((model) => {
          if (!model || disposed) return;
          coll = bendModel(model, samples, offset, object, cast);
        });
    }
  }

  const collGeo = () => (coll && samples.length >= 2 ? extrudeProfile(samples, coll, { closed: true, caps: !curve.closed, hard: true }) : null);

  return {
    object,
    ready,
    helper: ctx.editor
      ? splineHelper(
          SPLINEMESH_TYPE,
          samples.map((s) => s.pos),
          pts.map((p) => new THREE.Vector3(...p.p)),
        )
      : undefined,
    colliders(root) {
      if (!bool(o, 'collision', true)) return [];
      const g = collGeo();
      if (!g) return [];
      root.updateMatrixWorld(true);
      const t = worldTrimesh(g, root.matrixWorld);
      g.dispose();
      return t ? [{ type: 'trimesh', ...t }] : [];
    },
    dispose() {
      disposed = true;
      object.traverse((c) => {
        const m = c as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mat of mats) if (!mat.userData.shared && !c.userData.modelMaterial) mat.dispose();
      });
    },
  };
}

/**
 * 3D-Modell entlang der Kurve verbiegen (wie UE5 Spline-Mesh): Modell-X = entlang der Kurve, Y = oben,
 * Z = rechts. Das Modell wird so oft wiederholt, dass es ohne Lücke die ganze Länge füllt.
 * Liefert das Kollisions-Profil (Umriss des Modells im Querschnitt).
 */
function bendModel(model: THREE.Object3D, samples: SplineSample[], offset: number, into: THREE.Object3D, cast: boolean): ProfilePoint[] {
  model.updateMatrixWorld(true);
  const parts: { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[] }[] = [];
  const bb = new THREE.Box3();
  model.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    g.computeBoundingBox();
    bb.union(g.boundingBox!);
    parts.push({ geo: g, mat: m.material });
  });
  if (!parts.length || bb.isEmpty()) return [];
  const L = Math.max(0.05, bb.max.x - bb.min.x);
  const total = samples[samples.length - 1].s;
  const count = Math.max(1, Math.round(total / L));
  const k = total / (count * L);
  const f = { pos: new THREE.Vector3(), tan: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();
  for (let i = 0; i < count; i++)
    for (const part of parts) {
      const g = part.geo.clone();
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const nor = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
      for (let j = 0; j < pos.count; j++) {
        v.fromBufferAttribute(pos, j);
        frameAt(samples, (i * L + (v.x - bb.min.x)) * k, f);
        const p = f.pos.addScaledVector(f.right, v.z + offset).addScaledVector(f.up, v.y);
        pos.setXYZ(j, p.x, p.y, p.z);
        if (nor) {
          nv.fromBufferAttribute(nor, j);
          const n = new THREE.Vector3().addScaledVector(f.tan, nv.x).addScaledVector(f.up, nv.y).addScaledVector(f.right, nv.z).normalize();
          nor.setXYZ(j, n.x, n.y, n.z);
        }
      }
      pos.needsUpdate = true;
      if (nor) nor.needsUpdate = true;
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const mesh = new THREE.Mesh(g, part.mat);
      mesh.userData.modelMaterial = true;
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      into.add(mesh);
    }
  for (const p of parts) p.geo.dispose();
  return [
    { x: bb.max.z + offset, y: bb.min.y },
    { x: bb.max.z + offset, y: bb.max.y },
    { x: bb.min.z + offset, y: bb.max.y },
    { x: bb.min.z + offset, y: bb.min.y },
  ];
}

// ---------- Kabel / Rohr ----------

const CABLE_PROPS: PropDef[] = [
  POINTS,
  CLOSED,
  {
    key: 'kind',
    label: 'Art',
    type: 'select',
    default: 'kabel',
    options: [
      { value: 'kabel', label: 'Kabel (hängt durch)' },
      { value: 'rohr', label: 'Rohr (Kurve)' },
    ],
    group: 'Kabel',
  },
  { key: 'radius', label: 'Radius (m)', type: 'number', default: 0.015, min: 0.003, max: 2, step: 0.005, group: 'Kabel' },
  { key: 'sag', label: 'Durchhang (% der Spannweite)', type: 'number', default: 3, min: 0, max: 40, step: 0.5, group: 'Kabel' },
  { key: 'color', label: 'Farbe', type: 'color', default: '#1b1b1c', group: 'Kabel' },
  { key: 'metal', label: 'Metallisch', type: 'bool', default: false, group: 'Kabel' },
  { key: 'collision', label: 'Kollision', type: 'bool', default: false, group: 'Physik' },
  { key: 'castShadow', label: 'Wirft Schatten', type: 'bool', default: true, group: 'Rendering' },
];

function createCable(o: MapObjectData, ctx: AssetContext): AssetInstance {
  const object = new THREE.Group();
  const pts = parsePoints(o.props.points);
  const closed = bool(o, 'closed', false);
  const kind = str(o, 'kind', 'kabel');
  const radius = Math.max(0.003, num(o, 'radius', 0.015));
  const line = kind === 'kabel' ? sampleCable(pts, num(o, 'sag', 3) / 100, 0.5, closed) : new SplineCurve(pts, closed).sample(0.25).map((s) => s.pos);
  const radial = kind === 'kabel' ? 6 : radius > 0.1 ? 16 : 10;
  const metal = bool(o, 'metal', false);
  if (line.length >= 2) {
    const mat = new THREE.MeshStandardMaterial({ color: str(o, 'color', '#1b1b1c'), roughness: metal ? 0.35 : 0.6, metalness: metal ? 0.8 : 0 });
    const m = new THREE.Mesh(tubeGeometry(line, radius, radial, 1), mat);
    m.castShadow = bool(o, 'castShadow', true);
    m.receiveShadow = true;
    if (metal) m.userData.foliageSurface = 'beton';
    object.add(m);
  }
  return {
    object,
    helper: ctx.editor ? splineHelper(CABLE_TYPE, line, pts.map((p) => new THREE.Vector3(...p.p))) : undefined,
    colliders(root) {
      if (!bool(o, 'collision', false) || line.length < 2) return [];
      const g = tubeGeometry(line, radius, 6);
      root.updateMatrixWorld(true);
      const t = worldTrimesh(g, root.matrixWorld);
      g.dispose();
      return t ? [{ type: 'trimesh', ...t }] : [];
    },
    dispose: () => disposeTree(object),
  };
}

export const SPLINE_ASSETS: Record<string, AssetDef> = {
  [ROAD_TYPE]: { label: 'Straße (Spline)', category: 'Splines', fixedRotation: true, fixedScale: true, props: ROAD_PROPS, create: createRoad },
  [SPLINEMESH_TYPE]: { label: 'Spline-Mesh', category: 'Splines', fixedRotation: true, fixedScale: true, props: SPLINEMESH_PROPS, create: createSplineMesh },
  [CABLE_TYPE]: { label: 'Kabel / Rohr', category: 'Splines', fixedRotation: true, fixedScale: true, props: CABLE_PROPS, create: createCable },
};

/** Vorgaben der „Neu“-Knöpfe im Splines-Modus */
export const SPLINE_PRESETS: { id: string; label: string; type: string; icon: string; props: Record<string, PropValue> }[] = [
  { id: 'road', label: 'Straße', type: ROAD_TYPE, icon: 'road', props: {} },
  { id: 'path', label: 'Feldweg', type: ROAD_TYPE, icon: 'road', props: { width: 3, surface: 'kies', markings: 'none', edgeLines: false, shoulder: 2, texScale: 3 } },
  { id: 'guardrail', label: 'Leitplanke', type: SPLINEMESH_TYPE, icon: 'fence', props: { profile: 'leitplanke', spacing: 2 } },
  { id: 'fence', label: 'Zaun', type: SPLINEMESH_TYPE, icon: 'fence', props: { profile: 'zaun', height: 2, spacing: 2.5 } },
  { id: 'wall', label: 'Mauer', type: SPLINEMESH_TYPE, icon: 'wall', props: { profile: 'mauer', height: 1.5, thickness: 0.3 } },
  { id: 'modelspline', label: 'Modell', type: SPLINEMESH_TYPE, icon: 'model', props: { profile: 'modell' } },
  { id: 'cable', label: 'Stromkabel', type: CABLE_TYPE, icon: 'cable', props: {} },
  { id: 'pipe', label: 'Rohr', type: CABLE_TYPE, icon: 'cable', props: { kind: 'rohr', radius: 0.15, sag: 0, color: '#8b9195', metal: true, collision: true } },
];
