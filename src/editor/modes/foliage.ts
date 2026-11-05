import * as THREE from 'three';
import { h, numberField, confirmDialog, pickFile, toast, showMenu, type MenuItem } from '../ui.ts';
import { icon } from '../icons.ts';
import { models } from '../models.ts';
import type { EditorMode, ModeContext } from './types.ts';
import { newId, type MapObjectData } from '../../world/mapFormat.ts';
import { modelLabel } from '../../world/modelStore.ts';
import { FOLIAGE_TYPE, foliageEntry, foliageProps, type FoliageEntry } from '../../world/foliage/asset.ts';
import { CELL, CellRecorder, STRIDE, cellKey, cellOf, type FoliageCell, type FoliageData } from '../../world/foliage/data.ts';
import { FOLIAGE_PRESETS, PROC_MESHES, makeFoliageType, modelFoliageType, type FoliageCollision, type FoliageType } from '../../world/foliage/types.ts';
import { LANDSCAPE_TYPE, landscapeEntry } from '../../world/landscape/asset.ts';
import type { LandscapeData } from '../../world/landscape/data.ts';
import { SURFACE_OPTIONS, type SurfaceId } from '../../world/surfaces.ts';
import { GRASS_PRESETS } from '../../world/foliage/grass.ts';
import { GridRecorder, type DataEdit } from '../history.ts';

// Foliage-Modus (Phase 3, wie UE5 „Foliage“): Typen verwalten, Instanzen malen, radieren, auswählen,
// neu anwenden und ganze Landscapes füllen. Die Instanzen liegen im (einzigen) Foliage-Objekt der Map;
// es wird beim ersten Typ automatisch angelegt. Jeder Strich ist ein Undo-Schritt (nur geänderte 64-m-Zellen).
// Das Layer-Gras der Landscapes steht als eigener Eintrag in der Typ-Liste: Radieren entfernt es (Gras-Maske
// der Landscape, wird mitgespeichert), Malen stellt es wieder her.

/** Pinselgröße auf sinnvolle Stellen runden (unter 10 m: 0,1 m, sonst 0,5 m) */
const roundRadius = (r: number) => (r < 10 ? Math.round(r * 10) / 10 : Math.round(r * 2) / 2);

type ToolId = 'paint' | 'erase' | 'select' | 'reapply' | 'fill';

const TOOLS: { id: ToolId; label: string; hint: string }[] = [
  { id: 'paint', label: 'Malen', hint: 'Aktive Typen malen (Layer-Gras: wiederherstellen), Umschalt = Radieren' },
  { id: 'erase', label: 'Radieren', hint: 'Instanzen und Layer-Gras im Pinsel entfernen' },
  { id: 'select', label: 'Auswählen', hint: 'Klick = eine Instanz, Ziehen = Pinsel, Umschalt = hinzufügen, Entf = löschen' },
  { id: 'reapply', label: 'Neu anwenden', hint: 'Höhe, Ausrichtung, Skalierung und Filter der Typ-Einstellungen erneut anwenden' },
  { id: 'fill', label: 'Füllen', hint: 'Alle Landscapes mit den aktiven Typen füllen' },
];

const BRUSH_TOOLS = new Set<ToolId>(['paint', 'erase', 'select', 'reapply']);

const COLORS: Record<string, number> = {
  paint: 0x5cff7a,
  erase: 0xff5a4d,
  select: 0xffc640,
  reapply: 0x66b3ff,
};

const PREFS_KEY = 'bodycam.editor.foliage';
const MIN_RADIUS = 0.25;
/** höchstens so viele neue Instanzen je Pinsel-Schritt */
const MAX_ADD_STEP = 4000;
const RING_SEGMENTS = 64;
/** Eintrag „Layer-Gras“ in der Typ-Liste (für prefs.inactive) */
const GRASS_ID = '@layer-gras';
/** weicher Rand beim Radieren/Wiederherstellen von Gras (Anteil des Radius) */
const GRASS_EDGE = 0.25;

interface Prefs {
  tool: ToolId;
  radius: number;
  /** Faktor auf die Typ-Dichte */
  density: number;
  /** Radieren: nur aktive Typen */
  eraseActiveOnly: boolean;
  /** abgewählte Typen (neue Typen sind aktiv) */
  inactive: string[];
  reHeight: boolean;
  reAlign: boolean;
  reScale: boolean;
  reFilter: boolean;
}

const DEFAULT_PREFS: Prefs = {
  tool: 'paint',
  radius: 10,
  density: 1,
  eraseActiveOnly: true,
  inactive: [],
  reHeight: true,
  reAlign: true,
  reScale: true,
  reFilter: true,
};

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    const p = { ...DEFAULT_PREFS, ...raw };
    if (!TOOLS.some((t) => t.id === p.tool)) p.tool = 'paint';
    if (!Array.isArray(p.inactive)) p.inactive = [];
    return p;
  } catch {
    return { ...DEFAULT_PREFS, inactive: [] };
  }
}

/** Foliage-Objekt der Map */
interface Target {
  obj: MapObjectData;
  entry: FoliageEntry;
  data: FoliageData;
  /** Welt-Position des Foliage-Objekts (Instanzen sind relativ dazu) */
  origin: THREE.Vector3;
}

/** Landscape, auf die gemalt werden kann */
interface Ground {
  d: LandscapeData;
  o: THREE.Vector3;
}

interface Hover {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

interface SelItem {
  typeId: string;
  key: number;
  x: number;
  y: number;
  z: number;
}

interface FillItem {
  t: FoliageType;
  /** Rechteck (lokal zum Foliage-Objekt) = 64-m-Zelle ∩ Landscape */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

interface FillJob {
  T: Target;
  rec: CellRecorder;
  items: FillItem[];
  i: number;
  added: number;
}

const cloneTypes = (l: FoliageType[]) => l.map((t) => ({ ...t }));
const RAD2DEG = 180 / Math.PI;

export function createFoliageMode(ctx: ModeContext): EditorMode {
  const { state, viewport: vp } = ctx;
  const prefs = loadPrefs();
  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* egal */
    }
  };

  const panel = h('div', { class: 'mode-panel-body foliage-panel' });
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let active = false;
  let shift = false;
  let hover: Hover | null = null;
  let lastPointer: { x: number; y: number } | null = null;
  /** Typ im Eigenschafts-Editor */
  let selType = '';

  // Strich (T = null: kein Foliage-Objekt, nur Layer-Gras)
  let stroke: {
    T: Target | null;
    rec: CellRecorder | null;
    /** Gras-Masken der berührten Landscapes */
    grass: Map<LandscapeData, GridRecorder>;
    tool: ToolId;
    acc: number;
    downX: number;
    downY: number;
    brushing: boolean;
    label: string;
  } | null = null;
  // Auswahl einzelner Instanzen
  const selection = new Map<string, SelItem>();
  // Füllen (läuft über mehrere Frames)
  let job: FillJob | null = null;

