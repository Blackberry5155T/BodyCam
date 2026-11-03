import * as THREE from 'three';
import { ASSETS, type AssetContext, type AssetDef, type AssetInstance } from './assets.ts';
import type { MapData, MapObjectData, WorldSettings } from './mapFormat.ts';
import { SCALE, type Collider } from './collision.ts';

// Baut aus MapData die Szene. Gemeinsam genutzt von Spiel (main.ts) und Editor.

const DEG = THREE.MathUtils.DEG2RAD;

/** Ein Map-Objekt in der Szene: root trägt die Transformation, instance den Inhalt */
export class MapNode {
  readonly root = new THREE.Group();
  instance: AssetInstance | null = null;
  colliders: Collider[] = [];
  collisionEnabled = true;

  constructor(
    public data: MapObjectData,
    public def: AssetDef,
  ) {
    this.root.userData.mapNode = this;
    this.root.name = data.name;
  }
}

const UNKNOWN: AssetDef = {
  label: 'Unbekannt',
  category: 'Gameplay',
  props: [],
  create: () => ({ object: new THREE.Group() }),
};

export function createNode(data: MapObjectData, ctx: AssetContext): MapNode {
  const node = new MapNode(data, ASSETS[data.type] ?? UNKNOWN);
  applyTransform(node);
  buildInstance(node, ctx);
  return node;
}

/** (Neu-)Aufbau des Inhalts, z. B. nach Änderung von Eigenschaften */
export function buildInstance(node: MapNode, ctx: AssetContext): void {
  if (node.instance) {
    node.root.remove(node.instance.object);
    if (node.instance.helper) node.root.remove(node.instance.helper);
    node.instance.dispose?.();
  }
  node.def = ASSETS[node.data.type] ?? UNKNOWN;
  const inst = node.def.create(node.data, ctx);
  node.instance = inst;
  node.root.add(inst.object);
  if (inst.helper) node.root.add(inst.helper);
  node.root.visible = ctx.editor || !node.data.hidden;
  node.root.updateMatrixWorld(true);
  inst.onTransform?.(node.root);
}

export function applyTransform(node: MapNode): void {
  const d = node.data;
  node.root.position.set(...d.pos);
  node.root.rotation.set(d.rot[0] * DEG, d.rot[1] * DEG, d.rot[2] * DEG, 'XYZ');
  if (node.def.fixedScale) node.root.scale.set(1, 1, 1);
  else node.root.scale.set(...d.scale);
  node.root.updateMatrixWorld(true);
  node.instance?.onTransform?.(node.root);
}

const round = (v: number, f = 10000) => Math.round(v * f) / f;

/** Übernimmt die aktuelle Transformation des root in die Daten (nach Gizmo-Bewegung) */
export function readTransform(node: MapNode): void {
  const r = node.root;
  node.data.pos = [round(r.position.x), round(r.position.y), round(r.position.z)];
  node.data.rot = [round(r.rotation.x / DEG, 100), round(r.rotation.y / DEG, 100), round(r.rotation.z / DEG, 100)];
  if (!node.def.fixedScale) node.data.scale = [round(r.scale.x), round(r.scale.y), round(r.scale.z)];
}

// ---------- Kollision ----------

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _up = new THREE.Vector3();
const _x = new THREE.Vector3();
const _box = new THREE.Box3();
const _m = new THREE.Matrix4();

/** Lokale Box (im Raum von matrixWorld) → gedrehte Box, falls nur um Y gedreht, sonst achsenparallele Hülle */
function colliderFromLocalBox(local: THREE.Box3, matrixWorld: THREE.Matrix4): Collider {
  matrixWorld.decompose(_pos, _quat, _scl);
  _up.set(0, 1, 0).applyQuaternion(_quat);
  if (_up.y > 0.9995) {
    _x.set(1, 0, 0).applyQuaternion(_quat);
    const yaw = Math.atan2(-_x.z, _x.x);
    const center = local.getCenter(new THREE.Vector3()).applyMatrix4(matrixWorld);
    const half = local.getSize(new THREE.Vector3()).multiply(_scl).multiplyScalar(0.5);
    half.set(Math.abs(half.x), Math.abs(half.y), Math.abs(half.z));
    if (Math.abs(yaw) < 1e-4) return { type: 'box', min: center.clone().sub(half), max: center.clone().add(half) };
    return { type: 'obox', center, half, yaw };
  }
  _box.copy(local).applyMatrix4(matrixWorld);
  return { type: 'box', min: _box.min.clone(), max: _box.max.clone() };
}

