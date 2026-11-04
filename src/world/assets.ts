import * as THREE from 'three';
import type { MapObjectData, PropValue, Vec3 } from './mapFormat.ts';
import { MATERIAL_OPTIONS, getMaterial } from './materials.ts';
import { createDust, createFogVolume, createLightCone, volumeFX } from './volumetrics.ts';
import { createFire, createSmoke, createSparks, type EffectControl, type Effect } from './particles.ts';
import { loadModel } from './modelStore.ts';
import { setupLightShadow } from './lightShadow.ts';
import { SCALE, type Collider } from './collision.ts';
import { LANDSCAPE_ASSET, LANDSCAPE_TYPE } from './landscape/asset.ts';
import { WEATHER_OPTIONS } from './weather.ts';
import { ASPECTS, SCREEN_PX, STAGE_W, defaultScreen, drawStage, stageHeight, stageView } from './screen.ts';
import type { BlobSource } from './blobStore.ts';

// Asset-Registry: alle Objekttypen, die eine Map enthalten kann.
// Jeder Typ beschreibt seine Eigenschaften (für das Details-Panel im Editor) und baut sein 3D-Objekt.
// Neue Typen: Eintrag in ASSETS + ggf. Preset in PRESETS ergänzen.

export type PropType = 'number' | 'color' | 'bool' | 'select' | 'text' | 'model';

export interface PropDef {
  key: string;
  label: string;
  type: PropType;
  default: PropValue;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  group?: string;
  /** Nicht im Details-Panel zeigen (vom Werkzeug verwaltet, z. B. Blob-Verweise) */
  hidden?: boolean;
}

export interface AssetContext {
  anisotropy: number;
  /** true im Editor: Hilfsobjekte (Icons, Drahtgitter) werden erzeugt */
  editor: boolean;
  /** Binär-Daten der Map (Heightmaps usw., Verweise "blob:<id>"); fehlt bei Maps ohne Blobs */
  blobs?: BlobSource;
}

export interface LightControl {
  setOn(on: boolean): void;
  isOn(): boolean;
  setIntensity(v: number): void;
  getIntensity(): number;
  setColor(c: string): void;
  setFlicker(on: boolean): void;
}

export interface AssetInstance {
  object: THREE.Object3D;
  /** Nur im Editor sichtbar (Icons, Drahtgitter); wird nicht exportiert */
  helper?: THREE.Object3D;
  update?(dt: number, t: number, live: boolean): void;
  /** Nach Verschieben/Skalieren im Editor (z. B. Welt-UVs neu berechnen) */
  onTransform?(root: THREE.Object3D): void;
  light?: LightControl;
  /** Partikeleffekt (Feuer, Rauch, Funken) – per Skript steuerbar */
  effect?: EffectControl;
  /** Meshes, deren Farbe Scripts ändern dürfen */
  colorables?: THREE.Mesh[];
  /** Erfüllt, sobald asynchrone Inhalte (Modelle) geladen sind */
  ready?: Promise<void>;
  /** Programmierbarer Bildschirm: Zeichenfläche für die Bühne */
  screen?: ScreenSurface;
  /**
   * Eigenschaften haben sich geändert: selbst übernehmen und true liefern (kein Neuaufbau),
   * z. B. Landscape-Farben oder neue Blob-Verweise nach dem Speichern
   */
  updateProps?(o: MapObjectData): boolean;
  /** Eigene Collider (Weltkoordinaten), zusätzlich zu userData.collider */
  colliders?(root: THREE.Object3D): Collider[];
  dispose?(): void;
}

export interface ScreenSurface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  /** Bildschirmfläche (für Raycasts → UV) */
  mesh: THREE.Mesh;
  /** Bühnenhöhe in Einheiten (Breite = STAGE_W) */
  stageH: number;
  widthM: number;
  heightM: number;
  /** Statische Vorschau neu zeichnen (Startzustand) */
  redraw(): void;
}

export interface AssetDef {
  label: string;
  category: string;
  props: PropDef[];
  /** Skalierung ist fest 1 (Lichter, Spawn, Terminal) */
  fixedScale?: boolean;
  /** Drehung ist fest 0 (Landscape) */
  fixedRotation?: boolean;
  /** Geometrie wird in Metern aus der Skalierung gebaut (Treppe, Türwand) */
  rebuildOnScale?: boolean;
  /** Höchstens ein Objekt dieses Typs pro Map */
  unique?: boolean;
  create(o: MapObjectData, ctx: AssetContext): AssetInstance;
}

// ---------- Hilfen ----------

const p = <T extends PropValue>(o: MapObjectData, key: string, def: T): T => {
  const v = o.props[key];
  return (typeof v === typeof def ? v : def) as T;
};

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/** Welt-skalierte Box-UVs (1 Textur = 2 m), unabhängig von Skalierung und Drehung */
function worldUV(mesh: THREE.Mesh, uvScale: number): void {
  const geo = mesh.geometry;
  mesh.updateWorldMatrix(true, false);
  _nm.getNormalMatrix(mesh.matrixWorld);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const s = 0.5 * uvScale;
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    _n.fromBufferAttribute(nor, i).applyMatrix3(_nm).normalize();
    let u: number;
    let v: number;
    if (Math.abs(_n.x) >= Math.abs(_n.y) && Math.abs(_n.x) >= Math.abs(_n.z)) {
      u = _n.x > 0 ? -_v.z : _v.z;
      v = _v.y;
    } else if (Math.abs(_n.y) >= Math.abs(_n.z)) {
      u = _v.x;
      v = _n.y > 0 ? -_v.z : _v.z;
    } else {
      u = _n.z > 0 ? _v.x : -_v.x;
      v = _v.y;
    }
    uv.setXY(i, u * s, v * s);
  }
  uv.needsUpdate = true;
}

/** Zylinder-UVs: Mantel nach Umfang/Höhe in Metern, Deckel planar */
function cylinderUV(mesh: THREE.Mesh, uvScale: number): void {
  const geo = mesh.geometry;
  mesh.updateWorldMatrix(true, false);
  const ws = new THREE.Vector3();
  mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), ws);
  if (!geo.userData.uv0) geo.userData.uv0 = (geo.attributes.uv.array as Float32Array).slice();
  const uv0 = geo.userData.uv0 as Float32Array;
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const s = 0.5 * uvScale;
  const circ = Math.PI * ((ws.x + ws.z) / 2);
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(nor.getY(i)) > 0.5) uv.setXY(i, pos.getX(i) * ws.x * s, pos.getZ(i) * ws.z * s);
    else uv.setXY(i, uv0[i * 2] * circ * s, uv0[i * 2 + 1] * ws.y * s);
  }
  uv.needsUpdate = true;
}

function matParams(o: MapObjectData, side?: THREE.Side) {
  return {
    material: p(o, 'material', 'farbe'),
    color: p(o, 'color', '#ffffff'),
    emissive: p(o, 'emissive', '#000000'),
    emissiveIntensity: p(o, 'emissiveIntensity', 0),
    roughness: p(o, 'roughness', 0.75),
    metalness: p(o, 'metalness', 0),
    side,
  };
}

function helperMark<T extends THREE.Object3D>(o: T, pickable = true): T {
  o.traverse((c) => {
    c.userData.editorHelper = true;
    if (!pickable) c.userData.noPick = true;
  });
  return o;
}

const iconCache = new Map<string, THREE.SpriteMaterial>();
type IconKind = 'light' | 'spot' | 'sun' | 'weather' | 'fog' | 'dust' | 'empty' | 'trigger' | 'fire' | 'smoke' | 'sparks';

