import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { h } from '../ui.ts';
import { buildGeometry } from './build.ts';
import { objectMatrix, type MObject } from './doc.ts';
import { mirrorCopies } from './ops.ts';
import { ek, ekA, ekB } from './mesh.ts';
import type { SelMode, Selection } from './ops.ts';

// 3D-Ansicht des Modelers: eigene Szene & Kamera (Orbit wie Blender), Objekte, Edit-Overlays
// (Kanten, Punkte, gewählte Flächen), Auswahl per Klick/Rahmen mit Sichtbarkeitsprüfung, Gizmo, Achsen-Kreuz.

export type ViewName = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';

interface ObjView {
  mesh: THREE.Mesh;
  triFace: Int32Array;
  bvhDirty: boolean;
  /** Live-Spiegel: gespiegelte Hälfte(n), nur Anzeige (nicht anklickbar) */
  mirror: THREE.Mesh | null;
}

export interface ViewHandlers {
  /** Linke Maustaste (nicht Navigation, nicht Gizmo) */
  down(e: PointerEvent, x: number, y: number): void;
  move(e: PointerEvent, x: number, y: number): void;
  up(e: PointerEvent, x: number, y: number): void;
  /** Rechtsklick ohne Ziehen */
  context(e: PointerEvent, x: number, y: number): void;
  /** Kamera bewegt (für Anzeigen) */
  camera?(): void;
}

const SEL = new THREE.Color('#ffa500');
const SEL_ACTIVE = new THREE.Color('#ffd27a');
const WIRE = new THREE.Color('#0b0b0b');
const WIRE_XRAY = new THREE.Color('#9a9a9a');

export class ModelView {
  readonly canvas: HTMLCanvasElement;
  /** Ansichtsname (links oben) und frei belegbare Statistik-Zeile */
  readonly viewLabel = h('b', {});
  readonly stats = h('span', {});
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly persp = new THREE.PerspectiveCamera(40, 1, 0.01, 2000);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  cam: THREE.Camera = this.persp;
  orthoMode = false;
  /** Orbit */
  target = new THREE.Vector3(0, 0.5, 0);
  dist = 4.5;
  yaw = Math.PI / 4;
  pitch = 0.5;
  xray = false;

  readonly objRoot = new THREE.Group();
  readonly overlay = new THREE.Group();
  readonly gizmo: TransformControls;
  readonly gizmoTarget = new THREE.Object3D();
  private views = new Map<string, ObjView>();
  private edgeLines: THREE.LineSegments;
  private points: THREE.Points;
  private faceSel: THREE.Mesh;
  private outlines = new THREE.Group();
  private grid = new THREE.Group();
  private nav: HTMLCanvasElement;
  private marquee: HTMLDivElement;
  readonly info: HTMLDivElement;
  readonly hud: HTMLDivElement;
  private running = false;
  private raycaster = new THREE.Raycaster();
  handlers: ViewHandlers | null = null;
  /** zuletzt gezeichneter Edit-Overlay-Zustand */
  private editObj: MObject | null = null;
  private viewName = 'Perspektive';

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    container.append(this.canvas);
    this.scene.background = new THREE.Color('#3a3a3a');
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    // Studio-Licht an der Kamera (wie Blenders Solid-Ansicht: Formen von jeder Seite lesbar)
    const key = new THREE.DirectionalLight('#ffffff', 1.6);
    key.position.set(-2, 3, 4);
    key.target.position.set(0, 0, -1);
    this.persp.add(key, key.target);
    const keyO = key.clone();
    keyO.target.position.set(0, 0, -1);
    this.ortho.add(keyO, keyO.target);
    this.scene.add(this.persp, this.ortho, new THREE.HemisphereLight('#ffffff', '#555555', 0.9));

    this.buildGrid();
    this.scene.add(this.grid, this.objRoot, this.overlay, this.outlines);