export function computeColliders(node: MapNode): Collider[] {
  const out: Collider[] = [];
  if (!node.instance || !node.collisionEnabled) return out;
  node.root.updateMatrixWorld(true);
  node.instance.object.traverse((o) => {
    const kind = o.userData.collider as string | undefined;
    if (!kind) return;
    if (kind === 'bounds') {
      // Hülle aller Meshes im lokalen Raum des Objekts
      const inv = _m.copy(o.matrixWorld).invert();
      const local = new THREE.Box3();
      o.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.computeBoundingBox();
        local.union(_box.copy(mesh.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld)));
      });
      if (!local.isEmpty()) out.push(colliderFromLocalBox(local, o.matrixWorld));
      return;
    }
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    if (kind === 'cylinder') {
      mesh.matrixWorld.decompose(_pos, _quat, _scl);
      _up.set(0, 1, 0).applyQuaternion(_quat);
      if (Math.abs(_up.y) > 0.9995) {
        const c = bb.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
        const radius = ((bb.max.x - bb.min.x) / 2) * Math.max(Math.abs(_scl.x), Math.abs(_scl.z));
        const h = ((bb.max.y - bb.min.y) * Math.abs(_scl.y)) / 2;
        out.push({ type: 'cylinder', center: new THREE.Vector2(c.x, c.z), radius, minY: c.y - h, maxY: c.y + h });
        return;
      }
    }
    out.push(colliderFromLocalBox(bb, mesh.matrixWorld));
  });
  return out;
}

/** Collider eines Knotens in der gemeinsamen Liste ersetzen (in place, der Spieler hält die Referenz) */
export function refreshColliders(node: MapNode, all: Collider[]): void {
  for (const c of node.colliders) {
    const i = all.indexOf(c);
    if (i >= 0) all.splice(i, 1);
  }
  node.colliders = computeColliders(node);
  all.push(...node.colliders);
}

// ---------- Welt (Himmel, Sonne, Bodennebel) ----------

export class WorldRig {
  readonly group = new THREE.Group();
  readonly hemi = new THREE.HemisphereLight();
  readonly sun = new THREE.DirectionalLight();
  readonly groundFog: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  constructor(world: WorldSettings) {
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 4;
    this.groundFog = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
    );
    this.groundFog.rotation.x = -Math.PI / 2;
    this.groundFog.userData.noPick = true;
    this.groundFog.userData.noShot = true;
    this.group.add(this.hemi, this.sun, this.sun.target, this.groundFog);
    this.apply(world);
  }

  apply(w: WorldSettings): void {
    this.hemi.color.set(w.skyColor);
    this.hemi.groundColor.set(w.groundColor);
    this.hemi.intensity = w.hemiIntensity;
    this.sun.color.set(w.sunColor);
    this.sun.intensity = w.sunIntensity;
    const az = w.sunAzimuth * DEG;
    const el = w.sunElevation * DEG;
    const dist = Math.max(22, w.sunShadowArea);
    this.sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist);
    this.sun.castShadow = w.sunShadow;
    const a = w.sunShadowArea;
    Object.assign(this.sun.shadow.camera, { left: -a, right: a, top: a, bottom: -a, near: 1, far: dist * 2.6 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.groundFog.material.color.set(w.fogColor);
    this.groundFog.material.opacity = w.groundFogOpacity;
    this.groundFog.position.y = w.groundFogHeight;
    this.groundFog.scale.set(w.groundFogSize, w.groundFogSize, 1);
    this.groundFog.visible = w.groundFog;
  }
}

// ---------- Ganze Map ----------

export interface TerminalPlacement {
  center: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface LoadedMap {
  data: MapData;
  group: THREE.Group;
  world: WorldRig;
  nodes: MapNode[];
  colliders: Collider[];
  /** Augenposition des Spielers beim Start */
  spawn: THREE.Vector3;
  spawnYaw: number;
  terminal: TerminalPlacement | null;
  update(dt: number, t: number): void;
}

export function loadMap(data: MapData, ctx: AssetContext): LoadedMap {
  const group = new THREE.Group();
  const world = new WorldRig(data.world);
  group.add(world.group);
  const nodes: MapNode[] = [];
  const colliders: Collider[] = [];
  let spawn = new THREE.Vector3(0, SCALE.playerHeight, 0);
  let spawnYaw = 0;
  let terminal: TerminalPlacement | null = null;

  for (const o of data.objects) {
    const node = createNode(o, ctx);
    group.add(node.root);
    nodes.push(node);
    refreshColliders(node, colliders);
    // Modelle laden asynchron: Collider nachziehen, sobald sie da sind
    node.instance?.ready?.then(() => refreshColliders(node, colliders));
    if (o.type === 'spawn') {
      spawn = new THREE.Vector3(o.pos[0], o.pos[1] + SCALE.playerHeight, o.pos[2]);
      spawnYaw = o.rot[1] * DEG;
    } else if (o.type === 'terminal' && !terminal) {
      terminal = {
        center: new THREE.Vector3(...o.pos),
        normal: new THREE.Vector3(0, 0, 1).applyQuaternion(node.root.quaternion).normalize(),
      };
    }
  }

  return {
    data,
    group,
    world,
    nodes,
    colliders,
    spawn,
    spawnYaw,
    terminal,
    update(dt: number, t: number) {
      for (const n of nodes) n.instance?.update?.(dt, t, true);
    },
  };
}

/** Findet zu einem getroffenen Mesh das zugehörige Map-Objekt */
export function nodeOf(obj: THREE.Object3D | null): MapNode | null {
  for (let o = obj; o; o = o.parent) {
    if (o.userData.mapNode) return o.userData.mapNode as MapNode;
  }
  return null;
}
