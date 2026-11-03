import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { EditorState } from './state.ts';
import type { AssetContext } from '../world/assets.ts';
import { MapNode, WorldRig, applyTransform, buildInstance, createNode, nodeOf, readTransform } from '../world/mapLoader.ts';
import { ScriptRuntime } from '../scripting/runtime.ts';
import { SCALE } from '../world/collision.ts';
import { h } from './ui.ts';

// 3D-Viewport des Editors: Navigation wie in UE5 (RMT + WASD fliegen, MMT schieben, Alt+LMT orbit,
// Mausrad vor/zurück), Gizmo (W/E/R), Auswahl mit Outline, Drag & Drop aus dem Content Browser.

export type GizmoMode = 'select' | 'translate' | 'rotate' | 'scale';
export type ViewMode = 'lit' | 'bright' | 'wire';

const CAMERA_SPEEDS = [0.5, 1, 2, 4, 7, 12, 20, 35];
const HELPER_LAYER = 1;
const EXPOSURE = 1.15;

interface Entry {
  node: MapNode;
  propsKey: string;
  scaleKey: string;
  xfKey: string;
}

interface Drag {
  mode: 'click' | 'fly' | 'pan' | 'orbit' | 'dolly';
  button: number;
  x: number;
  y: number;
  moved: number;
  pivot?: THREE.Vector3;
  orbitDist?: number;
  ctrl: boolean;
  shift: boolean;
}