    // Edit-Overlays
    this.edgeLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }));
    this.points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true, toneMapped: false }));
    this.faceSel = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: SEL, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, toneMapped: false }),
    );
    for (const o of [this.edgeLines, this.points, this.faceSel]) {
      o.frustumCulled = false;
      o.renderOrder = 5;
    }
    this.points.renderOrder = 6;
    this.overlay.add(this.faceSel, this.edgeLines, this.points);
    this.overlay.matrixAutoUpdate = false;

    this.gizmo = new TransformControls(this.cam, this.canvas);
    this.gizmo.setSize(0.85);
    this.scene.add(this.gizmo.getHelper(), this.gizmoTarget);

    this.nav = h('canvas', { class: 'md-nav', width: 96, height: 96 });
    this.marquee = h('div', { class: 'md-marquee hidden' });
    this.info = h('div', { class: 'md-info' }, this.viewLabel, this.stats);
    this.hud = h('div', { class: 'md-hud hidden' });
    container.append(this.nav, this.marquee, this.info, this.hud);
    this.bindInput();
    this.bindNav();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.updateCamera();
  }

  private buildGrid(): void {
    const g = new THREE.GridHelper(40, 40, '#5a5a5a', '#474747');
    (g.material as THREE.Material).depthWrite = false;
    const fine = new THREE.GridHelper(4, 40, '#4c4c4c', '#424242');
    (fine.material as THREE.Material).depthWrite = false;
    fine.position.y = -0.0005;
    const axis = (a: THREE.Vector3, b: THREE.Vector3, c: string) => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: c, toneMapped: false }));
      l.position.y = 0.0005;
      return l;
    };
    this.grid.add(fine, g, axis(new THREE.Vector3(-20, 0, 0), new THREE.Vector3(20, 0, 0), '#c8424b'), axis(new THREE.Vector3(0, 0, -20), new THREE.Vector3(0, 0, 20), '#4a7fcf'));
  }

  // ---------- Kamera ----------

  updateCamera(): void {
    const off = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch)).multiplyScalar(this.dist);
    for (const c of [this.persp, this.ortho]) {
      c.position.copy(this.target).add(off);
      c.up.set(0, 1, 0);
      if (Math.abs(Math.cos(this.pitch)) < 1e-4) c.up.set(-Math.sin(this.yaw) * Math.sign(this.pitch), 0, -Math.cos(this.yaw) * Math.sign(this.pitch));
      c.lookAt(this.target);
    }
    const w = this.canvas.clientWidth || 1;
    const ht = this.canvas.clientHeight || 1;
    const half = this.dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    this.ortho.left = (-half * w) / ht;
    this.ortho.right = (half * w) / ht;
    this.ortho.top = half;
    this.ortho.bottom = -half;
    this.ortho.near = -this.dist * 50 - 100;
    this.ortho.far = this.dist * 50 + 100;
    this.ortho.updateProjectionMatrix();
    this.persp.near = Math.max(0.001, this.dist / 1000);
    this.persp.far = Math.max(200, this.dist * 100);
    this.persp.updateProjectionMatrix();
    this.cam = this.orthoMode ? this.ortho : this.persp;
    this.gizmo.camera = this.cam;
    this.viewLabel.textContent = `${this.viewName}${this.orthoMode ? ' (Orthografisch)' : ''}`;
    this.handlers?.camera?.();
  }

  setView(v: ViewName): void {
    const map: Record<ViewName, [number, number, string]> = {
      front: [0, 0, 'Vorne'],
      back: [Math.PI, 0, 'Hinten'],
      right: [Math.PI / 2, 0, 'Rechts'],
      left: [-Math.PI / 2, 0, 'Links'],
      top: [0, Math.PI / 2, 'Oben'],
      bottom: [0, -Math.PI / 2, 'Unten'],
    };
    const [yaw, pitch, name] = map[v];
    this.yaw = yaw;
    this.pitch = pitch;
    this.viewName = name;
    this.wasAutoOrtho = this.wasAutoOrtho || !this.orthoMode;
    this.orthoMode = true;
    this.updateCamera();
  }

  toggleOrtho(): void {
    this.orthoMode = !this.orthoMode;
    this.wasAutoOrtho = false;
    this.updateCamera();
  }

  /** Box (Welt) einpassen */
  frame(box: THREE.Box3): void {
    if (box.isEmpty()) return;
    const s = box.getBoundingSphere(new THREE.Sphere());
    this.target.copy(s.center);
    this.dist = Math.max(0.3, (Math.max(s.radius, 0.05) / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2))) * 1.1);
    this.updateCamera();
  }

  private orbit(dx: number, dy: number): void {
    this.yaw -= dx * 0.008;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.008, -Math.PI / 2, Math.PI / 2);
    this.viewName = 'Benutzer';
    if (this.orthoMode && this.wasAutoOrtho) this.orthoMode = false;
    this.wasAutoOrtho = false;
    this.updateCamera();
  }
  private wasAutoOrtho = false;

  private pan(dx: number, dy: number): void {
    const h = this.canvas.clientHeight || 1;
    const scale = (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))) / h;
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
    this.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    this.updateCamera();
  }

  zoom(f: number): void {
    this.dist = THREE.MathUtils.clamp(this.dist * f, 0.05, 500);
    this.updateCamera();
  }

  // ---------- Eingabe ----------

  private bindInput(): void {
    const c = this.canvas;
    let nav: { mode: 'orbit' | 'pan' | 'zoom'; x: number; y: number; moved: number; button: number } | null = null;
    let left = false;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      const { x, y } = this.local(e);
      // Navigation: mittlere Taste (wie Blender) oder rechte Taste ziehen; Alt+Klick bleibt für Schleifen frei
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        const mode = e.shiftKey ? 'pan' : e.ctrlKey ? 'zoom' : 'orbit';
        nav = { mode, x: e.clientX, y: e.clientY, moved: 0, button: e.button };
        c.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      if (this.gizmo.dragging || (this.gizmo.enabled && this.gizmo.object && this.gizmo.axis !== null)) return;
      left = true;
      c.setPointerCapture(e.pointerId);
      this.handlers?.down(e, x, y);
    });
    c.addEventListener('pointermove', (e) => {
      const { x, y } = this.local(e);
      if (nav) {
        const dx = e.clientX - nav.x;
        const dy = e.clientY - nav.y;
        nav.x = e.clientX;
        nav.y = e.clientY;
        nav.moved += Math.abs(dx) + Math.abs(dy);
        if (nav.button === 2 && nav.moved < 4) return;
        if (nav.mode === 'orbit') this.orbit(dx, dy);
        else if (nav.mode === 'pan') this.pan(dx, dy);
        else this.zoom(Math.pow(1.01, dy));
        return;
      }
      this.handlers?.move(e, x, y);
    });
    const end = (e: PointerEvent) => {
      const { x, y } = this.local(e);
      if (nav) {
        const wasClick = nav.button === 2 && nav.moved < 4;
        nav = null;
        if (wasClick) this.handlers?.context(e, x, y);
        return;
      }
      if (left) {
        left = false;
        this.handlers?.up(e, x, y);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey) this.pan(-e.deltaX * 0.5, 0);
        this.zoom(Math.pow(1.0015, e.deltaY * (e.deltaMode === 1 ? 30 : 1)));
      },
      { passive: false },
    );
  }

  private bindNav(): void {
    let drag: { x: number; y: number; moved: number } | null = null;
    this.nav.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
      this.nav.setPointerCapture(e.pointerId);
    });
    this.nav.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 3) this.orbit(dx, dy);
    });
    this.nav.addEventListener('pointerup', (e) => {
      const d = drag;
      drag = null;
      if (!d || d.moved > 3) return;
      const r = this.nav.getBoundingClientRect();
      const hit = this.navHit(e.clientX - r.left, e.clientY - r.top);
      if (hit) this.setView(hit);
    });
  }

  private navDots(): { v: ViewName; label: string; color: string; x: number; y: number; z: number; pos: boolean }[] {
    const cam = this.cam;
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const fwd = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2);
    const R = 34;
    const items: [THREE.Vector3, ViewName, string, string, boolean][] = [
      [new THREE.Vector3(1, 0, 0), 'right', 'X', '#e0525c', true],
      [new THREE.Vector3(-1, 0, 0), 'left', '', '#8a3a40', false],
      [new THREE.Vector3(0, 1, 0), 'top', 'Y', '#6cbf4a', true],
      [new THREE.Vector3(0, -1, 0), 'bottom', '', '#46752f', false],
      [new THREE.Vector3(0, 0, 1), 'front', 'Z', '#4a86e0', true],
      [new THREE.Vector3(0, 0, -1), 'back', '', '#30558c', false],
    ];
    return items.map(([d, v, label, color, pos]) => ({ v, label, color, pos, x: 48 + d.dot(right) * R, y: 48 - d.dot(up) * R, z: d.dot(fwd) }));
  }

  private navHit(x: number, y: number): ViewName | null {
    let best: ViewName | null = null;
    let bd = 11 * 11;
    for (const d of this.navDots().sort((a, b) => b.z - a.z)) {
      const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (dd < bd) {
        bd = dd;
        best = d.v;
      }
    }
    return best;
  }

  private drawNav(): void {
    const ctx = this.nav.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 96, 96);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.arc(48, 48, 46, 0, Math.PI * 2);
    ctx.fill();
    for (const d of this.navDots().sort((a, b) => a.z - b.z)) {
      if (d.pos) {
        ctx.strokeStyle = d.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(48, 48);
        ctx.lineTo(d.x, d.y);
        ctx.stroke();
      }
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.pos ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      if (d.label) {
        ctx.fillStyle = '#111';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(d.label, d.x, d.y + 0.5);
      }
    }
  }

  local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  showMarquee(x0: number, y0: number, x1: number, y1: number): void {
    const s = this.marquee.style;
    s.left = `${Math.min(x0, x1)}px`;
    s.top = `${Math.min(y0, y1)}px`;
    s.width = `${Math.abs(x1 - x0)}px`;
    s.height = `${Math.abs(y1 - y0)}px`;
    this.marquee.classList.remove('hidden');
  }

  hideMarquee(): void {
    this.marquee.classList.add('hidden');
  }

  // ---------- Darstellung ----------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateCamera();
  }

  private render(): void {
    // Raster ausblenden, wenn von unten/der Seite in Ortho geschaut wird
    this.grid.visible = !(this.orthoMode && Math.abs(this.pitch) < 1e-3);
    this.renderer.render(this.scene, this.cam);
    this.drawNav();
  }

  /** Objekt (neu) aufbauen; materials = Anzeige-Materialien je Slot */
  syncObject(o: MObject, materials: THREE.Material[]): void {
    let v = this.views.get(o.id);
    const built = buildGeometry(o.mesh, { smooth: o.smooth, smoothAngle: o.smoothAngle, uvScale: (i) => (materials[i]?.userData.uvScale as number) ?? 1, uvMatrix: objectMatrix(o) });
    if (!v) {
      const mesh = new THREE.Mesh(built.geometry, materials);
      mesh.raycast = acceleratedRaycast;
      mesh.userData.objectId = o.id;
      this.objRoot.add(mesh);
      v = { mesh, triFace: built.triFace, bvhDirty: true, mirror: null };
      this.views.set(o.id, v);
    } else {
      v.mesh.geometry.dispose();
      v.mesh.geometry = built.geometry;
      v.mesh.material = materials;
      v.triFace = built.triFace;
      v.bvhDirty = true;
    }
    const copies = o.mesh.faces.length ? mirrorCopies(o.mesh, o.mirror) : null;
    if (copies) {
      const mb = buildGeometry(copies, { smooth: o.smooth, smoothAngle: o.smoothAngle, uvScale: (i) => (materials[i]?.userData.uvScale as number) ?? 1, uvMatrix: objectMatrix(o) });
      if (!v.mirror) {
        v.mirror = new THREE.Mesh(mb.geometry, materials);
        v.mirror.raycast = () => {};
        v.mesh.add(v.mirror);
      } else {
        v.mirror.geometry.dispose();
        v.mirror.geometry = mb.geometry;
        v.mirror.material = materials;
      }
    } else if (v.mirror) {
      v.mirror.geometry.dispose();
      v.mesh.remove(v.mirror);
      v.mirror = null;
    }
    this.syncTransform(o);
  }

  syncTransform(o: MObject): void {
    const v = this.views.get(o.id);
    if (!v) return;
    v.mesh.position.copy(o.pos);
    v.mesh.rotation.copy(o.rot);
    v.mesh.scale.copy(o.scale);
    v.mesh.visible = o.visible;
    v.mesh.updateMatrixWorld(true);
    if (this.editObj === o) {
      this.overlay.matrix.copy(v.mesh.matrixWorld);
      this.overlay.matrixWorldNeedsUpdate = true;
    }
  }

  /** Objekte entfernen, die es nicht mehr gibt */
  prune(ids: Set<string>): void {
    for (const [id, v] of this.views) {
      if (ids.has(id)) continue;
      v.mesh.geometry.dispose();
      v.mirror?.geometry.dispose();
      this.objRoot.remove(v.mesh);
      this.views.delete(id);
    }
  }

  meshOf(id: string): THREE.Mesh | null {
    return this.views.get(id)?.mesh ?? null;
  }

  setMaterials(materials: THREE.Material[]): void {
    for (const v of this.views.values()) {
      v.mesh.material = materials;
      if (v.mirror) v.mirror.material = materials;
    }
  }

  /** Umrisse der gewählten Objekte (Objektmodus) */
  setObjectOutlines(objs: MObject[], active: MObject | null): void {
    for (const c of [...this.outlines.children]) {
      (c as THREE.LineSegments).geometry.dispose();
      this.outlines.remove(c);
    }
    for (const o of objs) {
      if (!o.visible) continue;
      const pos: number[] = [];
      const m = o.mesh;
      for (const k of m.allEdges()) {
        const a = m.verts[ekA(k)];
        const b = m.verts[ekB(k)];
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: o === active ? SEL_ACTIVE : SEL, toneMapped: false, transparent: true, opacity: 0.9 }));
      l.matrixAutoUpdate = false;
      l.matrix.copy(objectMatrix(o));
      l.renderOrder = 4;
      this.outlines.add(l);
    }
  }

  /** Edit-Overlays für das bearbeitete Objekt (null = aus) */
  setEdit(o: MObject | null, sel: Selection | null, mode: SelMode): void {
    this.editObj = o;
    this.overlay.visible = !!o;
    if (!o || !sel) return;
    const m = o.mesh;
    this.overlay.matrix.copy(objectMatrix(o));
    this.overlay.matrixWorldNeedsUpdate = true;
    const wire = this.xray ? WIRE_XRAY : WIRE;
    // Kanten
    const edges = m.allEdges();
    const ep = new Float32Array(edges.length * 6);
    const ec = new Float32Array(edges.length * 6);
    edges.forEach((k, i) => {
      const a = m.verts[ekA(k)];
      const b = m.verts[ekB(k)];
      ep.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      const col = sel.e.has(k) ? SEL : wire;
      ec.set([col.r, col.g, col.b, col.r, col.g, col.b], i * 6);
    });
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
    eg.setAttribute('color', new THREE.BufferAttribute(ec, 3));
    this.edgeLines.geometry.dispose();
    this.edgeLines.geometry = eg;
    // Punkte (nur im Punkt-Modus)
    const pg = new THREE.BufferGeometry();
    if (mode === 'v') {
      const pp = new Float32Array(m.verts.length * 3);
      const pc = new Float32Array(m.verts.length * 3);
      m.verts.forEach((p, i) => {
        pp.set([p.x, p.y, p.z], i * 3);
        const col = sel.v.has(i) ? SEL : wire;
        pc.set([col.r, col.g, col.b], i * 3);
      });
      pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
      pg.setAttribute('color', new THREE.BufferAttribute(pc, 3));
    }
    this.points.geometry.dispose();
    this.points.geometry = pg;
    // gewählte Flächen
    const fp: number[] = [];
    for (const fi of sel.f) {
      const f = m.faces[fi];
      if (!f) continue;
      const a = m.verts[f.v[0]];
      for (let i = 1; i + 1 < f.v.length; i++) {
        const b = m.verts[f.v[i]];
        const c = m.verts[f.v[i + 1]];
        fp.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    this.faceSel.geometry.dispose();
    this.faceSel.geometry = fg;
    for (const mat of [this.edgeLines.material, this.points.material, this.faceSel.material] as THREE.Material[]) mat.depthTest = !this.xray;
  }

  // ---------- Picking ----------

  ray(x: number, y: number): THREE.Ray {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.raycaster.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), this.cam);
    return this.raycaster.ray.clone();
  }

  /** Welt → Bildschirm (Pixel), z = Tiefe (NDC) */
  project(p: THREE.Vector3): THREE.Vector3 {
    const v = p.clone().project(this.cam);
    return new THREE.Vector3(((v.x + 1) / 2) * this.canvas.clientWidth, ((1 - v.y) / 2) * this.canvas.clientHeight, v.z);
  }

  private ensureBvh(v: ObjView): void {
    if (!v.bvhDirty) return;
    v.mesh.geometry.boundsTree = new MeshBVH(v.mesh.geometry);
    v.bvhDirty = false;
  }

  private hitMeshes(x: number, y: number, only?: string): THREE.Intersection[] {
    const meshes: THREE.Mesh[] = [];
    for (const [id, v] of this.views) {
      if (!v.mesh.visible || (only && id !== only)) continue;
      this.ensureBvh(v);
      meshes.push(v.mesh);
    }
    this.ray(x, y);
    return this.raycaster.intersectObjects(meshes, false);
  }

  pickObject(x: number, y: number): string | null {
    const hit = this.hitMeshes(x, y)[0];
    return (hit?.object.userData.objectId as string) ?? null;
  }

  /** Oberflächenpunkt unter der Maus (Welt) */
  pickSurface(x: number, y: number): THREE.Vector3 | null {
    return this.hitMeshes(x, y)[0]?.point.clone() ?? null;
  }

  pickFace(o: MObject, x: number, y: number): number {
    const v = this.views.get(o.id);
    const hit = this.hitMeshes(x, y, o.id)[0];
    if (!v || !hit || hit.faceIndex === undefined || hit.faceIndex === null) return -1;
    return v.triFace[hit.faceIndex] ?? -1;
  }

  /** Ist ein Weltpunkt von der Kamera aus sichtbar (nicht durch Objekte verdeckt)? */
  visible(p: THREE.Vector3): boolean {
    if (this.xray) return true;
    const origin = this.orthoMode
      ? p.clone().addScaledVector(new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 2), this.dist * 50)
      : this.cam.position.clone();
    const dir = p.clone().sub(origin);
    const len = dir.length();
    if (len < 1e-6) return true;
    this.raycaster.set(origin, dir.divideScalar(len));
    this.raycaster.far = len;
    const meshes: THREE.Mesh[] = [];
    for (const v of this.views.values()) {
      if (!v.mesh.visible) continue;
      this.ensureBvh(v);
      meshes.push(v.mesh);
    }
    this.raycaster.firstHitOnly = true;
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    this.raycaster.firstHitOnly = false;
    this.raycaster.far = Infinity;
    return !hit || hit.distance >= len - Math.max(1e-3, len * 2e-3);
  }

  pickVert(o: MObject, x: number, y: number, px = 14): number {
    const mat = objectMatrix(o);
    let best = -1;
    let bd = px * px;
    const p = new THREE.Vector3();
    const cand: { i: number; d: number }[] = [];
    o.mesh.verts.forEach((v, i) => {
      p.copy(v).applyMatrix4(mat);
      const s = this.project(p);
      if (s.z > 1 || s.z < -1) return;
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bd * 4) cand.push({ i, d });
    });
    cand.sort((a, b) => a.d - b.d);
    for (const c of cand) {
      if (c.d > bd) break;
      if (this.visible(p.copy(o.mesh.verts[c.i]).applyMatrix4(mat))) {
        best = c.i;
        bd = c.d;
        break;
      }
    }
    return best;
  }

  pickEdge(o: MObject, x: number, y: number, px = 10): number {
    const mat = objectMatrix(o);
    const ws = o.mesh.verts.map((v) => v.clone().applyMatrix4(mat));
    const sp = ws.map((w) => this.project(w));
    const cand: { k: number; d: number; t: number }[] = [];
    for (const k of o.mesh.allEdges()) {
      const a = sp[ekA(k)];
      const b = sp[ekB(k)];
      if (a.z > 1 || b.z > 1) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (y - a.y) * dy) / l2, 0, 1);
      const d = (a.x + dx * t - x) ** 2 + (a.y + dy * t - y) ** 2;
      if (d <= px * px) cand.push({ k, d, t });
    }
    cand.sort((a, b) => a.d - b.d);
    for (const c of cand) {
      const pt = ws[ekA(c.k)].clone().lerp(ws[ekB(c.k)], c.t);
      if (this.visible(pt)) return c.k;
    }
    return -1;
  }

  /** Rahmen-Auswahl im Edit-Modus */
  boxSelect(o: MObject, x0: number, y0: number, x1: number, y1: number, mode: SelMode): number[] {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const mat = objectMatrix(o);
    const m = o.mesh;
    const ws = m.verts.map((v) => v.clone().applyMatrix4(mat));
    const inside = (p: THREE.Vector3) => {
      const s = this.project(p);
      return s.z <= 1 && s.z >= -1 && s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
    };
    const visCache = new Map<number, boolean>();
    const vis = (i: number) => {
      let r = visCache.get(i);
      if (r === undefined) visCache.set(i, (r = this.visible(ws[i])));
      return r;
    };
    if (mode === 'v') return ws.map((_, i) => i).filter((i) => inside(ws[i]) && vis(i));
    if (mode === 'e') {
      return m.allEdges().filter((k) => {
        const a = ekA(k);
        const b = ekB(k);
        return inside(ws[a]) && inside(ws[b]) && (vis(a) || vis(b) || this.visible(ws[a].clone().lerp(ws[b], 0.5)));
      });
    }
    const c = new THREE.Vector3();
    const out: number[] = [];
    m.faces.forEach((_, fi) => {
      m.faceCenter(fi, c).applyMatrix4(mat);
      if (!inside(c)) return;
      if (this.xray || this.visible(c.clone().addScaledVector(this.faceWorldNormal(o, fi, mat), 1e-3))) out.push(fi);
    });
    return out;
  }

  private faceWorldNormal(o: MObject, fi: number, mat: THREE.Matrix4): THREE.Vector3 {
    return o.mesh.faceNormal(fi).transformDirection(mat);
  }

  /** Objekte im Rahmen (Objektmodus) */
  boxObjects(objs: MObject[], x0: number, y0: number, x1: number, y1: number): string[] {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const out: string[] = [];
    const p = new THREE.Vector3();
    for (const o of objs) {
      if (!o.visible) continue;
      const mat = objectMatrix(o);
      if (o.mesh.verts.some((v) => {
        const s = this.project(p.copy(v).applyMatrix4(mat));
        return s.z <= 1 && s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
      }))
        out.push(o.id);
    }
    return out;
  }

  /** Kante unter der Maus für Schleifen-Auswahl: liefert Kantenschlüssel */
  nearestEdgeKey(o: MObject, x: number, y: number): number {
    const k = this.pickEdge(o, x, y, 18);
    if (k >= 0) return k;
    // Fläche treffen und deren nächste Kante nehmen
    const fi = this.pickFace(o, x, y);
    if (fi < 0) return -1;
    const mat = objectMatrix(o);
    const f = o.mesh.faces[fi].v;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < f.length; i++) {
      const a = this.project(o.mesh.verts[f[i]].clone().applyMatrix4(mat));
      const b = this.project(o.mesh.verts[f[(i + 1) % f.length]].clone().applyMatrix4(mat));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      const d = (a.x + dx * t - x) ** 2 + (a.y + dy * t - y) ** 2;
      if (d < bd) {
        bd = d;
        best = ek(f[i], f[(i + 1) % f.length]);
      }
    }
    return best;
  }

  /** Blickrichtung (Welt, von der Kamera weg) */
  viewDir(): THREE.Vector3 {
    return new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 2).negate();
  }

  private lineSets = new Map<string, THREE.LineSegments>();

  /** Hilfslinien in Weltkoordinaten (Loop-Cut-Vorschau, Kollisionsform); leere Liste = aus */
  setLines(name: string, positions: number[], color: string, onTop = true): void {
    let l = this.lineSets.get(name);
    if (!positions.length) {
      if (l) l.visible = false;
      return;
    }
    if (!l) {
      l = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ toneMapped: false, transparent: true }));
      l.frustumCulled = false;
      l.renderOrder = 8;
      this.scene.add(l);
      this.lineSets.set(name, l);
    }
    const mat = l.material as THREE.LineBasicMaterial;
    mat.color.set(color);
    mat.depthTest = !onTop;
    l.geometry.dispose();
    l.geometry = new THREE.BufferGeometry();
    l.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    l.visible = true;
  }

  setXray(v: boolean): void {
    this.xray = v;
  }

  dispose(): void {
    this.stop();
    this.gizmo.dispose();
    this.renderer.dispose();
  }
}