/** Billboard-Icon im Editor (wie Licht-Symbole in UE5) */
function iconSprite(kind: IconKind, color: string): THREE.Sprite {
  const key = kind + color;
  let mat = iconCache.get(key);
  if (!mat) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(32, 32, 29, 0, Math.PI * 2);
    g.fillStyle = 'rgba(20,20,20,0.75)';
    g.fill();
    g.fillStyle = color;
    if (kind === 'light' || kind === 'spot') {
      g.beginPath();
      g.arc(32, 28, 10, 0, Math.PI * 2);
      g.fill();
      g.fillRect(27, 38, 10, 8);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.beginPath();
        g.moveTo(32 + Math.cos(a) * 15, 28 + Math.sin(a) * 15);
        g.lineTo(32 + Math.cos(a) * 20, 28 + Math.sin(a) * 20);
        g.stroke();
      }
      if (kind === 'spot') {
        g.beginPath();
        g.moveTo(20, 54);
        g.lineTo(44, 54);
        g.stroke();
      }
    } else if (kind === 'sun') {
      g.beginPath();
      g.arc(32, 32, 9, 0, Math.PI * 2);
      g.fill();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        g.beginPath();
        g.moveTo(32 + Math.cos(a) * 14, 32 + Math.sin(a) * 14);
        g.lineTo(32 + Math.cos(a) * (i % 2 ? 19 : 22), 32 + Math.sin(a) * (i % 2 ? 19 : 22));
        g.stroke();
      }
    } else if (kind === 'weather') {
      // Wolke mit Regenstrichen
      for (const [x, y, r] of [[24, 28, 8], [34, 24, 10], [43, 29, 7]]) {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
      g.fillRect(18, 29, 30, 8);
      for (const x of [22, 32, 42]) {
        g.beginPath();
        g.moveTo(x, 42);
        g.lineTo(x - 3, 52);
        g.stroke();
      }
    } else if (kind === 'fog') {
      for (const [x, y, r] of [[24, 34, 10], [36, 30, 12], [44, 38, 8], [30, 40, 9]]) {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
    } else if (kind === 'dust') {
      for (const [x, y, r] of [[22, 24, 3], [40, 20, 4], [34, 36, 3], [24, 44, 4], [44, 42, 3]]) {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
    } else if (kind === 'fire') {
      g.beginPath();
      g.moveTo(32, 12);
      g.bezierCurveTo(44, 26, 48, 36, 44, 46);
      g.quadraticCurveTo(32, 56, 20, 46);
      g.bezierCurveTo(16, 36, 24, 30, 26, 22);
      g.quadraticCurveTo(30, 30, 32, 12);
      g.fill();
    } else if (kind === 'smoke') {
      for (const [x, y, r] of [[28, 46, 8], [34, 34, 9], [28, 22, 7], [38, 16, 5]]) {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.stroke();
      }
    } else if (kind === 'sparks') {
      for (let i = 0; i < 7; i++) {
        const a = -Math.PI / 2 + (i - 3) * 0.42;
        g.beginPath();
        g.moveTo(32 + Math.cos(a) * 6, 40 + Math.sin(a) * 6);
        g.lineTo(32 + Math.cos(a) * 20, 40 + Math.sin(a) * 20);
        g.stroke();
      }
    } else if (kind === 'trigger') {
      g.strokeRect(18, 18, 28, 28);
      g.beginPath();
      g.moveTo(32, 24);
      g.lineTo(32, 36);
      g.moveTo(32, 41);
      g.lineTo(32, 42);
      g.stroke();
    } else {
      g.beginPath();
      g.moveTo(18, 32);
      g.lineTo(46, 32);
      g.moveTo(32, 18);
      g.lineTo(32, 46);
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
    iconCache.set(key, mat);
  }
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(0.45);
  s.renderOrder = 1000;
  return s;
}

function boxEdges(color: string, opacity = 1): THREE.LineSegments {
  const l = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false }),
  );
  return l;
}

/** Ein-/Aus-Zustand mit optionalem Flackern (wie Leuchtstoffröhren im Flur) */
class LightState {
  on = true;
  flicker = false;
  private flickOn = true;
  private timer = 1;
  constructor(
    private apply: (k: number) => void,
    public intensity: number,
  ) {}
  update(dt: number, live: boolean): void {
    if (this.flicker && live) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.flickOn = !this.flickOn;
        // Meist an, gelegentlich kurze Aussetzer — teils als schnelle Serie
        this.timer = this.flickOn ? (Math.random() < 0.3 ? 0.05 : 0.4 + Math.random() * 3) : 0.03 + Math.random() * 0.12;
      }
    } else {
      this.flickOn = true;
    }
    this.apply(this.on ? (this.flickOn ? 1 : 0.04) : 0);
  }
}

const shadowSetup = setupLightShadow;

const LAMP_EMISSIVE = 6;
const fixtureMat = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.5, metalness: 0.6 });

// ---------- Eigenschaften ----------

const surfaceProps = (material: string): PropDef[] => [
  { key: 'material', label: 'Material', type: 'select', default: material, options: MATERIAL_OPTIONS, group: 'Material' },
  { key: 'color', label: 'Farbe / Tönung', type: 'color', default: material === 'farbe' ? '#8c8c8c' : '#ffffff', group: 'Material' },
  { key: 'roughness', label: 'Rauheit (einfarbig)', type: 'number', default: 0.75, min: 0, max: 1, step: 0.05, group: 'Material' },
  { key: 'metalness', label: 'Metall (einfarbig)', type: 'number', default: 0, min: 0, max: 1, step: 0.05, group: 'Material' },
  { key: 'emissive', label: 'Leuchtfarbe', type: 'color', default: '#000000', group: 'Material' },
  { key: 'emissiveIntensity', label: 'Leuchtstärke', type: 'number', default: 0, min: 0, max: 50, step: 0.5, group: 'Material' },
  { key: 'uvScale', label: 'Textur-Skalierung', type: 'number', default: 1, min: 0.05, max: 20, step: 0.1, group: 'Material' },
  { key: 'castShadow', label: 'Wirft Schatten', type: 'bool', default: true, group: 'Rendering' },
  { key: 'collision', label: 'Kollision', type: 'bool', default: true, group: 'Physik' },
];

const lightProps = (color: string, intensity: number, distance: number, shadow: boolean): PropDef[] => [
  { key: 'color', label: 'Lichtfarbe', type: 'color', default: color, group: 'Licht' },
  { key: 'intensity', label: 'Intensität', type: 'number', default: intensity, min: 0, max: 500, step: 0.5, group: 'Licht' },
  { key: 'distance', label: 'Reichweite (m)', type: 'number', default: distance, min: 0.5, max: 100, step: 0.5, group: 'Licht' },
  { key: 'shadow', label: 'Schatten', type: 'bool', default: shadow, group: 'Licht' },
  { key: 'flicker', label: 'Flackern', type: 'bool', default: false, group: 'Licht' },
  { key: 'on', label: 'Eingeschaltet', type: 'bool', default: true, group: 'Licht' },
];

// ---------- Asset-Typen ----------

function primitive(geo: THREE.BufferGeometry, o: MapObjectData, ctx: AssetContext, uv: 'box' | 'cylinder', collider: 'box' | 'cylinder' | null, side?: THREE.Side): AssetInstance {
  const mesh = new THREE.Mesh(geo, getMaterial(matParams(o, side), ctx.anisotropy));
  mesh.castShadow = p(o, 'castShadow', true);
  mesh.receiveShadow = true;
  if (collider && p(o, 'collision', true)) mesh.userData.collider = collider;
  const uvScale = p(o, 'uvScale', 1);
  return {
    object: mesh,
    colorables: [mesh],
    onTransform: () => (uv === 'box' ? worldUV(mesh, uvScale) : cylinderUV(mesh, uvScale)),
    dispose: () => geo.dispose(),
  };
}

