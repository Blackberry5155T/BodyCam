import * as THREE from 'three';
import type { MapObjectData, PropValue, Vec3 } from './mapFormat.ts';
import { MATERIAL_OPTIONS, getMaterial } from './materials.ts';
import { createDust, createFogVolume, createLightCone } from './volumetrics.ts';
import { loadModel } from './modelStore.ts';
import { SCALE } from './collision.ts';

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
}

export interface AssetContext {
  anisotropy: number;
  /** true im Editor: Hilfsobjekte (Icons, Drahtgitter) werden erzeugt */
  editor: boolean;
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
  /** Meshes, deren Farbe Scripts ändern dürfen */
  colorables?: THREE.Mesh[];
  /** Erfüllt, sobald asynchrone Inhalte (Modelle) geladen sind */
  ready?: Promise<void>;
  dispose?(): void;
}

export interface AssetDef {
  label: string;
  category: string;
  props: PropDef[];
  /** Skalierung ist fest 1 (Lichter, Spawn, Terminal) */
  fixedScale?: boolean;
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
type IconKind = 'light' | 'spot' | 'fog' | 'dust' | 'empty' | 'trigger';

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

function shadowSetup(light: THREE.PointLight | THREE.SpotLight, size = 512): void {
  light.castShadow = true;
  light.shadow.mapSize.set(size, size);
  light.shadow.bias = -0.003;
  light.shadow.radius = 3;
  light.shadow.camera.near = 0.1;
}

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
      return {
        object: light,
        helper: ctx.editor ? helperMark(iconSprite('light', p(o, 'color', '#ffffff'))) : undefined,
        update: (dt, _t, live) => state.update(dt, live),
        light: lightControl(state, (c) => light.color.set(c)),
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
        cone = createLightCone({ color, length: distance * 0.8, angle, strength });
        cone.mesh.userData.noPick = true;
        group.add(cone.mesh);
      }
      const coneMat = cone?.mesh.material as THREE.ShaderMaterial | undefined;
      const state = new LightState((k) => {
        light.intensity = state.intensity * k;
        if (coneMat) coneMat.uniforms.uStrength.value = strength * k * Math.min(1, state.intensity / 40) ** 0.5;
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
          coneMat?.uniforms.uColor.value.set(c);
        }),
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
      return {
        object: group,
        update: (dt, _t, live) => state.update(dt, live),
        light: lightControl(state, (c) => {
          light.color.set(c);
          tubeMat.emissive.set(c);
        }),
        dispose: () => tubeMat.dispose(),
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
      });
      fog.mesh.userData.noPick = true;
      fog.mesh.userData.noShot = true;
      let helper: THREE.Object3D | undefined;
      if (ctx.editor) {
        helper = new THREE.Group();
        helper.add(boxEdges('#7fb8ff', 0.8), iconSprite('fog', '#9fd0ff'));
        helperMark(helper);
      }
      return { object: fog.mesh, helper, update: (_dt, t) => fog.update(t), dispose: () => fog.mesh.geometry.dispose() };
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
      dust.points.userData.noPick = true;
      dust.points.userData.noShot = true;
      let helper: THREE.Object3D | undefined;
      if (ctx.editor) {
        helper = new THREE.Group();
        helper.add(boxEdges('#d8c08a', 0.6), iconSprite('dust', '#e8d6a8'));
        helperMark(helper);
      }
      return { object: dust.points, helper, update: (dt, t) => dust.update(dt, t), dispose: () => dust.points.geometry.dispose() };
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

export const CATEGORIES = ['Geometrie', 'Props', 'Licht', 'Volumetrik', 'Gameplay', 'Modelle'];

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
  { id: 'streetlamp', label: 'Laternenlicht', category: 'Licht', type: 'lamp', icon: 'bulb', props: { color: '#c8dcff', intensity: 30, distance: 16, tubeX: 0.35, tubeY: 0.06, tubeZ: 0.35, shadow: true } },

  { id: 'fog', label: 'Nebelvolumen', category: 'Volumetrik', type: 'fogvolume', icon: 'fog', scale: [6, 3, 6] },
  { id: 'groundfog', label: 'Bodennebel', category: 'Volumetrik', type: 'fogvolume', icon: 'fog', scale: [10, 1.2, 10], props: { density: 0.8, heightFalloff: 1, noise: 0.7 } },
  { id: 'shaft', label: 'Lichtschacht', category: 'Volumetrik', type: 'fogvolume', icon: 'shaft', scale: [1.5, 4, 1.5], props: { color: '#fff1d6', density: 0.25, brightness: 3, noise: 0.4, edge: 0.4, heightFalloff: 0 } },
  { id: 'dust', label: 'Staubpartikel', category: 'Volumetrik', type: 'dust', icon: 'dust', scale: [6, 3, 6] },

  { id: 'spawn', label: 'Player Start', category: 'Gameplay', type: 'spawn', icon: 'flag' },
  { id: 'trigger', label: 'Trigger-Volumen', category: 'Gameplay', type: 'trigger', icon: 'trigger', scale: [2, 2, 2] },
  { id: 'terminal', label: 'Terminal (Hauptmenü)', category: 'Gameplay', type: 'terminal', icon: 'monitor' },
  { id: 'empty', label: 'Leeres Objekt', category: 'Gameplay', type: 'empty', icon: 'empty' },
];

/** Standard-Eigenschaften eines Asset-Typs (+ Preset-Werte) */
export function defaultProps(type: string, extra: Record<string, PropValue> = {}): Record<string, PropValue> {
  const def = ASSETS[type];
  const props: Record<string, PropValue> = {};
  for (const d of def?.props ?? []) props[d.key] = d.default;
  return { ...props, ...extra };
}