  // ---------- Pinsel-Ring und Auswahl-Markierung ----------

  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RING_SEGMENTS * 3), 3));
  const ringMat = new THREE.LineBasicMaterial({ color: COLORS.paint, depthTest: false, transparent: true, opacity: 0.95 });
  const ring = new THREE.LineLoop(ringGeo, ringMat);
  ring.renderOrder = 999;
  ring.frustumCulled = false;
  ring.visible = false;
  ring.userData.noWeather = true;
  const innerRing = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: true, transparent: true, opacity: 0.5 }));
  innerRing.frustumCulled = false;
  innerRing.renderOrder = 998;
  ring.add(innerRing);
  vp.scene.add(ring);

  const markGeo = new THREE.BufferGeometry();
  const marks = new THREE.Points(markGeo, new THREE.PointsMaterial({ color: 0xffb020, size: 9, sizeAttenuation: false, depthTest: false, transparent: true }));
  marks.renderOrder = 999;
  marks.frustumCulled = false;
  marks.visible = false;
  marks.userData.noWeather = true;
  vp.scene.add(marks);

  // ---------- Ziele ----------

  function target(): Target | null {
    for (const obj of state.map.objects) {
      if (obj.type !== FOLIAGE_TYPE || state.editorHidden.has(obj.id)) continue;
      const entry = foliageEntry(obj.id);
      if (!entry || !entry.renderer.group.parent) continue;
      entry.renderer.group.updateWorldMatrix(true, false);
      return { obj, entry, data: entry.data, origin: new THREE.Vector3().setFromMatrixPosition(entry.renderer.group.matrixWorld) };
    }
    return null;
  }

  /** Foliage-Objekt holen oder anlegen */
  function ensureTarget(): Target | null {
    const t = target();
    if (t) return t;
    if (state.map.objects.some((o) => o.type === FOLIAGE_TYPE)) {
      ctx.status('Das Foliage-Objekt ist ausgeblendet oder lädt noch', true);
      return null;
    }
    state.update(() => {
      state.add([{ id: '', name: 'Foliage', type: FOLIAGE_TYPE, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], props: foliageProps(newId()) }], false);
    });
    state.select([]);
    return target();
  }

  function grounds(): Ground[] {
    const out: Ground[] = [];
    for (const obj of state.map.objects) {
      if (obj.type !== LANDSCAPE_TYPE || state.editorHidden.has(obj.id)) continue;
      const node = vp.nodeById(obj.id);
      const e = landscapeEntry(obj.id);
      if (!node || !e || !e.renderer.mesh.parent) continue;
      node.root.updateMatrixWorld(true);
      out.push({ d: e.data, o: new THREE.Vector3().setFromMatrixPosition(node.root.matrixWorld) });
    }
    return out;
  }

  const isActive = (id: string) => !prefs.inactive.includes(id);
  const activeTypes = (T: Target) => T.data.types.filter((t) => isActive(t.id));
  const grassActive = () => isActive(GRASS_ID);
  const hasGrass = (d: LandscapeData) => d.layers.some((l) => !!l.grass.type);
  /** Landscapes mit Layer-Gras */
  const grassGrounds = () => grounds().filter((g) => hasGrass(g.d));

  // ---------- Strahlen und Oberfläche ----------

  function screenRay(x: number, y: number): THREE.Ray {
    const r = vp.renderer.domElement.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, vp.camera);
    return raycaster.ray;
  }

  const skipFoliage = (_id: string, type: string) => type === FOLIAGE_TYPE;
  const skipFoliageAndLandscape = (_id: string, type: string) => type === FOLIAGE_TYPE || type === LANDSCAPE_TYPE;

  function cast(x: number, y: number): Hover | null {
    const hit = vp.castSurface(screenRay(x, y).clone(), 20000, skipFoliage);
    if (!hit) return null;
    if (hit.normal.y < 0) hit.normal.negate();
    return { point: hit.point, normal: hit.normal };
  }

  // Ergebnis von sample(): Höhe (Welt) + Normale
  let sy = 0;
  const sn = new THREE.Vector3();
  const _ray = new THREE.Ray();
  const _up = new THREE.Vector3();

  /** Oberfläche unter (wx, wz) für einen Typ; yHint = null: nur Landscapes (Füllen) */
  function sample(t: FoliageType, gs: Ground[], wx: number, wz: number, yHint: number | null, reach: number): boolean {
    let found = false;
    if (t.onLandscape)
      for (const g of gs) {
        const lx = wx - g.o.x;
        const lz = wz - g.o.z;
        const hgt = g.d.heightAt(lx, lz);
        if (hgt === null) continue;
        const y = hgt + g.o.y;
        if (found && y <= sy) continue;
        sy = y;
        g.d.normalAt(Math.round(g.d.toGridX(lx)), Math.round(g.d.toGridZ(lz)), sn);
        found = true;
      }
    if (t.onMeshes && yHint !== null) {
      _ray.origin.set(wx, yHint + reach, wz);
      _ray.direction.set(0, -1, 0);
      const hit = vp.castSurface(_ray, reach * 2 + 20, skipFoliageAndLandscape);
      if (hit && (!found || hit.point.y > sy)) {
        sy = hit.point.y;
        sn.copy(hit.normal);
        if (sn.y < 0) sn.negate();
        found = true;
      }
    }
    return found;
  }

  function allowed(t: FoliageType, y: number, n: THREE.Vector3): boolean {
    const slope = Math.acos(THREE.MathUtils.clamp(n.y, -1, 1)) * RAD2DEG;
    return slope >= t.slopeMin - 0.01 && slope <= t.slopeMax + 0.01 && y >= t.heightMin && y <= t.heightMax;
  }

  const randScale = (t: FoliageType) => {
    const a = Math.min(t.scaleMin, t.scaleMax);
    const b = Math.max(t.scaleMin, t.scaleMax);
    return a + Math.random() * (b - a);
  };

  /** eine Instanz an (wx, wz) setzen, wenn Oberfläche und Filter passen */
  function place(T: Target, t: FoliageType, gs: Ground[], rec: CellRecorder, wx: number, wz: number, yHint: number | null, reach: number): boolean {
    const lx = wx - T.origin.x;
    const lz = wz - T.origin.z;
    if (t.minDist > 0 && T.data.anyWithin(t.id, lx, lz, t.minDist)) return false;
    if (!sample(t, gs, wx, wz, yHint, reach) || !allowed(t, sy, sn)) return false;
    const s = randScale(t);
    _up.set(0, 1, 0).lerp(sn, t.align).normalize();
    rec.touch(t.id, cellKey(cellOf(lx), cellOf(lz)));
    T.data.add(t.id, lx, sy - t.sink * s - T.origin.y, lz, t.randomYaw ? Math.random() * Math.PI * 2 : 0, s, _up.x, _up.z);
    return true;
  }

  /** Instanzen eines Typs im Kreis (lokal), rückwärts — fn darf die aktuelle entfernen */
  function eachInDisc(data: FoliageData, typeId: string, lx: number, lz: number, r: number, fn: (c: FoliageCell, key: number, i: number, o: number) => void): void {
    const m = data.cells.get(typeId);
    if (!m) return;
    const r2 = r * r;
    for (const key of data.keysInCircle(lx, lz, r)) {
      const c = m.get(key);
      if (!c) continue;
      for (let i = c.n - 1; i >= 0; i--) {
        if (i >= c.n) continue;
        const o = i * STRIDE;
        const dx = c.data[o] - lx;
        const dz = c.data[o + 2] - lz;
        if (dx * dx + dz * dz <= r2) fn(c, key, i, o);
      }
    }
  }

  // ---------- Pinsel-Werkzeuge ----------

  function effectiveTool(): ToolId {
    return prefs.tool === 'paint' && shift ? 'erase' : prefs.tool;
  }

  function paintStep(T: Target, hv: Hover): boolean {
    const gs = grounds();
    const r = prefs.radius;
    const area = Math.PI * r * r;
    const c = hv.point;
    const lx = c.x - T.origin.x;
    const lz = c.z - T.origin.z;
    let changed = false;
    let budget = MAX_ADD_STEP;
    for (const t of activeTypes(T)) {
      const want = (t.density * prefs.density * area) / 100;
      let have = 0;
      eachInDisc(T.data, t.id, lx, lz, r, () => have++);
      let need = Math.floor(want - have + Math.random());
      if (need <= 0) continue;
      need = Math.min(need, budget);
      let attempts = need * 3 + 2;
      while (need > 0 && attempts-- > 0) {
        const a = Math.random() * Math.PI * 2;
        const d = r * Math.sqrt(Math.random());
        if (place(T, t, gs, stroke!.rec!, c.x + Math.cos(a) * d, c.z + Math.sin(a) * d, c.y, r + 30)) {
          need--;
          budget--;
          changed = true;
        }
      }
      if (budget <= 0) break;
    }
    return changed;
  }

  function eraseStep(T: Target, hv: Hover): boolean {
    const lx = hv.point.x - T.origin.x;
    const lz = hv.point.z - T.origin.z;
    let changed = false;
    for (const t of T.data.types) {
      if (prefs.eraseActiveOnly && !isActive(t.id)) continue;
      eachInDisc(T.data, t.id, lx, lz, prefs.radius, (_c, key, i) => {
        stroke!.rec!.touch(t.id, key);
        T.data.removeAt(t.id, key, i);
        changed = true;
      });
    }
    return changed;
  }

  /** Layer-Gras im Pinsel entfernen (erase) oder wiederherstellen; weicher Rand */
  function grassStep(hv: Hover, erase: boolean): void {
    if (!stroke) return;
    const r = prefs.radius;
    for (const g of grassGrounds()) {
      const d = g.d;
      if (!erase && !d.grassMask) continue;
      const div = d.splatDiv;
      const step = d.quadSize * div;
      const cx = d.toGridX(hv.point.x - g.o.x) / div;
      const cz = d.toGridZ(hv.point.z - g.o.z) / div;
      const rt = r / step;
      const rect = d.clip({ x: cx - rt - 1, y: cz - rt - 1, w: rt * 2 + 3, h: rt * 2 + 3 }, d.SW, d.SH);
      if (!rect) continue;
      let rec = stroke.grass.get(d);
      if (!rec) {
        rec = new GridRecorder(() => d.ensureGrassMask(), d.SW, d.SH, 1, (rr) => d.changed(rr, 'grass'));
        stroke.grass.set(d, rec);
      }
      rec.touch(rect);
      const m = d.ensureGrassMask();
      const SW = d.SW;
      let changed = false;
      for (let z = rect.y; z < rect.y + rect.h; z++)
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const dist = Math.hypot(x - cx, z - cz) * step;
          if (dist > r) continue;
          // 1 innen, zum Rand weich auf 0
          const f = Math.min(1, (r - dist) / Math.max(1e-3, r * GRASS_EDGE));
          const i = z * SW + x;
          const v = erase ? Math.max(m[i], Math.round(255 * f)) : Math.min(m[i], Math.round(255 * (1 - f)));
          if (v !== m[i]) {
            m[i] = v;
            changed = true;
          }
        }
      if (changed) d.changed(rect, 'grass');
    }
  }

  function reapplyStep(T: Target, hv: Hover): boolean {
    const gs = grounds();
    const lx = hv.point.x - T.origin.x;
    const lz = hv.point.z - T.origin.z;
    let changed = false;
    for (const t of activeTypes(T)) {
      eachInDisc(T.data, t.id, lx, lz, prefs.radius, (c, key, i, o) => {
        const d = c.data;
        const wx = d[o] + T.origin.x;
        const wz = d[o + 2] + T.origin.z;
        const s0 = d[o + 4];
        const ok = sample(t, gs, wx, wz, d[o + 1] + T.origin.y + t.sink * s0, 30);
        stroke!.rec!.touch(t.id, key);
        if (prefs.reFilter && (!ok || !allowed(t, sy, sn))) {
          T.data.removeAt(t.id, key, i);
          changed = true;
          return;
        }
        let s = s0;
        const lo = Math.min(t.scaleMin, t.scaleMax);
        const hi = Math.max(t.scaleMin, t.scaleMax);
        if (prefs.reScale && (s < lo - 1e-4 || s > hi + 1e-4)) s = randScale(t);
        if (ok && prefs.reHeight) d[o + 1] = sy - t.sink * s - T.origin.y;
        else if (s !== s0) d[o + 1] += t.sink * (s0 - s);
        d[o + 4] = s;
        if (ok && prefs.reAlign) {
          _up.set(0, 1, 0).lerp(sn, t.align).normalize();
          d[o + 5] = _up.x;
          d[o + 6] = _up.z;
        }
        c.mats = null;
        changed = true;
      });
    }
    return changed;
  }

  const selId = (typeId: string, x: number, z: number) => `${typeId}|${x}|${z}`;

  function selectDisc(T: Target, hv: Hover): void {
    const lx = hv.point.x - T.origin.x;
    const lz = hv.point.z - T.origin.z;
    for (const t of activeTypes(T))
      eachInDisc(T.data, t.id, lx, lz, prefs.radius, (c, key, _i, o) => {
        const d = c.data;
        selection.set(selId(t.id, d[o], d[o + 2]), { typeId: t.id, key, x: d[o], y: d[o + 1], z: d[o + 2] });
      });
    updateMarks();
  }

  function selectAt(x: number, y: number, add: boolean): void {
    const T = target();
    if (!T) return;
    const ray = screenRay(x, y).clone();
    const only = new Set(activeTypes(T).map((t) => t.id));
    const hit = T.entry.renderer.pick(ray, 5000, only);
    if (!add) selection.clear();
    if (hit) {
      const c = T.data.getCell(hit.typeId, hit.key);
      if (c && hit.index < c.n) {
        const o = hit.index * STRIDE;
        const id = selId(hit.typeId, c.data[o], c.data[o + 2]);
        if (add && selection.has(id)) selection.delete(id);
        else selection.set(id, { typeId: hit.typeId, key: hit.key, x: c.data[o], y: c.data[o + 1], z: c.data[o + 2] });
        const t = T.data.type(hit.typeId);
        ctx.status(`${t?.name ?? 'Instanz'} ausgewählt (${selection.size})`);
      }
    }
    updateMarks();
    render();
  }

  /** Index einer ausgewählten Instanz in ihrer Zelle (-1 = gibt es nicht mehr) */
  function findSel(data: FoliageData, s: SelItem): number {
    const c = data.getCell(s.typeId, s.key);
    if (!c) return -1;
    for (let i = 0, o = 0; i < c.n; i++, o += STRIDE) if (c.data[o] === s.x && c.data[o + 2] === s.z) return i;
    return -1;
  }

  function deleteSelection(): void {
    const T = target();
    if (!T || !selection.size) return;
    const rec = new CellRecorder(T.data);
    let n = 0;
    for (const s of selection.values()) {
      const i = findSel(T.data, s);
      if (i < 0) continue;
      rec.touch(s.typeId, s.key);
      T.data.removeAt(s.typeId, s.key, i);
      n++;
    }
    selection.clear();
    updateMarks();
    if (n) {
      T.data.changed('instances');
      state.commitData(rec.finish('Foliage: Auswahl löschen', queueRender));
      ctx.status(`${n} Instanzen gelöscht`);
    }
    render();
  }

  function updateMarks(): void {
    const T = target();
    if (!T || !selection.size || !active) {
      marks.visible = false;
      return;
    }
    const pos: number[] = [];
    for (const [id, s] of selection) {
      if (findSel(T.data, s) < 0) {
        selection.delete(id);
        continue;
      }
      pos.push(s.x + T.origin.x, s.y + T.origin.y + 0.4, s.z + T.origin.z);
    }
    markGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    markGeo.computeBoundingSphere();
    marks.visible = pos.length > 0;
  }

  function applyStroke(dt: number): void {
    if (!stroke || !hover) return;
    const T = stroke.T;
    // Malen/Radieren ~30×/s, Neu anwenden ~10×/s (kann Strahltests je Instanz brauchen)
    stroke.acc += dt;
    const step = stroke.tool === 'reapply' ? 0.1 : 1 / 30;
    if (stroke.acc < step) return;
    stroke.acc = 0;
    if (stroke.tool === 'paint' && grassActive()) grassStep(hover, false);
    if (stroke.tool === 'erase' && (grassActive() || !prefs.eraseActiveOnly)) grassStep(hover, true);
    if (!T) return;
    let changed = false;
    if (stroke.tool === 'paint') changed = paintStep(T, hover);
    else if (stroke.tool === 'erase') changed = eraseStep(T, hover);
    else if (stroke.tool === 'reapply') changed = reapplyStep(T, hover);
    else if (stroke.tool === 'select' && stroke.brushing) selectDisc(T, hover);
    if (changed) T.data.changed('instances');
  }

  function endStroke(): void {
    if (!stroke) return;
    const s = stroke;
    stroke = null;
    if (s.tool === 'select') {
      if (!s.brushing) selectAt(s.downX, s.downY, shift);
      else render();
      return;
    }
    // Instanzen und Gras-Masken als ein Undo-Schritt
    const label = `Foliage: ${s.label}`;
    const edits: DataEdit[] = [];
    const inst = s.rec?.finish(label, queueRender);
    if (inst) edits.push(inst);
    for (const rec of s.grass.values()) {
      const e = rec.finish(label);
      if (e) edits.push(e);
    }
    commitAll(label, edits);
    if (s.tool === 'erase' || s.tool === 'reapply') updateMarks();
    render();
  }

  /** mehrere Undo-Schritte als einen eintragen */
  function commitAll(label: string, edits: DataEdit[]): void {
    if (edits.length <= 1) return state.commitData(edits[0] ?? null);
    state.commitData({
      label,
      bytes: edits.reduce((n, e) => n + e.bytes, 0),
      undo: () => [...edits].reverse().forEach((e) => e.undo()),
      redo: () => edits.forEach((e) => e.redo()),
    });
  }

  // ---------- Ring ----------

  function updateRing(): void {
    const tool = effectiveTool();
    if (!active || !hover || !BRUSH_TOOLS.has(prefs.tool) || job) {
      ring.visible = false;
      return;
    }
    const gs = grounds();
    const a = ringGeo.attributes.position as THREE.BufferAttribute;
    const c = hover.point;
    const r = prefs.radius;
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const ang = (i / RING_SEGMENTS) * Math.PI * 2;
      const x = c.x + Math.cos(ang) * r;
      const z = c.z + Math.sin(ang) * r;
      let y = c.y;
      for (const g of gs) {
        const hgt = g.d.heightAt(x - g.o.x, z - g.o.z);
        if (hgt !== null && Math.abs(hgt + g.o.y - c.y) < r * 3 + 5) {
          y = hgt + g.o.y;
          break;
        }
      }
      a.setXYZ(i, x, y + 0.15, z);
    }
    a.needsUpdate = true;
    ringGeo.computeBoundingSphere();
    ringMat.color.setHex(COLORS[tool] ?? COLORS.paint);
    ring.visible = true;
  }

  // ---------- Füllen ----------

  function fillDialog(): void {
    const T = ensureTarget();
    if (!T) return;
    const types = activeTypes(T);
    if (!types.length) return ctx.status('Keine aktiven Foliage-Typen', true);
    const land = types.filter((t) => t.onLandscape);
    if (!land.length) return ctx.status('Füllen setzt nur auf Landscapes — kein aktiver Typ hat „Auf Landscape“', true);
    const gs = grounds();
    if (!gs.length) return ctx.status('Keine Landscape in der Map', true);
    let area = 0;
    for (const g of gs) area += g.d.sizeX * g.d.sizeZ;
    let est = 0;
    for (const t of land) est += (t.density * prefs.density * area) / 100;
    const names = land.map((t) => t.name).join(', ');
    void confirmDialog(
      'Landscape füllen',
      `${names} auf ${gs.length} Landscape${gs.length > 1 ? 's' : ''} (${fmtArea(area)}) setzen — bis zu ${fmtCount(est)} Instanzen (Neigungs-/Höhenfilter und Mindestabstand verringern das). Vorhandene Instanzen bleiben; Füllen ergänzt nur bis zur Dichte.`,
      'Füllen',
    ).then((ok) => ok && startFill(T, land, gs));
  }

  function startFill(T: Target, types: FoliageType[], gs: Ground[]): void {
    const items: FillItem[] = [];
    for (const g of gs) {
      // Landscape-Rechteck (lokal zum Foliage-Objekt)
      const ax = g.o.x - g.d.sizeX / 2 - T.origin.x;
      const az = g.o.z - g.d.sizeZ / 2 - T.origin.z;
      const bx = ax + g.d.sizeX;
      const bz = az + g.d.sizeZ;
      for (const t of types)
        for (let cz = cellOf(az); cz <= cellOf(bz - 1e-6); cz++)
          for (let cx = cellOf(ax); cx <= cellOf(bx - 1e-6); cx++) {
            const x0 = Math.max(ax, cx * CELL);
            const z0 = Math.max(az, cz * CELL);
            const x1 = Math.min(bx, (cx + 1) * CELL);
            const z1 = Math.min(bz, (cz + 1) * CELL);
            if (x1 > x0 && z1 > z0) items.push({ t, x0, z0, x1, z1 });
          }
    }
    job = { T, rec: new CellRecorder(T.data), items, i: 0, added: 0 };
    updateRing();
    render();
  }

  function fillItem(j: FillJob, it: FillItem, gs: Ground[]): void {
    const { T } = j;
    const t = it.t;
    const area = (it.x1 - it.x0) * (it.z1 - it.z0);
    let have = 0;
    const c = T.data.getCell(t.id, cellKey(cellOf(it.x0), cellOf(it.z0)));
    if (c)
      for (let i = 0, o = 0; i < c.n; i++, o += STRIDE) {
        const x = c.data[o];
        const z = c.data[o + 2];
        if (x >= it.x0 && x < it.x1 && z >= it.z0 && z < it.z1) have++;
      }
    let need = Math.floor((t.density * prefs.density * area) / 100 - have + Math.random());
    let attempts = need + 2;
    while (need > 0 && attempts-- > 0) {
      const wx = it.x0 + Math.random() * (it.x1 - it.x0) + T.origin.x;
      const wz = it.z0 + Math.random() * (it.z1 - it.z0) + T.origin.z;
      if (place(T, t, gs, j.rec, wx, wz, null, 0)) {
        need--;
        j.added++;
      }
    }
  }

  function runFill(): void {
    if (!job) return;
    const j = job;
    const gs = grounds();
    const t0 = performance.now();
    const before = j.added;
    while (j.i < j.items.length && performance.now() - t0 < 12) fillItem(j, j.items[j.i++], gs);
    if (j.added !== before) j.T.data.changed('instances');
    updateProgress();
    if (j.i >= j.items.length) finishFill(false);
  }

  function finishFill(cancelled: boolean): void {
    if (!job) return;
    const j = job;
    job = null;
    state.commitData(j.rec.finish('Foliage: Füllen', queueRender));
    ctx.status(`${cancelled ? 'Füllen abgebrochen — ' : ''}${fmtCount(j.added)} Instanzen gesetzt`);
    render();
  }

  let progressBar: HTMLElement | null = null;
  let progressText: HTMLElement | null = null;
  function updateProgress(): void {
    if (!job || !progressBar || !progressText) return;
    const p = job.items.length ? job.i / job.items.length : 1;
    progressBar.style.width = `${(p * 100).toFixed(1)}%`;
    progressText.textContent = `Füllen … ${Math.round(p * 100)} % · ${fmtCount(job.added)} Instanzen`;
  }

  // ---------- Typen ----------

  function commitTypes(T: Target, label: string, before: FoliageType[], after: FoliageType[], removed?: { typeId: string; cells: [number, Float32Array][] }): void {
    const d = T.data;
    let bytes = 4096;
    for (const [, a] of removed?.cells ?? []) bytes += a.byteLength;
    const apply = (types: FoliageType[], restore: boolean) => {
      d.setTypes(cloneTypes(types));
      if (restore && removed) {
        for (const [k, a] of removed.cells) d.setCell(removed.typeId, k, a);
        d.changed('instances');
      }
      queueRender();
    };
    state.commitData({ label, bytes, undo: () => apply(before, true), redo: () => apply(after, false) });
  }

  let liveBefore: FoliageType[] | null = null;
  /** eine Eigenschaft ändern; live = während des Ziehens (Undo erst beim Loslassen) */
  function editType(T: Target, id: string, label: string, fn: (t: FoliageType) => void, live = false): void {
    const d = T.data;
    const before = liveBefore ?? cloneTypes(d.types);
    const next = cloneTypes(d.types);
    const t = next.find((x) => x.id === id);
    if (!t) return;
    fn(t);
    d.setTypes(next);
    if (live) {
      liveBefore = before;
      return;
    }
    liveBefore = null;
    commitTypes(T, `Foliage: ${label}`, before, cloneTypes(next));
  }

  function addType(base: Omit<FoliageType, 'id'>): void {
    const T = ensureTarget();
    if (!T) return;
    const d = T.data;
    const before = cloneTypes(d.types);
    const t = makeFoliageType(base, d.types.map((x) => x.id));
    // gleiche Namen durchnummerieren
    let name = t.name;
    for (let n = 2; d.types.some((x) => x.name === name); n++) name = `${t.name} ${n}`;
    t.name = name;
    const next = [...cloneTypes(d.types), t];
    d.setTypes(next);
    selType = t.id;
    prefs.inactive = prefs.inactive.filter((x) => x !== t.id);
    savePrefs();
    commitTypes(T, `Foliage: Typ „${t.name}“ hinzufügen`, before, cloneTypes(next));
    ctx.status(`Foliage-Typ „${t.name}“ angelegt`);
    render();
  }

  async function removeType(T: Target, id: string): Promise<void> {
    const d = T.data;
    const t = d.type(id);
    if (!t) return;
    const n = d.count(id);
    if (n && !(await confirmDialog('Foliage-Typ entfernen', `„${t.name}“ und alle ${fmtCount(n)} Instanzen entfernen?`, 'Entfernen', true))) return;
    const before = cloneTypes(d.types);
    const cells: [number, Float32Array][] = [];
    for (const [k, c] of d.cells.get(id) ?? []) if (c.n) cells.push([k, c.data.slice(0, c.n * STRIDE)]);
    const next = cloneTypes(d.types.filter((x) => x.id !== id));
    d.setTypes(next);
    d.changed('instances');
    commitTypes(T, `Foliage: Typ „${t.name}“ entfernen`, before, cloneTypes(next), { typeId: id, cells });
    if (selType === id) selType = '';
    render();
  }

  async function clearType(T: Target, id: string): Promise<void> {
    const d = T.data;
    const t = d.type(id);
    const n = d.count(id);
    if (!t || !n) return;
    if (!(await confirmDialog('Instanzen löschen', `Alle ${fmtCount(n)} Instanzen von „${t.name}“ löschen? (Der Typ bleibt.)`, 'Löschen', true))) return;
    const rec = new CellRecorder(d);
    for (const k of [...(d.cells.get(id)?.keys() ?? [])]) {
      rec.touch(id, k);
      d.setCell(id, k, null);
    }
    d.changed('instances');
    state.commitData(rec.finish(`Foliage: „${t.name}“ leeren`, queueRender));
    updateMarks();
    render();
  }

  function addMenu(anchor: HTMLElement): void {
    const items: MenuItem[] = [{ heading: 'Platzhalter' }];
    for (const p of FOLIAGE_PRESETS) items.push({ label: p.label, icon: 'leaf', action: () => addType(p.make()) });
    items.push({ separator: true }, { heading: 'Modell (glb, LOD0/1/2 über Knotennamen)' });
    for (const ref of models.all.slice(0, 40)) items.push({ label: modelLabel(ref), icon: 'model', action: () => addType(modelFoliageType(ref, modelLabel(ref))) });
    items.push({
      label: 'Modell importieren…',
      icon: 'upload',
      action: () =>
        void pickFile('.glb,.gltf').then(async (f) => {
          if (!f) return;
          try {
            const ref = await models.import(f);
            addType(modelFoliageType(ref, modelLabel(ref)));
          } catch (e) {
            toast((e as Error).message, 'error', 5000);
          }
        }),
    });
    showMenu(items, anchor);
  }

  // ---------- Panel ----------

  const section = (title: string, ...rows: (HTMLElement | null | false)[]) =>
    h('div', { class: 'section' }, h('div', { class: 'section-head' }, title), h('div', { class: 'section-body' }, ...rows.filter((r): r is HTMLElement => !!r)));
  const row = (label: string, ...el: (Node | string)[]) => h('div', { class: 'prop-row' }, h('label', { title: label }, label), h('div', { class: 'value' }, ...el));
  const num = (label: string, get: () => number, set: (v: number) => void, step: number, min?: number, max?: number) =>
    row(label, numberField({ value: get(), step, min, max, onChange: (v) => (set(v), savePrefs(), updateRing()) }));
  const check = (label: string, value: boolean, set: (v: boolean) => void) => {
    const c = h('input', { type: 'checkbox' }) as HTMLInputElement;
    c.checked = value;
    c.addEventListener('change', () => {
      set(c.checked);
      savePrefs();
    });
    return row(label, c);
  };
  const button = (label: string, fn: () => void, cls = 'btn', ico?: string, enabled = true) => {
    const b = h('button', { class: cls, html: `${ico ? icon(ico) : ''}${label}` });
    b.addEventListener('click', fn);
    b.toggleAttribute('disabled', !enabled);
    return b;
  };

  function meshLabel(mesh: string): string {
    return PROC_MESHES.find((m) => m.value === mesh)?.label ?? modelLabel(mesh);
  }

  /** Eintrag „Layer-Gras“ (nur, wenn eine Landscape Gras-Layer hat) */
  function grassItem(): HTMLElement | null {
    const gs = grounds();
    const kinds = new Set<string>();
    for (const g of gs) for (const l of g.d.layers) if (l.grass.type) kinds.add(GRASS_PRESETS.find((p) => p.id === l.grass.type)?.label ?? l.grass.type);
    if (!kinds.size) return null;
    const cb = h('input', { type: 'checkbox', title: 'Aktiv (Radieren entfernt, Malen stellt wieder her)' }) as HTMLInputElement;
    cb.checked = grassActive();
    cb.addEventListener('change', () => {
      prefs.inactive = cb.checked ? prefs.inactive.filter((x) => x !== GRASS_ID) : [...prefs.inactive, GRASS_ID];
      savePrefs();
    });
    const erased = gs.some((g) => g.d.grassMask?.some((v) => v !== 0));
    const sw = h('span', { class: 'fol-swatch' });
    sw.style.background = GRASS_PRESETS[0].tip;
    const reset = button('Zurücksetzen', resetGrass, 'btn', undefined, erased);
    reset.title = 'Radiertes Gras auf allen Landscapes wiederherstellen';
    return h(
      'div',
      { class: 'ls-layer fol-type fol-grass' },
      h('div', { class: 'fol-check' }, cb),
      h('div', { class: 'ls-layer-name' }, sw, 'Layer-Gras', h('span', { class: 'dim' }, ` · ${[...kinds].join(', ')}`)),
      h('div', { class: 'ls-layer-sub dim' }, erased ? 'teilweise radiert' : 'aus den Landscape-Layern'),
      erased ? h('div', { class: 'fol-grass-reset' }, reset) : null,
    );
  }

  /** alle Gras-Masken leeren (ein Undo-Schritt) */
  function resetGrass(): void {
    const label = 'Foliage: Layer-Gras zurücksetzen';
    const edits: DataEdit[] = [];
    for (const g of grounds()) {
      const d = g.d;
      if (!d.grassMask) continue;
      const rec = new GridRecorder(() => d.ensureGrassMask(), d.SW, d.SH, 1, (rr) => d.changed(rr, 'grass'));
      const all = { x: 0, y: 0, w: d.SW, h: d.SH };
      rec.touch(all);
      d.grassMask.fill(0);
      d.changed(all, 'grass');
      const e = rec.finish(label);
      if (e) edits.push(e);
    }
    if (!edits.length) return;
    commitAll(label, edits);
    ctx.status('Layer-Gras wiederhergestellt');
    render();
  }

  function typeList(T: Target | null): HTMLElement {
    const types = T?.data.types ?? [];
    const list = h('div', { class: 'ls-layers' });
    const gi = grassItem();
    if (gi) list.append(gi);
    for (const t of types) {
      const cb = h('input', { type: 'checkbox', title: 'Aktiv (wird gemalt/gefüllt)' }) as HTMLInputElement;
      cb.checked = isActive(t.id);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        prefs.inactive = cb.checked ? prefs.inactive.filter((x) => x !== t.id) : [...prefs.inactive, t.id];
        savePrefs();
      });
      const sw = h('span', { class: 'fol-swatch' });
      sw.style.background = t.color;
      const item = h(
        'div',
        { class: `ls-layer fol-type${selType === t.id ? ' on' : ''}` },
        h('div', { class: 'fol-check' }, cb),
        h('div', { class: 'ls-layer-name' }, sw, t.name, h('span', { class: 'dim' }, ` · ${fmtCount(T!.data.count(t.id))}`)),
        h('div', { class: 'ls-layer-sub dim' }, `${meshLabel(t.mesh)} · ${t.density} je 100 m²`),
      );
      item.addEventListener('click', () => {
        selType = selType === t.id ? '' : t.id;
        render();
      });
      list.append(item);
    }
    const addBtn = button('Neu', () => addMenu(addBtn), 'btn primary', 'plus');
    const cur = T?.data.type(selType);
    return section(
      `Typen (${types.length})`,
      list.childElementCount ? list : null,
      types.length ? null : h('div', { class: 'mode-note dim' }, 'Noch keine Foliage-Typen. „Neu“ legt einen an (Platzhalter oder glb-Modell).'),
      h(
        'div',
        { class: 'ls-buttons' },
        addBtn,
        button('Duplizieren', () => cur && addType({ ...cur, name: `${cur.name} Kopie` }), 'btn', undefined, !!cur),
        button('Leeren', () => T && cur && void clearType(T, cur.id), 'btn', undefined, !!cur && !!T?.data.count(cur.id)),
        button('Entfernen', () => T && cur && void removeType(T, cur.id), 'btn', 'trash', !!cur),
      ),
      types.length > 1
        ? h(
            'div',
            { class: 'ls-buttons' },
            button('Alle aktiv', () => ((prefs.inactive = []), savePrefs(), render())),
            button('Keiner aktiv', () => ((prefs.inactive = [...types.map((t) => t.id), GRASS_ID]), savePrefs(), render())),
          )
        : null,
    );
  }

  function typeProps(T: Target, t: FoliageType): HTMLElement {
    const id = t.id;
    const tnum = (label: string, key: keyof FoliageType, step: number, min?: number, max?: number, scale = 1) =>
      row(
        label,
        numberField({
          value: (t[key] as number) * scale,
          step,
          min,
          max,
          onChange: (v, live) => editType(T, id, label, (x) => ((x[key] as number) = v / scale), live),
        }),
      );
    const tcheck = (label: string, key: keyof FoliageType, title = '') => {
      const c = h('input', { type: 'checkbox', title }) as HTMLInputElement;
      c.checked = t[key] as boolean;
      c.addEventListener('change', () => editType(T, id, label, (x) => ((x[key] as boolean) = c.checked)));
      return row(label, c);
    };
    const tselect = <V extends string>(label: string, value: V, options: [V, string][], set: (x: FoliageType, v: V) => void) => {
      const s = h('select', {}, ...options.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
      s.value = value;
      s.addEventListener('change', () => editType(T, id, label, (x) => set(x, s.value as V)));
      return row(label, s);
    };

    const name = h('input', { type: 'text', value: t.name, spellcheck: 'false' }) as HTMLInputElement;
    name.addEventListener('change', () => {
      editType(T, id, 'Typ-Name', (x) => (x.name = name.value.trim() || 'Foliage'));
      render();
    });

    const mesh = h('select', {}) as HTMLSelectElement;
    mesh.append(h('optgroup', { label: 'Platzhalter' }, ...PROC_MESHES.map((m) => h('option', { value: m.value }, m.label))));
    const all = models.all;
    if (all.length) mesh.append(h('optgroup', { label: 'Modelle' }, ...all.map((r) => h('option', { value: r }, modelLabel(r)))));
    if (![...mesh.options].some((o) => o.value === t.mesh)) mesh.append(h('option', { value: t.mesh }, `${modelLabel(t.mesh)} (fehlt)`));
    mesh.value = t.mesh;
    mesh.addEventListener('change', () => editType(T, id, 'Typ-Mesh', (x) => (x.mesh = mesh.value)));
    const imp = button('', () =>
      void pickFile('.glb,.gltf').then(async (f) => {
        if (!f) return;
        try {
          const ref = await models.import(f);
          editType(T, id, 'Typ-Mesh', (x) => (x.mesh = ref));
          render();
        } catch (e) {
          toast((e as Error).message, 'error', 5000);
        }
      }),
    'btn icon-btn', 'upload');
    imp.title = 'glb importieren';

    const color = h('input', { type: 'color', value: t.color }) as HTMLInputElement;
    color.addEventListener('change', () => editType(T, id, 'Typ-Farbe', (x) => (x.color = color.value)));

    const b = T.entry.renderer.bounds(id);
    return h(
      'div',
      {},
      section(
        `Typ „${t.name}“`,
        row('Name', name),
        row('Mesh', mesh, imp),
        row('Färbung', color),
        b ? h('div', { class: 'mode-note dim' }, `Größe bei Skalierung 1: ${b.height.toFixed(1)} m hoch, Radius ${b.radius.toFixed(1)} m`) : null,
      ),
      section(
        'Platzierung',
        tnum('Dichte / 100 m²', 'density', 0.1, 0, 2000),
        tnum('Skalierung min', 'scaleMin', 0.05, 0.01, 100),
        tnum('Skalierung max', 'scaleMax', 0.05, 0.01, 100),
        tcheck('Zufällige Drehung', 'randomYaw'),
        tnum('Ausrichten (%)', 'align', 5, 0, 100, 100),
        tnum('Neigung min (°)', 'slopeMin', 1, 0, 90),
        tnum('Neigung max (°)', 'slopeMax', 1, 0, 90),
        tnum('Höhe min (m)', 'heightMin', 1),
        tnum('Höhe max (m)', 'heightMax', 1),
        tnum('Mindestabstand (m)', 'minDist', 0.1, 0, 100),
        tnum('Versenken (m)', 'sink', 0.05, -10, 10),
        tcheck('Auf Landscape', 'onLandscape'),
        tcheck('Auf Meshes', 'onMeshes', 'Auch auf Objekte (Felsen, Dächer …) malen; Füllen setzt nur auf Landscapes'),
      ),
      section(
        'Darstellung',
        tnum('Sichtweite (m)', 'cull', 10, 5, 10000),
        tnum('LOD1 ab (m)', 'lod1', 5, 1, 10000),
        tnum('LOD2 ab (m)', 'lod2', 5, 1, 10000),
        tnum('Impostor ab (m)', 'impostor', 10, 0, 10000),
        h('div', { class: 'mode-note dim' }, 'Impostor 0 = keiner. Impostor sind vorgerenderte Ansichten (8 Richtungen) für die Ferne.'),
        tcheck('Schatten', 'shadow'),
        tnum('Wind (m)', 'wind', 0.05, 0, 5),
      ),
      section(
        'Spiel',
        tselect<FoliageCollision>('Kollision', t.collision, [['none', 'Keine'], ['trunk', 'Stamm'], ['full', 'Ganz']], (x, v) => (x.collision = v)),
        tcheck('Blockiert KI-Sicht', 'sight', 'Gegner sehen nicht hindurch (Kugeln fliegen trotzdem, wenn Kollision „Keine“ ist)'),
        tselect<SurfaceId>('Oberfläche', t.surface, SURFACE_OPTIONS.map((s) => [s.value, s.label] as [SurfaceId, string]), (x, v) => (x.surface = v)),
      ),
    );
  }

  function render(): void {
    if (!active) return;
    const T = target();
    const children: (HTMLElement | null)[] = [h('div', { class: 'mode-head', html: `${icon('leaf')}<span>Foliage</span>` })];
    const total = T ? T.data.count() : 0;
    const gcount = grounds().length;
    children.push(
      h(
        'div',
        { class: 'mode-note dim' },
        T ? `${fmtCount(total)} Instanzen · ${T.data.types.length} Typen${gcount ? '' : ' · keine Landscape (Malen auf Meshes möglich)'}` : 'Noch kein Foliage in dieser Map — „Neu“ legt den ersten Typ an.',
      ),
    );

    const grid = h('div', { class: 'ls-tools' });
    TOOLS.forEach((tool, i) => {
      const b = h('button', { class: `btn ls-tool${prefs.tool === tool.id ? ' on' : ''}`, title: `${tool.hint} (Taste ${i + 1})` }, tool.label);
      b.addEventListener('click', () => setTool(tool.id));
      grid.append(b);
    });
    children.push(grid, h('div', { class: 'mode-note dim' }, TOOLS.find((x) => x.id === prefs.tool)?.hint ?? ''));

    if (job) {
      progressBar = h('div', { class: 'bar' });
      progressText = h('div', { class: 'mode-note' });
      children.push(
        section(
          'Füllen',
          h('div', { class: 'ls-job' }, progressText, h('div', { class: 'ls-progress' }, progressBar), h('div', { class: 'ls-buttons' }, button('Abbrechen', () => finishFill(true)))),
        ),
      );
      updateProgress();
    } else {
      progressBar = progressText = null;
    }

    if (BRUSH_TOOLS.has(prefs.tool)) {
      children.push(
        section(
          'Pinsel',
          num('Größe (m)', () => prefs.radius, (v) => (prefs.radius = v), 0.5, MIN_RADIUS, 500),
          prefs.tool === 'paint' ? num('Dichte (×)', () => prefs.density, (v) => (prefs.density = v), 0.05, 0.01, 10) : null,
          prefs.tool === 'erase' || prefs.tool === 'paint' ? check('Radieren: nur aktive', prefs.eraseActiveOnly, (v) => (prefs.eraseActiveOnly = v)) : null,
          prefs.tool === 'reapply' ? check('Höhe', prefs.reHeight, (v) => (prefs.reHeight = v)) : null,
          prefs.tool === 'reapply' ? check('Ausrichtung', prefs.reAlign, (v) => (prefs.reAlign = v)) : null,
          prefs.tool === 'reapply' ? check('Skalierung (außerhalb)', prefs.reScale, (v) => (prefs.reScale = v)) : null,
          prefs.tool === 'reapply' ? check('Filter (entfernen)', prefs.reFilter, (v) => (prefs.reFilter = v)) : null,
          h('div', { class: 'mode-note dim' }, '[ / ] oder Strg+Mausrad = Größe' + (prefs.tool === 'paint' ? ', Strg+Umschalt+Mausrad = Dichte' : '')),
        ),
      );
    }
    if (prefs.tool === 'select') {
      children.push(
        section(
          `Auswahl (${selection.size})`,
          h(
            'div',
            { class: 'ls-buttons' },
            button('Löschen', deleteSelection, 'btn', 'trash', selection.size > 0),
            button('Aufheben', () => (selection.clear(), updateMarks(), render()), 'btn', undefined, selection.size > 0),
          ),
        ),
      );
    }
    if (prefs.tool === 'fill' && !job) {
      children.push(
        section(
          'Füllen',
          num('Dichte (×)', () => prefs.density, (v) => (prefs.density = v), 0.05, 0.01, 10),
          h('div', { class: 'ls-buttons' }, button('Landscapes füllen…', fillDialog, 'btn primary', 'leaf', !!T && activeTypes(T).length > 0 && gcount > 0)),
          h('div', { class: 'mode-note dim' }, 'Setzt die aktiven Typen mit ihrer Dichte, ihren Filtern und dem Mindestabstand auf alle Landscapes (ein Undo-Schritt). Läuft im Hintergrund, Esc bricht ab.'),
        ),
      );
    }

    children.push(typeList(T));
    const cur = T?.data.type(selType);
    if (T && cur) children.push(typeProps(T, cur));
    panel.replaceChildren(...children.filter((c): c is HTMLElement => !!c));
  }

  function setTool(id: ToolId): void {
    if (stroke) endStroke();
    prefs.tool = id;
    savePrefs();
    render();
    updateRing();
  }

  let renderQueued = false;
  function queueRender(): void {
    if (!active || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (active && !stroke) {
        render();
        updateMarks();
      }
    });
  }
  state.on('scene', queueRender);
  state.on('selection', queueRender);
  state.on('meta', queueRender);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Shift') {
      shift = e.type === 'keydown';
      updateRing();
    }
  };

  return {
    id: 'foliage',
    label: 'Foliage',
    icon: 'leaf',
    panel,
    allowsSelection: false,
    activate() {
      active = true;
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      render();
      updateMarks();
    },
    deactivate() {
      if (stroke) endStroke();
      active = false;
      hover = null;
      ring.visible = false;
      marks.visible = false;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    },
    pointerDown(e) {
      shift = e.shiftKey;
      if (job || !BRUSH_TOOLS.has(prefs.tool)) return false;
      const tool = effectiveTool();
      // Layer-Gras braucht kein Foliage-Objekt
      const withGrass = grassGrounds().length > 0;
      const grassPaint = tool === 'paint' && grassActive() && withGrass;
      const grassErase = tool === 'erase' && (grassActive() || !prefs.eraseActiveOnly) && withGrass;
      let T = target();
      if (tool === 'paint' && !T && !grassPaint) T = ensureTarget();
      if (tool === 'paint' && !(T && activeTypes(T).length) && !grassPaint) {
        ctx.status(T?.data.types.length ? 'Kein aktiver Foliage-Typ' : 'Zuerst einen Foliage-Typ anlegen („Neu“)', true);
        return true;
      }
      if (!T && !grassPaint && !grassErase) return false;
      hover = cast(e.clientX, e.clientY);
      lastPointer = { x: e.clientX, y: e.clientY };
      const label = TOOLS.find((t) => t.id === tool)?.label ?? 'Pinsel';
      stroke = { T, rec: T ? new CellRecorder(T.data) : null, grass: new Map(), tool, acc: 1, downX: e.clientX, downY: e.clientY, brushing: false, label };
      if (tool === 'select') {
        if (!shift) {
          selection.clear();
          updateMarks();
        }
        return true;
      }
      applyStroke(1);
      updateRing();
      return true;
    },
    pointerMove(e, inStroke) {
      shift = e.shiftKey;
      lastPointer = { x: e.clientX, y: e.clientY };
      hover = cast(e.clientX, e.clientY);
      if (inStroke && stroke?.tool === 'select' && !stroke.brushing && Math.hypot(e.clientX - stroke.downX, e.clientY - stroke.downY) > 5) stroke.brushing = true;
      updateRing();
    },
    pointerUp() {
      if (stroke) endStroke();
    },
    pointerLeave() {
      hover = null;
      lastPointer = null;
      updateRing();
    },
    wheel(e) {
      if (!e.ctrlKey) return false;
      const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      if (e.shiftKey) {
        prefs.density = THREE.MathUtils.clamp(prefs.density * k, 0.01, 10);
        ctx.status(`Pinsel-Dichte ×${prefs.density.toFixed(2)}`);
      } else {
        prefs.radius = roundRadius(THREE.MathUtils.clamp(prefs.radius * k, MIN_RADIUS, 500));
        ctx.status(`Pinselgröße ${fmtRadius(prefs.radius)}`);
      }
      savePrefs();
      render();
      updateRing();
      return true;
    },
    update(dt) {
      if (job) runFill();
      if (!stroke) return;
      // Kamera kann sich während des Strichs bewegen → Treffer neu bestimmen
      if (lastPointer) hover = cast(lastPointer.x, lastPointer.y) ?? hover;
      applyStroke(Math.min(dt, 0.1));
      updateRing();
    },
    key(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      if (e.key === '[' || e.key === ']') {
        prefs.radius = roundRadius(THREE.MathUtils.clamp(prefs.radius * (e.key === ']' ? 1.15 : 1 / 1.15), MIN_RADIUS, 500));
        savePrefs();
        ctx.status(`Pinselgröße ${fmtRadius(prefs.radius)}`);
        render();
        updateRing();
        return true;
      }
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m && !e.shiftKey && TOOLS[Number(m[1]) - 1]) {
        setTool(TOOLS[Number(m[1]) - 1].id);
        return true;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
        deleteSelection();
        return true;
      }
      if (e.key === 'Escape') {
        if (job) {
          finishFill(true);
          return true;
        }
        if (selection.size) {
          selection.clear();
          updateMarks();
          render();
          return true;
        }
      }
      return false;
    },
  };
}

function fmtCount(n: number): string {
  n = Math.round(n);
  return n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)} Tsd.` : String(n);
}

function fmtArea(m2: number): string {
  return m2 >= 1e6 ? `${(m2 / 1e6).toFixed(2)} km²` : `${Math.round(m2)} m²`;
}

function fmtRadius(m: number): string {
  return m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(1)} m`;
}