/** Baut mehrere Boxen in Metern (für Treppe/Türwand); Container hebt die Objektskalierung auf */
function meterBoxes(o: MapObjectData, ctx: AssetContext, boxes: { c: Vec3; s: Vec3 }[]): AssetInstance {
  const group = new THREE.Group();
  const [sx, sy, sz] = o.scale.map((v) => Math.max(Math.abs(v), 0.001));
  group.scale.set(1 / sx, 1 / sy, 1 / sz);
  const mat = getMaterial(matParams(o), ctx.anisotropy);
  const meshes: THREE.Mesh[] = [];
  for (const b of boxes) {
    if (b.s.some((v) => v <= 0.001)) continue;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...b.s), mat);
    mesh.position.set(...b.c);
    mesh.castShadow = p(o, 'castShadow', true);
    mesh.receiveShadow = true;
    if (p(o, 'collision', true)) mesh.userData.collider = 'box';
    group.add(mesh);
    meshes.push(mesh);
  }
  const uvScale = p(o, 'uvScale', 1);
  return {
    object: group,
    colorables: meshes,
    onTransform: () => meshes.forEach((m) => worldUV(m, uvScale)),
    dispose: () => meshes.forEach((m) => m.geometry.dispose()),
  };
}

export const ASSETS: Record<string, AssetDef> = {
  [LANDSCAPE_TYPE]: LANDSCAPE_ASSET,
  box: {
    label: 'Box',
    category: 'Geometrie',
    props: surfaceProps('farbe'),
    create: (o, ctx) => primitive(new THREE.BoxGeometry(1, 1, 1), o, ctx, 'box', 'box'),
  },
  cylinder: {
    label: 'Zylinder',
    category: 'Geometrie',
    props: [...surfaceProps('farbe'), { key: 'segments', label: 'Segmente', type: 'number', default: 32, min: 3, max: 96, step: 1, group: 'Form' }],
    create: (o, ctx) =>
      primitive(new THREE.CylinderGeometry(0.5, 0.5, 1, Math.round(p(o, 'segments', 32))), o, ctx, 'cylinder', 'cylinder'),
  },
  plane: {
    label: 'Ebene',
    category: 'Geometrie',
    props: [...surfaceProps('farbe').filter((d) => d.key !== 'collision'), { key: 'doubleSided', label: 'Beidseitig', type: 'bool', default: false, group: 'Rendering' }],
    create: (o, ctx) => {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.rotateX(-Math.PI / 2);
      return primitive(geo, o, ctx, 'box', null, p(o, 'doubleSided', false) ? THREE.DoubleSide : THREE.FrontSide);
    },
  },
  stairs: {
    label: 'Treppe',
    category: 'Geometrie',
    rebuildOnScale: true,
    props: [{ key: 'stepHeight', label: 'Stufenhöhe (m)', type: 'number', default: 0.2, min: 0.05, max: 0.3, step: 0.01, group: 'Form' }, ...surfaceProps('beton_dunkel')],
    create: (o, ctx) => {
      // Steigt Richtung lokal -Z an; Stufen ≤ 0.3 m sind begehbar (Step-Height des Spielers)
      const [w, h, d] = o.scale.map(Math.abs);
      const n = Math.max(1, Math.ceil(h / p(o, 'stepHeight', 0.2)));
      const boxes: { c: Vec3; s: Vec3 }[] = [];
      for (let i = 0; i < n; i++) {
        const sh = ((i + 1) * h) / n;
        boxes.push({ c: [0, -h / 2 + sh / 2, d / 2 - ((i + 0.5) * d) / n], s: [w, sh, d / n] });
      }
      return meterBoxes(o, ctx, boxes);
    },
  },
  doorwall: {
    label: 'Wand mit Tür',
    category: 'Geometrie',
    rebuildOnScale: true,
    props: [
      { key: 'doorWidth', label: 'Türbreite (m)', type: 'number', default: SCALE.doorWidth, min: 0.3, max: 10, step: 0.05, group: 'Form' },
      { key: 'doorHeight', label: 'Türhöhe (m)', type: 'number', default: SCALE.doorHeight, min: 0.3, max: 10, step: 0.05, group: 'Form' },
      { key: 'doorOffset', label: 'Tür-Versatz (m)', type: 'number', default: 0, step: 0.05, group: 'Form' },
      ...surfaceProps('beton_gelb'),
    ],
    create: (o, ctx) => {
      const [w, h, t] = o.scale.map(Math.abs);
      const dh = Math.min(p(o, 'doorHeight', SCALE.doorHeight), h);
      const dw = Math.min(p(o, 'doorWidth', SCALE.doorWidth), w);
      const off = THREE.MathUtils.clamp(p(o, 'doorOffset', 0), -w / 2 + dw / 2, w / 2 - dw / 2);
      const l = off - dw / 2 + w / 2; // Breite links
      const r = w / 2 - (off + dw / 2); // Breite rechts
      return meterBoxes(o, ctx, [
        { c: [-w / 2 + l / 2, 0, 0], s: [l, h, t] },
        { c: [w / 2 - r / 2, 0, 0], s: [r, h, t] },
        { c: [off, -h / 2 + dh + (h - dh) / 2, 0], s: [dw, h - dh, t] },
      ]);
    },
  },

  pointlight: {
    label: 'Punktlicht',
    category: 'Licht',
    fixedScale: true,
    props: lightProps('#ffe2b8', 10, 10, false),
    create: (o, ctx) => {
      const light = new THREE.PointLight(p(o, 'color', '#ffffff'), 0, p(o, 'distance', 10), 2);
      if (p(o, 'shadow', false)) shadowSetup(light);
      const state = new LightState((k) => (light.intensity = state.intensity * k), p(o, 'intensity', 10));
      state.on = p(o, 'on', true);
      state.flicker = p(o, 'flicker', false);
      state.update(0, false);
      const unregister = volumeFX.addLight(light);
      return {
        object: light,
        helper: ctx.editor ? helperMark(iconSprite('light', p(o, 'color', '#ffffff'))) : undefined,
        update: (dt, _t, live) => state.update(dt, live),
        light: lightControl(state, (c) => light.color.set(c)),
        dispose: () => void unregister(),
      };
    },
  },
  spotlight: {
    label: 'Spotlicht',
    category: 'Licht',
    fixedScale: true,
    props: [
      ...lightProps('#fff1d6', 40, 15, true),
      { key: 'angle', label: 'Kegelwinkel (°)', type: 'number', default: 30, min: 1, max: 80, step: 1, group: 'Licht' },
      { key: 'penumbra', label: 'Weiche Kante', type: 'number', default: 0.4, min: 0, max: 1, step: 0.05, group: 'Licht' },
      { key: 'volumetric', label: 'Volumetrischer Kegel', type: 'bool', default: true, group: 'Volumetrik' },
      { key: 'volumeStrength', label: 'Kegel-Stärke', type: 'number', default: 0.5, min: 0, max: 5, step: 0.05, group: 'Volumetrik' },
    ],
    create: (o, ctx) => {
      const group = new THREE.Group();
      const color = p(o, 'color', '#ffffff');
      const distance = p(o, 'distance', 15);
      const angle = THREE.MathUtils.degToRad(p(o, 'angle', 30));
      const light = new THREE.SpotLight(color, 0, distance, angle, p(o, 'penumbra', 0.4), 2);
      light.target.position.set(0, -1, 0);
      group.add(light, light.target);
      if (p(o, 'shadow', true)) shadowSetup(light, 1024);
      let cone: ReturnType<typeof createLightCone> | null = null;
      const strength = p(o, 'volumeStrength', 0.5);
      if (p(o, 'volumetric', true)) {
        cone = createLightCone({ color, length: distance, angle, penumbra: p(o, 'penumbra', 0.4), strength });
        // Schattenkarte des Spotlichts verdeckt den Kegel (ohne Schatten: Wände/Objekte aus den Collidern)
        cone.setLight(light);
        group.add(cone.mesh);
      }
      const unregister = volumeFX.addLight(light);
      const state = new LightState((k) => {
        light.intensity = state.intensity * k;
        cone?.setIntensity(state.intensity * k);
      }, p(o, 'intensity', 40));
      state.on = p(o, 'on', true);
      state.flicker = p(o, 'flicker', false);
      state.update(0, false);
      let helper: THREE.Object3D | undefined;
      if (ctx.editor) {
        helper = new THREE.Group();
        helper.add(iconSprite('spot', color));
        const r = Math.tan(angle) * Math.min(distance, 3);
        const pts = [0, 1, 2, 3].flatMap((i) => {
          const a = (i / 4) * Math.PI * 2;
          return [new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * r, -Math.min(distance, 3), Math.sin(a) * r)];
        });
        helper.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#ffd76a', toneMapped: false })));
        helperMark(helper);
      }
      return {
        object: group,
        helper,
        update: (dt, t, live) => {
          state.update(dt, live);
          cone?.update(t);
        },
        light: lightControl(state, (c) => {
          light.color.set(c);
          cone?.setColor(c);
        }),
        dispose: () => {
          unregister();
          cone?.mesh.geometry.dispose();
          (cone?.mesh.material as THREE.Material | undefined)?.dispose();
        },
      };
    },
  },
  lamp: {
    label: 'Lampe (Leuchtkörper)',
    category: 'Licht',
    fixedScale: true,
    props: [
      ...lightProps('#dde6ff', 9, 9, false),
      { key: 'tubeX', label: 'Röhre Breite (m)', type: 'number', default: 0.08, min: 0.01, max: 5, step: 0.01, group: 'Form' },
      { key: 'tubeY', label: 'Röhre Höhe (m)', type: 'number', default: 0.04, min: 0.01, max: 5, step: 0.01, group: 'Form' },
      { key: 'tubeZ', label: 'Röhre Länge (m)', type: 'number', default: 1.2, min: 0.01, max: 5, step: 0.01, group: 'Form' },
      { key: 'housing', label: 'Gehäuse', type: 'bool', default: true, group: 'Form' },
    ],
    create: (o) => {
      // Gehäuse + emissive Röhre (Bloom) + PointLight, wie die Lampen der Startmap
      const group = new THREE.Group();
      const color = p(o, 'color', '#ffffff');
      const size = new THREE.Vector3(p(o, 'tubeX', 0.08), p(o, 'tubeY', 0.04), p(o, 'tubeZ', 1.2));
      if (p(o, 'housing', true)) {
        const housing = new THREE.Mesh(new THREE.BoxGeometry(size.x + 0.06, 0.05, size.z + 0.06), fixtureMat);
        housing.position.y = 0.03;
        group.add(housing);
      }
      const tubeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: LAMP_EMISSIVE, roughness: 0.3 });
      const tube = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), tubeMat);
      group.add(tube);
      const light = new THREE.PointLight(color, 0, p(o, 'distance', 9), 2);
      light.position.y = -0.12;
      if (p(o, 'shadow', false)) shadowSetup(light);
      group.add(light);
      const state = new LightState((k) => {
        light.intensity = state.intensity * k;
        tubeMat.emissiveIntensity = LAMP_EMISSIVE * Math.max(k, 0.04);
      }, p(o, 'intensity', 9));
      state.on = p(o, 'on', true);
      state.flicker = p(o, 'flicker', false);
      state.update(0, false);
      const unregister = volumeFX.addLight(light);
      return {
        object: group,
        update: (dt, _t, live) => state.update(dt, live),
        light: lightControl(state, (c) => {
          light.color.set(c);
          tubeMat.emissive.set(c);
        }),
        dispose: () => {
          unregister();
          tubeMat.dispose();
        },
      };
    },
  },

  fogvolume: {
    label: 'Nebelvolumen',
    category: 'Volumetrik',
    props: [
      { key: 'color', label: 'Farbe', type: 'color', default: '#8d98a4', group: 'Nebel' },
      { key: 'density', label: 'Dichte', type: 'number', default: 0.35, min: 0, max: 10, step: 0.05, group: 'Nebel' },
      { key: 'brightness', label: 'Helligkeit', type: 'number', default: 1, min: 0, max: 20, step: 0.1, group: 'Nebel' },
      { key: 'noise', label: 'Wolkenstruktur', type: 'number', default: 0.6, min: 0, max: 1, step: 0.05, group: 'Nebel' },
      { key: 'noiseScale', label: 'Strukturgröße', type: 'number', default: 0.5, min: 0.02, max: 5, step: 0.05, group: 'Nebel' },
      { key: 'edge', label: 'Weiche Kante', type: 'number', default: 0.15, min: 0, max: 0.5, step: 0.01, group: 'Nebel' },
      { key: 'heightFalloff', label: 'Bodennähe', type: 'number', default: 0.5, min: 0, max: 1, step: 0.05, group: 'Nebel' },
      { key: 'speed', label: 'Bewegung', type: 'number', default: 1, min: 0, max: 10, step: 0.1, group: 'Nebel' },
      { key: 'lightResponse', label: 'Lichtreaktion', type: 'number', default: 1, min: 0, max: 5, step: 0.05, group: 'Licht' },
      { key: 'anisotropy', label: 'Vorwärtsstreuung', type: 'number', default: 0.45, min: 0, max: 0.9, step: 0.05, group: 'Licht' },
      { key: 'interactive', label: 'Spieler/Schüsse verdrängen', type: 'bool', default: true, group: 'Interaktion' },
    ],
    create: (o, ctx) => {
      const fog = createFogVolume({
        color: p(o, 'color', '#8d98a4'),
        density: p(o, 'density', 0.35),
        brightness: p(o, 'brightness', 1),
        noise: p(o, 'noise', 0.6),
        noiseScale: p(o, 'noiseScale', 0.5),
        edge: p(o, 'edge', 0.15),
        heightFalloff: p(o, 'heightFalloff', 0.5),
        speed: p(o, 'speed', 1),
        lightResponse: p(o, 'lightResponse', 1),
        anisotropy: p(o, 'anisotropy', 0.45),
        interactive: p(o, 'interactive', true),
      });
      let helper: THREE.Object3D | undefined;
      if (ctx.editor) {
        helper = new THREE.Group();
        helper.add(boxEdges('#7fb8ff', 0.8), iconSprite('fog', '#9fd0ff'));
        helperMark(helper);
      }
      return {
        object: fog.mesh,
        helper,
        update: (_dt, t) => fog.update(t),
        dispose: () => {
          fog.dispose();
          fog.mesh.geometry.dispose();
          (fog.mesh.material as THREE.Material).dispose();
        },
      };
    },
  },
  dust: {
    label: 'Staubpartikel',
    category: 'Volumetrik',
    props: [
      { key: 'count', label: 'Anzahl', type: 'number', default: 400, min: 1, max: 5000, step: 10, group: 'Partikel' },
      { key: 'size', label: 'Größe', type: 'number', default: 0.035, min: 0.005, max: 0.5, step: 0.005, group: 'Partikel' },
      { key: 'color', label: 'Farbe', type: 'color', default: '#d8d0c0', group: 'Partikel' },
      { key: 'opacity', label: 'Deckkraft', type: 'number', default: 0.6, min: 0, max: 1, step: 0.05, group: 'Partikel' },
      { key: 'speed', label: 'Bewegung', type: 'number', default: 1, min: 0, max: 10, step: 0.1, group: 'Partikel' },
    ],
    create: (o, ctx) => {
      const dust = createDust(
        { count: p(o, 'count', 400), size: p(o, 'size', 0.035), color: p(o, 'color', '#d8d0c0'), opacity: p(o, 'opacity', 0.6), speed: p(o, 'speed', 1) },
        o.id.length * 17 + o.id.charCodeAt(0),
      );
      let helper: THREE.Object3D | undefined;
      if (ctx.editor) {
        helper = new THREE.Group();
        helper.add(boxEdges('#d8c08a', 0.6), iconSprite('dust', '#e8d6a8'));
        helperMark(helper);
      }
      return {
        object: dust.points,
        helper,
        update: (dt, t) => dust.update(dt, t),
        dispose: () => {
          dust.dispose();
          dust.points.geometry.dispose();
          (dust.points.material as THREE.Material).dispose();
        },
      };
    },
  },

  fire: {
    label: 'Feuer',
    category: 'Effekte',
    props: [
      { key: 'size', label: 'Flammenhöhe (m)', type: 'number', default: 1, min: 0.1, max: 6, step: 0.05, group: 'Feuer' },
      { key: 'radius', label: 'Grundfläche (m)', type: 'number', default: 0.35, min: 0.05, max: 4, step: 0.05, group: 'Feuer' },
      { key: 'rate', label: 'Flammendichte', type: 'number', default: 90, min: 5, max: 400, step: 5, group: 'Feuer' },
      { key: 'color', label: 'Farbton', type: 'color', default: '#ffffff', group: 'Feuer' },
      { key: 'flicker', label: 'Flackern', type: 'number', default: 0.7, min: 0, max: 1, step: 0.05, group: 'Feuer' },
      { key: 'embers', label: 'Glutfunken/s', type: 'number', default: 8, min: 0, max: 80, step: 1, group: 'Feuer' },
      { key: 'on', label: 'Brennt', type: 'bool', default: true, group: 'Feuer' },
      { key: 'smoke', label: 'Rauch', type: 'number', default: 1, min: 0, max: 3, step: 0.1, group: 'Rauch' },
      { key: 'smokeColor', label: 'Rauchfarbe', type: 'color', default: '#2b2723', group: 'Rauch' },
      { key: 'light', label: 'Lichtstärke', type: 'number', default: 14, min: 0, max: 200, step: 0.5, group: 'Licht' },
      { key: 'lightColor', label: 'Lichtfarbe', type: 'color', default: '#ff8a3a', group: 'Licht' },
      { key: 'shadow', label: 'Schatten', type: 'bool', default: false, group: 'Licht' },
    ],
    create: (o, ctx) =>
      effectInstance(
        o,
        ctx,
        createFire(
          {
            size: p(o, 'size', 1),
            radius: p(o, 'radius', 0.35),
            rate: p(o, 'rate', 90),
            color: p(o, 'color', '#ffffff'),
            flicker: p(o, 'flicker', 0.7),
            embers: p(o, 'embers', 8),
            smoke: p(o, 'smoke', 1),
            smokeColor: p(o, 'smokeColor', '#2b2723'),
            light: p(o, 'light', 14),
            lightColor: p(o, 'lightColor', '#ff8a3a'),
          },
          seedOf(o),
        ),
        'fire',
        '#ff9a40',
        0.5,
        (fx) => {
          if (!p(o, 'shadow', false)) return;
          fx.object.traverse((c) => {
            if ((c as THREE.PointLight).isPointLight) shadowSetup(c as THREE.PointLight);
          });
        },
      ),
  },
  smoke: {
    label: 'Rauch',
    category: 'Effekte',
    props: [
      { key: 'color', label: 'Farbe', type: 'color', default: '#5d5a56', group: 'Rauch' },
      { key: 'opacity', label: 'Deckkraft', type: 'number', default: 0.55, min: 0, max: 1, step: 0.05, group: 'Rauch' },
      { key: 'rate', label: 'Partikel/s', type: 'number', default: 10, min: 0.5, max: 80, step: 0.5, group: 'Rauch' },
      { key: 'life', label: 'Lebensdauer (s)', type: 'number', default: 6, min: 0.5, max: 20, step: 0.5, group: 'Rauch' },
      { key: 'size', label: 'Startgröße (m)', type: 'number', default: 0.5, min: 0.05, max: 5, step: 0.05, group: 'Rauch' },
      { key: 'grow', label: 'Endgröße (m)', type: 'number', default: 2.5, min: 0.1, max: 15, step: 0.1, group: 'Rauch' },
      { key: 'on', label: 'Aktiv', type: 'bool', default: true, group: 'Rauch' },
      { key: 'rise', label: 'Auftrieb (m/s)', type: 'number', default: 0.8, min: -2, max: 6, step: 0.05, group: 'Bewegung' },
      { key: 'spread', label: 'Quellradius (m)', type: 'number', default: 0.3, min: 0, max: 5, step: 0.05, group: 'Bewegung' },
      { key: 'turbulence', label: 'Verwirbelung', type: 'number', default: 0.5, min: 0, max: 3, step: 0.05, group: 'Bewegung' },
    ],
    create: (o, ctx) =>
      effectInstance(
        o,
        ctx,
        createSmoke(
          {
            color: p(o, 'color', '#5d5a56'),
            opacity: p(o, 'opacity', 0.55),
            rate: p(o, 'rate', 10),
            life: p(o, 'life', 6),
            size: p(o, 'size', 0.5),
            grow: p(o, 'grow', 2.5),
            rise: p(o, 'rise', 0.8),
            spread: p(o, 'spread', 0.3),
            turbulence: p(o, 'turbulence', 0.5),
          },
          seedOf(o),
        ),
        'smoke',
        '#c8c4bc',
        0.5,
      ),
  },
  sparks: {
    label: 'Funken',
    category: 'Effekte',
    props: [
      { key: 'color', label: 'Farbe', type: 'color', default: '#ffaa44', group: 'Funken' },
      { key: 'rate', label: 'Ausbrüche/s (0 = nur Skript)', type: 'number', default: 0.6, min: 0, max: 20, step: 0.1, group: 'Funken' },
      { key: 'count', label: 'Funken je Ausbruch', type: 'number', default: 30, min: 1, max: 300, step: 1, group: 'Funken' },
      { key: 'speed', label: 'Geschwindigkeit', type: 'number', default: 3, min: 0.1, max: 20, step: 0.1, group: 'Funken' },
      { key: 'gravity', label: 'Schwerkraft', type: 'number', default: 9.8, min: -5, max: 30, step: 0.1, group: 'Funken' },
      { key: 'life', label: 'Lebensdauer (s)', type: 'number', default: 1.4, min: 0.1, max: 6, step: 0.1, group: 'Funken' },
      { key: 'size', label: 'Größe', type: 'number', default: 0.025, min: 0.005, max: 0.3, step: 0.005, group: 'Funken' },
      { key: 'bounce', label: 'Abprallen', type: 'number', default: 0.35, min: 0, max: 0.9, step: 0.05, group: 'Funken' },
      { key: 'flash', label: 'Lichtblitz', type: 'bool', default: true, group: 'Funken' },
      { key: 'on', label: 'Aktiv', type: 'bool', default: true, group: 'Funken' },
    ],
    create: (o, ctx) =>
      effectInstance(
        o,
        ctx,
        createSparks(
          {
            color: p(o, 'color', '#ffaa44'),
            rate: p(o, 'rate', 0.6),
            count: p(o, 'count', 30),
            speed: p(o, 'speed', 3),
            gravity: p(o, 'gravity', 9.8),
            life: p(o, 'life', 1.4),
            size: p(o, 'size', 0.025),
            bounce: p(o, 'bounce', 0.35),
            flash: p(o, 'flash', true),
          },
          seedOf(o),
        ),
        'sparks',
        '#ffc070',
        -0.5,
      ),
  },

  sun: {
    // Das eigentliche Licht + Himmel baut WorldRig (mapLoader.ts) aus Drehung und Eigenschaften, siehe world/sun.ts
    label: 'Sonne',
    category: 'Licht',
    fixedScale: true,
    unique: true,
    props: [
      { key: 'color', label: 'Farbe', type: 'color', default: '#aebdd0', group: 'Licht' },
      { key: 'intensity', label: 'Intensität', type: 'number', default: 0.9, min: 0, max: 20, step: 0.05, group: 'Licht' },
      { key: 'disc', label: 'Sonnenscheibe', type: 'bool', default: true, group: 'Himmel' },
      { key: 'size', label: 'Scheibengröße (°)', type: 'number', default: 2.5, min: 0.2, max: 20, step: 0.1, group: 'Himmel' },
      { key: 'glow', label: 'Leuchten', type: 'number', default: 0.5, min: 0, max: 3, step: 0.05, group: 'Himmel' },
      { key: 'shadow', label: 'Schatten', type: 'bool', default: true, group: 'Schatten' },
      { key: 'shadowDistance', label: 'Schattendistanz (m)', type: 'number', default: 120, min: 10, max: 2000, step: 5, group: 'Schatten' },
    ],
    create: (o, ctx) => {
      const object = new THREE.Group();
      if (!ctx.editor) return { object };
      const color = p(o, 'color', '#ffffff');
      const helper = new THREE.Group();
      helper.add(iconSprite('sun', '#ffd76a'));
      // Pfeil = Richtung, in die das Licht fällt
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -0.3), 2.2, color, 0.45, 0.22);
      for (const m of [arrow.line.material, arrow.cone.material] as THREE.Material[]) m.toneMapped = false;
      helper.add(arrow);
      return { object, helper: helperMark(helper) };
    },
  },
  weather: {
    // Partikel, Nässe und Pfützen baut Weather (weather.ts) aus Drehung (= Windrichtung) und Eigenschaften, siehe world/weatherObject.ts
    label: 'Wetter',
    category: 'Volumetrik',
    fixedScale: true,
    unique: true,
    props: [
      { key: 'weather', label: 'Wetter', type: 'select', default: 'regen', options: WEATHER_OPTIONS, group: 'Wetter' },
      { key: 'intensity', label: 'Stärke', type: 'number', default: 1, min: 0, max: 2, step: 0.05, group: 'Wetter' },
      { key: 'windStrength', label: 'Windstärke (m/s)', type: 'number', default: 1.5, min: 0, max: 15, step: 0.1, group: 'Wetter' },
      { key: 'wetness', label: 'Anfangsnässe', type: 'number', default: 0, min: 0, max: 1, step: 0.05, group: 'Boden' },
      { key: 'puddles', label: 'Pfützen', type: 'number', default: 0.6, min: 0, max: 1, step: 0.05, group: 'Boden' },
      { key: 'snowCover', label: 'Anfangs-Schnee', type: 'number', default: 0, min: 0, max: 1, step: 0.05, group: 'Boden' },
      { key: 'timeScale', label: 'Zeitfaktor (0 = eingefroren)', type: 'number', default: 1, min: 0, max: 20, step: 0.1, group: 'Boden' },
    ],
    create: (_o, ctx) => {
      const object = new THREE.Group();
      if (!ctx.editor) return { object };
      const helper = new THREE.Group();
      helper.add(iconSprite('weather', '#9cc8ff'));
      // Pfeil = Windrichtung
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -0.3), 1.8, '#9cc8ff', 0.4, 0.2);
      for (const m of [arrow.line.material, arrow.cone.material] as THREE.Material[]) m.toneMapped = false;
      helper.add(arrow);
      return { object, helper: helperMark(helper) };
    },
  },
  spawn: {
    label: 'Player Start',
    category: 'Gameplay',
    fixedScale: true,
    unique: true,
    props: [],
    create: (_o, ctx) => {
      const object = new THREE.Group();
      if (!ctx.editor) return { object };
      const helper = new THREE.Group();
      const capsule = new THREE.Mesh(
        new THREE.CapsuleGeometry(SCALE.playerRadius, SCALE.playerHeight - SCALE.playerRadius * 2, 4, 12),
        new THREE.MeshBasicMaterial({ color: '#3fc4ff', wireframe: true, toneMapped: false }),
      );
      capsule.position.y = SCALE.playerHeight / 2;
      helper.add(capsule);
      helper.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1.5, 0), 1, 0x3fc4ff, 0.25, 0.15));
      return { object, helper: helperMark(helper) };
    },
  },
  npcspawn: {
    label: 'NPC-Spawn (Training)',
    category: 'Gameplay',
    fixedScale: true,
    props: [],
    create: (_o, ctx) => {
      const object = new THREE.Group();
      if (!ctx.editor) return { object };
      const helper = new THREE.Group();
      const capsule = new THREE.Mesh(
        new THREE.CapsuleGeometry(SCALE.playerRadius, SCALE.playerHeight - SCALE.playerRadius * 2, 4, 12),
        new THREE.MeshBasicMaterial({ color: '#ff4a4a', wireframe: true, toneMapped: false }),
      );
      capsule.position.y = SCALE.playerHeight / 2;
      helper.add(capsule);
      helper.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1.5, 0), 1, 0xff4a4a, 0.25, 0.15));
      return { object, helper: helperMark(helper) };
    },
  },
  trigger: {
    label: 'Trigger-Volumen',
    category: 'Gameplay',
    props: [],
    create: (_o, ctx) => {
      const object = new THREE.Group();
      if (!ctx.editor) return { object };
      const helper = new THREE.Group();
      const fill = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: '#46d36b', transparent: true, opacity: 0.06, depthWrite: false, toneMapped: false }),
      );
      fill.userData.noPick = true;
      helper.add(boxEdges('#46d36b'), fill, iconSprite('trigger', '#6ee88e'));
      return { object, helper: helperMark(helper) };
    },
  },
  terminal: {
    label: 'Terminal (Hauptmenü)',
    category: 'Gameplay',
    fixedScale: true,
    unique: true,
    props: [],
    create: (_o, ctx) => {
      // Im Spiel baut main.ts das echte Terminal an dieser Stelle; im Editor ein gleich großer Platzhalter
      const object = new THREE.Group();
      if (!ctx.editor) return { object };
      const w = 1.2;
      const h = w * (720 / 1280);
      const bezel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, h + 0.1, 0.06), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.85 }));
      bezel.position.z = 0.03;
      const c = document.createElement('canvas');
      c.width = 512;
      c.height = 288;
      const g = c.getContext('2d')!;
      g.fillStyle = '#061015';
      g.fillRect(0, 0, 512, 288);
      g.strokeStyle = '#3fc4ff';
      g.lineWidth = 4;
      g.strokeRect(16, 16, 480, 256);
      g.fillStyle = '#9fe2ff';
      g.font = 'bold 34px Consolas, monospace';
      g.textAlign = 'center';
      g.fillText('TERMINAL', 256, 130);
      g.font = '22px Consolas, monospace';
      g.fillText('Hauptmenü (im Spiel)', 256, 175);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1 }),
      );
      screen.position.z = 0.061;
      object.add(bezel, screen);
      return { object };
    },
  },
  screen: {
    label: 'Bildschirm (programmierbar)',
    category: 'Gameplay',
    fixedScale: true,
    props: [
      { key: 'width', label: 'Breite (m)', type: 'number', default: 1.2, min: 0.2, max: 12, step: 0.05, group: 'Bildschirm' },
      {
        key: 'aspect',
        label: 'Seitenverhältnis',
        type: 'select',
        default: '16:9',
        options: Object.keys(ASPECTS).map((k) => ({ value: k, label: k })),
        group: 'Bildschirm',
      },
      { key: 'brightness', label: 'Helligkeit', type: 'number', default: 1, min: 0, max: 4, step: 0.05, group: 'Bildschirm' },
      { key: 'bezel', label: 'Rahmen', type: 'bool', default: true, group: 'Bildschirm' },
      { key: 'glow', label: 'Leuchtet in den Raum', type: 'bool', default: true, group: 'Bildschirm' },
      {
        key: 'control',
        label: 'Bedienung',
        type: 'select',
        default: 'focus',
        options: [
          { value: 'focus', label: 'Herantreten (Maus-Cursor)' },
          { value: 'aim', label: 'Zielen + Benutzen-Taste' },
          { value: 'none', label: 'Nur Anzeige' },
        ],
        group: 'Interaktion',
      },
      { key: 'prompt', label: 'Hinweistext', type: 'text', default: 'Bildschirm benutzen', group: 'Interaktion' },
    ],
    create: (o, ctx) => {
      const object = new THREE.Group();
      const widthM = Math.max(0.05, p(o, 'width', 1.2));
      const aspect = p(o, 'aspect', '16:9');
      const stageH = stageHeight(aspect);
      const heightM = widthM * (stageH / STAGE_W);
      const canvas = document.createElement('canvas');
      canvas.width = STAGE_W * SCREEN_PX;
      canvas.height = stageH * SCREEN_PX;
      const g = canvas.getContext('2d')!;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = ctx.anisotropy;
      const bright = p(o, 'brightness', 1);
      const mat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.35, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: bright });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), mat);
      mesh.userData.screenSurface = true;
      mesh.position.z = 0.061;
      object.add(mesh);
      if (p(o, 'bezel', true)) {
        const frame = Math.min(0.08, widthM * 0.05);
        const bezel = new THREE.Mesh(
          new THREE.BoxGeometry(widthM + frame * 2, heightM + frame * 2, 0.06),
          new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.85 }),
        );
        bezel.position.z = 0.03;
        bezel.castShadow = true;
        bezel.userData.collider = 'bounds';
        object.add(bezel);
      } else {
        mesh.position.z = 0.002;
      }
      let glow: THREE.PointLight | undefined;
      if (p(o, 'glow', true) && bright > 0) {
        glow = new THREE.PointLight(0x9fdcff, 0.6 * bright * Math.max(0.5, widthM), 2.5 + widthM, 2);
        glow.position.set(0, 0, 0.35);
        object.add(glow);
      }
      const redraw = () => {
        drawStage(g, stageView(o.screen ?? defaultScreen()), stageH, SCREEN_PX);
        texture.needsUpdate = true;
      };
      redraw();
      return {
        object,
        screen: { canvas, ctx: g, texture, mesh, stageH, widthM, heightM, redraw },
        dispose: () => texture.dispose(),
      };
    },
  },
  empty: {
    label: 'Leeres Objekt',
    category: 'Gameplay',
    props: [],
    create: (_o, ctx) => ({
      object: new THREE.Group(),
      helper: ctx.editor ? helperMark(iconSprite('empty', '#e0e0e0')) : undefined,
    }),
  },

  model: {
    label: '3D-Modell',
    category: 'Modelle',
    props: [
      { key: 'model', label: 'Modell', type: 'model', default: '', group: 'Modell' },
      {
        key: 'collision',
        label: 'Kollision',
        type: 'select',
        default: 'bounds',
        options: [
          { value: 'none', label: 'Keine' },
          { value: 'bounds', label: 'Box (Umriss)' },
        ],
        group: 'Physik',
      },
      { key: 'castShadow', label: 'Wirft Schatten', type: 'bool', default: true, group: 'Rendering' },
    ],
    create: (o, ctx) => {
      const group = new THREE.Group();
      const ref = p(o, 'model', '');
      let helper: THREE.Object3D | undefined;
      if (ctx.editor) {
        helper = helperMark(boxEdges('#ff5fa2', 0.8));
        helper.position.y = 0.5;
      }
      const colorables: THREE.Mesh[] = [];
      let disposed = false;
      const ready = ref
        ? loadModel(ref).then((model) => {
            if (!model || disposed) return;
            const cast = p(o, 'castShadow', true);
            model.traverse((c) => {
              const m = c as THREE.Mesh;
              if (m.isMesh) {
                m.castShadow = cast;
                colorables.push(m);
              }
            });
            group.add(model);
            if (helper) helper.visible = false;
            if (p(o, 'collision', 'bounds') === 'bounds') group.userData.collider = 'bounds';
          })
        : Promise.resolve();
      return { object: group, helper, colorables, ready, dispose: () => (disposed = true) };
    },
  },
};

