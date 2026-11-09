import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { MATERIAL_OPTIONS, defaultColorFor } from '../../world/materials.ts';
import { MODELER_PREFIX, listImportedModels, modelLabel } from '../../world/modelStore.ts';
import { models } from '../models.ts';
import { closeMenus, confirmDialog, fmt, h, iconEl, isMenuOpen, numberField, pickFile, promptText, showMenu, toast, type MenuItem } from '../ui.ts';
import { slotMaterial } from './build.ts';
import { BOOL_OPS, booleanMesh, type BoolOp } from './boolean.ts';
import {
  COLLISION_OPTIONS,
  History,
  defaultSlot,
  docFromJSON,
  docToJSON,
  newDoc,
  newObject,
  objectMatrix,
  type MObject,
  type ModelCollision,
  type ModelDoc,
  type Snapshot,
} from './doc.ts';
import { docFromGlb, download, exportGlb, loadDoc, refForName, saveDoc } from './io.ts';
import { EditMesh, PRIMITIVES, ek, ekA, ekB, makePrimitive, primitiveDefaults, primitiveHalfHeight, type PrimitiveKind } from './mesh.ts';
import * as ops from './ops.ts';
import type { SelMode, Selection } from './ops.ts';
import { ModelView, type ViewName } from './view.ts';

// Modeler: Polygon-Modellierung wie in Blender, in einem eigenen Tab des Editors.
// Objektmodus (Objekte anordnen, verbinden, Boolean) und Bearbeitungsmodus (Punkte/Kanten/Flächen,
// Extrudieren, Inset, Abschrägen, Loop Cut …). Gespeichert wird als .glb im Content Browser (Modelle/Eigene).

export interface ModelerHost {
  status(msg: string, err?: boolean): void;
  /** Name/ungespeicherte Änderungen für den Tab */
  title(name: string, dirty: boolean): void;
  /** Modell wurde gespeichert (Content Browser & Level aktualisieren) */
  saved(ref: string): void;
  /** Modell im Level platzieren (wechselt zum Level-Tab) */
  place(ref: string): void;
}

type Tool = 'select' | 'move' | 'rotate' | 'scale' | 'loopcut';

interface EditState {
  mode: 'object' | 'edit';
  selMode: SelMode;
  active: string | null;
  selected: string[];
  v: number[];
  e: number[];
  f: number[];
}

interface OpField {
  key: string;
  label: string;
  type: 'number' | 'int' | 'bool' | 'select';
  step?: number;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}
type OpValues = Record<string, number | boolean | string>;

interface LastOp {
  title: string;
  fields: OpField[];
  values: OpValues;
  before: Snapshot;
  run(v: OpValues): void;
}

type ModalKind = 'grab' | 'rotate' | 'scale' | 'inset' | 'bevel';

interface Modal {
  kind: ModalKind;
  title: string;
  x0: number;
  y0: number;
  x: number;
  y: number;
  ctrl: boolean;
  shift: boolean;
  pivot: THREE.Vector3;
  axis: THREE.Vector3 | null;
  axisName: string;
  /** feste Richtung (z. B. Normale beim Extrudieren), solange keine Achse gewählt ist */
  normal: THREE.Vector3 | null;
  typed: string;
  baseVerts: Map<number, THREE.Vector3> | null;
  baseObjs: Map<string, THREE.Matrix4> | null;
  baseMesh: EditMesh | null;
  baseSel: Selection | null;
  before: Snapshot;
  individual: boolean;
  /** Ergebnis für das Redo-Panel */
  result: { T: THREE.Matrix4; value: number; delta: THREE.Vector3 };
  /** nach Bestätigen als Operation festhalten (Extrudieren/Duplizieren) */
  wrap?: { title: string; prepare(): void };
}

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const AXIS_NAMES = ['X', 'Y', 'Z'];
const DEG = Math.PI / 180;

export class Modeler {
  readonly el: HTMLElement;
  doc: ModelDoc = newDoc();
  private history = new History();
  readonly view: ModelView;
  private mode: 'object' | 'edit' = 'object';
  private selMode: SelMode = 'f';
  private activeId: string | null = null;
  private selected = new Set<string>();
  private sel: Selection = ops.emptySel();
  private tool: Tool = 'select';
  private dirty = false;
  private active = false;
  private displayMats: THREE.Material[] = [];
  private modal: Modal | null = null;
  private lastOp: LastOp | null = null;
  private activeSlot = 0;
  private snapOn = false;
  private showCollision = false;
  private mouse = { x: 0, y: 0, inside: false };
  private drag: { x0: number; y0: number; shift: boolean; ctrl: boolean; alt: boolean; boxing: boolean } | null = null;
  private gizmoBase: { verts: Map<number, THREE.Vector3> | null; objs: Map<string, THREE.Matrix4> | null; pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3; before: Snapshot } | null = null;
  private loopHover = -1;

  // UI
  private toolbar: HTMLElement;
  private shelf: HTMLElement;
  private side: HTMLElement;
  private redoPanel: HTMLElement;
  private vpEl: HTMLElement;
  private collapsed = new Set<string>();