export class Viewport {
  readonly container: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 800);
  readonly ctx: AssetContext;

  mode: GizmoMode = 'translate';
  space: 'world' | 'local' = 'world';
  snap = { translate: true, translateStep: 0.5, rotate: true, rotateStep: 15, scale: false, scaleStep: 0.25 };
  viewMode: ViewMode = 'lit';
  showHelpers = true;
  showGrid = true;
  showFog = true;
  bloomEnabled = true;
  speedIndex = 3;

  onStatus?: (msg: string, error?: boolean) => void;
  onContextMenu?: (node: MapNode | null, x: number, y: number) => void;
  onSimulationChange?: () => void;

  private overlay = new THREE.Scene();
  private mapGroup = new THREE.Group();
  private entries = new Map<string, Entry>();
  private world: WorldRig;
  private fog = new THREE.Fog(0x000000, 1, 80);
  private grid = new THREE.Group();
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private outline: OutlinePass;
  private gizmo: TransformControls;
  private pivot = new THREE.Object3D();
  private brightLight = new THREE.AmbientLight(0xffffff, 1.6);
  private selBoxes = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private clock = new THREE.Clock();
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = -0.3;
  private drag: Drag | null = null;
  private altDown = false;
  private gizmoMoved = false;
  private dragStart: { pivot: THREE.Matrix4; nodes: { node: MapNode; matrix: THREE.Matrix4 }[] } | null = null;
  private runtime: ScriptRuntime | null = null;
  private simInfo: HTMLElement;
  private message: HTMLElement;
  private messageTimer = 0;
  private info: HTMLElement;

  constructor(
    container: HTMLElement,
    private state: EditorState,
  ) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.autoClear = false;
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    container.append(canvas);
    this.ctx = { anisotropy: this.renderer.capabilities.getMaxAnisotropy(), editor: true };

    this.camera.rotation.order = 'YXZ';
    this.camera.layers.enable(HELPER_LAYER);
    this.scene.add(this.camera, this.mapGroup);
    this.world = new WorldRig(state.map.world);
    this.scene.add(this.world.group);

    // Raster: 1-m-Linien + 10-m-Linien
    const minor = new THREE.GridHelper(400, 400, 0x3a3a3a, 0x3a3a3a);
    const major = new THREE.GridHelper(400, 40, 0x6a6a6a, 0x5a5a5a);
    for (const g of [minor, major]) {
      const m = g.material as THREE.LineBasicMaterial;
      m.transparent = true;
      m.opacity = g === minor ? 0.22 : 0.4;
      m.depthWrite = false;
      g.position.y = 0.002;
      g.layers.set(HELPER_LAYER);
      g.userData.noPick = true;
      this.grid.add(g);
    }
    this.scene.add(this.grid);

    // Post-Processing: wie im Spiel (Bloom), dazu orange Auswahl-Outline wie in UE5
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.outline = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera);
    this.outline.visibleEdgeColor.set('#ffa500');
    this.outline.hiddenEdgeColor.set('#7a4f00');
    this.outline.edgeStrength = 4;
    this.outline.edgeThickness = 1;
    this.outline.edgeGlow = 0;
    this.composer.addPass(this.outline);
    this.composer.addPass(new OutputPass());

    // Gizmo + Auswahlboxen werden nach dem Post-Processing direkt darübergezeichnet
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.9);
    this.overlay.add(this.gizmo.getHelper(), this.pivot, this.selBoxes);
    this.gizmo.addEventListener('dragging-changed', (e) => this.onGizmoDrag(e.value as boolean));
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
    this.applySnap();

    this.simInfo = h('div', { class: 'vp-sim hidden' }, h('span', {}, 'SIMULATION — Klick: Benutzen · Shift+Klick: Treffer · Esc: Stopp'));
    this.message = h('div', { class: 'vp-message hidden' });
    this.info = h('div', { class: 'vp-info' });
    container.append(this.simInfo, this.message, this.info);

    this.bindInput(canvas);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    state.on('scene', () => this.sync());
    state.on('selection', () => {
      this.updateGizmo();
      this.updateSelectionVisuals();
    });
    state.on('world', () => this.applyWorld());
    state.on('transform', () => this.updateSelectionVisuals());

    this.camera.position.set(0, 8, 14);
    this.applyCamera();
    this.renderer.setAnimationLoop(() => this.frameLoop());
  }

  // ---------- Szene abgleichen ----------

  /** Gleicht 3D-Szene mit den Map-Daten ab (nur Geändertes wird neu gebaut) */
  sync(): void {
    const objects = this.state.map.objects;
    const ids = new Set(objects.map((o) => o.id));
    for (const [id, e] of this.entries) {
      if (!ids.has(id)) {
        this.mapGroup.remove(e.node.root);
        e.node.instance?.dispose?.();
        this.entries.delete(id);
      }
    }
    for (const o of objects) {
      const propsKey = JSON.stringify([o.type, o.props]);
      const scaleKey = o.scale.join(',');
      const xfKey = JSON.stringify([o.pos, o.rot, o.scale]);
      let e = this.entries.get(o.id);
      if (!e) {
        const node = createNode(o, this.ctx);
        this.mapGroup.add(node.root);
        e = { node, propsKey, scaleKey, xfKey };
        this.entries.set(o.id, e);
        this.prepareNode(node);
      } else {
        const node = e.node;
        node.data = o;
        const rebuild = e.propsKey !== propsKey || node.def !== undefined && node.def.rebuildOnScale && e.scaleKey !== scaleKey;
        if (e.xfKey !== xfKey) applyTransform(node);
        if (rebuild) {
          buildInstance(node, this.ctx);
          this.prepareNode(node);
        }
        e.propsKey = propsKey;
        e.scaleKey = scaleKey;
        e.xfKey = xfKey;
      }
      e.node.root.name = o.name;
      e.node.root.visible = !this.state.editorHidden.has(o.id);
    }
    this.updateGizmo();
    this.updateSelectionVisuals();
  }

  private prepareNode(node: MapNode): void {
    node.instance?.helper?.traverse((c) => c.layers.set(HELPER_LAYER));
    if (this.viewMode === 'wire') this.setWire(node.root, true);
    node.instance?.ready?.then(() => {
      if (this.viewMode === 'wire') this.setWire(node.root, true);
      this.updateSelectionVisuals();
    });
  }

  nodeById(id: string): MapNode | undefined {
    return this.entries.get(id)?.node;
  }

  private selectedNodes(): MapNode[] {
    return this.state.selection.map((id) => this.entries.get(id)?.node).filter((n): n is MapNode => !!n);
  }

  // ---------- Welt & Anzeige ----------

  applyWorld(): void {
    const w = this.state.map.world;
    this.world.apply(w);
    this.scene.background = new THREE.Color(w.background);
    this.fog.color.set(w.fogColor);
    this.scene.fog = this.showFog ? this.fog : null;
    this.world.groundFog.visible = w.groundFog && this.showFog;
    this.renderer.toneMappingExposure = EXPOSURE * w.exposure;
  }

  setViewMode(m: ViewMode): void {
    if (this.viewMode === 'wire') this.setWire(this.mapGroup, false);
    this.viewMode = m;
    if (m === 'wire') this.setWire(this.mapGroup, true);
    if (m === 'bright') this.scene.add(this.brightLight);
    else this.scene.remove(this.brightLight);
  }

  private setWire(root: THREE.Object3D, on: boolean): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || o.userData.editorHelper) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) (m as THREE.MeshStandardMaterial).wireframe = on;
      }
    });
  }

  setShowHelpers(on: boolean): void {
    this.showHelpers = on;
    if (on) this.camera.layers.enable(HELPER_LAYER);
    else this.camera.layers.disable(HELPER_LAYER);
    this.grid.visible = this.showGrid;
  }

  setShowGrid(on: boolean): void {
    this.showGrid = on;
    this.grid.visible = on;
  }

  setShowFog(on: boolean): void {
    this.showFog = on;
    this.applyWorld();
  }

  setBloom(on: boolean): void {
    this.bloomEnabled = on;
    this.bloom.enabled = on;
  }

  setMode(m: GizmoMode): void {
    this.mode = m;
    this.updateGizmo();
  }

  setSpace(s: 'world' | 'local'): void {
    this.space = s;
    this.updateGizmo();
  }

  applySnap(): void {
    const s = this.snap;
    this.gizmo.setTranslationSnap(s.translate ? s.translateStep : null);
    this.gizmo.setRotationSnap(s.rotate ? THREE.MathUtils.degToRad(s.rotateStep) : null);
    this.gizmo.setScaleSnap(s.scale ? s.scaleStep : null);
  }

  get cameraSpeed(): number {
    return CAMERA_SPEEDS[this.speedIndex];
  }

  // ---------- Gizmo ----------

  private updateGizmo(): void {
    if (this.dragStart) return;
    const nodes = this.selectedNodes().filter((n) => n.root.visible);
    const prim = nodes[nodes.length - 1];
    const scaleable = nodes.some((n) => !n.def.fixedScale);
    if (!prim || this.mode === 'select' || this.state.simulating || (this.mode === 'scale' && !scaleable)) {
      this.gizmo.detach();
      return;
    }
    this.pivot.position.copy(prim.root.position);
    this.pivot.quaternion.copy(prim.root.quaternion);
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
    this.gizmo.attach(this.pivot);
    this.gizmo.setMode(this.mode);
    this.gizmo.setSpace(this.mode === 'scale' ? 'local' : this.space);
  }

  private onGizmoDrag(dragging: boolean): void {
    if (dragging) {
      this.gizmoMoved = false;
      // Alt + Ziehen: Auswahl duplizieren und die Kopien bewegen (wie in UE5)
      if (this.altDown && this.mode === 'translate') {
        const copies = this.state.duplicateSelected(false);
        if (copies.length) this.onStatus?.(`${copies.length} Objekt(e) dupliziert`);
      }
      this.pivot.updateMatrixWorld(true);
      this.dragStart = {
        pivot: this.pivot.matrixWorld.clone(),
        nodes: this.selectedNodes().map((node) => ({ node, matrix: node.root.matrixWorld.clone() })),
      };
    } else {
      this.dragStart = null;
      if (this.gizmoMoved) this.state.commit();
      this.updateGizmo();
    }
  }

  private onGizmoChange(): void {
    const ds = this.dragStart;
    if (!ds) return;
    this.gizmoMoved = true;
    this.pivot.updateMatrixWorld(true);
    const delta = this.pivot.matrixWorld.clone().multiply(ds.pivot.clone().invert());
    const m = new THREE.Matrix4();
    for (const { node, matrix } of ds.nodes) {
      m.multiplyMatrices(delta, matrix);
      const oldScale = node.data.scale.join(',');
      m.decompose(node.root.position, node.root.quaternion, node.root.scale);
      if (node.def.fixedScale) node.root.scale.set(1, 1, 1);
      node.root.updateMatrixWorld(true);
      readTransform(node);
      const e = this.entries.get(node.data.id);
      if (node.def.rebuildOnScale && node.data.scale.join(',') !== oldScale) {
        buildInstance(node, this.ctx);
        this.prepareNode(node);
      } else {
        node.instance?.onTransform?.(node.root);
      }
      if (e) {
        e.scaleKey = node.data.scale.join(',');
        e.xfKey = JSON.stringify([node.data.pos, node.data.rot, node.data.scale]);
        e.propsKey = JSON.stringify([node.data.type, node.data.props]);
      }
    }
    this.state.emit('transform');
  }

  private updateSelectionVisuals(): void {
    const nodes = this.selectedNodes().filter((n) => n.root.visible);
    const meshes: THREE.Object3D[] = [];
    for (const c of [...this.selBoxes.children]) {
      this.selBoxes.remove(c);
      (c as THREE.Box3Helper).geometry.dispose();
    }
    for (const n of nodes) {
      let hasMesh = false;
      n.instance?.object.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) hasMesh = true;
      });
      if (hasMesh && n.instance) meshes.push(n.instance.object);
      else {
        const box = new THREE.Box3().setFromObject(n.root);
        if (box.isEmpty()) box.setFromCenterAndSize(n.root.position, new THREE.Vector3(0.5, 0.5, 0.5));
        const helper = new THREE.Box3Helper(box.expandByScalar(0.02), 0xffa500);
        (helper.material as THREE.LineBasicMaterial).toneMapped = false;
        this.selBoxes.add(helper);
      }
    }
    this.outline.selectedObjects = meshes;
  }

  // ---------- Kamera ----------

  private forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  private applyCamera(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  lookAt(target: THREE.Vector3): void {
    const d = target.clone().sub(this.camera.position).normalize();
    this.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    this.yaw = Math.atan2(-d.x, -d.z);
    this.applyCamera();
  }

  /** Kamera auf Auswahl (F) bzw. ganze Map ausrichten */
  focus(ids: string[]): void {
    const box = new THREE.Box3();
    const nodes = ids.length ? ids.map((id) => this.entries.get(id)?.node).filter((n): n is MapNode => !!n) : [...this.entries.values()].map((e) => e.node);
    for (const n of nodes) {
      const b = new THREE.Box3().setFromObject(n.root);
      if (b.isEmpty()) b.setFromCenterAndSize(n.root.position, new THREE.Vector3(1, 1, 1));
      box.union(b);
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(10, 2, 10));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 0.5);
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * (ids.length ? 1.1 : 0.75);
    if (!ids.length) {
      this.yaw = Math.PI * 0.82;
      this.pitch = -0.6;
    }
    this.camera.position.copy(sphere.center).addScaledVector(this.forward(), -dist);
    this.applyCamera();
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const hgt = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, hgt, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, hgt);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
  }

  // ---------- Eingabe ----------

  get isFlying(): boolean {
    return this.drag?.mode === 'fly';
  }

  private bindInput(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // vor TransformControls (Capture), damit Alt beim Gizmo-Start bekannt ist
    canvas.addEventListener('pointerdown', (e) => (this.altDown = e.altKey), { capture: true });
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      if (this.gizmo.dragging || (e.button === 0 && this.gizmo.axis !== null && this.gizmo.object)) return;
      let mode: Drag['mode'] = 'click';
      if (e.button === 2) mode = e.altKey ? 'dolly' : 'fly';
      else if (e.button === 1) mode = 'pan';
      else if (e.button === 0 && e.altKey) mode = 'orbit';
      this.drag = { mode, button: e.button, x: e.clientX, y: e.clientY, moved: 0, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      if (mode === 'orbit') {
        const sel = this.selectedNodes();
        const pivot = sel.length ? new THREE.Box3().setFromObject(sel[sel.length - 1].root).getCenter(new THREE.Vector3()) : this.camera.position.clone().addScaledVector(this.forward(), 10);
        this.drag.pivot = pivot;
        this.drag.orbitDist = pivot.distanceTo(this.camera.position);
      }
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.movementX;
      const dy = e.movementY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      const speed = this.cameraSpeed;
      if (d.mode === 'fly' || d.mode === 'orbit') {
        this.yaw -= dx * 0.0032;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0032, -1.55, 1.55);
        this.applyCamera();
        if (d.mode === 'orbit' && d.pivot) this.camera.position.copy(d.pivot).addScaledVector(this.forward(), -(d.orbitDist ?? 10));
      } else if (d.mode === 'pan') {
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        const k = 0.004 * speed + 0.004;
        this.camera.position.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      } else if (d.mode === 'dolly') {
        this.camera.position.addScaledVector(this.forward(), dx * 0.01 * speed);
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.moved < 4 && d.mode === 'click') this.clickSelect(e, d);
      else if (d.moved < 4 && d.mode === 'fly') {
        const node = this.pick(e.clientX, e.clientY);
        if (node && !this.state.selection.includes(node.data.id)) this.state.select([node.data.id]);
        this.onContextMenu?.(node, e.clientX, e.clientY);
      }
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.isFlying) {
        this.speedIndex = THREE.MathUtils.clamp(this.speedIndex + (e.deltaY < 0 ? 1 : -1), 0, CAMERA_SPEEDS.length - 1);
        this.onStatus?.(`Kamerageschwindigkeit ${this.speedIndex + 1} (${this.cameraSpeed} m/s)`);
      } else {
        this.camera.position.addScaledVector(this.forward(), -Math.sign(e.deltaY) * (0.4 + this.cameraSpeed * 0.35));
      }
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (this.runtime && !e.repeat && document.activeElement === canvas) this.runtime.keyPressed(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.drag = null;
    });
  }

  private clickSelect(e: PointerEvent, d: Drag): void {
    const node = this.pick(e.clientX, e.clientY);
    if (this.runtime) {
      if (node) {
        if (e.shiftKey) this.runtime.hit(node);
        else this.runtime.interact(node);
      }
      return;
    }
    if (!node) {
      if (!d.ctrl && !d.shift) this.state.select([]);
      return;
    }
    this.state.select([node.data.id], d.ctrl || d.shift ? 'toggle' : 'set');
  }

  private ndc(x: number, y: number): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  private pickable(o: THREE.Object3D): boolean {
    for (let c: THREE.Object3D | null = o; c && c !== this.mapGroup; c = c.parent) {
      if (!c.visible || c.userData.noPick) return false;
    }
    return true;
  }

  /** Objekt unter dem Mauszeiger (inkl. Icons/Drahtgitter, wenn sichtbar) */
  pick(x: number, y: number): MapNode | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    this.raycaster.layers.mask = this.camera.layers.mask;
    this.raycaster.params.Line.threshold = 0.06;
    for (const hit of this.raycaster.intersectObjects(this.mapGroup.children, true)) {
      if (this.pickable(hit.object)) return nodeOf(hit.object);
    }
    return null;
  }

  /** Oberflächenpunkt für das Platzieren (nur echte Geometrie) */
  surfacePoint(x: number, y: number, exclude?: Set<string>): { point: THREE.Vector3; normal: THREE.Vector3 } {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    this.raycaster.layers.set(0);
    for (const hit of this.raycaster.intersectObjects(this.mapGroup.children, true)) {
      const node = nodeOf(hit.object);
      if (!node || exclude?.has(node.data.id) || !this.pickable(hit.object) || !(hit.object as THREE.Mesh).isMesh || !hit.face) continue;
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      return { point: hit.point.clone(), normal };
    }
    const ray = this.raycaster.ray;
    const t = ray.direction.y < -0.02 ? -ray.origin.y / ray.direction.y : -1;
    if (t > 0 && t < 400) return { point: ray.at(t, new THREE.Vector3()), normal: new THREE.Vector3(0, 1, 0) };
    return { point: ray.at(8, new THREE.Vector3()), normal: new THREE.Vector3(0, 1, 0) };
  }

  /** Setzt ein Objekt so auf eine Fläche, dass es aufliegt statt einzusinken */
  placeOnSurface(id: string, point: THREE.Vector3, normal: THREE.Vector3): void {
    const node = this.entries.get(id)?.node;
    if (!node?.instance) return;
    node.root.position.copy(point);
    node.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(node.instance.object);
    if (box.isEmpty()) {
      node.root.position.addScaledVector(normal, 0.4);
    } else {
      const a = Math.abs(normal.x) > Math.abs(normal.y) ? (Math.abs(normal.x) > Math.abs(normal.z) ? 'x' : 'z') : Math.abs(normal.y) > Math.abs(normal.z) ? 'y' : 'z';
      const n = normal[a];
      node.root.position[a] += n > 0 ? point[a] - box.min[a] : point[a] - box.max[a];
      if (this.snap.translate) {
        const s = this.snap.translateStep;
        for (const ax of ['x', 'y', 'z'] as const) if (ax !== a) node.root.position[ax] = Math.round(node.root.position[ax] / s) * s;
      }
    }
    if (node.data.type === 'spawn') node.root.position.y = point.y;
    node.root.updateMatrixWorld(true);
    readTransform(node);
    applyTransform(node);
    const e = this.entries.get(id)!;
    e.xfKey = JSON.stringify([node.data.pos, node.data.rot, node.data.scale]);
    this.state.emit('transform');
  }

  /** Punkt in der Bildmitte, auf dem neue Objekte landen */
  centerPoint(): { point: THREE.Vector3; normal: THREE.Vector3 } {
    const r = this.renderer.domElement.getBoundingClientRect();
    const hit = this.surfacePoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit.point.distanceTo(this.camera.position) > 40) hit.point.copy(this.camera.position).addScaledVector(this.forward(), 8);
    return hit;
  }

  /** Auswahl auf darunterliegende Fläche setzen (Ende-Taste) */
  snapToFloor(): number {
    let count = 0;
    const exclude = new Set(this.state.selection);
    for (const node of this.selectedNodes()) {
      if (!node.instance) continue;
      const box = new THREE.Box3().setFromObject(node.instance.object);
      if (box.isEmpty()) box.setFromCenterAndSize(node.root.position, new THREE.Vector3());
      const origin = box.getCenter(new THREE.Vector3());
      origin.y = box.min.y + 0.01;
      this.raycaster.set(origin, new THREE.Vector3(0, -1, 0));
      this.raycaster.layers.set(0);
      let ground = 0;
      for (const hit of this.raycaster.intersectObjects(this.mapGroup.children, true)) {
        const n = nodeOf(hit.object);
        if (!n || exclude.has(n.data.id) || !this.pickable(hit.object) || !(hit.object as THREE.Mesh).isMesh) continue;
        ground = hit.point.y;
        break;
      }
      if (ground > origin.y) ground = 0;
      node.root.position.y += ground - box.min.y;
      node.root.updateMatrixWorld(true);
      readTransform(node);
      count++;
    }
    if (count) this.state.update(() => {});
    return count;
  }

  // ---------- Simulieren ----------

  get simulating(): boolean {
    return this.runtime !== null;
  }

  startSimulation(): void {
    if (this.runtime) return;
    this.state.simulating = true;
    this.gizmo.detach();
    const nodes = [...this.entries.values()].map((e) => e.node);
    const camFeet = () => this.camera.position.clone().setY(this.camera.position.y - (SCALE.playerHeight - 0.3));
    this.runtime = new ScriptRuntime(nodes, [], {
      playerPosition: camFeet,
      teleportPlayer: (feet) => this.camera.position.copy(feet).setY(feet.y + SCALE.playerHeight - 0.3),
      showMessage: (text, sec) => {
        this.message.textContent = text;
        this.message.classList.remove('hidden');
        this.messageTimer = sec;
      },
      keyDown: (code) => this.keys.has(code),
      log: (msg, err) => this.onStatus?.(msg, err),
    });
    this.runtime.start();
    this.simInfo.classList.remove('hidden');
    this.onStatus?.(this.runtime.hasScripts ? 'Simulation gestartet' : 'Simulation gestartet (keine Scripts in der Map)');
    this.onSimulationChange?.();
  }

  stopSimulation(): void {
    if (!this.runtime) return;
    this.runtime.stop();
    this.runtime = null;
    this.state.simulating = false;
    // Alles auf den gespeicherten Zustand zurücksetzen
    for (const e of this.entries.values()) {
      e.node.collisionEnabled = true;
      applyTransform(e.node);
      buildInstance(e.node, this.ctx);
      this.prepareNode(e.node);
      e.node.root.visible = !this.state.editorHidden.has(e.node.data.id);
    }
    this.simInfo.classList.add('hidden');
    this.message.classList.add('hidden');
    this.updateGizmo();
    this.updateSelectionVisuals();
    this.onStatus?.('Simulation beendet');
    this.onSimulationChange?.();
  }

  // ---------- Frame ----------

  private frameLoop(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    if (this.isFlying) {
      const f = this.forward();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const move = new THREE.Vector3();
      const k = this.keys;
      if (k.has('KeyW')) move.add(f);
      if (k.has('KeyS')) move.sub(f);
      if (k.has('KeyD')) move.add(right);
      if (k.has('KeyA')) move.sub(right);
      if (k.has('KeyE')) move.y += 1;
      if (k.has('KeyQ')) move.y -= 1;
      if (move.lengthSq() > 0) {
        const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1;
        this.camera.position.addScaledVector(move.normalize(), this.cameraSpeed * boost * dt);
      }
    }

    for (const e of this.entries.values()) e.node.instance?.update?.(dt, t, this.simulating);
    if (this.runtime) {
      this.runtime.update(dt);
      if (this.selBoxes.children.length) this.updateSelectionVisuals();
    }
    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.message.classList.add('hidden');
    }

    const p = this.camera.position;
    this.info.textContent = `${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}  ·  Kamera ${this.speedIndex + 1}`;

    this.renderer.clear();
    this.composer.render(dt);
    this.renderer.clearDepth();
    this.renderer.render(this.overlay, this.camera);
  }
}