function seedOf(o: MapObjectData): number {
  let h = 7;
  for (let i = 0; i < o.id.length; i++) h = (h * 31 + o.id.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

/** Gemeinsamer Rahmen für Partikeleffekte: Editor-Helfer, An/Aus aus Props, Aufräumen */
function effectInstance(
  o: MapObjectData,
  ctx: AssetContext,
  fx: Effect,
  icon: IconKind,
  color: string,
  boxY: number,
  setup?: (fx: Effect) => void,
): AssetInstance {
  setup?.(fx);
  fx.control.setOn(p(o, 'on', true));
  let helper: THREE.Object3D | undefined;
  if (ctx.editor) {
    helper = new THREE.Group();
    const box = boxEdges(color, 0.5);
    box.position.y = boxY;
    helper.add(box, iconSprite(icon, color));
    helperMark(helper);
  }
  return {
    object: fx.object,
    helper,
    effect: fx.control,
    update: (dt, t) => fx.update(dt, t),
    dispose: () => fx.dispose(),
  };
}

function lightControl(state: LightState, setColor: (c: string) => void): LightControl {
  return {
    setOn: (on) => (state.on = on),
    isOn: () => state.on,
    setIntensity: (v) => (state.intensity = Math.max(0, v)),
    getIntensity: () => state.intensity,
    setColor,
    setFlicker: (on) => (state.flicker = on),
  };
}

export const CATEGORIES = ['Geometrie', 'Props', 'Licht', 'Volumetrik', 'Effekte', 'Gameplay', 'Modelle'];

/** Vorlage im Content Browser: Asset-Typ + Startwerte */
export interface AssetPreset {
  id: string;
  label: string;
  category: string;
  type: string;
  icon: string;
  scale?: Vec3;
  rot?: Vec3;
  props?: Record<string, PropValue>;
}

export const PRESETS: AssetPreset[] = [
  { id: 'box', label: 'Würfel', category: 'Geometrie', type: 'box', icon: 'cube' },
  { id: 'cylinder', label: 'Zylinder', category: 'Geometrie', type: 'cylinder', icon: 'cylinder' },
  { id: 'plane', label: 'Ebene', category: 'Geometrie', type: 'plane', icon: 'plane', scale: [4, 1, 4] },
  { id: 'stairs', label: 'Treppe', category: 'Geometrie', type: 'stairs', icon: 'stairs', scale: [1.5, 1.2, 2.4] },
  { id: 'doorwall', label: 'Wand mit Tür', category: 'Geometrie', type: 'doorwall', icon: 'door', scale: [4, 3, 0.3] },

  { id: 'wall', label: 'Wand (Beton)', category: 'Props', type: 'box', icon: 'wall', scale: [4, 3, 0.3], props: { material: 'wand_beton', color: '#ffffff' } },
  { id: 'floor', label: 'Boden (Fliesen)', category: 'Props', type: 'box', icon: 'floor', scale: [10, 0.1, 10], props: { material: 'bodenfliesen', color: '#ffffff', castShadow: false } },
  { id: 'ceiling', label: 'Decke (Beton)', category: 'Props', type: 'box', icon: 'floor', scale: [4, 0.2, 4], props: { material: 'decke', color: '#ffffff' } },
  { id: 'doorframe', label: 'Türrahmen (gelb)', category: 'Props', type: 'doorwall', icon: 'door', scale: [6, 3, 0.3], props: { material: 'beton_gelb', color: '#ffffff' } },
  { id: 'cover', label: 'Deckung (Holz)', category: 'Props', type: 'box', icon: 'crate', scale: [1.4, SCALE.coverHeight, 0.6], props: { material: 'holz', color: '#ffffff' } },
  { id: 'crate', label: 'Holzkiste 1 m', category: 'Props', type: 'box', icon: 'crate', props: { material: 'holz', color: '#ffffff' } },
  { id: 'pillar', label: 'Pfeiler (Beton)', category: 'Props', type: 'cylinder', icon: 'cylinder', scale: [1, 3, 1], props: { material: 'beton_dunkel', color: '#ffffff' } },
  { id: 'pole', label: 'Laternenmast', category: 'Props', type: 'cylinder', icon: 'pole', scale: [0.14, 3.4, 0.14], props: { material: 'metall', color: '#3a3d40', roughness: 0.45, metalness: 0.8 } },
  { id: 'refchar', label: 'Referenz-Figur 1.8 m', category: 'Props', type: 'box', icon: 'person', scale: [0.7, 1.8, 0.7], props: { material: 'farbe', color: '#2f4a66' } },

  { id: 'pointlight', label: 'Punktlicht', category: 'Licht', type: 'pointlight', icon: 'bulb' },
  { id: 'spotlight', label: 'Spotlicht (volumetrisch)', category: 'Licht', type: 'spotlight', icon: 'spot' },
  { id: 'tube', label: 'Leuchtstoffröhre', category: 'Licht', type: 'lamp', icon: 'tube' },
  { id: 'sodium', label: 'Natriumdampflampe', category: 'Licht', type: 'lamp', icon: 'tube', props: { color: '#ffa65a', intensity: 14, distance: 14, tubeX: 0.5, tubeY: 0.08, tubeZ: 0.1 } },
  { id: 'sun', label: 'Sonne (Directional Light)', category: 'Licht', type: 'sun', icon: 'sun' },
  { id: 'streetlamp', label: 'Laternenlicht', category: 'Licht', type: 'lamp', icon: 'bulb', props: { color: '#c8dcff', intensity: 30, distance: 16, tubeX: 0.35, tubeY: 0.06, tubeZ: 0.35, shadow: true } },

  { id: 'fog', label: 'Nebelvolumen', category: 'Volumetrik', type: 'fogvolume', icon: 'fog', scale: [6, 3, 6] },
  { id: 'groundfog', label: 'Bodennebel', category: 'Volumetrik', type: 'fogvolume', icon: 'fog', scale: [10, 1.2, 10], props: { density: 0.8, heightFalloff: 1, noise: 0.7 } },
  { id: 'shaft', label: 'Lichtschacht', category: 'Volumetrik', type: 'fogvolume', icon: 'shaft', scale: [1.5, 4, 1.5], props: { color: '#fff1d6', density: 0.25, brightness: 3, noise: 0.4, edge: 0.4, heightFalloff: 0 } },
  { id: 'dust', label: 'Staubpartikel', category: 'Volumetrik', type: 'dust', icon: 'dust', scale: [6, 3, 6] },
  { id: 'weather', label: 'Wetter (Regen, Schnee …)', category: 'Volumetrik', type: 'weather', icon: 'cloud' },
  { id: 'smokefog', label: 'Rauchschwaden (dicht)', category: 'Volumetrik', type: 'fogvolume', icon: 'fog', scale: [8, 2.5, 8], props: { color: '#6c6862', density: 1.4, brightness: 0.35, noise: 0.85, noiseScale: 0.7, heightFalloff: 0.3, speed: 1.6, lightResponse: 1.6, anisotropy: 0.6 } },

  { id: 'campfire', label: 'Lagerfeuer', category: 'Effekte', type: 'fire', icon: 'fire' },
  { id: 'barrelfire', label: 'Fassfeuer', category: 'Effekte', type: 'fire', icon: 'fire', props: { size: 0.8, radius: 0.25, rate: 70, embers: 5, smoke: 0.8, light: 10 } },
  { id: 'wreckfire', label: 'Brennendes Wrack', category: 'Effekte', type: 'fire', icon: 'fire', props: { size: 2.4, radius: 1.2, rate: 240, embers: 25, smoke: 2.2, smokeColor: '#1b1918', light: 45 } },
  { id: 'torch', label: 'Fackel', category: 'Effekte', type: 'fire', icon: 'fire', props: { size: 0.35, radius: 0.07, rate: 40, embers: 2, smoke: 0.3, light: 5, flicker: 0.9 } },
  { id: 'smokecolumn', label: 'Rauchsäule', category: 'Effekte', type: 'smoke', icon: 'smoke', props: { color: '#3a3836', rate: 14, life: 9, size: 0.8, grow: 4.5, rise: 1.6, opacity: 0.6 } },
  { id: 'steam', label: 'Dampf', category: 'Effekte', type: 'smoke', icon: 'smoke', props: { color: '#e4e8ec', opacity: 0.3, rate: 18, life: 2.2, size: 0.12, grow: 1.1, rise: 1.4, spread: 0.05, turbulence: 0.9 } },
  { id: 'smokegrenade', label: 'Dichte Rauchwolke', category: 'Effekte', type: 'smoke', icon: 'smoke', props: { color: '#9a9690', opacity: 0.85, rate: 30, life: 14, size: 1, grow: 6, rise: 0.25, spread: 1.2, turbulence: 0.35 } },
  { id: 'sparks', label: 'Funkenregen (Kabel)', category: 'Effekte', type: 'sparks', icon: 'sparks', scale: [1, 2, 1] },
  { id: 'welding', label: 'Schweißfunken', category: 'Effekte', type: 'sparks', icon: 'sparks', props: { color: '#9fd0ff', rate: 6, count: 10, speed: 4.5, life: 0.8, size: 0.015 } },

  { id: 'spawn', label: 'Player Start', category: 'Gameplay', type: 'spawn', icon: 'flag' },
  { id: 'npcspawn', label: 'NPC-Spawn (Training: Gegner erscheinen hier)', category: 'Gameplay', type: 'npcspawn', icon: 'flag' },
  { id: 'trigger', label: 'Trigger-Volumen', category: 'Gameplay', type: 'trigger', icon: 'trigger', scale: [2, 2, 2] },
  { id: 'terminal', label: 'Terminal (Hauptmenü)', category: 'Gameplay', type: 'terminal', icon: 'monitor' },
  { id: 'screen', label: 'Bildschirm (programmierbar)', category: 'Gameplay', type: 'screen', icon: 'monitor' },
  { id: 'empty', label: 'Leeres Objekt', category: 'Gameplay', type: 'empty', icon: 'empty' },
];

/** Standard-Eigenschaften eines Asset-Typs (+ Preset-Werte) */
export function defaultProps(type: string, extra: Record<string, PropValue> = {}): Record<string, PropValue> {
  const def = ASSETS[type];
  const props: Record<string, PropValue> = {};
  for (const d of def?.props ?? []) props[d.key] = d.default;
  return { ...props, ...extra };
}