  constructor(
    root: HTMLElement,
    private host: ModelerHost,
  ) {
    this.el = root;
    root.classList.add('modeler');
    this.toolbar = h('div', { class: 'md-toolbar' });
    this.shelf = h('div', { class: 'md-shelf' });
    this.vpEl = h('div', { class: 'md-viewport' });
    this.side = h('div', { class: 'md-side panel' });
    this.redoPanel = h('div', { class: 'md-redo hidden' });
    root.append(this.toolbar, h('div', { class: 'md-main' }, this.shelf, this.vpEl, this.side));
    this.view = new ModelView(this.vpEl);
    this.vpEl.append(this.redoPanel);
    this.view.handlers = {
      down: (e, x, y) => this.onDown(e, x, y),
      move: (e, x, y) => this.onMove(e, x, y),
      up: (e, x, y) => this.onUp(e, x, y),
      context: (e, x, y) => this.onContext(e, x, y),
    };
    this.vpEl.addEventListener('pointerenter', () => (this.mouse.inside = true));
    this.vpEl.addEventListener('pointerleave', () => (this.mouse.inside = false));
    this.bindGizmo();
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('pointermove', (e) => {
      if (!this.modal) return;
      const p = this.view.local(e);
      this.modal.x = p.x;
      this.modal.y = p.y;
      this.modal.ctrl = e.ctrlKey;
      this.modal.shift = e.shiftKey;
      this.modalUpdate();
    });
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.modal) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.button === 0) this.modalEnd(true);
        else if (e.button === 2) this.modalEnd(false);
      },
      true,
    );
    this.loadDoc(newDoc(), true);
  }

  // ---------- Öffentliche Steuerung ----------

  get isDirty(): boolean {
    return this.dirty;
  }

  get name(): string {
    return this.doc.name;
  }

  activate(): void {
    this.active = true;
    this.view.start();
    this.view.canvas.focus();
  }

  deactivate(): void {
    if (this.modal) this.modalEnd(false);
    this.active = false;
    this.view.stop();
    closeMenus();
  }

  /** Neues, leeres Modell (Würfel) */
  newModel(name = 'Neues Modell'): void {
    this.loadDoc(newDoc(name), true);
  }

  /** Modell aus dem Content Browser öffnen */
  async open(ref: string): Promise<boolean> {
    this.host.status(`Lade ${modelLabel(ref)} …`);
    const doc = await loadDoc(ref).catch((e) => {
      console.error(e);
      return null;
    });
    if (!doc) {
      this.host.status(`Modell ${modelLabel(ref)} konnte nicht geladen werden`, true);
      return false;
    }
    this.loadDoc(doc, true);
    this.host.status(ref.startsWith(MODELER_PREFIX) ? `Modell „${doc.name}“ geöffnet` : `„${doc.name}“ übernommen — Speichern legt es unter Modelle/Eigene ab`);
    return true;
  }

  private loadDoc(doc: ModelDoc, frame: boolean): void {
    this.doc = doc;
    this.mode = 'object';
    this.selected = new Set(doc.objects.length ? [doc.objects[0].id] : []);
    this.activeId = doc.objects[0]?.id ?? null;
    this.sel = ops.emptySel();
    this.lastOp = null;
    this.activeSlot = 0;
    this.setDirty(false);
    this.rebuildMaterials();
    this.rebuildAll();
    this.history.reset(this.snap('Öffnen'));
    if (frame) this.frameAll();
    this.refresh();
  }

  // ---------- Zustand & Historie ----------

  private get activeObj(): MObject | null {
    return this.doc.objects.find((o) => o.id === this.activeId) ?? null;
  }

  private get selectedObjs(): MObject[] {
    return this.doc.objects.filter((o) => this.selected.has(o.id));
  }

  private editState(): EditState {
    return { mode: this.mode, selMode: this.selMode, active: this.activeId, selected: [...this.selected], v: [...this.sel.v], e: [...this.sel.e], f: [...this.sel.f] };
  }

  private snap(label: string): Snapshot {
    return { doc: JSON.stringify(docToJSON(this.doc)), state: JSON.stringify(this.editState()), label };
  }

  private restore(s: Snapshot): void {
    const ref = this.doc.ref;
    this.doc = docFromJSON(JSON.parse(s.doc));
    this.doc.ref = ref;
    const st = JSON.parse(s.state) as EditState;
    this.mode = st.mode;
    this.selMode = st.selMode;
    this.activeId = st.active;
    this.selected = new Set(st.selected);
    this.sel = { v: new Set(st.v), e: new Set(st.e), f: new Set(st.f) };
    if (!this.activeObj) this.mode = 'object';
    this.rebuildMaterials();
    this.rebuildAll();
  }

  /** Änderung abschließen: Historie, Anzeige, Tab-Titel */
  private commit(label: string, keepOp = false): void {
    if (!keepOp) this.lastOp = null;
    this.history.push(this.snap(label));
    this.setDirty(true);
    this.refresh();
  }

  private setDirty(v: boolean): void {
    this.dirty = v;
    this.host.title(this.doc.name, v);
  }

  undo(): void {
    if (this.modal) return;
    const s = this.history.undo();
    if (!s) return this.host.status('Nichts rückgängig zu machen');
    this.restore(s);
    this.lastOp = null;
    this.setDirty(true);
    this.refresh();
    this.host.status(`Rückgängig: ${s.label}`);
  }

  redo(): void {
    if (this.modal) return;
    const s = this.history.redo();
    if (!s) return this.host.status('Nichts zu wiederholen');
    this.restore(s);
    this.lastOp = null;
    this.setDirty(true);
    this.refresh();
    this.host.status(`Wiederholen: ${s.label}`);
  }

  /** Operation mit Parametern ausführen (Redo-Panel erlaubt nachträgliches Ändern) */
  private runOp(title: string, fields: OpField[], values: OpValues, run: (v: OpValues) => void, before = this.snap(title)): void {
    try {
      run(values);
    } catch (e) {
      console.error(e);
      this.restore(before);
      this.refresh();
      this.host.status(`${title} fehlgeschlagen: ${(e as Error).message}`, true);
      return;
    }
    this.afterMeshChange();
    this.lastOp = fields.length ? { title, fields, values: { ...values }, before, run } : null;
    this.commit(title, true);
  }

  private rerunOp(values: OpValues): void {
    const op = this.lastOp;
    if (!op) return;
    this.restore(op.before);
    try {
      op.run(values);
    } catch (e) {
      console.error(e);
      this.restore(op.before);
    }
    op.values = { ...values };
    this.afterMeshChange();
    this.history.replace(this.snap(op.title));
    this.setDirty(true);
    this.refresh();
  }

  // ---------- Anzeige ----------

  private rebuildMaterials(): void {
    for (const m of this.displayMats) m.dispose();
    this.displayMats = this.doc.materials.map((s) => {
      const m = slotMaterial(s).clone();
      m.userData = { uvScale: s.uvScale };
      m.polygonOffset = true;
      m.polygonOffsetFactor = 1;
      m.polygonOffsetUnits = 1;
      if (this.view?.xray) {
        m.transparent = true;
        m.opacity = 0.35;
        m.depthWrite = false;
      }
      return m;
    });
    if (!this.displayMats.length) this.displayMats.push(new THREE.MeshStandardMaterial({ color: '#b4b4b4' }));
  }

  private rebuildAll(): void {
    for (const o of this.doc.objects) this.view.syncObject(o, this.displayMats);
    this.view.prune(new Set(this.doc.objects.map((o) => o.id)));
  }

  /** Nach Netzänderungen des aktiven Objekts */
  private afterMeshChange(): void {
    const o = this.activeObj;
    if (o) {
      if (this.mode === 'edit') this.sel = ops.resel(o.mesh, this.sel, this.selMode);
    }
    this.rebuildAll();
  }

  /** Overlays, Gizmo, Panel, Infos */
  private refresh(panel = true): void {
    const o = this.activeObj;
    if (this.mode === 'edit' && o) {
      this.view.setEdit(o, this.sel, this.selMode);
      this.view.setObjectOutlines([], null);
    } else {
      this.view.setEdit(null, null, this.selMode);
      this.view.setObjectOutlines(this.selectedObjs, o);
    }
    this.updateGizmo();
    this.updateCollisionPreview();
    this.updateInfo();
    this.renderToolbar();
    this.renderShelf();
    this.renderRedo();
    if (panel) this.renderSide();
  }

  private updateInfo(): void {
    const o = this.activeObj;
    let tris = 0;
    let faces = 0;
    let verts = 0;
    for (const ob of this.doc.objects) {
      tris += ob.mesh.triangleCount;
      faces += ob.mesh.faces.length;
      verts += ob.mesh.verts.length;
    }
    const base = this.mode === 'edit' && o
      ? `Bearbeiten · ${o.name} · Punkte ${this.sel.v.size}/${o.mesh.verts.length} · Kanten ${this.sel.e.size}/${o.mesh.allEdges().length} · Flächen ${this.sel.f.size}/${o.mesh.faces.length}`
      : `Objekt · ${this.doc.objects.length} Objekte · Punkte ${verts} · Flächen ${faces} · Dreiecke ${tris}`;
    this.view.stats.textContent = base;
  }

  private frameAll(): void {
    const box = new THREE.Box3();
    for (const o of this.doc.objects) if (o.visible) box.union(o.mesh.bounds().applyMatrix4(objectMatrix(o)));
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(1, 1, 1));
    this.view.frame(box);
  }

  private frameSelected(): void {
    const box = new THREE.Box3();
    if (this.mode === 'edit' && this.activeObj) {
      const m = objectMatrix(this.activeObj);
      for (const v of this.sel.v) box.expandByPoint(this.activeObj.mesh.verts[v].clone().applyMatrix4(m));
    } else for (const o of this.selectedObjs) box.union(o.mesh.bounds().applyMatrix4(objectMatrix(o)));
    if (box.isEmpty()) return this.frameAll();
    if (box.getSize(new THREE.Vector3()).length() < 0.05) box.expandByScalar(0.25);
    this.view.frame(box);
  }

  // ---------- Modus & Auswahl ----------

  private setMode(mode: 'object' | 'edit'): void {
    if (mode === this.mode) return;
    if (this.modal) this.modalEnd(false);
    if (mode === 'edit') {
      const o = this.activeObj;
      if (!o) return this.host.status('Zum Bearbeiten erst ein Objekt wählen', true);
      if (!o.visible) o.visible = true;
      this.sel = ops.emptySel();
    }
    this.mode = mode;
    if (mode === 'object' && this.tool === 'loopcut') {
      this.tool = 'select';
      this.loopHover = -1;
      this.view.setLines('loopcut', [], '#ffd34d');
    }
    this.lastOp = null;
    this.history.push(this.snap(mode === 'edit' ? 'Bearbeitungsmodus' : 'Objektmodus'));
    this.refresh();
  }

  private setSelMode(m: SelMode): void {
    if (this.mode !== 'edit' || !this.activeObj) return;
    this.selMode = m;
    this.sel = ops.resel(this.activeObj.mesh, this.sel, m);
    this.refresh();
  }

  private setSel(s: Selection, label = 'Auswahl'): void {
    this.sel = this.activeObj ? ops.resel(this.activeObj.mesh, s, this.selMode) : s;
    this.history.push(this.snap(label));
    this.refresh();
  }

  /** Auswahl aus Elementen des aktuellen Modus (Punkte, Kantenschlüssel oder Flächen) */
  private selFrom(items: Iterable<number>): Selection {
    const m = this.activeObj!.mesh;
    if (this.selMode === 'v') return ops.selFromVerts(m, items);
    if (this.selMode === 'e') return ops.selFromEdges(m, items);
    return ops.selFromFaces(m, items);
  }

  private modeSet(s: Selection): Set<number> {
    return this.selMode === 'v' ? s.v : this.selMode === 'e' ? s.e : s.f;
  }

  private applyPick(items: number[], extend: boolean, subtract: boolean, toggle: boolean): void {
    const cur = new Set(this.modeSet(this.sel));
    if (!extend && !subtract && !toggle) cur.clear();
    for (const i of items) {
      if (subtract) cur.delete(i);
      else if (toggle && cur.has(i) && items.length === 1) cur.delete(i);
      else cur.add(i);
    }
    this.setSel(this.selFrom(cur));
  }

  private selectAll(): void {
    if (this.mode === 'edit' && this.activeObj) this.setSel(ops.selectAll(this.activeObj.mesh), 'Alles auswählen');
    else {
      this.selected = new Set(this.doc.objects.filter((o) => o.visible).map((o) => o.id));
      if (!this.activeId && this.doc.objects[0]) this.activeId = this.doc.objects[0].id;
      this.history.push(this.snap('Alles auswählen'));
      this.refresh();
    }
  }

  private selectNone(): void {
    if (this.mode === 'edit') this.setSel(ops.emptySel(), 'Nichts auswählen');
    else {
      this.selected.clear();
      this.history.push(this.snap('Nichts auswählen'));
      this.refresh();
    }
  }

  private selectInvert(): void {
    if (this.mode === 'edit' && this.activeObj) this.setSel(ops.invertSel(this.activeObj.mesh, this.sel, this.selMode), 'Auswahl umkehren');
    else {
      this.selected = new Set(this.doc.objects.filter((o) => o.visible && !this.selected.has(o.id)).map((o) => o.id));
      this.history.push(this.snap('Auswahl umkehren'));
      this.refresh();
    }
  }

  private selectObject(id: string | null, extend: boolean): void {
    if (!id) {
      if (!extend) this.selected.clear();
    } else if (extend && this.selected.has(id) && this.activeId === id) {
      this.selected.delete(id);
    } else {
      if (!extend) this.selected.clear();
      this.selected.add(id);
      this.activeId = id;
    }
    this.history.push(this.snap('Auswahl'));
    this.refresh();
  }

  // ---------- Maus ----------

  private onDown(e: PointerEvent, x: number, y: number): void {
    if (this.modal) return;
    closeMenus();
    if (this.tool === 'loopcut' && this.mode === 'edit') {
      this.loopCutAt(x, y);
      return;
    }
    this.drag = { x0: x, y0: y, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, boxing: false };
  }

  private onMove(e: PointerEvent, x: number, y: number): void {
    this.mouse.x = x;
    this.mouse.y = y;
    if (this.modal) return;
    const d = this.drag;
    if (d) {
      if (!d.boxing && Math.hypot(x - d.x0, y - d.y0) > 4 && !d.alt) d.boxing = true;
      if (d.boxing) this.view.showMarquee(d.x0, d.y0, x, y);
      return;
    }
    if (this.tool === 'loopcut' && this.mode === 'edit') this.loopPreview(x, y);
    void e;
  }

  private onUp(e: PointerEvent, x: number, y: number): void {
    const d = this.drag;
    this.drag = null;
    this.view.hideMarquee();
    if (!d) return;
    const o = this.activeObj;
    if (d.boxing) {
      if (this.mode === 'edit' && o) {
        const items = this.view.boxSelect(o, d.x0, d.y0, x, y, this.selMode);
        this.applyPick(items, d.shift, d.ctrl, false);
      } else {
        const ids = this.view.boxObjects(this.doc.objects, d.x0, d.y0, x, y);
        if (!d.shift && !d.ctrl) this.selected.clear();
        for (const id of ids) d.ctrl ? this.selected.delete(id) : this.selected.add(id);
        if (ids.length && !d.ctrl && (!this.activeId || !this.selected.has(this.activeId))) this.activeId = ids[0];
        this.history.push(this.snap('Rahmenauswahl'));
        this.refresh();
      }
      return;
    }
    // Klick
    if (this.mode === 'edit' && o) {
      if (d.alt) {
        const k = this.view.nearestEdgeKey(o, x, y);
        if (k < 0) return;
        let s: Selection;
        if (d.ctrl) {
          const ring = ops.edgeRing(o.mesh, k);
          s = ops.selFromEdges(o.mesh, ring ? ring.edges.map(([a, b]) => ek(a, b)) : [k]);
          if (this.selMode === 'f' && ring) s = ops.selFromFaces(o.mesh, ring.quads);
        } else if (this.selMode === 'f') {
          const ring = ops.edgeRing(o.mesh, k);
          s = ops.selFromFaces(o.mesh, ring?.quads ?? []);
        } else s = ops.selFromEdges(o.mesh, ops.edgeLoop(o.mesh, k));
        // Shift: zur Auswahl hinzufügen, im jeweiligen Modus (über Punkte vereinigt kämen in Flächen-/Kantenmodus Nachbarn dazu)
        if (d.shift) {
          s =
            this.selMode === 'f'
              ? ops.selFromFaces(o.mesh, [...this.sel.f, ...s.f])
              : this.selMode === 'e'
                ? ops.selFromEdges(o.mesh, [...this.sel.e, ...s.e])
                : ops.selFromVerts(o.mesh, [...this.sel.v, ...s.v]);
        }
        this.setSel(s, 'Schleife auswählen');
        void e;
        return;
      }
      const hit = this.selMode === 'v' ? this.view.pickVert(o, x, y) : this.selMode === 'e' ? this.view.pickEdge(o, x, y) : this.view.pickFace(o, x, y);
      if (hit < 0) {
        if (!d.shift) this.setSel(ops.emptySel());
        return;
      }
      this.applyPick([hit], false, false, d.shift);
      if (d.shift && !this.modeSet(this.sel).has(hit)) return;
      return;
    }
    this.selectObject(this.view.pickObject(x, y), d.shift);
  }

  private onContext(e: PointerEvent, x: number, y: number): void {
    if (this.modal) return this.modalEnd(false);
    this.mouse.x = x;
    this.mouse.y = y;
    showMenu(this.contextItems(), { x: e.clientX, y: e.clientY });
  }

  // ---------- Gizmo-Werkzeuge ----------

  private bindGizmo(): void {
    const g = this.view.gizmo;
    g.addEventListener('mouseDown', () => {
      const t = this.view.gizmoTarget;
      this.gizmoBase = { ...this.captureBase(), pos: t.position.clone(), quat: t.quaternion.clone(), scale: t.scale.clone(), before: this.snap('Transformieren') };
    });
    g.addEventListener('objectChange', () => {
      const b = this.gizmoBase;
      if (!b) return;
      const t = this.view.gizmoTarget;
      const T = new THREE.Matrix4();
      if (this.tool === 'move') T.makeTranslation(t.position.x - b.pos.x, t.position.y - b.pos.y, t.position.z - b.pos.z);
      else {
        const p = b.pos;
        const M = this.tool === 'rotate' ? new THREE.Matrix4().makeRotationFromQuaternion(t.quaternion.clone().multiply(b.quat.clone().invert())) : new THREE.Matrix4().makeScale(t.scale.x / b.scale.x, t.scale.y / b.scale.y, t.scale.z / b.scale.z);
        T.makeTranslation(p.x, p.y, p.z).multiply(M).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
      }
      this.applyWorld(T, b.verts, b.objs, true);
    });
    g.addEventListener('mouseUp', () => {
      const b = this.gizmoBase;
      this.gizmoBase = null;
      if (!b) return;
      this.rebuildAll();
      this.commit({ move: 'Verschieben', rotate: 'Drehen', scale: 'Skalieren', select: 'Transformieren', loopcut: '' }[this.tool] || 'Transformieren');
    });
  }

  private updateGizmo(): void {
    const g = this.view.gizmo;
    const t = this.view.gizmoTarget;
    const usable = this.tool === 'move' || this.tool === 'rotate' || this.tool === 'scale';
    const pivot = this.pivot();
    if (!usable || !pivot || this.modal) {
      g.detach();
      g.getHelper().visible = false;
      return;
    }
    if (this.gizmoBase) return;
    t.position.copy(pivot);
    t.quaternion.identity();
    t.scale.set(1, 1, 1);
    t.updateMatrixWorld();
    g.setMode(this.tool === 'move' ? 'translate' : this.tool === 'rotate' ? 'rotate' : 'scale');
    g.setSpace('world');
    g.setTranslationSnap(this.snapOn ? 0.1 : null);
    g.setRotationSnap(this.snapOn ? 15 * DEG : null);
    g.setScaleSnap(this.snapOn ? 0.1 : null);
    g.attach(t);
    g.getHelper().visible = true;
  }

  /** Drehpunkt der Auswahl (Welt) oder null */
  private pivot(): THREE.Vector3 | null {
    const o = this.activeObj;
    if (this.mode === 'edit' && o) {
      if (!this.sel.v.size) return null;
      return ops.selCenter(o.mesh, this.sel).applyMatrix4(objectMatrix(o));
    }
    const objs = this.selectedObjs;
    if (!objs.length) return null;
    const c = new THREE.Vector3();
    for (const ob of objs) c.add(ob.pos);
    return c.divideScalar(objs.length);
  }

  private captureBase(): { verts: Map<number, THREE.Vector3> | null; objs: Map<string, THREE.Matrix4> | null } {
    const o = this.activeObj;
    if (this.mode === 'edit' && o) {
      const verts = new Map<number, THREE.Vector3>();
      for (const v of this.sel.v) verts.set(v, o.mesh.verts[v].clone());
      return { verts, objs: null };
    }
    const objs = new Map<string, THREE.Matrix4>();
    for (const ob of this.selectedObjs) objs.set(ob.id, objectMatrix(ob));
    return { verts: null, objs };
  }

  /** Welt-Transformation auf Basis-Zustand anwenden */
  private applyWorld(T: THREE.Matrix4, verts: Map<number, THREE.Vector3> | null, objs: Map<string, THREE.Matrix4> | null, live: boolean): void {
    const o = this.activeObj;
    if (verts && o) {
      const O = objectMatrix(o);
      const M = O.clone().invert().multiply(T).multiply(O);
      const clip = o.mirrorClip && o.mirror.some(Boolean);
      for (const [i, p] of verts) {
        o.mesh.verts[i].copy(p).applyMatrix4(M);
        if (clip) ops.clipToMirror(o.mesh.verts[i], p, o.mirror);
      }
      this.view.syncObject(o, this.displayMats);
      this.view.setEdit(o, this.sel, this.selMode);
    }
    if (objs) {
      const q = new THREE.Quaternion();
      for (const ob of this.doc.objects) {
        const base = objs.get(ob.id);
        if (!base) continue;
        new THREE.Matrix4().multiplyMatrices(T, base).decompose(ob.pos, q, ob.scale);
        ob.rot.setFromQuaternion(q);
        this.view.syncTransform(ob);
      }
      this.view.setObjectOutlines(this.selectedObjs, this.activeObj);
    }
    if (live) this.updateInfo();
  }

  // ---------- Modale Transformation (G/R/S, Extrudieren, Inset, Bevel) ----------

  private startModal(kind: ModalKind, title: string, opts: Partial<Pick<Modal, 'normal' | 'wrap' | 'before'>> = {}): void {
    const pivot = this.pivot();
    if (!pivot) return this.host.status('Nichts ausgewählt', true);
    const o = this.activeObj;
    const base = this.captureBase();
    const x = this.mouse.inside ? this.mouse.x : this.view.canvas.clientWidth / 2;
    const y = this.mouse.inside ? this.mouse.y : this.view.canvas.clientHeight / 2;
    this.modal = {
      kind,
      title,
      x0: x,
      y0: y,
      x,
      y,
      ctrl: false,
      shift: false,
      pivot,
      axis: null,
      axisName: '',
      normal: opts.normal ?? null,
      typed: '',
      baseVerts: base.verts,
      baseObjs: base.objs,
      baseMesh: kind === 'inset' || kind === 'bevel' ? o!.mesh.clone() : null,
      baseSel: kind === 'inset' || kind === 'bevel' ? { v: new Set(this.sel.v), e: new Set(this.sel.e), f: new Set(this.sel.f) } : null,
      before: opts.before ?? this.snap(title),
      individual: false,
      result: { T: new THREE.Matrix4(), value: 0, delta: new THREE.Vector3() },
      wrap: opts.wrap,
    };
    // Bei Start mitten auf dem Drehpunkt: Bezugsabstand künstlich vergrößern
    const ps = this.view.project(pivot);
    if (Math.hypot(x - ps.x, y - ps.y) < 30 && kind !== 'grab') {
      this.modal.x0 = ps.x + 80;
      this.modal.y0 = ps.y;
      if (kind === 'scale' || kind === 'rotate') {
        this.modal.x = this.modal.x0;
        this.modal.y = this.modal.y0;
      }
    }
    this.view.gizmo.detach();
    this.view.gizmo.getHelper().visible = false;
    this.lastOp = null;
    this.renderRedo();
    this.modalUpdate();
  }

  private pxWorld(p: THREE.Vector3): number {
    const hgt = this.view.canvas.clientHeight || 1;
    if (this.view.orthoMode) return (this.view.ortho.top - this.view.ortho.bottom) / hgt;
    const d = p.clone().sub(this.view.persp.position).dot(this.view.viewDir());
    return (2 * Math.max(0.01, d) * Math.tan((this.view.persp.fov / 2) * DEG)) / hgt;
  }

  /** Parameter auf der Achse (Pivot + t·dir), der dem Mausstrahl am nächsten liegt */
  private axisParam(x: number, y: number, p: THREE.Vector3, dir: THREE.Vector3): number {
    const r = this.view.ray(x, y);
    const w0 = p.clone().sub(r.origin);
    const a = dir.dot(dir);
    const b = dir.dot(r.direction);
    const c = r.direction.dot(r.direction);
    const d = dir.dot(w0);
    const e = r.direction.dot(w0);
    const den = a * c - b * b;
    if (Math.abs(den) < 1e-9) return 0;
    return (b * e - c * d) / den;
  }

  private planePoint(x: number, y: number, p: THREE.Vector3): THREE.Vector3 {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.view.viewDir(), p);
    return this.view.ray(x, y).intersectPlane(plane, new THREE.Vector3()) ?? p.clone();
  }

  private typedValue(): number | null {
    const t = this.modal?.typed ?? '';
    if (!t || t === '-' || t === '.') return null;
    const v = Number(t.replace(',', '.'));
    return isFinite(v) ? v : null;
  }

  private modalUpdate(): void {
    const md = this.modal;
    if (!md) return;
    const p = md.pivot;
    const typed = this.typedValue();
    const ps = this.view.project(p);
    const snap = md.ctrl !== this.snapOn;
    let hud = '';
    const T = new THREE.Matrix4();
    if (md.kind === 'grab') {
      const dir = md.axis ?? md.normal;
      const d = new THREE.Vector3();
      if (typed !== null) d.copy(dir ?? AXES[0]).multiplyScalar(typed);
      else if (dir) {
        let t = this.axisParam(md.x, md.y, p, dir) - this.axisParam(md.x0, md.y0, p, dir);
        if (snap) t = Math.round(t / (md.shift ? 0.01 : 0.1)) * (md.shift ? 0.01 : 0.1);
        d.copy(dir).multiplyScalar(t);
      } else {
        d.subVectors(this.planePoint(md.x, md.y, p), this.planePoint(md.x0, md.y0, p));
        if (snap) {
          const s = md.shift ? 0.01 : 0.1;
          d.set(Math.round(d.x / s) * s, Math.round(d.y / s) * s, Math.round(d.z / s) * s);
        }
      }
      T.makeTranslation(d.x, d.y, d.z);
      md.result.delta.copy(d);
      md.result.value = dir ? d.dot(dir) : d.length();
      hud = dir ? `${md.axisName || 'Normale'}: ${fmt(md.result.value)} m` : `X ${fmt(d.x)}  Y ${fmt(d.y)}  Z ${fmt(d.z)} m`;
    } else if (md.kind === 'rotate') {
      const toCam = this.view.viewDir().negate();
      const axis = md.axis ?? toCam;
      let ang: number;
      if (typed !== null) ang = typed * DEG;
      else {
        const a0 = Math.atan2(md.y0 - ps.y, md.x0 - ps.x);
        const a1 = Math.atan2(md.y - ps.y, md.x - ps.x);
        ang = -(a1 - a0);
        if (axis.dot(toCam) < 0) ang = -ang;
        if (snap) ang = Math.round(ang / (5 * DEG)) * 5 * DEG;
      }
      T.makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationAxis(axis, ang)).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
      md.result.value = ang / DEG;
      hud = `Drehen${md.axisName ? ` um ${md.axisName}` : ''}: ${fmt(ang / DEG)}°`;
    } else if (md.kind === 'scale') {
      let f: number;
      if (typed !== null) f = typed;
      else {
        f = Math.hypot(md.x - ps.x, md.y - ps.y) / Math.max(1, Math.hypot(md.x0 - ps.x, md.y0 - ps.y));
        if (snap) f = Math.round(f / 0.1) * 0.1;
      }
      const S = new THREE.Matrix4();
      if (md.axis) {
        const a = md.axis;
        const k = f - 1;
        S.set(1 + k * a.x * a.x, k * a.x * a.y, k * a.x * a.z, 0, k * a.y * a.x, 1 + k * a.y * a.y, k * a.y * a.z, 0, k * a.z * a.x, k * a.z * a.y, 1 + k * a.z * a.z, 0, 0, 0, 0, 1);
      } else S.makeScale(f, f, f);
      T.makeTranslation(p.x, p.y, p.z).multiply(S).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
      md.result.value = f;
      hud = `Skalieren${md.axisName ? ` ${md.axisName}` : ''}: ${fmt(f)}`;
    } else {
      // Inset / Bevel: Abstand der Maus zum Drehpunkt
      let v: number;
      if (typed !== null) v = typed;
      else {
        const d0 = Math.hypot(md.x0 - ps.x, md.y0 - ps.y);
        const d1 = Math.hypot(md.x - ps.x, md.y - ps.y);
        v = Math.max(0, (md.kind === 'inset' ? d0 - d1 : d1 - d0) * this.pxWorld(p));
        if (md.kind === 'bevel' && d0 < 1) v = 0;
        if (snap) v = Math.round(v / 0.01) * 0.01;
      }
      md.result.value = Math.max(0, v);
      this.applyInsetBevel(md);
      hud = md.kind === 'inset' ? `Inset Dicke: ${fmt(md.result.value)} m${md.individual ? ' (einzeln)' : ''}` : `Abschrägen Breite: ${fmt(md.result.value)} m`;
    }
    if (md.kind === 'grab' || md.kind === 'rotate' || md.kind === 'scale') {
      md.result.T.copy(T);
      this.applyWorld(T, md.baseVerts, md.baseObjs, true);
    }
    const keys =
      md.kind === 'inset'
        ? 'I Einzeln · Strg Raster · Zahl tippen · Enter/Linksklick OK · Esc/Rechtsklick Abbrechen'
        : md.kind === 'bevel'
          ? 'Strg Raster · Zahl tippen · Enter/Linksklick OK · Esc/Rechtsklick Abbrechen'
          : 'X/Y/Z Achse · Strg Raster · Zahl tippen · Enter/Linksklick OK · Esc/Rechtsklick Abbrechen';
    this.view.hud.classList.remove('hidden');
    this.view.hud.replaceChildren(h('b', {}, `${md.title}${md.typed ? ` [${md.typed}]` : ''}`), h('span', {}, hud), h('small', {}, keys));
  }

  private applyInsetBevel(md: Modal): void {
    const o = this.activeObj;
    if (!o || !md.baseMesh || !md.baseSel) return;
    o.mesh = md.baseMesh.clone();
    if (md.kind === 'inset') this.sel = ops.inset(o.mesh, [...md.baseSel.f], md.result.value, 0, md.individual);
    else this.sel = ops.bevel(o.mesh, md.baseSel.e, md.result.value);
    if (this.mode === 'edit') this.sel = ops.resel(o.mesh, this.sel, this.selMode);
    this.view.syncObject(o, this.displayMats);
    this.view.setEdit(o, this.sel, this.selMode);
  }

  private modalKey(e: KeyboardEvent): void {
    const md = this.modal!;
    e.preventDefault();
    e.stopPropagation();
    const k = e.key;
    if (k === 'Escape') return this.modalEnd(false);
    if (k === 'Enter' || k === ' ') return this.modalEnd(true);
    if ((k === 'x' || k === 'y' || k === 'z' || k === 'X' || k === 'Y' || k === 'Z') && (md.kind === 'grab' || md.kind === 'rotate' || md.kind === 'scale')) {
      const i = 'xyz'.indexOf(k.toLowerCase());
      if (md.axisName === AXIS_NAMES[i]) {
        md.axis = null;
        md.axisName = '';
      } else {
        md.axis = AXES[i].clone();
        md.axisName = AXIS_NAMES[i];
      }
    } else if ((k === 'i' || k === 'I') && md.kind === 'inset') md.individual = !md.individual;
    else if (/^[0-9.,]$/.test(k)) md.typed += k === ',' ? '.' : k;
    else if (k === '-') md.typed = md.typed.startsWith('-') ? md.typed.slice(1) : `-${md.typed}`;
    else if (k === 'Backspace') md.typed = md.typed.slice(0, -1);
    else if (k === 'Control') md.ctrl = true;
    else return;
    this.modalUpdate();
  }

  private modalEnd(ok: boolean): void {
    const md = this.modal;
    if (!md) return;
    this.modal = null;
    this.view.hud.classList.add('hidden');
    if (!ok) {
      this.restore(md.before);
      this.refresh();
      this.host.status(`${md.title} abgebrochen`);
      return;
    }
    this.rebuildAll();
    // als Operation mit Redo-Panel festhalten
    const before = md.before;
    const r = md.result;
    const wrap = md.wrap;
    const axisName = md.axisName;
    const axis = md.axis?.clone() ?? null;
    const normal = md.normal?.clone() ?? null;
    const individual = md.individual;
    const transformRun = (T: THREE.Matrix4) => {
      wrap?.prepare();
      const b = this.captureBase();
      this.applyWorld(T, b.verts, b.objs, false);
    };
    const pivotT = (M: THREE.Matrix4) => {
      const p = this.pivot() ?? new THREE.Vector3();
      return new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(M).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    };
    let op: LastOp | null = null;
    const title = wrap?.title ?? md.title;
    if (md.kind === 'grab') {
      const dir = axis ?? normal;
      if (dir) {
        op = { title, before, values: { d: r.value }, fields: [{ key: 'd', label: `Abstand${axisName ? ` (${axisName})` : ''}`, type: 'number', step: 0.05 }], run: (v) => transformRun(new THREE.Matrix4().makeTranslation(dir.x * (v.d as number), dir.y * (v.d as number), dir.z * (v.d as number))) };
      } else {
        op = {
          title,
          before,
          values: { x: r.delta.x, y: r.delta.y, z: r.delta.z },
          fields: ['x', 'y', 'z'].map((k) => ({ key: k, label: k.toUpperCase(), type: 'number' as const, step: 0.05 })),
          run: (v) => transformRun(new THREE.Matrix4().makeTranslation(v.x as number, v.y as number, v.z as number)),
        };
      }
    } else if (md.kind === 'rotate') {
      const ax = axis ?? this.view.viewDir().negate();
      op = { title, before, values: { a: r.value }, fields: [{ key: 'a', label: `Winkel°${axisName ? ` (${axisName})` : ''}`, type: 'number', step: 5 }], run: (v) => transformRun(pivotT(new THREE.Matrix4().makeRotationAxis(ax, (v.a as number) * DEG))) };
    } else if (md.kind === 'scale') {
      op = {
        title,
        before,
        values: { f: r.value },
        fields: [{ key: 'f', label: `Faktor${axisName ? ` (${axisName})` : ''}`, type: 'number', step: 0.05 }],
        run: (v) => {
          const f = v.f as number;
          if (!axis) return transformRun(pivotT(new THREE.Matrix4().makeScale(f, f, f)));
          const k = f - 1;
          const a = axis;
          transformRun(pivotT(new THREE.Matrix4().set(1 + k * a.x * a.x, k * a.x * a.y, k * a.x * a.z, 0, k * a.y * a.x, 1 + k * a.y * a.y, k * a.y * a.z, 0, k * a.z * a.x, k * a.z * a.y, 1 + k * a.z * a.z, 0, 0, 0, 0, 1)));
        },
      };
    } else if (md.kind === 'inset') {
      op = {
        title: 'Inset',
        before,
        values: { t: r.value, d: 0, ind: individual },
        fields: [
          { key: 't', label: 'Dicke', type: 'number', step: 0.01, min: 0 },
          { key: 'd', label: 'Tiefe', type: 'number', step: 0.01 },
          { key: 'ind', label: 'Einzeln', type: 'bool' },
        ],
        run: (v) => {
          const o = this.activeObj!;
          this.sel = ops.inset(o.mesh, [...this.sel.f], v.t as number, v.d as number, !!v.ind);
        },
      };
    } else if (md.kind === 'bevel') {
      op = {
        title: 'Abschrägen',
        before,
        values: { w: r.value },
        fields: [{ key: 'w', label: 'Breite', type: 'number', step: 0.01, min: 0 }],
        run: (v) => {
          const o = this.activeObj!;
          this.sel = ops.bevel(o.mesh, this.sel.e, v.w as number);
        },
      };
    }
    this.afterMeshChange();
    this.lastOp = op;
    this.commit(title, true);
  }

  // ---------- Bearbeitungs-Operationen ----------

  private needEdit(what = 'Diese Funktion'): MObject | null {
    const o = this.activeObj;
    if (this.mode !== 'edit' || !o) {
      this.host.status(`${what} gibt es nur im Bearbeitungsmodus (Tab)`, true);
      return null;
    }
    return o;
  }

  private doExtrude(): void {
    const o = this.needEdit('Extrudieren');
    if (!o) return;
    if (!this.sel.v.size) return this.host.status('Nichts ausgewählt', true);
    const before = this.snap('Extrudieren');
    const selBefore = { v: new Set(this.sel.v), e: new Set(this.sel.e), f: new Set(this.sel.f) };
    const selModeBefore = this.selMode;
    const doIt = () => {
      const s = this.selMode === 'f' ? { v: new Set<number>(), e: new Set<number>(), f: this.sel.f } : this.selMode === 'e' ? { v: new Set<number>(), e: this.sel.e, f: new Set<number>() } : { v: this.sel.v, e: new Set<number>(), f: new Set<number>() };
      const m = this.activeObj!.mesh; // nicht `o`: Redo-Panel stellt das Dokument neu her
      const r = ops.extrude(m, s.f.size || s.e.size || s.v.size ? s : this.sel);
      if (!r) return null;
      this.sel = r.sel;
      if (this.selMode === 'v' && this.sel.e.size === 0 && r.sel.v.size) this.sel = ops.selFromVerts(m, r.sel.v);
      return r;
    };
    const r = doIt();
    if (!r) return;
    const normal = r.normal ? r.normal.clone().transformDirection(objectMatrix(o)) : null;
    this.afterMeshChange();
    this.refresh(false);
    this.startModal('grab', 'Extrudieren', {
      normal,
      before,
      wrap: {
        title: 'Extrudieren',
        prepare: () => {
          this.sel = { v: new Set(selBefore.v), e: new Set(selBefore.e), f: new Set(selBefore.f) };
          this.selMode = selModeBefore;
          doIt();
        },
      },
    });
  }

  private doInset(): void {
    const o = this.needEdit('Inset');
    if (!o) return;
    if (!this.sel.f.size) return this.host.status('Inset: erst Flächen auswählen', true);
    this.startModal('inset', 'Inset');
  }

  private doBevel(): void {
    const o = this.needEdit('Abschrägen');
    if (!o) return;
    if (!this.sel.e.size) return this.host.status('Abschrägen: erst Kanten auswählen', true);
    this.startModal('bevel', 'Abschrägen');
  }

  private loopPreview(x: number, y: number): void {
    const o = this.activeObj;
    if (!o) return;
    const k = this.view.nearestEdgeKey(o, x, y);
    this.loopHover = k;
    const pos: number[] = [];
    if (k >= 0) {
      const ring = ops.edgeRing(o.mesh, k);
      if (ring) {
        const M = objectMatrix(o);
        const pts = ring.edges.map(([a, b]) => o.mesh.verts[a].clone().lerp(o.mesh.verts[b], 0.5).applyMatrix4(M));
        for (let i = 0; i + 1 < pts.length; i++) pos.push(...pts[i].toArray(), ...pts[i + 1].toArray());
        if (ring.closed && pts.length > 2) pos.push(...pts[pts.length - 1].toArray(), ...pts[0].toArray());
      }
    }
    this.view.setLines('loopcut', pos, '#ffd34d');
  }

  private loopCutAt(x: number, y: number): void {
    const o = this.activeObj;
    if (!o) return;
    const hit = this.view.nearestEdgeKey(o, x, y);
    const k = hit >= 0 ? hit : this.loopHover;
    this.loopHover = -1;
    if (k < 0 || !ops.edgeRing(o.mesh, k)) return this.host.status('Loop Cut: über eine Kante zwischen Vierecken fahren', true);
    this.view.setLines('loopcut', [], '#ffd34d');
    this.runOp(
      'Loop Cut',
      [
        { key: 'n', label: 'Anzahl', type: 'int', min: 1, max: 32 },
        { key: 'f', label: 'Position', type: 'number', step: 0.05, min: 0.01, max: 0.99 },
      ],
      { n: 1, f: 0.5 },
      (v) => {
        const m = this.activeObj!.mesh; // nach Redo-Panel-Änderungen ist das Objekt neu aufgebaut
        const ring = ops.edgeRing(m, k);
        if (!ring) throw new Error('kein Kantenring');
        this.sel = ops.loopCut(m, ring, v.n as number, v.f as number);
        this.selMode = 'e';
      },
    );
  }

  private simpleOp(title: string, fn: (o: MObject) => void, needSel = true): void {
    const o = this.needEdit(title);
    if (!o) return;
    if (needSel && !this.sel.v.size) return this.host.status('Nichts ausgewählt', true);
    this.runOp(title, [], {}, () => fn(this.activeObj!));
  }

  private doDelete(kind: 'v' | 'e' | 'f' | 'dissolveE' | 'dissolveV' | 'onlyFaces'): void {
    const titles = { v: 'Punkte löschen', e: 'Kanten löschen', f: 'Flächen löschen', dissolveE: 'Kanten auflösen', dissolveV: 'Punkte auflösen', onlyFaces: 'Nur Flächen löschen' };
    this.simpleOp(titles[kind], (o) => {
      const m = o.mesh;
      if (kind === 'v') ops.deleteVerts(m, new Set(this.sel.v));
      else if (kind === 'e') ops.deleteEdges(m, new Set(this.sel.e));
      else if (kind === 'f') {
        // Flächen samt Punkten/Kanten, die nur zu ihnen gehören
        const keep = new Set<number>();
        m.faces.forEach((f, i) => {
          if (!this.sel.f.has(i)) for (const v of f.v) keep.add(v);
        });
        for (const [a, b] of m.edges) keep.add(a).add(b);
        ops.deleteFaces(m, new Set(this.sel.f));
        void keep;
      } else if (kind === 'onlyFaces') {
        m.faces = m.faces.filter((_, i) => !this.sel.f.has(i));
        const ef = new Set<number>();
        for (const f of m.faces) for (let i = 0; i < f.v.length; i++) ef.add(ek(f.v[i], f.v[(i + 1) % f.v.length]));
        for (const k of this.sel.e) if (!ef.has(k)) m.edges.push([ekA(k), ekB(k)]);
        m.tidyEdges();
      } else if (kind === 'dissolveE') this.sel = ops.dissolveEdges(m, new Set(this.sel.e));
      else ops.dissolveVerts(m, new Set(this.sel.v));
      if (kind !== 'dissolveE') this.sel = ops.emptySel();
    });
  }

  private doFill(): void {
    this.simpleOp('Füllen', (o) => {
      const r = ops.fill(o.mesh, this.sel, this.view.viewDir().transformDirection(objectMatrix(o).invert()), this.activeSlot);
      if (!r) throw new Error('mindestens 2 Punkte wählen');
      this.sel = r;
      if (this.selMode !== 'f' && r.f.size) this.selMode = 'f';
    });
  }

  private doMerge(at: 'center' | 'distance'): void {
    const o = this.needEdit('Zusammenführen');
    if (!o || !this.sel.v.size) return;
    if (at === 'center') {
      this.runOp('Zusammenführen (Mitte)', [], {}, () => {
        const m = this.activeObj!.mesh;
        this.sel = ops.mergeAt(m, this.sel.v, ops.selCenter(m, this.sel));
        this.selMode = 'v';
      });
    } else {
      let removed = 0;
      this.runOp('Nach Abstand zusammenführen', [{ key: 'd', label: 'Abstand', type: 'number', step: 0.001, min: 0 }], { d: 0.001 }, (v) => {
        const m = this.activeObj!.mesh;
        removed = ops.mergeByDistance(m, new Set(this.sel.v), v.d as number);
        this.sel = ops.emptySel();
      });
      this.host.status(`${removed} Punkte entfernt`);
    }
  }

  private doSubdivide(): void {
    const o = this.needEdit('Unterteilen');
    if (!o) return;
    if (!this.sel.f.size) return this.host.status('Unterteilen: erst Flächen auswählen', true);
    this.runOp('Unterteilen', [{ key: 'n', label: 'Durchgänge', type: 'int', min: 1, max: 4 }], { n: 1 }, (v) => {
      const m = this.activeObj!.mesh;
      let s = this.sel;
      for (let i = 0; i < (v.n as number); i++) s = ops.subdivide(m, [...s.f]);
      this.sel = s;
    });
  }

  private doSmoothSubdiv(): void {
    const targets = this.mode === 'edit' && this.activeObj ? [this.activeObj] : this.selectedObjs;
    if (!targets.length) return this.host.status('Nichts ausgewählt', true);
    const ids = targets.map((t) => t.id);
    this.runOp('Glätten (Subdivision)', [{ key: 'n', label: 'Stufen', type: 'int', min: 1, max: 3 }], { n: 1 }, (v) => {
      for (const id of ids) {
        const o = this.doc.objects.find((x) => x.id === id);
        if (!o) continue;
        if (o.mesh.faces.length * Math.pow(4, v.n as number) > 400000) throw new Error('zu viele Flächen');
        for (let i = 0; i < (v.n as number); i++) ops.catmullClark(o.mesh);
        o.smooth = true;
      }
      this.sel = ops.emptySel();
    });
  }

  private doDuplicate(): void {
    const o = this.activeObj;
    if (this.mode === 'edit' && o) {
      if (!this.sel.v.size) return;
      const before = this.snap('Duplizieren');
      const selBefore = { v: new Set(this.sel.v), e: new Set(this.sel.e), f: new Set(this.sel.f) };
      const doIt = () => {
        this.sel = ops.duplicate(this.activeObj!.mesh, { v: new Set(selBefore.v), e: new Set(selBefore.e), f: new Set(selBefore.f) });
      };
      doIt();
      this.afterMeshChange();
      this.refresh(false);
      this.startModal('grab', 'Duplizieren', { before, wrap: { title: 'Duplizieren', prepare: doIt } });
      return;
    }
    const objs = this.selectedObjs;
    if (!objs.length) return;
    const before = this.snap('Duplizieren');
    const srcIds = objs.map((x) => x.id);
    const doIt = () => {
      const copies: MObject[] = [];
      for (const id of srcIds) {
        const src = this.doc.objects.find((x) => x.id === id);
        if (!src) continue;
        const c = newObject(`${src.name}.001`.replace(/(\.\d{3})\.001$/, (_m, a: string) => `.${String(Number(a.slice(1)) + 1).padStart(3, '0')}`), src.mesh.clone());
        c.pos.copy(src.pos);
        c.rot.copy(src.rot);
        c.scale.copy(src.scale);
        c.smooth = src.smooth;
        c.smoothAngle = src.smoothAngle;
        c.mirror = [...src.mirror];
        c.mirrorClip = src.mirrorClip;
        copies.push(c);
      }
      this.doc.objects.push(...copies);
      this.selected = new Set(copies.map((c) => c.id));
      this.activeId = copies[copies.length - 1]?.id ?? this.activeId;
    };
    doIt();
    this.rebuildAll();
    this.refresh(false);
    this.startModal('grab', 'Duplizieren', { before, wrap: { title: 'Duplizieren', prepare: doIt } });
  }

  private doSeparate(): void {
    const o = this.needEdit('Trennen');
    if (!o) return;
    if (!this.sel.f.size && !this.sel.e.size) return this.host.status('Trennen: erst Flächen auswählen', true);
    this.runOp('Trennen', [], {}, () => {
      const src = this.activeObj!;
      const part = ops.separate(src.mesh, this.sel);
      if (!part) throw new Error('keine Flächen oder losen Kanten ausgewählt');
      const n = newObject(`${src.name}.Teil`, part);
      n.pos.copy(src.pos);
      n.rot.copy(src.rot);
      n.scale.copy(src.scale);
      n.smooth = src.smooth;
      n.smoothAngle = src.smoothAngle;
      n.mirror = [...src.mirror];
      n.mirrorClip = src.mirrorClip;
      this.doc.objects.push(n);
      this.selected.add(n.id);
      this.sel = ops.emptySel();
    });
  }

  private doJoin(): void {
    const target = this.activeObj;
    const others = this.selectedObjs.filter((o) => o !== target);
    if (this.mode !== 'object' || !target || !others.length) return this.host.status('Verbinden: mehrere Objekte wählen (aktives zuletzt)', true);
    this.runOp('Verbinden', [], {}, () => {
      const inv = objectMatrix(target).invert();
      for (const o of others) {
        const m = o.mesh.clone();
        m.applyMatrix(inv.clone().multiply(objectMatrix(o)));
        target.mesh.append(m);
      }
      const ids = new Set(others.map((o) => o.id));
      this.doc.objects = this.doc.objects.filter((o) => !ids.has(o.id));
      this.selected = new Set([target.id]);
    });
  }

  private doApplyTransform(what: 'all' | 'scale' | 'rotscale' | 'loc'): void {
    const objs = this.selectedObjs;
    if (this.mode !== 'object' || !objs.length) return this.host.status('Anwenden: im Objektmodus Objekte wählen', true);
    const titles = { all: 'Alle Transformationen anwenden', scale: 'Skalierung anwenden', rotscale: 'Drehung & Skalierung anwenden', loc: 'Position anwenden' };
    this.runOp(titles[what], [], {}, () => {
      for (const o of objs) {
        const full = objectMatrix(o);
        const keep = new THREE.Matrix4();
        if (what === 'scale') keep.compose(o.pos, new THREE.Quaternion().setFromEuler(o.rot), new THREE.Vector3(1, 1, 1));
        else if (what === 'rotscale') keep.makeTranslation(o.pos.x, o.pos.y, o.pos.z);
        else if (what === 'loc') keep.compose(new THREE.Vector3(), new THREE.Quaternion().setFromEuler(o.rot), o.scale);
        o.mesh.applyMatrix(keep.clone().invert().multiply(full));
        const q = new THREE.Quaternion();
        keep.decompose(o.pos, q, o.scale);
        o.rot.setFromQuaternion(q);
      }
    });
  }

  /** Ursprung eines Objekts verschieben (Geometrie bleibt in der Welt stehen) */
  private doOrigin(where: 'center' | 'bottom' | 'world'): void {
    const objs = this.selectedObjs;
    if (this.mode !== 'object' || !objs.length) return this.host.status('Ursprung: im Objektmodus Objekte wählen', true);
    this.runOp('Ursprung setzen', [], {}, () => {
      for (const o of objs) {
        const b = o.mesh.bounds();
        if (b.isEmpty()) continue;
        const M = objectMatrix(o);
        let local: THREE.Vector3;
        if (where === 'world') local = new THREE.Vector3().applyMatrix4(M.clone().invert());
        else {
          local = b.getCenter(new THREE.Vector3());
          if (where === 'bottom') local.y = b.min.y;
        }
        for (const v of o.mesh.verts) v.sub(local);
        o.pos.copy(local.clone().applyMatrix4(M));
      }
    });
  }

  /** Ganzes Modell so verschieben, dass der Modell-Ursprung (Drehpunkt im Level) passt */
  private doModelOrigin(where: 'bottom' | 'center' | 'selection'): void {
    let target: THREE.Vector3 | null = null;
    if (where === 'selection') target = this.pivot();
    else {
      const box = new THREE.Box3();
      for (const o of this.doc.objects) if (o.visible) box.union(o.mesh.bounds().applyMatrix4(objectMatrix(o)));
      if (box.isEmpty()) return;
      target = box.getCenter(new THREE.Vector3());
      if (where === 'bottom') target.y = box.min.y;
    }
    if (!target) return this.host.status('Nichts ausgewählt', true);
    const t = target;
    this.runOp('Modell-Ursprung', [], {}, () => {
      for (const o of this.doc.objects) o.pos.sub(t);
    });
  }

  private doBoolean(op: BoolOp): void {
    const target = this.activeObj;
    const tools = this.selectedObjs.filter((o) => o !== target);
    if (this.mode !== 'object' || !target || tools.length !== 1) return this.host.status('Boolean: genau zwei Objekte wählen — das aktive (zuletzt geklickt) wird bearbeitet, das andere ist das Werkzeug', true);
    const toolId = tools[0].id;
    this.runOp(
      'Boolean',
      [
        { key: 'op', label: 'Art', type: 'select', options: BOOL_OPS },
        { key: 'del', label: 'Werkzeug löschen', type: 'bool' },
      ],
      { op, del: true },
      (v) => {
        const t = this.activeObj!;
        const tool = this.doc.objects.find((o) => o.id === toolId)!;
        const res = booleanMesh(t.mesh, objectMatrix(t), tool.mesh, objectMatrix(tool), v.op as BoolOp, (m) => m);
        if (!res.faces.length && v.op !== 'difference') throw new Error('Ergebnis ist leer');
        t.mesh = res;
        if (v.del) {
          this.doc.objects = this.doc.objects.filter((o) => o.id !== toolId);
          this.selected = new Set([t.id]);
        } else {
          tool.visible = false;
          this.selected = new Set([t.id]);
        }
      },
    );
  }

  private doMirror(axis: 0 | 1 | 2, symmetrize: boolean): void {
    const o = this.activeObj;
    if (!o) return;
    if (this.mode === 'edit') {
      if (!this.sel.v.size) return;
      this.runOp(`Spiegeln ${AXIS_NAMES[axis]}`, [], {}, () => {
        const ob = this.activeObj!;
        ops.mirrorSelection(ob.mesh, this.sel, axis, ops.selCenter(ob.mesh, this.sel));
      });
      return;
    }
    const objs = this.selectedObjs;
    this.runOp(symmetrize ? `Symmetrisieren ${AXIS_NAMES[axis]}` : `Spiegeln ${AXIS_NAMES[axis]}`, [], {}, () => {
      for (const ob of objs) {
        if (symmetrize) ops.mirrorMerge(ob.mesh, axis);
        else {
          const s = new THREE.Vector3(1, 1, 1).setComponent(axis, -1);
          ob.mesh.applyMatrix(new THREE.Matrix4().makeScale(s.x, s.y, s.z));
        }
      }
    });
  }

  private doNormals(kind: 'outside' | 'inside' | 'flip'): void {
    const o = this.activeObj;
    if (!o) return;
    const title = kind === 'flip' ? 'Normalen umdrehen' : kind === 'outside' ? 'Normalen nach außen' : 'Normalen nach innen';
    const inEdit = this.mode === 'edit';
    const targets = inEdit ? [o] : this.selectedObjs;
    this.runOp(title, [], {}, () => {
      for (const t of targets) {
        const only = inEdit && this.sel.f.size ? new Set(this.sel.f) : undefined;
        if (kind === 'flip') ops.flipFaces(t.mesh, only ?? t.mesh.faces.map((_, i) => i));
        else ops.recalcNormals(t.mesh, only, kind === 'inside');
      }
    });
  }

  private doDeleteObjects(): void {
    const ids = new Set(this.selected);
    if (!ids.size) return;
    this.runOp('Objekte löschen', [], {}, () => {
      this.doc.objects = this.doc.objects.filter((o) => !ids.has(o.id));
      this.selected.clear();
      if (this.activeId && ids.has(this.activeId)) this.activeId = this.doc.objects[0]?.id ?? null;
    });
  }

  private addPrimitive(kind: PrimitiveKind): void {
    const def = PRIMITIVES.find((p) => p.kind === kind)!;
    const p = primitiveDefaults(kind);
    const fields: OpField[] = [{ key: 'size', label: kind === 'cube' || kind === 'plane' || kind === 'grid' ? 'Größe' : 'Durchmesser', type: 'number', step: 0.05, min: 0.001 }];
    if (kind === 'cylinder' || kind === 'cone') fields.push({ key: 'height', label: 'Höhe', type: 'number', step: 0.05, min: 0.001 });
    if (kind === 'cone') fields.push({ key: 'radius2', label: 'Spitze (Anteil)', type: 'number', step: 0.05, min: 0, max: 2 });
    if (kind === 'torus') fields.push({ key: 'radius2', label: 'Rohr-Radius (Anteil)', type: 'number', step: 0.02, min: 0.01, max: 0.5 });
    if (['circle', 'cylinder', 'cone', 'sphere', 'torus'].includes(kind)) fields.push({ key: 'segments', label: 'Segmente', type: 'int', min: 3, max: 256 });
    if (kind === 'sphere') fields.push({ key: 'rings', label: 'Ringe', type: 'int', min: 3, max: 128 });
    if (kind === 'icosphere') fields.push({ key: 'rings', label: 'Unterteilungen', type: 'int', min: 1, max: 6 });
    if (kind === 'torus') fields.push({ key: 'rings', label: 'Rohr-Segmente', type: 'int', min: 3, max: 128 });
    if (kind === 'grid') fields.push({ key: 'rings', label: 'Unterteilungen', type: 'int', min: 1, max: 100 });
    if (['circle', 'cylinder', 'cone'].includes(kind)) fields.push({ key: 'fill', label: 'Deckel füllen', type: 'bool' });
    fields.push({ key: 'ground', label: 'Auf den Boden setzen', type: 'bool' });
    const values: OpValues = { ...p, ground: true };
    const inEdit = this.mode === 'edit' && !!this.activeObj;
    this.runOp(`${def.label} hinzufügen`, fields, values, (v) => {
      const params = { ...p, ...(v as unknown as typeof p) };
      const mesh = makePrimitive(kind, params, this.activeSlot);
      const lift = v.ground ? primitiveHalfHeight(kind, params) : 0;
      if (inEdit) {
        const o = this.activeObj!;
        mesh.applyMatrix(objectMatrix(o).invert().multiply(new THREE.Matrix4().makeTranslation(0, lift, 0)));
        const off = o.mesh.append(mesh);
        this.sel = ops.selFromVerts(
          o.mesh,
          mesh.verts.map((_, i) => off + i),
        );
      } else {
        const o = newObject(this.uniqueName(def.label), mesh);
        o.pos.y = lift;
        this.doc.objects.push(o);
        this.selected = new Set([o.id]);
        this.activeId = o.id;
      }
    });
  }

  private uniqueName(base: string): string {
    const names = new Set(this.doc.objects.map((o) => o.name));
    if (!names.has(base)) return base;
    for (let i = 1; ; i++) {
      const n = `${base}.${String(i).padStart(3, '0')}`;
      if (!names.has(n)) return n;
    }
  }

  private assignSlot(slot: number): void {
    const o = this.needEdit('Material zuweisen');
    if (!o) return;
    if (!this.sel.f.size) return this.host.status('Erst Flächen auswählen', true);
    this.runOp('Material zuweisen', [], {}, () => {
      for (const fi of this.sel.f) this.activeObj!.mesh.faces[fi].m = slot;
    });
  }

  private selectSlot(slot: number): void {
    const o = this.needEdit('Material auswählen');
    if (!o) return;
    const faces = o.mesh.faces.map((f, i) => (f.m === slot ? i : -1)).filter((i) => i >= 0);
    this.selMode = 'f';
    this.setSel(ops.selFromVerts(o.mesh, [...this.sel.v, ...ops.selFromFaces(o.mesh, faces).v]), 'Material auswählen');
  }

  // ---------- Speichern / Laden ----------

  async save(saveAs = false): Promise<string | null> {
    if (this.modal) this.modalEnd(true);
    let name = this.doc.name;
    if (saveAs || !this.doc.ref) {
      const n = await promptText(saveAs ? 'Speichern unter' : 'Modell speichern', 'Name im Content Browser (Modelle/Eigene)', name);
      if (!n?.trim()) return null;
      name = n.trim();
    }
    const ref = refForName(name);
    if (ref !== this.doc.ref) {
      const existing = await listImportedModels();
      if (existing.includes(ref) && !(await confirmDialog('Überschreiben?', `Es gibt schon ein Modell „${modelLabel(ref)}“. Ersetzen?`, 'Ersetzen', true))) return null;
    }
    this.doc.name = name;
    try {
      const saved = await saveDoc(this.doc);
      this.doc.ref = saved;
      this.setDirty(false);
      this.host.saved(saved);
      this.host.status(`Gespeichert: Modelle/Eigene/${modelLabel(saved)}`);
      this.renderSide();
      return saved;
    } catch (e) {
      console.error(e);
      this.host.status(`Speichern fehlgeschlagen: ${(e as Error).message}`, true);
      return null;
    }
  }

  private async importGlb(): Promise<void> {
    const file = await pickFile('.glb,.gltf');
    if (!file) return;
    try {
      const doc = await docFromGlb(await file.arrayBuffer(), file.name.replace(/\.(glb|gltf)$/i, ''));
      this.runOp('Importieren', [], {}, () => {
        const off = this.doc.materials.length;
        this.doc.materials.push(...doc.materials);
        for (const o of doc.objects) {
          for (const f of o.mesh.faces) f.m += off;
          o.name = this.uniqueName(o.name);
          this.doc.objects.push(o);
        }
        this.selected = new Set(doc.objects.map((o) => o.id));
        this.activeId = doc.objects[0]?.id ?? this.activeId;
        this.mode = 'object';
        this.rebuildMaterials();
      });
      this.frameSelected();
      this.host.status(`${doc.objects.length} Objekt(e) importiert`);
    } catch (e) {
      console.error(e);
      this.host.status(`Import fehlgeschlagen: ${(e as Error).message}`, true);
    }
  }

  private async exportFile(): Promise<void> {
    try {
      download(await exportGlb(this.doc), `${modelLabel(refForName(this.doc.name))}.glb`);
      this.host.status('Export als .glb heruntergeladen');
    } catch (e) {
      console.error(e);
      this.host.status(`Export fehlgeschlagen: ${(e as Error).message}`, true);
    }
  }

  private async placeInLevel(): Promise<void> {
    let ref = this.doc.ref;
    if (!ref || this.dirty) ref = (await this.save()) ?? undefined;
    if (ref) this.host.place(ref);
  }

  private openMenu(anchor: HTMLElement): void {
    const own = models.imported.filter((r) => r.startsWith(MODELER_PREFIX));
    const other = [...models.imported.filter((r) => !r.startsWith(MODELER_PREFIX)), ...models.project];
    const items: MenuItem[] = [{ heading: 'Eigene Modelle' }];
    if (!own.length) items.push({ label: '(noch keine)', disabled: true });
    for (const r of own) items.push({ label: modelLabel(r), icon: 'modeler', action: () => void this.open(r) });
    if (other.length) items.push({ separator: true }, { heading: 'Andere Modelle (werden übernommen)' });
    for (const r of other) items.push({ label: modelLabel(r), icon: 'model', action: () => void this.open(r) });
    showMenu(items, anchor);
  }

  // ---------- Tastatur ----------

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    const t = e.target as HTMLElement | null;
    if (this.modal) return this.modalKey(e);
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.modal-back:not(.hidden)')) return;
    if (isMenuOpen() && e.key !== 'Escape') return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const edit = this.mode === 'edit';
    let handled = true;
    // Ansicht (Ziffernblock)
    if (e.code.startsWith('Numpad')) {
      const n = e.code.slice(6);
      if (n === '1') this.view.setView(ctrl ? 'back' : 'front');
      else if (n === '3') this.view.setView(ctrl ? 'left' : 'right');
      else if (n === '7') this.view.setView(ctrl ? 'bottom' : 'top');
      else if (n === '5') this.view.toggleOrtho();
      else if (n === 'Decimal') this.frameSelected();
      else if (n === 'Add' && ctrl) this.grow(true);
      else if (n === 'Subtract' && ctrl) this.grow(false);
      else if (n === 'Add') this.view.zoom(0.85);
      else if (n === 'Subtract') this.view.zoom(1.15);
      else handled = false;
    } else if (ctrl && k === 'z' && !e.shiftKey) this.undo();
    else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) this.redo();
    else if (ctrl && k === 's') void this.save(e.shiftKey);
    else if (ctrl && k === 'i') this.selectInvert();
    else if (ctrl && k === 'b') this.doBevel();
    else if (ctrl && k === 'r') {
      if (this.needEdit('Loop Cut')) this.setTool('loopcut');
    } else if (ctrl && k === 'j') this.doJoin();
    else if (ctrl && k === 'a') showMenu(this.applyItems(), this.menuPos());
    else if (ctrl && k === 'l') this.selectLinked(false);
    else if (ctrl && (e.key === '+' || e.key === '=')) this.grow(true);
    else if (ctrl && e.key === '-') this.grow(false);
    else if (ctrl) handled = false;
    else if (e.key === 'Tab') this.setMode(edit ? 'object' : 'edit');
    else if (edit && (e.key === '1' || e.key === '2' || e.key === '3')) this.setSelMode((['v', 'e', 'f'] as const)[Number(e.key) - 1]);
    else if (k === 'a' && e.altKey) this.selectNone();
    else if (k === 'a' && e.shiftKey) showMenu(this.addItems(), this.menuPos());
    else if (k === 'a') this.selectAll();
    else if (k === 'z' && e.altKey) this.toggleXray();
    else if (k === 'g') this.startModal('grab', 'Verschieben');
    else if (k === 'r') this.startModal('rotate', 'Drehen');
    else if (k === 's' && !e.shiftKey) this.startModal('scale', 'Skalieren');
    else if (k === 'd' && e.shiftKey) this.doDuplicate();
    else if (k === 'e' && edit) this.doExtrude();
    else if (k === 'i' && edit) this.doInset();
    else if (k === 'f' && edit) this.doFill();
    else if (k === 'm' && edit) showMenu(this.mergeItems(), this.menuPos());
    else if (k === 'p' && edit) this.doSeparate();
    else if (k === 'l' && edit) this.selectLinked(true);
    else if (k === 'n' && e.shiftKey) this.doNormals('outside');
    else if (k === 'n' && e.altKey) this.doNormals('flip');
    else if (k === 'x' || e.key === 'Delete') {
      if (edit) showMenu(this.deleteItems(), this.menuPos());
      else this.doDeleteObjects();
    } else if (e.key === 'Home') this.frameAll();
    else if (e.key === 'Escape') {
      if (this.tool === 'loopcut') {
        this.setTool('select');
        this.view.setLines('loopcut', [], '#ffd34d');
      } else if (isMenuOpen()) closeMenus();
      else handled = false;
    } else if (k === 'w') this.setTool(this.tool === 'select' ? 'move' : this.tool === 'move' ? 'rotate' : this.tool === 'rotate' ? 'scale' : 'select');
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private menuPos(): { x: number; y: number } {
    const r = this.view.canvas.getBoundingClientRect();
    return this.mouse.inside ? { x: r.left + this.mouse.x, y: r.top + this.mouse.y } : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  private grow(more: boolean): void {
    const o = this.activeObj;
    if (this.mode !== 'edit' || !o) return;
    this.setSel(ops.growSel(o.mesh, this.sel, more), more ? 'Auswahl erweitern' : 'Auswahl verkleinern');
  }

  private selectLinked(underMouse: boolean): void {
    const o = this.activeObj;
    if (this.mode !== 'edit' || !o) return;
    let seeds: number[] = [...this.sel.v];
    if (underMouse) {
      const fi = this.view.pickFace(o, this.mouse.x, this.mouse.y);
      const vi = fi >= 0 ? -1 : this.view.pickVert(o, this.mouse.x, this.mouse.y, 20);
      if (fi < 0 && vi < 0) return;
      seeds = fi >= 0 ? o.mesh.faces[fi].v : [vi];
      const s = ops.selectLinked(o.mesh, seeds);
      this.setSel(ops.selFromVerts(o.mesh, [...this.sel.v, ...s.v]), 'Verbundenes auswählen');
      return;
    }
    this.setSel(ops.selectLinked(o.mesh, seeds), 'Verbundenes auswählen');
  }

  private setTool(t: Tool): void {
    this.tool = t;
    if (t !== 'loopcut') this.view.setLines('loopcut', [], '#ffd34d');
    this.refresh(false);
  }

  private toggleXray(): void {
    this.view.setXray(!this.view.xray);
    this.rebuildMaterials();
    this.view.setMaterials(this.displayMats);
    this.refresh(false);
  }

  // ---------- Menüs ----------

  private addItems(): MenuItem[] {
    return [{ heading: this.mode === 'edit' ? 'Netz hinzufügen (ins Objekt)' : 'Netz hinzufügen' }, ...PRIMITIVES.map((p) => ({ label: p.label, icon: p.icon, action: () => this.addPrimitive(p.kind) }))];
  }

  private deleteItems(): MenuItem[] {
    return [
      { heading: 'Löschen' },
      { label: 'Punkte', action: () => this.doDelete('v') },
      { label: 'Kanten', action: () => this.doDelete('e') },
      { label: 'Flächen', action: () => this.doDelete('f') },
      { label: 'Nur Flächen', action: () => this.doDelete('onlyFaces') },
      { separator: true },
      { label: 'Punkte auflösen', action: () => this.doDelete('dissolveV') },
      { label: 'Kanten auflösen', action: () => this.doDelete('dissolveE') },
    ];
  }

  private mergeItems(): MenuItem[] {
    return [
      { heading: 'Zusammenführen' },
      { label: 'In der Mitte', action: () => this.doMerge('center') },
      { label: 'Nach Abstand', action: () => this.doMerge('distance') },
    ];
  }

  private applyItems(): MenuItem[] {
    return [
      { heading: 'Transformation anwenden' },
      { label: 'Alles', action: () => this.doApplyTransform('all') },
      { label: 'Position', action: () => this.doApplyTransform('loc') },
      { label: 'Drehung & Skalierung', action: () => this.doApplyTransform('rotscale') },
      { label: 'Skalierung', action: () => this.doApplyTransform('scale') },
    ];
  }

  private meshItems(): MenuItem[] {
    if (this.mode === 'edit') {
      return [
        { heading: 'Netz bearbeiten' },
        { label: 'Extrudieren', key: 'E', icon: 'extrude', action: () => this.doExtrude() },
        { label: 'Inset', key: 'I', icon: 'inset', action: () => this.doInset() },
        { label: 'Abschrägen', key: 'Strg+B', icon: 'bevel', action: () => this.doBevel() },
        { label: 'Loop Cut', key: 'Strg+R', icon: 'loopcut', action: () => this.setTool('loopcut') },
        { label: 'Unterteilen', icon: 'subdivide', action: () => this.doSubdivide() },
        { label: 'Glätten (Subdivision)', action: () => this.doSmoothSubdiv() },
        { label: 'Füllen', key: 'F', icon: 'fill', action: () => this.doFill() },
        { label: 'Duplizieren', key: 'Umschalt+D', action: () => this.doDuplicate() },
        { label: 'Trennen (neues Objekt)', key: 'P', action: () => this.doSeparate() },
        { separator: true },
        ...this.mergeItems().slice(1).map((i) => ({ ...i, label: `Zusammenführen: ${i.label}`, key: i.label === 'In der Mitte' ? 'M' : undefined })),
        { separator: true },
        { label: 'Spiegeln X', icon: 'mirror', action: () => this.doMirror(0, false) },
        { label: 'Spiegeln Y', action: () => this.doMirror(1, false) },
        { label: 'Spiegeln Z', action: () => this.doMirror(2, false) },
        { separator: true },
        { label: 'Normalen nach außen', key: 'Umschalt+N', action: () => this.doNormals('outside') },
        { label: 'Normalen nach innen', action: () => this.doNormals('inside') },
        { label: 'Normalen umdrehen', key: 'Alt+N', action: () => this.doNormals('flip') },
        { separator: true },
        ...this.deleteItems().slice(1).map((i) => (i.separator ? i : { ...i, label: `Löschen: ${i.label}` })),
      ];
    }
    return [
      { heading: 'Objekt' },
      { label: 'Duplizieren', key: 'Umschalt+D', action: () => this.doDuplicate() },
      { label: 'Verbinden', key: 'Strg+J', action: () => this.doJoin() },
      { label: 'Löschen', key: 'X', icon: 'trash', action: () => this.doDeleteObjects() },
      { separator: true },
      { heading: 'Boolean (aktives Objekt ← anderes)' },
      ...BOOL_OPS.map((b) => ({ label: b.label, icon: b.value === 'difference' ? 'subtract' : b.value === 'intersect' ? 'intersect' : 'plus', action: () => this.doBoolean(b.value) })),
      { separator: true },
      { label: 'Glätten (Subdivision)', action: () => this.doSmoothSubdiv() },
      { label: 'Symmetrisieren X', icon: 'mirror', action: () => this.doMirror(0, true) },
      { label: 'Symmetrisieren Z', action: () => this.doMirror(2, true) },
      { label: 'Spiegeln X', action: () => this.doMirror(0, false) },
      { label: 'Spiegeln Y', action: () => this.doMirror(1, false) },
      { label: 'Spiegeln Z', action: () => this.doMirror(2, false) },
      { separator: true },
      ...this.applyItems().slice(1).map((i) => ({ ...i, label: `Anwenden: ${i.label}` })),
      { separator: true },
      { label: 'Ursprung → Mitte der Geometrie', action: () => this.doOrigin('center') },
      { label: 'Ursprung → Boden-Mitte der Geometrie', action: () => this.doOrigin('bottom') },
      { label: 'Ursprung → Weltmitte', action: () => this.doOrigin('world') },
      { separator: true },
      { label: 'Normalen nach außen', key: 'Umschalt+N', action: () => this.doNormals('outside') },
      { label: 'Normalen umdrehen', key: 'Alt+N', action: () => this.doNormals('flip') },
    ];
  }

  private selectItems(): MenuItem[] {
    const edit = this.mode === 'edit';
    const items: MenuItem[] = [
      { heading: 'Auswahl' },
      { label: 'Alles', key: 'A', action: () => this.selectAll() },
      { label: 'Nichts', key: 'Alt+A', action: () => this.selectNone() },
      { label: 'Umkehren', key: 'Strg+I', action: () => this.selectInvert() },
    ];
    if (edit) {
      items.push(
        { label: 'Verbundenes', key: 'Strg+L', action: () => this.selectLinked(false) },
        { label: 'Mehr', key: 'Strg++', action: () => this.grow(true) },
        { label: 'Weniger', key: 'Strg+-', action: () => this.grow(false) },
        { label: 'Schleife: Alt+Klick · Ring: Strg+Alt+Klick', disabled: true },
      );
    }
    return items;
  }

  private viewItems(): MenuItem[] {
    const v = (n: ViewName, label: string, key: string): MenuItem => ({ label, key, action: () => this.view.setView(n) });
    return [
      { heading: 'Ansicht' },
      v('front', 'Vorne', 'Num 1'),
      v('back', 'Hinten', 'Strg+Num 1'),
      v('right', 'Rechts', 'Num 3'),
      v('left', 'Links', 'Strg+Num 3'),
      v('top', 'Oben', 'Num 7'),
      v('bottom', 'Unten', 'Strg+Num 7'),
      { label: 'Perspektive/Orthografisch', key: 'Num 5', action: () => this.view.toggleOrtho() },
      { separator: true },
      { label: 'Auswahl einpassen', key: 'Num ,', action: () => this.frameSelected() },
      { label: 'Alles einpassen', key: 'Pos1', action: () => this.frameAll() },
      { label: 'Röntgen (durchsichtig)', key: 'Alt+Z', checked: this.view.xray, action: () => this.toggleXray() },
      { separator: true },
      { heading: 'Navigation' },
      { label: 'Drehen: mittlere/rechte Maustaste ziehen', disabled: true },
      { label: 'Verschieben: Umschalt + mittlere/rechte Taste', disabled: true },
      { label: 'Zoom: Mausrad · Strg + mittlere Taste', disabled: true },
    ];
  }

  private contextItems(): MenuItem[] {
    if (this.mode === 'edit') {
      const m = this.selMode;
      const items: MenuItem[] = [{ heading: m === 'v' ? 'Punkte' : m === 'e' ? 'Kanten' : 'Flächen' }];
      items.push({ label: 'Extrudieren', key: 'E', icon: 'extrude', action: () => this.doExtrude() });
      if (m === 'f') items.push({ label: 'Inset', key: 'I', icon: 'inset', action: () => this.doInset() }, { label: 'Unterteilen', icon: 'subdivide', action: () => this.doSubdivide() });
      if (m !== 'v') items.push({ label: 'Abschrägen', key: 'Strg+B', icon: 'bevel', action: () => this.doBevel() });
      if (m === 'e') items.push({ label: 'Kanten auflösen', action: () => this.doDelete('dissolveE') });
      if (m === 'v') items.push({ label: 'Punkte auflösen', action: () => this.doDelete('dissolveV') });
      items.push(
        { label: 'Füllen', key: 'F', icon: 'fill', action: () => this.doFill() },
        { label: 'Zusammenführen (Mitte)', key: 'M', icon: 'merge', action: () => this.doMerge('center') },
        { label: 'Duplizieren', key: 'Umschalt+D', action: () => this.doDuplicate() },
        { label: 'Trennen', key: 'P', action: () => this.doSeparate() },
        { separator: true },
        { label: 'Verschieben', key: 'G', action: () => this.startModal('grab', 'Verschieben') },
        { label: 'Drehen', key: 'R', action: () => this.startModal('rotate', 'Drehen') },
        { label: 'Skalieren', key: 'S', action: () => this.startModal('scale', 'Skalieren') },
        { separator: true },
      );
      if (this.doc.materials.length > 1 && m === 'f') {
        items.push({ heading: 'Material zuweisen' });
        this.doc.materials.forEach((s, i) => items.push({ label: s.name, action: () => this.assignSlot(i) }));
        items.push({ separator: true });
      }
      items.push({ label: 'Löschen …', key: 'X', icon: 'trash', action: () => showMenu(this.deleteItems(), this.menuPos()) });
      return items;
    }
    return [
      { label: 'Bearbeiten', key: 'Tab', icon: 'editMode', disabled: !this.activeObj, action: () => this.setMode('edit') },
      { separator: true },
      ...this.meshItems().slice(1),
      { separator: true },
      ...this.addItems(),
    ];
  }

  // ---------- Oberfläche ----------

  private tbButton(iconName: string, label: string, title: string, action: () => void, active = false, disabled = false): HTMLButtonElement {
    const b = h('button', { class: `tb-button${active ? ' active' : ''}`, title }, iconEl(iconName), label ? h('span', {}, label) : '');
    b.disabled = disabled;
    b.addEventListener('click', action);
    return b;
  }

  private renderToolbar(): void {
    const edit = this.mode === 'edit';
    const menuBtn = (label: string, items: () => MenuItem[]) => {
      const b = h('button', { class: 'tb-button md-menu' }, h('span', {}, label), h('span', { class: 'md-caret' }, '▾'));
      b.addEventListener('click', () => showMenu(items(), b));
      return b;
    };
    const openBtn = this.tbButton('open', 'Öffnen', 'Gespeichertes Modell öffnen (auch Modelle aus dem Content Browser)', () => this.openMenu(openBtn));
    this.toolbar.replaceChildren(
      this.tbButton('plus', 'Neu', 'Neues Modell', () => void this.askNew()),
      openBtn,
      this.tbButton('save', 'Speichern', 'Im Content Browser speichern (Strg+S)', () => void this.save()),
      this.tbButton('save', 'Speichern unter', 'Unter neuem Namen speichern (Strg+Umschalt+S)', () => void this.save(true)),
      h('div', { class: 'tb-sep' }),
      this.tbButton('upload', 'Import', '.glb-Datei ins Modell importieren', () => void this.importGlb()),
      this.tbButton('download', 'Export', 'Als .glb herunterladen (mit Texturen)', () => void this.exportFile()),
      h('div', { class: 'tb-sep' }),
      this.tbButton('undo', '', 'Rückgängig (Strg+Z)', () => this.undo(), false, !this.history.canUndo),
      this.tbButton('redo', '', 'Wiederholen (Strg+Y)', () => this.redo(), false, !this.history.canRedo),
      h('div', { class: 'tb-sep' }),
      h(
        'div',
        { class: 'tb-group' },
        this.tbButton('objectMode', 'Objekt', 'Objektmodus (Tab)', () => this.setMode('object'), !edit),
        this.tbButton('editMode', 'Bearbeiten', 'Bearbeitungsmodus (Tab)', () => this.setMode('edit'), edit, !this.activeObj),
      ),
      edit
        ? h(
            'div',
            { class: 'tb-group' },
            this.tbButton('vertex', '', 'Punkte (1)', () => this.setSelMode('v'), this.selMode === 'v'),
            this.tbButton('edge', '', 'Kanten (2)', () => this.setSelMode('e'), this.selMode === 'e'),
            this.tbButton('face', '', 'Flächen (3)', () => this.setSelMode('f'), this.selMode === 'f'),
          )
        : '',
      h('div', { class: 'tb-sep' }),
      menuBtn('Ansicht', () => this.viewItems()),
      menuBtn('Auswahl', () => this.selectItems()),
      menuBtn('Hinzufügen', () => this.addItems()),
      menuBtn(edit ? 'Netz' : 'Objekt', () => this.meshItems()),
      h('div', { class: 'tb-spacer' }),
      this.tbButton('magnet', 'Raster', 'Am Raster einrasten (0,1 m · 15° · 0,1) — Strg kehrt es beim Ziehen um', () => {
        this.snapOn = !this.snapOn;
        this.refresh(false);
      }, this.snapOn),
      this.tbButton('xray', 'Röntgen', 'Durchsichtig: auch verdeckte Punkte auswählen (Alt+Z)', () => this.toggleXray(), this.view.xray),
      h('div', { class: 'tb-sep' }),
      this.tbButton('levelPlace', 'Im Level platzieren', 'Speichern und im Level-Tab platzieren', () => void this.placeInLevel()),
    );
  }

  private async askNew(): Promise<void> {
    if (this.dirty && !(await confirmDialog('Neues Modell', 'Ungespeicherte Änderungen verwerfen?', 'Verwerfen', true))) return;
    this.newModel();
    this.host.status('Neues Modell');
  }

  private renderShelf(): void {
    const edit = this.mode === 'edit';
    const tool = (t: Tool, ic: string, title: string) => this.tbButton(ic, '', title, () => this.setTool(t), this.tool === t);
    const op = (ic: string, title: string, fn: () => void) => this.tbButton(ic, '', title, fn);
    this.shelf.replaceChildren(
      tool('select', 'select', 'Auswählen (W wechselt) — Klick, Rahmen ziehen, Umschalt = hinzufügen'),
      tool('move', 'move', 'Verschieben-Gizmo (G für frei)'),
      tool('rotate', 'rotate', 'Drehen-Gizmo (R für frei)'),
      tool('scale', 'scale', 'Skalieren-Gizmo (S für frei)'),
      h('div', { class: 'md-shelf-sep' }),
      ...(edit
        ? [
            op('extrude', 'Extrudieren (E)', () => this.doExtrude()),
            op('inset', 'Inset (I) — Flächen', () => this.doInset()),
            op('bevel', 'Abschrägen (Strg+B) — Kanten', () => this.doBevel()),
            tool('loopcut', 'loopcut', 'Loop Cut (Strg+R) — über Kante fahren, klicken'),
            op('subdivide', 'Unterteilen — Flächen', () => this.doSubdivide()),
            op('fill', 'Füllen (F)', () => this.doFill()),
            op('merge', 'Zusammenführen (M)', () => showMenu(this.mergeItems(), this.menuPos())),
          ]
        : [op('cube', 'Würfel hinzufügen (Umschalt+A für mehr)', () => this.addPrimitive('cube')), op('cylinder', 'Zylinder hinzufügen', () => this.addPrimitive('cylinder')), op('sphere', 'Kugel hinzufügen', () => this.addPrimitive('sphere'))]),
      h('div', { class: 'md-shelf-sep' }),
      op('frame', 'Auswahl einpassen (Num ,)', () => this.frameSelected()),
    );
  }

  private renderRedo(): void {
    const op = this.lastOp;
    if (!op || this.modal) {
      this.redoPanel.classList.add('hidden');
      return;
    }
    this.redoPanel.classList.remove('hidden');
    const rows = op.fields.map((f) => {
      const val = op.values[f.key];
      let input: HTMLElement;
      if (f.type === 'bool') {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = !!val;
        cb.addEventListener('change', () => this.rerunOp({ ...op.values, [f.key]: cb.checked }));
        input = cb;
      } else if (f.type === 'select') {
        const s = h('select', {}, ...(f.options ?? []).map((o) => h('option', { value: o.value }, o.label)));
        s.value = String(val);
        s.addEventListener('change', () => this.rerunOp({ ...op.values, [f.key]: s.value }));
        input = s;
      } else {
        input = numberField({
          value: val as number,
          step: f.type === 'int' ? 1 : f.step ?? 0.1,
          min: f.min,
          max: f.max,
          onChange: (v, live) => {
            const nv = f.type === 'int' ? Math.round(v) : v;
            if (live && op.title.endsWith('hinzufügen') === false && op.fields.length > 3) return;
            this.rerunOp({ ...op.values, [f.key]: nv });
            void live;
          },
        });
      }
      return h('div', { class: 'prop-row' }, h('label', {}, f.label), h('div', { class: 'value' }, input));
    });
    const head = h('div', { class: 'md-redo-head' }, op.title);
    head.addEventListener('click', () => this.redoPanel.classList.toggle('collapsed'));
    this.redoPanel.replaceChildren(head, h('div', { class: 'md-redo-body' }, ...rows));
  }

  // --- Seitenleiste ---

  private section(title: string, ...rows: (HTMLElement | null | false)[]): HTMLElement {
    const sec = h('div', { class: `section${this.collapsed.has(title) ? ' collapsed' : ''}` });
    const head = h('div', { class: 'section-head' }, title);
    head.addEventListener('click', () => {
      sec.classList.toggle('collapsed');
      if (sec.classList.contains('collapsed')) this.collapsed.add(title);
      else this.collapsed.delete(title);
    });
    sec.append(head, h('div', { class: 'section-body' }, ...rows.filter((r): r is HTMLElement => !!r)));
    return sec;
  }

  private row(label: string, ...value: (Node | string)[]): HTMLElement {
    return h('div', { class: 'prop-row' }, h('label', { title: label }, label), h('div', { class: 'value' }, ...value));
  }

  private vecRow(label: string, v: THREE.Vector3 | THREE.Euler, step: number, scale: number, apply: (axis: 'x' | 'y' | 'z', val: number, live: boolean) => void): HTMLElement {
    return this.row(
      label,
      ...(['x', 'y', 'z'] as const).map((a) => numberField({ value: (v[a] as number) * scale, step, axis: a, onChange: (val, live) => apply(a, val / scale, live) })),
    );
  }

  private renderSide(): void {
    const scroll = this.side.scrollTop;
    this.side.replaceChildren(
      h('div', { class: 'panel-tabs' }, h('div', { class: 'panel-tab active' }, iconEl('modeler'), 'Modell')),
      h('div', { class: 'panel-body md-side-body' }, this.objectsSection(), this.propsSection(), this.mirrorSection(), this.materialsSection(), this.modelSection()),
    );
    const body = this.side.querySelector('.md-side-body');
    if (body) body.scrollTop = scroll;
  }

  private objectsSection(): HTMLElement {
    const list = h('div', { class: 'md-objects' });
    for (const o of this.doc.objects) {
      const eye = h('span', { class: 'md-eye', title: 'Sichtbar', html: '' }, iconEl(o.visible ? 'eye' : 'eyeOff'));
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        o.visible = !o.visible;
        if (!o.visible && this.mode === 'edit' && o.id === this.activeId) this.mode = 'object';
        this.view.syncTransform(o);
        this.commit(o.visible ? 'Einblenden' : 'Ausblenden');
      });
      const rowEl = h(
        'div',
        { class: `md-obj${this.selected.has(o.id) ? ' selected' : ''}${o.id === this.activeId ? ' active' : ''}` },
        iconEl('cube'),
        h('span', { class: 'md-obj-name' }, o.name),
        h('span', { class: 'md-obj-sub' }, `${o.mesh.faces.length} F`),
        eye,
      );
      rowEl.addEventListener('click', (e) => {
        if (this.mode === 'edit' && o.id !== this.activeId) this.mode = 'object';
        this.selectObject(o.id, e.shiftKey || e.ctrlKey);
      });
      rowEl.addEventListener('dblclick', async () => {
        const n = await promptText('Umbenennen', 'Name', o.name);
        if (n?.trim()) {
          o.name = n.trim();
          this.commit('Umbenennen');
        }
      });
      list.append(rowEl);
    }
    if (!this.doc.objects.length) list.append(h('div', { class: 'empty-hint' }, 'Leer — Umschalt+A fügt Grundkörper hinzu'));
    return this.section('Objekte', list);
  }

  private propsSection(): HTMLElement {
    const o = this.activeObj;
    if (!o) return this.section('Eigenschaften', h('div', { class: 'empty-hint' }, 'Kein Objekt gewählt'));
    if (this.mode === 'edit') {
      const c = ops.selCenter(o.mesh, this.sel);
      const rows: HTMLElement[] = [];
      if (this.sel.v.size) {
        const base = c.clone();
        let snapB: Map<number, THREE.Vector3> | null = null;
        rows.push(
          this.vecRow(this.sel.v.size === 1 ? 'Punkt' : 'Mitte', c, 0.05, 1, (a, val, live) => {
            if (!snapB) snapB = new Map([...this.sel.v].map((i) => [i, o.mesh.verts[i].clone()]));
            const d = val - base[a];
            for (const [i, p] of snapB) {
              o.mesh.verts[i][a] = p[a] + d;
              if (o.mirrorClip) ops.clipToMirror(o.mesh.verts[i], p, o.mirror);
            }
            this.view.syncObject(o, this.displayMats);
            this.view.setEdit(o, this.sel, this.selMode);
            if (!live) {
              snapB = null;
              this.commit('Punkte verschieben');
            }
          }),
        );
        rows.push(h('div', { class: 'md-hint' }, 'Koordinaten im lokalen Raum des Objekts'));
      } else rows.push(h('div', { class: 'empty-hint' }, 'Nichts ausgewählt — Klick, Rahmen ziehen oder A'));
      if (this.sel.f.size) {
        const s = h('select', {}, ...this.doc.materials.map((m, i) => h('option', { value: String(i) }, m.name)));
        const used = new Set([...this.sel.f].map((fi) => o.mesh.faces[fi]?.m));
        s.value = used.size === 1 ? String([...used][0]) : '';
        s.addEventListener('change', () => this.assignSlot(Number(s.value)));
        rows.push(this.row('Material', s));
      }
      return this.section('Auswahl', ...rows);
    }
    const name = h('input', { type: 'text', value: o.name });
    name.addEventListener('change', () => {
      o.name = name.value.trim() || o.name;
      this.commit('Umbenennen');
    });
    const smooth = h('input', { type: 'checkbox' });
    smooth.checked = o.smooth;
    smooth.addEventListener('change', () => {
      o.smooth = smooth.checked;
      this.view.syncObject(o, this.displayMats);
      this.commit('Schattierung');
    });
    const size = o.mesh.bounds().getSize(new THREE.Vector3()).multiply(o.scale);
    const tf = (live: boolean, label: string) => {
      this.view.syncTransform(o);
      this.view.setObjectOutlines(this.selectedObjs, o);
      this.updateGizmo();
      if (!live) {
        this.view.syncObject(o, this.displayMats);
        this.commit(label);
      }
    };
    return this.section(
      'Eigenschaften',
      this.row('Name', name),
      this.vecRow('Position', o.pos, 0.05, 1, (a, v, live) => {
        o.pos[a] = v;
        tf(live, 'Position');
      }),
      this.vecRow('Drehung °', o.rot, 5, 1 / DEG, (a, v, live) => {
        o.rot[a] = v;
        tf(live, 'Drehung');
      }),
      this.vecRow('Skalierung', o.scale, 0.05, 1, (a, v, live) => {
        o.scale[a] = v;
        tf(live, 'Skalierung');
      }),
      this.row('Abmessungen', h('span', { class: 'md-dim' }, `${fmt(Math.abs(size.x))} × ${fmt(Math.abs(size.y))} × ${fmt(Math.abs(size.z))} m`)),
      this.row('Glatt schattieren', smooth),
      o.smooth
        ? this.row(
            'Winkelgrenze °',
            numberField({
              value: o.smoothAngle,
              step: 5,
              min: 0,
              max: 180,
              onChange: (v, live) => {
                o.smoothAngle = v;
                this.view.syncObject(o, this.displayMats);
                if (!live) this.commit('Glättungswinkel');
              },
            }),
          )
        : null,
    );
  }

  /** Live-Spiegel des aktiven Objekts: in Objekt- und Edit-Modus umschaltbar, während man modelliert */
  private mirrorSection(): HTMLElement | null {
    const o = this.activeObj;
    if (!o) return null;
    const axisBtn = (a: 0 | 1 | 2) => {
      const b = this.smallBtn('', AXIS_NAMES[a], `Live an der lokalen ${AXIS_NAMES[a]}-Achse spiegeln (durch den Objekt-Ursprung)`, () => this.toggleLiveMirror(a));
      b.classList.toggle('active', o.mirror[a]);
      return b;
    };
    const clip = h('input', { type: 'checkbox' });
    clip.checked = o.mirrorClip;
    clip.addEventListener('change', () => {
      o.mirrorClip = clip.checked;
      this.commit('Spiegel-Clipping');
    });
    const on = o.mirror.some(Boolean);
    return this.section(
      'Spiegeln (live)',
      this.row('Achsen', h('div', { class: 'md-btns' }, axisBtn(0), axisBtn(1), axisBtn(2))),
      on ? this.row('Clipping', clip) : null,
      on ? h('div', { class: 'md-btns' }, this.smallBtn('mirror', 'Anwenden', 'Spiegelung fest ins Netz übernehmen (Naht wird verschweißt)', () => this.applyLiveMirror())) : null,
      h('div', { class: 'md-hint' }, on ? 'Du bearbeitest eine Seite, die andere folgt live. Clipping hält Punkte an der Spiegelebene fest. Export und Kollision nutzen das gespiegelte Modell.' : 'Spiegelt das Objekt live, während du modellierst (Ebene durch den Objekt-Ursprung).'),
    );
  }

  private toggleLiveMirror(axis: 0 | 1 | 2): void {
    const o = this.activeObj;
    if (!o) return;
    o.mirror[axis] = !o.mirror[axis];
    this.view.syncObject(o, this.displayMats);
    this.commit(`Live-Spiegel ${AXIS_NAMES[axis]} ${o.mirror[axis] ? 'an' : 'aus'}`);
  }

  private applyLiveMirror(): void {
    const o = this.activeObj;
    if (!o || !o.mirror.some(Boolean)) return;
    o.mesh = ops.mirroredMesh(o.mesh, o.mirror);
    o.mirror = [false, false, false];
    if (this.mode === 'edit') this.sel = ops.emptySel();
    this.view.syncObject(o, this.displayMats);
    if (this.mode === 'edit') this.view.setEdit(o, this.sel, this.selMode);
    this.commit('Live-Spiegel anwenden');
  }

  private materialsSection(): HTMLElement {
    const list = h('div', { class: 'md-slots' });
    const edit = this.mode === 'edit';
    this.doc.materials.forEach((s, i) => {
      const swatch = h('span', { class: 'md-swatch', style: `background:${s.color}` });
      const rowEl = h('div', { class: `md-slot${i === this.activeSlot ? ' active' : ''}` }, swatch, h('span', { class: 'md-slot-name' }, s.name), h('span', { class: 'md-obj-sub' }, MATERIAL_OPTIONS.find((m) => m.value === s.material)?.label ?? s.material));
      rowEl.addEventListener('click', () => {
        this.activeSlot = i;
        this.renderSide();
      });
      list.append(rowEl);
    });
    const slot = this.doc.materials[this.activeSlot];
    const rows: (HTMLElement | null)[] = [list];
    const btns = h(
      'div',
      { class: 'md-btns' },
      this.smallBtn('plus', 'Slot', 'Neuen Material-Slot anlegen', () => {
        this.doc.materials.push(defaultSlot('farbe', `Material ${this.doc.materials.length + 1}`));
        this.activeSlot = this.doc.materials.length - 1;
        this.materialsChanged('Material-Slot hinzufügen');
      }),
      this.smallBtn('trash', '', 'Slot entfernen (Flächen bekommen den ersten Slot)', () => {
        if (this.doc.materials.length < 2) return;
        const rm = this.activeSlot;
        this.doc.materials.splice(rm, 1);
        for (const o of this.doc.objects) for (const f of o.mesh.faces) f.m = f.m === rm ? 0 : f.m > rm ? f.m - 1 : f.m;
        this.activeSlot = Math.max(0, rm - 1);
        this.materialsChanged('Material-Slot entfernen');
      }),
      edit ? this.smallBtn('', 'Zuweisen', 'Gewählten Flächen diesen Slot geben', () => this.assignSlot(this.activeSlot)) : '',
      edit ? this.smallBtn('', 'Auswählen', 'Flächen mit diesem Slot auswählen', () => this.selectSlot(this.activeSlot)) : '',
    );
    rows.push(btns);
    if (slot) {
      const name = h('input', { type: 'text', value: slot.name });
      name.addEventListener('change', () => {
        slot.name = name.value.trim() || slot.name;
        this.materialsChanged('Material umbenennen');
      });
      const matSel = h('select', {}, ...MATERIAL_OPTIONS.map((m) => h('option', { value: m.value }, m.label)));
      matSel.value = slot.material;
      matSel.addEventListener('change', () => {
        slot.material = matSel.value;
        slot.color = defaultColorFor(slot.material);
        if (slot.material === 'farbe') slot.color = '#b4b4b4';
        this.materialsChanged('Material ändern');
      });
      const color = h('input', { type: 'color', value: slot.color });
      color.addEventListener('input', () => {
        slot.color = color.value;
        this.materialsChanged('', true);
      });
      color.addEventListener('change', () => this.materialsChanged('Farbe ändern'));
      rows.push(
        this.row('Name', name),
        this.row('Material', matSel),
        this.row('Farbe / Tönung', color),
        this.row(
          'Textur-Maßstab',
          numberField({
            value: slot.uvScale,
            step: 0.1,
            min: 0.01,
            onChange: (v, live) => {
              slot.uvScale = v;
              this.materialsChanged('Textur-Maßstab', live);
            },
          }),
        ),
      );
      if (slot.material === 'farbe' || slot.material === 'metall') {
        rows.push(
          this.row(
            'Rauheit',
            numberField({
              value: slot.roughness ?? (slot.material === 'metall' ? 0.45 : 0.75),
              step: 0.05,
              min: 0,
              max: 1,
              onChange: (v, live) => {
                slot.roughness = v;
                this.materialsChanged('Rauheit', live);
              },
            }),
          ),
          this.row(
            'Metall',
            numberField({
              value: slot.metalness ?? (slot.material === 'metall' ? 0.8 : 0),
              step: 0.05,
              min: 0,
              max: 1,
              onChange: (v, live) => {
                slot.metalness = v;
                this.materialsChanged('Metall', live);
              },
            }),
          ),
        );
      }
    }
    return this.section('Materialien', ...rows);
  }

  private materialsChanged(label: string, live = false): void {
    this.rebuildMaterials();
    this.rebuildAll();
    if (live) return;
    this.commit(label);
  }

  private smallBtn(ic: string, label: string, title: string, fn: () => void): HTMLButtonElement {
    const b = h('button', { class: 'btn md-small', title }, ic ? iconEl(ic) : '', label);
    b.addEventListener('click', fn);
    return b;
  }

  private modelSection(): HTMLElement {
    const name = h('input', { type: 'text', value: this.doc.name });
    name.addEventListener('change', () => {
      this.doc.name = name.value.trim() || this.doc.name;
      this.setDirty(true);
      this.history.push(this.snap('Modellname'));
    });
    const col = h('select', {}, ...COLLISION_OPTIONS.map((c) => h('option', { value: c.value }, c.label)));
    col.value = this.doc.collision;
    col.addEventListener('change', () => {
      this.doc.collision = col.value as ModelCollision;
      this.commit('Kollision');
    });
    const prev = h('input', { type: 'checkbox' });
    prev.checked = this.showCollision;
    prev.addEventListener('change', () => {
      this.showCollision = prev.checked;
      this.updateCollisionPreview();
    });
    const box = new THREE.Box3();
    let tris = 0;
    for (const o of this.doc.objects) {
      if (!o.visible) continue;
      box.union(o.mesh.bounds().applyMatrix4(objectMatrix(o)));
      tris += o.mesh.triangleCount;
    }
    const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
    return this.section(
      'Modell',
      this.row('Name', name),
      this.row('Gespeichert als', h('span', { class: 'md-dim' }, this.doc.ref ? `Modelle/Eigene/${modelLabel(this.doc.ref)}` : '— noch nicht gespeichert —')),
      this.row('Kollision', col),
      this.row('Kollision zeigen', prev),
      this.row(
        'Ursprung (Drehpunkt)',
        h(
          'div',
          { class: 'md-btns' },
          this.smallBtn('', 'Boden-Mitte', 'Modell so verschieben, dass die Unterseite mittig im Ursprung liegt (empfohlen fürs Level)', () => this.doModelOrigin('bottom')),
          this.smallBtn('', 'Mitte', 'Mitte des Modells in den Ursprung', () => this.doModelOrigin('center')),
          this.smallBtn('', 'Auswahl', 'Auswahl in den Ursprung', () => this.doModelOrigin('selection')),
        ),
      ),
      this.row('Größe', h('span', { class: 'md-dim' }, `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} m`)),
      this.row('Dreiecke', h('span', { class: 'md-dim' }, String(tris))),
      h('div', { class: 'md-hint' }, 'Der Ursprung (rote/blaue Achse) ist im Level der Drehpunkt des Modells und liegt auf dem Boden.'),
    );
  }

  private updateCollisionPreview(): void {
    if (!this.showCollision) return this.view.setLines('collision', [], '#3ddc84');
    const pts: THREE.Vector3[] = [];
    for (const o of this.doc.objects) {
      if (!o.visible) continue;
      const M = objectMatrix(o);
      for (const v of ops.mirroredMesh(o.mesh, o.mirror).verts) pts.push(v.clone().applyMatrix4(M));
    }
    const pos: number[] = [];
    if (pts.length && this.doc.collision === 'box') {
      const b = new THREE.Box3().setFromPoints(pts);
      const c = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
      for (const [a, z] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) pos.push(...c[a].toArray(), ...c[z].toArray());
    } else if (pts.length >= 4 && this.doc.collision === 'convex') {
      const hull = new ConvexHull().setFromPoints(pts);
      for (const f of hull.faces) {
        let e = f.edge;
        do {
          pos.push(...e.tail()!.point.toArray(), ...e.head().point.toArray());
          e = e.next;
        } while (e !== f.edge);
      }
    } else if (this.doc.collision === 'mesh') {
      for (const o of this.doc.objects) {
        if (!o.visible) continue;
        const M = objectMatrix(o);
        const mm = ops.mirroredMesh(o.mesh, o.mirror);
        for (const k of mm.allEdges()) pos.push(...mm.verts[ekA(k)].clone().applyMatrix4(M).toArray(), ...mm.verts[ekB(k)].clone().applyMatrix4(M).toArray());
      }
    }
    this.view.setLines('collision', pos, '#3ddc84', false);
  }
}

/** Hinweis für den Content Browser: ist das ein Modeler-Modell? */
export const isOwnModel = (ref: string): boolean => ref.startsWith(MODELER_PREFIX);

export { toast };
