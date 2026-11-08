import * as THREE from 'three';
import { h, numberField, pickFile, toast } from '../ui.ts';
import { icon } from '../icons.ts';
import { models } from '../models.ts';
import { actionButton } from '../assetAction.ts';
import type { EditorMode, ModeContext, ModeId } from './types.ts';
import type { EditorState } from '../state.ts';
import { ASSETS, defaultProps, type PropDef } from '../../world/assets.ts';
import type { MapObjectData, PropValue } from '../../world/mapFormat.ts';
import { modelLabel } from '../../world/modelStore.ts';
import { LANDSCAPE_TYPE } from '../../world/landscape/asset.ts';
import { liveLandscapes } from '../../world/landscape/render.ts';
import { CABLE_TYPE, ROAD_TYPE, SPLINEMESH_TYPE, SPLINE_PRESETS, SPLINE_TYPES } from '../../world/splines/asset.ts';
import { SplineCurve, parsePoints, sampleCable, stringifyPoints, type SplinePoint, type V3 } from '../../world/splines/curve.ts';

// Splines-Modus (Phase 4, wie UE5 Landscape-Splines / Spline-Mesh):
//  - „Neu“: Straße, Feldweg, Leitplanke, Zaun, Mauer, Modell, Kabel, Rohr — Klicks setzen Punkte, Enter/Esc beendet
//  - Punkt ziehen = verschieben (folgt dem Gelände), Umschalt+Ziehen = Höhe, Klick auf die Kurve = Punkt einfügen,
//    Strg+Klick = Punkt anhängen, Entf = Punkt löschen
//  - Kabel-Punkte auf einem Strommast rasten am nächsten Isolator ein und wandern mit, wenn der Mast bewegt wird
// Straßen formen das Gelände über world/splines/deform.ts (nicht-destruktiv, gemaltes Gelände bleibt erhalten).

const PICK_PX = 12;
const CURVE_PX = 9;
const SOCKET_SNAP = 1.5;

const DEG = Math.PI / 180;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Welt-Matrix eines Objekts aus seinen Daten (Grad, XYZ; feste Drehung/Skalierung beachtet) */
function objectMatrix(o: MapObjectData, out = new THREE.Matrix4()): THREE.Matrix4 {
  const def = ASSETS[o.type];
  _e.set(def?.fixedRotation ? 0 : o.rot[0] * DEG, def?.fixedRotation ? 0 : o.rot[1] * DEG, def?.fixedRotation ? 0 : o.rot[2] * DEG, 'XYZ');
  _q.setFromEuler(_e);
  _s.set(...(def?.fixedScale ? ([1, 1, 1] as V3) : o.scale));
  return out.compose(_v.set(...o.pos), _q, _s);
}

/**
 * Angehängte Kabel-Punkte nachführen (Mast verschoben/gedreht/gelöscht). Liefert true, wenn sich etwas geändert hat.
 * Gelöschte Ziele: Punkt bleibt, wo er war, und ist nicht mehr angehängt.
 */
export function resolveAttachments(state: EditorState): boolean {
  let changed = false;
  for (const o of state.map.objects) {
    if (!SPLINE_TYPES.has(o.type) || typeof o.props.points !== 'string' || !o.props.points.includes('"a"')) continue;
    const pts = parsePoints(o.props.points);
    let dirty = false;
    for (const p of pts) {
      if (!p.a) continue;
      const t = state.get(p.a);
      if (!t || !p.o) {
        delete p.a;
        delete p.o;
        dirty = true;
        continue;
      }
      const w = new THREE.Vector3(...p.o).applyMatrix4(objectMatrix(t, _m));
      const l: V3 = [w.x - o.pos[0], w.y - o.pos[1], w.z - o.pos[2]];
      if (Math.abs(l[0] - p.p[0]) + Math.abs(l[1] - p.p[1]) + Math.abs(l[2] - p.p[2]) > 0.002) {
        p.p = l;
        dirty = true;
      }
    }
    if (dirty) {
      o.props.points = stringifyPoints(pts);
      changed = true;
    }
  }
  return changed;
}

/** Im Editor einmal einrichten: Kabel folgen ihren Masten (Gizmo live und bei jeder Szenen-Änderung) */
export function installSplineAttachments(state: EditorState): void {
  let busy = false;
  const run = () => {
    if (busy || state.simulating) return;
    busy = true;
    try {
      if (resolveAttachments(state)) state.emit('scene');
    } finally {
      busy = false;
    }
  };
  state.on('transform', run);
  state.on('scene', run);
}

/** Basis-Höhe des Geländes (ohne Straßen-Verformung) an einem Welt-Punkt, sonst null */
function baseHeight(x: number, z: number): number | null {
  for (const ls of liveLandscapes()) {
    const d = ls.data;
    ls.mesh.updateWorldMatrix(true, false);
    const o = _v.setFromMatrixPosition(ls.mesh.matrixWorld);
    const gx = d.toGridX(x - o.x);
    const gz = d.toGridZ(z - o.z);
    if (gx < 0 || gz < 0 || gx > d.W || gz > d.H) continue;
    return d.heightAtGrid(gx, gz, d.editHeights) + o.y;
  }
  return null;
}

/** Vorlage im Modus-Panel („Neu“) */
export interface SplineModePreset {
  id: string;
  label: string;
  type: string;
  icon: string;
  props?: Record<string, PropValue>;
}

/**
 * Konfiguration des Spline-Modus: Splines (Phase 4) und Wasser (Phase 6) teilen sich das Werkzeug,
 * unterscheiden sich aber in Typen, Vorlagen, Mindest-Punktzahl und Details.
 */
export interface SplineModeConfig {
  id: ModeId;
  label: string;
  icon: string;
  /** Typen, die dieser Modus bearbeitet */
  types: ReadonlySet<string>;
  presets: readonly SplineModePreset[];
  /** Typen, die beim Setzen von Punkten nicht als Untergrund zählen */
  skip: ReadonlySet<string>;
  /** Mindest-Punktzahl; 0 = ein Klick setzt das ganze Objekt (Meer) */
  minPoints(type: string): number;
  /** geschlossene Kurve */
  closed(o: MapObjectData): boolean;
  /** Punkte liegen flach auf Objekthöhe (See); Höhe bestimmt die Objekt-Position */
  flat?(type: string): boolean;
  /** Breiten-Faktor je Punkt */
  pointWidth(type: string): boolean;
  /** Querneigung je Punkt */
  pointRoll(type: string): boolean;
  /** Eigenschaft im Panel zeigen */
  relevant(o: MapObjectData, p: PropDef): boolean;
  /** zusätzliche Zeilen unter dem Objekt-Namen */
  /** Statuszeile nach dem Setzen eines Ein-Klick-Objekts (minPoints 0) */
  placedNote?(type: string): string;
  objectRows?(o: MapObjectData, set: (fn: () => void, commit: boolean) => void): (HTMLElement | null | false)[];
  drawNote: string;
  emptyNote: string;
  help: string[];
}

/** Nur passende Eigenschaften je Art zeigen (Spline-Mesh: Mauer-Material nur bei Mauer …) */
function splineRelevant(o: MapObjectData, p: PropDef): boolean {
  if (p.hidden) return false;
  if (o.type === SPLINEMESH_TYPE) {
    const k = o.props.profile;
    if (p.key === 'thickness' || p.key === 'material') return k === 'mauer';
    if (p.key === 'height') return k === 'mauer' || k === 'zaun';
    if (p.key === 'spacing') return k === 'leitplanke' || k === 'zaun';
    if (p.key === 'model') return k === 'modell';
  }
  if (o.type === CABLE_TYPE && p.key === 'sag') return o.props.kind !== 'rohr';
  if (o.type === ROAD_TYPE) {
    if (p.key === 'curbHeight') return o.props.curbs === true;
    if (p.key === 'shoulder' || p.key === 'lower') return o.props.deform !== false;
    if (p.key === 'lineColor') return o.props.markings !== 'none' || o.props.edgeLines !== false;
  }
  return true;
}

export const SPLINES_CONFIG: SplineModeConfig = {
  id: 'splines',
  label: 'Splines',
  icon: 'spline',
  types: SPLINE_TYPES,
  presets: SPLINE_PRESETS,
  skip: SPLINE_TYPES,
  minPoints: () => 2,
  closed: (o) => o.props.closed === true,
  pointWidth: (t) => t === ROAD_TYPE,
  pointRoll: (t) => t !== CABLE_TYPE,
  relevant: splineRelevant,
  drawNote: 'Klicks setzen Punkte (Straßen folgen dem Gelände, Kabel rasten an Strommasten ein). Enter oder Esc beendet.',
  emptyNote: 'Spline im Viewport anklicken oder oben einen neuen anlegen.',
  help: [
    'Punkt ziehen: verschieben (folgt dem Gelände)',
    'Umschalt + Ziehen: Höhe ändern',
    'Klick auf die Kurve: Punkt einfügen',
    'Strg + Klick: Punkt am Ende anhängen',
    'Entf: Punkt löschen · Esc: Punkt abwählen',
    'Kabel auf einem Strommast: rastet am Isolator ein und folgt dem Mast',
  ],
};

interface Drawing {
  /** Vorgabe für ein neues Objekt (null = an bestehendes anhängen) */
  preset: SplineModePreset | null;
  /** Objekt, an das Punkte angehängt werden */
  id: string | null;
  /** Höhen der geklickten Punkte (flache Typen: Wasserspiegel = tiefster Uferpunkt) */
  heights: number[];
}

export function createSplinesMode(ctx: ModeContext, cfg: SplineModeConfig = SPLINES_CONFIG): EditorMode {
  const { state, viewport: vp } = ctx;
  const isFlat = (type: string) => cfg.flat?.(type) === true;
  const panel = h('div', { class: 'mode-panel-body splines-panel' });
  const raycaster = new THREE.Raycaster();
  let active = false;
  let drawing: Drawing | null = null;
  /** ausgewählter Punkt im aktuellen Spline */
  let selPoint = -1;
  let selFor = '';
  /** Ziehen eines Punkts */
  let drag: { id: string; index: number; vertical: boolean; startY: number; startWorldY: number; moved: boolean; pending: { x: number; y: number } | null } | null = null;

  // ---------- Overlay: Punkte des aktuellen Splines ----------

  const markGeo = new THREE.BufferGeometry();
  const marks = new THREE.Points(markGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 10, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }));
  const selGeo = new THREE.BufferGeometry();
  const selMark = new THREE.Points(selGeo, new THREE.PointsMaterial({ color: 0xffc23d, size: 15, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false }));
  for (const m of [marks, selMark]) {
    m.renderOrder = 999;
    m.frustumCulled = false;
    m.visible = false;
    m.userData.noWeather = true;
    m.userData.noPick = true;
    vp.scene.add(m);
  }

  function cur(): MapObjectData | undefined {
    const o = state.primary;
    return o && cfg.types.has(o.type) ? o : undefined;
  }
  const pointsOf = (o: MapObjectData) => parsePoints(o.props.points);
  const worldOf = (o: MapObjectData, p: SplinePoint) => new THREE.Vector3(p.p[0] + o.pos[0], p.p[1] + o.pos[1], p.p[2] + o.pos[2]);
  const localOf = (o: MapObjectData, w: THREE.Vector3): V3 => [w.x - o.pos[0], w.y - o.pos[1], w.z - o.pos[2]];

  function updateMarks(): void {
    const o = active ? cur() : undefined;
    if (!o) {
      marks.visible = selMark.visible = false;
      return;
    }
    if (selFor !== o.id) {
      selFor = o.id;
      selPoint = -1;
    }
    const pts = pointsOf(o);
    if (selPoint >= pts.length) selPoint = pts.length - 1;
    const arr = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => worldOf(o, p).toArray(arr, i * 3));
    markGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    marks.visible = pts.length > 0;
    if (selPoint >= 0) {
      selGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(worldOf(o, pts[selPoint]).toArray()), 3));
      selMark.visible = true;
    } else selMark.visible = false;
  }

  function setPoints(o: MapObjectData, pts: SplinePoint[], commit: boolean): void {
    state.update(() => (o.props.points = stringifyPoints(pts)), commit);
  }

  // ---------- Bildschirm / Treffer ----------

  function toScreen(w: THREE.Vector3): { x: number; y: number } | null {
    const r = vp.renderer.domElement.getBoundingClientRect();
    const v = w.clone().project(vp.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  function rayAt(x: number, y: number): THREE.Ray {
    const r = vp.renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), vp.camera);
    return raycaster.ray.clone();
  }

  /**
   * Punkt unter der Maus: Straßen und andere Splines werden übersprungen; auf einer Landscape zählt die Höhe ohne
   * Straßen-Verformung (sonst sinkt der Punkt bei jedem Ziehen um „Gelände unter Straße“). Kabel treffen auch Objekte.
   */
  function groundAt(x: number, y: number): { point: THREE.Vector3; id: string | null } {
    const ray = rayAt(x, y);
    const hit = vp.castSurface(ray, 4000, (_id, type) => cfg.skip.has(type));
    if (hit) {
      const t = state.get(hit.id);
      if (t?.type === LANDSCAPE_TYPE) {
        const b = baseHeight(hit.point.x, hit.point.z);
        if (b !== null) hit.point.y = b;
      }
      return { point: hit.point, id: hit.id };
    }
    return { point: vp.surfacePoint(x, y).point, id: null };
  }

  /** Nächster Isolator (Ankerpunkt) eines Objekts zu einem Welt-Punkt */
  function nearestSocket(id: string, w: THREE.Vector3): { local: V3; world: THREE.Vector3 } | null {
    const t = state.get(id);
    const node = vp.nodeById(id);
    const sockets = node?.instance?.object.userData.sockets as THREE.Vector3[] | undefined;
    if (!t || !sockets?.length) return null;
    const m = objectMatrix(t, new THREE.Matrix4());
    let best: { local: V3; world: THREE.Vector3 } | null = null;
    let bd = SOCKET_SNAP;
    for (const s of sockets) {
      const sw = s.clone().applyMatrix4(m);
      const d = sw.distanceTo(w);
      if (d < bd) {
        bd = d;
        best = { local: [s.x, s.y, s.z], world: sw };
      }
    }
    return best;
  }

  /** Punkt aus Klick bauen (Kabel: ggf. an Mast einrasten) */
  function pointFromHit(o: MapObjectData | null, g: { point: THREE.Vector3; id: string | null }, base?: SplinePoint): { world: THREE.Vector3; a?: string; ao?: V3 } {
    const isCable = (o?.type ?? drawing?.preset?.type) === CABLE_TYPE;
    if (isCable && g.id && state.get(g.id)?.type !== LANDSCAPE_TYPE) {
      const s = nearestSocket(g.id, g.point);
      if (s) return { world: s.world, a: g.id, ao: s.local };
    }
    const world = g.point.clone();
    // Kabel ohne Mast: 0,5 m über dem Boden, damit es nicht im Gras liegt
    if (isCable && !base) world.y += 0.5;
    return { world };
  }

  function applyPoint(o: MapObjectData, p: SplinePoint, r: { world: THREE.Vector3; a?: string; ao?: V3 }): void {
    p.p = localOf(o, r.world);
    if (isFlat(o.type)) p.p[1] = 0;
    if (r.a && r.ao) {
      p.a = r.a;
      p.o = r.ao;
    } else {
      delete p.a;
      delete p.o;
    }
  }

  /** Index des nächsten Kontrollpunkts auf dem Bildschirm */
  function nearestControl(o: MapObjectData, x: number, y: number): number {
    let best = -1;
    let bd = PICK_PX;
    pointsOf(o).forEach((p, i) => {
      const s = toScreen(worldOf(o, p));
      if (!s) return;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  /** Stelle auf der Kurve unter der Maus: Segment-Index und Welt-Punkt */
  function nearestOnCurve(o: MapObjectData, x: number, y: number): { seg: number; world: THREE.Vector3 } | null {
    const pts = pointsOf(o);
    if (pts.length < 2) return null;
    const closed = cfg.closed(o);
    // dichte Abtastung je Segment (Kabel: mit Durchhang)
    let best: { seg: number; world: THREE.Vector3 } | null = null;
    let bd = CURVE_PX;
    const segs = closed ? pts.length : pts.length - 1;
    const curve = new SplineCurve(pts, closed);
    const sag = o.type === CABLE_TYPE && o.props.kind !== 'rohr' ? Number(o.props.sag ?? 3) / 100 : -1;
    for (let s = 0; s < segs; s++) {
      const line =
        sag >= 0
          ? sampleCable([pts[s], pts[(s + 1) % pts.length]], sag, 0.25)
          : Array.from({ length: 33 }, (_, i) => curve.point(s, i / 32));
      for (let i = 1; i < line.length - 1; i++) {
        const w = line[i].clone().add(_v.set(...o.pos));
        const sc = toScreen(w);
        if (!sc) continue;
        const d = Math.hypot(sc.x - x, sc.y - y);
        if (d < bd) {
          bd = d;
          best = { seg: s, world: w };
        }
      }
    }
    return best;
  }

  // ---------- Aktionen ----------

  function startDrawing(preset: Drawing['preset'], id: string | null = null): void {
    drawing = { preset, id, heights: [] };
    if (!id) {
      state.select([]);
      selPoint = -1;
    }
    ctx.status(id ? 'Klicks hängen Punkte an — Enter/Esc beendet' : `${preset?.label}: Punkte in den Viewport klicken — Enter/Esc beendet`);
    render();
    updateMarks();
  }

  function stopDrawing(): void {
    if (!drawing) return;
    const o = drawing.id ? state.get(drawing.id) : undefined;
    const heights = drawing.heights;
    const isNew = !!drawing.preset;
    drawing = null;
    const min = o ? cfg.minPoints(o.type) : 0;
    if (o && pointsOf(o).length < min) {
      ctx.status(`„${ASSETS[o.type]?.label ?? o.type}“ braucht mindestens ${min} Punkte — Objekt entfernt`, true);
      state.update(() => {
        state.map.objects = state.map.objects.filter((x) => x.id !== o.id);
        state.selection = [];
      });
      state.emit('selection');
    } else if (o) {
      // flache Fläche (See): Spiegel auf den tiefsten geklickten Uferpunkt legen
      if (isFlat(o.type) && isNew && heights.length) {
        const y = Math.round(Math.min(...heights) * 100) / 100;
        if (Math.abs(y - o.pos[1]) > 1e-3) state.update(() => (o.pos[1] = y), true);
      }
      ctx.status(`„${o.name}“: ${pointsOf(o).length} Punkte`);
    }
    render();
    updateMarks();
  }

  /** Klick beim Zeichnen: erster Klick legt das Objekt an, jeder weitere hängt einen Punkt an */
  function drawClick(x: number, y: number): void {
    if (!drawing) return;
    let o = drawing.id ? state.get(drawing.id) : undefined;
    const g = groundAt(x, y);
    if (!o) {
      const pr = drawing.preset;
      if (!pr) return;
      const r = pointFromHit(null, g);
      const pos: V3 = [Math.round(r.world.x * 100) / 100, Math.round(r.world.y * 100) / 100, Math.round(r.world.z * 100) / 100];
      const props = defaultProps(pr.type, pr.props);
      if (cfg.minPoints(pr.type) === 0) {
        // Ein-Klick-Objekt (Meer): setzen, auswählen, fertig
        const existing = ASSETS[pr.type]?.unique ? state.map.objects.find((x) => x.type === pr.type) : undefined;
        drawing = null;
        if (existing) {
          state.select([existing.id]);
          ctx.status(`Es gibt nur ein „${ASSETS[pr.type]?.label ?? pr.type}“ pro Map — vorhandenes ausgewählt`, true);
        } else {
          const [one] = state.add([{ id: '', name: pr.label, type: pr.type, pos, rot: [0, 0, 0], scale: [1, 1, 1], props }], true);
          if (one) {
            state.select([one.id]);
            ctx.status(`„${one.name}“ gesetzt — ${cfg.placedNote?.(one.type) ?? 'Höhe im Panel einstellen'}`);
          }
        }
        render();
        updateMarks();
        return;
      }
      const [added] = state.add([{ id: '', name: pr.label, type: pr.type, pos, rot: [0, 0, 0], scale: [1, 1, 1], props }], false);
      if (!added) return;
      o = added;
      drawing.heights.push(r.world.y);
      const p: SplinePoint = { p: [0, 0, 0] };
      applyPoint(o, p, r);
      drawing.id = o.id;
      selFor = o.id;
      selPoint = 0;
      setPoints(o, [p], false);
      render();
      updateMarks();
      return;
    }
    const pts = pointsOf(o);
    const p: SplinePoint = { p: [0, 0, 0] };
    const hitPoint = pointFromHit(o, g);
    drawing.heights.push(hitPoint.world.y);
    applyPoint(o, p, hitPoint);
    pts.push(p);
    selPoint = pts.length - 1;
    setPoints(o, pts, pts.length >= Math.max(2, cfg.minPoints(o.type)));
    render();
    updateMarks();
  }

  function deletePoint(): void {
    const o = cur();
    if (!o || selPoint < 0) return;
    const pts = pointsOf(o);
    if (pts.length <= cfg.minPoints(o.type)) {
      ctx.status(`Mindestens ${cfg.minPoints(o.type)} Punkte nötig (ganzes Objekt: im Auswahl-Modus löschen)`, true);
      return;
    }
    pts.splice(selPoint, 1);
    selPoint = Math.min(selPoint, pts.length - 1);
    setPoints(o, pts, true);
    render();
    updateMarks();
  }

  function reverse(): void {
    const o = cur();
    if (!o) return;
    const pts = pointsOf(o).reverse();
    for (const p of pts) if (p.t) p.t = [-p.t[0], -p.t[1], -p.t[2]];
    if (selPoint >= 0) selPoint = pts.length - 1 - selPoint;
    setPoints(o, pts, true);
    updateMarks();
  }

  /** alle (nicht angehängten) Punkte auf das Gelände bzw. die Fläche darunter setzen */
  function dropToGround(): void {
    const o = cur();
    if (!o) return;
    const pts = pointsOf(o);
    let n = 0;
    for (const p of pts) {
      if (p.a) continue;
      const w = worldOf(o, p);
      let y = baseHeight(w.x, w.z);
      if (y === null) {
        const hit = vp.castSurface(new THREE.Ray(w.clone().setY(w.y + 200), new THREE.Vector3(0, -1, 0)), 1000, (id, type) => cfg.skip.has(type) || id === o.id);
        y = hit?.point.y ?? null;
      }
      if (y === null) continue;
      if (o.type === CABLE_TYPE) y += 0.5;
      p.p[1] = y - o.pos[1];
      n++;
    }
    setPoints(o, pts, true);
    updateMarks();
    ctx.status(`${n} Punkt${n === 1 ? '' : 'e'} aufs Gelände gesetzt`);
  }

  // ---------- Panel ----------

  const section = (title: string, ...rows: (HTMLElement | null | false)[]) =>
    h('div', { class: 'section' }, h('div', { class: 'section-head' }, title), h('div', { class: 'section-body' }, ...rows.filter((r): r is HTMLElement => !!r)));
  const row = (label: string, ...el: (Node | string)[]) => h('div', { class: 'prop-row' }, h('label', { title: label }, label), h('div', { class: 'value' }, ...el));
  const button = (label: string, fn: () => void, cls = 'btn', ico?: string, enabled = true) => {
    const b = h('button', { class: cls, html: `${ico ? icon(ico) : ''}${label}` });
    b.addEventListener('click', fn);
    b.toggleAttribute('disabled', !enabled);
    return b;
  };

  /** Eigenschaft des Splines (wie im Details-Panel) */
  function propRow(o: MapObjectData, p: PropDef): HTMLElement {
    const value = o.props[p.key] ?? p.default;
    const set = (v: PropValue, live = false) => {
      state.update(() => (o.props[p.key] = v), !live);
      if (p.type === 'select' || p.type === 'bool') render();
    };
    switch (p.type) {
      case 'action':
        return row('', actionButton(o, p));
      case 'number':
        return row(p.label, numberField({ value: Number(value), step: p.step ?? 0.1, min: p.min, max: p.max, onChange: (v, live) => set(v, live) }));
      case 'bool': {
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = !!value;
        cb.addEventListener('change', () => set(cb.checked));
        return row(p.label, cb);
      }
      case 'color': {
        const c = h('input', { type: 'color', value: String(value) }) as HTMLInputElement;
        c.addEventListener('input', () => set(c.value, true));
        c.addEventListener('change', () => set(c.value));
        return row(p.label, c);
      }
      case 'select': {
        const s = h('select', {}, ...(p.options ?? []).map((opt) => h('option', { value: opt.value, selected: opt.value === value }, opt.label)));
        s.addEventListener('change', () => set(s.value));
        return row(p.label, s);
      }
      case 'model': {
        const all = models.all;
        const s = h('select', {}, h('option', { value: '' }, '— kein Modell —'), ...all.map((ref) => h('option', { value: ref, selected: ref === value }, modelLabel(ref))));
        if (value && !all.includes(String(value))) s.append(h('option', { value: String(value), selected: true }, `${modelLabel(String(value))} (fehlt)`));
        s.addEventListener('change', () => set(s.value));
        const imp = h('button', { class: 'btn', title: '.glb-Datei importieren', html: icon('upload') });
        imp.addEventListener('click', async () => {
          const file = await pickFile('.glb');
          if (!file) return;
          try {
            set(await models.import(file));
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        });
        return row(p.label, s, imp);
      }
      default: {
        const t = h('input', { type: 'text', value: String(value), spellcheck: 'false' }) as HTMLInputElement;
        t.addEventListener('keydown', (e) => e.stopPropagation());
        t.addEventListener('change', () => set(t.value));
        return row(p.label, t);
      }
    }
  }

  function pointSection(o: MapObjectData): HTMLElement | null {
    const pts = pointsOf(o);
    if (selPoint < 0 || selPoint >= pts.length) return null;
    const p = pts[selPoint];
    const w = worldOf(o, p);
    const edit = (fn: (p: SplinePoint) => void, live: boolean) => {
      const all = pointsOf(o);
      fn(all[selPoint]);
      setPoints(o, all, !live);
      updateMarks();
    };
    const axis = (i: 0 | 1 | 2) =>
      numberField({
        value: Math.round(w.getComponent(i) * 100) / 100,
        step: 0.1,
        axis: (['x', 'y', 'z'] as const)[i],
        onChange: (v, live) =>
          edit((q) => {
            q.p[i] = v - o.pos[i];
            delete q.a;
            delete q.o;
          }, live),
      });
    const target = p.a ? state.get(p.a) : undefined;
    return section(
      `Punkt ${selPoint + 1} von ${pts.length}`,
      isFlat(o.type) ? row('Position', axis(0), axis(2)) : row('Position', axis(0), axis(1), axis(2)),
      cfg.pointWidth(o.type) && row('Breite (×)', numberField({ value: p.w ?? 1, step: 0.05, min: 0.1, max: 5, onChange: (v, live) => edit((q) => (q.w = v), live) })),
      cfg.pointRoll(o.type) && row('Querneigung (°)', numberField({ value: p.roll ?? 0, step: 1, min: -45, max: 45, onChange: (v, live) => edit((q) => (q.roll = v || undefined), live) })),
      target ? row('Hängt an', h('span', { class: 'hex' }, target.name), button('Lösen', () => edit((q) => (delete q.a, delete q.o), false))) : null,
      h('div', { class: 'ls-buttons' }, button('Punkt löschen', deletePoint, 'btn danger', 'trash', pts.length > cfg.minPoints(o.type))),
    );
  }

  function render(): void {
    if (!active) return;
    const children: (HTMLElement | null)[] = [h('div', { class: 'mode-head', html: `${icon(cfg.icon)}<span>${cfg.label}</span>` })];
    const grid = h('div', { class: 'ls-tools' });
    for (const pr of cfg.presets) {
      const on = drawing && !drawing.id && drawing.preset?.id === pr.id;
      const on2 = drawing?.preset?.id === pr.id;
      const b = h('button', { class: `btn ls-tool${on || on2 ? ' on' : ''}`, html: `${icon(pr.icon)}${pr.label}` });
      b.addEventListener('click', () => (drawing?.preset?.id === pr.id ? stopDrawing() : (stopDrawing(), startDrawing(pr))));
      grid.append(b);
    }
    children.push(section('Neu', grid));
    if (drawing)
      children.push(
        section(
          'Zeichnen',
          h('div', { class: 'mode-note' }, cfg.drawNote),
          h('div', { class: 'ls-buttons' }, button('Fertig', stopDrawing, 'btn primary')),
        ),
      );

    const o = cur();
    if (o) {
      const pts = pointsOf(o);
      const len = pts.length > 1 ? new SplineCurve(pts, cfg.closed(o)).length() : 0;
      const pointTools = cfg.minPoints(o.type) > 0;
      children.push(
        section(
          o.name,
          h('div', { class: 'mode-note dim' }, pointTools ? `${ASSETS[o.type]?.label ?? o.type} · ${pts.length} Punkte · ${len.toFixed(1)} m` : (ASSETS[o.type]?.label ?? o.type)),
          ...(cfg.objectRows?.(o, (fn, commit) => state.update(fn, commit)) ?? []),
          pointTools &&
            h(
              'div',
              { class: 'ls-buttons' },
              button('Punkte anhängen', () => startDrawing(null, o.id), 'btn', 'plus', !drawing),
              ...(isFlat(o.type) ? [] : [button('Umkehren', reverse), button('Aufs Gelände', dropToGround)]),
            ),
        ),
      );
      children.push(pointSection(o));
      const groups = new Map<string, PropDef[]>();
      for (const p of ASSETS[o.type]?.props ?? []) {
        if (!cfg.relevant(o, p)) continue;
        const g = p.group ?? 'Eigenschaften';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(p);
      }
      for (const [g, ps] of groups) children.push(section(g, ...ps.map((p) => propRow(o, p))));
    } else if (!drawing) children.push(h('div', { class: 'mode-note' }, cfg.emptyNote));
    children.push(
      section(
        'Bedienung',
        h('ul', { class: 'mode-list' }, ...cfg.help.map((t) => h('li', {}, t))),
      ),
    );
    panel.replaceChildren(...children.filter((c): c is HTMLElement => !!c));
  }

  let renderQueued = false;
  function queueRender(): void {
    if (!active || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!active) return;
      updateMarks();
      // Panel nicht unter laufendem Ziehen oder Tippen neu bauen
      if (!drag && !panel.contains(document.activeElement)) render();
    });
  }
  state.on('scene', queueRender);
  state.on('selection', queueRender);
  state.on('transform', queueRender);

  // ---------- Ziehen ----------

  function applyDrag(): void {
    if (!drag?.pending) return;
    const o = state.get(drag.id);
    if (!o) {
      drag = null;
      return;
    }
    const { x, y } = drag.pending;
    drag.pending = null;
    const pts = pointsOf(o);
    const p = pts[drag.index];
    if (!p) return;
    if (drag.vertical && !isFlat(o.type)) {
      const w = worldOf(o, p);
      const dist = w.distanceTo(vp.camera.position);
      const r = vp.renderer.domElement.getBoundingClientRect();
      const perPx = (2 * dist * Math.tan((vp.camera.fov * DEG) / 2)) / r.height;
      p.p[1] = drag.startWorldY + (drag.startY - y) * perPx - o.pos[1];
      delete p.a;
      delete p.o;
    } else {
      const g = groundAt(x, y);
      const r = pointFromHit(o, g, p);
      // Kabel ohne Mast: Höhe über dem Boden beibehalten
      if (o.type === CABLE_TYPE && !r.a) {
        const before = worldOf(o, p);
        const ground = baseHeight(before.x, before.z);
        r.world.y += ground !== null ? Math.max(0, before.y - ground) : 0.5;
      }
      applyPoint(o, p, r);
    }
    drag.moved = true;
    setPoints(o, pts, false);
  }

  return {
    id: cfg.id,
    label: cfg.label,
    icon: cfg.icon,
    panel,
    allowsSelection: false,
    activate() {
      active = true;
      render();
      updateMarks();
    },
    deactivate() {
      if (drawing) stopDrawing();
      if (drag) {
        drag = null;
        state.commit();
      }
      active = false;
      marks.visible = selMark.visible = false;
    },
    pointerDown(e) {
      const x = e.clientX;
      const y = e.clientY;
      if (drawing) {
        drawClick(x, y);
        return true;
      }
      const o = cur();
      if (o) {
        const i = nearestControl(o, x, y);
        if (i >= 0) {
          selPoint = i;
          const w = worldOf(o, pointsOf(o)[i]);
          drag = { id: o.id, index: i, vertical: e.shiftKey, startY: y, startWorldY: w.y, moved: false, pending: null };
          render();
          updateMarks();
          return true;
        }
        if (e.ctrlKey) {
          const pts = pointsOf(o);
          const p: SplinePoint = { p: [0, 0, 0] };
          applyPoint(o, p, pointFromHit(o, groundAt(x, y)));
          pts.push(p);
          selPoint = pts.length - 1;
          setPoints(o, pts, true);
          render();
          updateMarks();
          return true;
        }
        const on = nearestOnCurve(o, x, y);
        if (on) {
          const pts = pointsOf(o);
          const a = pts[on.seg];
          const b = pts[(on.seg + 1) % pts.length];
          const p: SplinePoint = { p: localOf(o, on.world) };
          if (a.w !== undefined || b.w !== undefined) p.w = ((a.w ?? 1) + (b.w ?? 1)) / 2;
          if (a.roll !== undefined || b.roll !== undefined) p.roll = ((a.roll ?? 0) + (b.roll ?? 0)) / 2;
          pts.splice(on.seg + 1, 0, p);
          selPoint = on.seg + 1;
          setPoints(o, pts, false);
          drag = { id: o.id, index: selPoint, vertical: e.shiftKey, startY: y, startWorldY: on.world.y, moved: true, pending: null };
          render();
          updateMarks();
          return true;
        }
      }
      // anderen Spline auswählen (oder abwählen)
      const node = vp.pick(x, y);
      if (node && cfg.types.has(node.data.type)) {
        if (node.data.id !== o?.id) {
          state.select([node.data.id]);
          selPoint = -1;
        }
      } else if (o) {
        if (selPoint >= 0) selPoint = -1;
        else state.select([]);
        render();
        updateMarks();
      }
      return true;
    },
    pointerMove(e, inStroke) {
      if (!inStroke || !drag) return;
      if (drag.vertical !== e.shiftKey) {
        const o = state.get(drag.id);
        const p = o && pointsOf(o)[drag.index];
        if (o && p) {
          drag.vertical = e.shiftKey;
          drag.startY = e.clientY;
          drag.startWorldY = worldOf(o, p).y;
        }
      }
      drag.pending = { x: e.clientX, y: e.clientY };
    },
    pointerUp() {
      if (!drag) return;
      applyDrag();
      const moved = drag.moved;
      drag = null;
      if (moved) state.commit();
      render();
      updateMarks();
    },
    update() {
      if (drag) applyDrag();
    },
    key(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      if (e.key === 'Enter' && drawing) {
        stopDrawing();
        return true;
      }
      if (e.key === 'Escape') {
        if (drawing) stopDrawing();
        else if (selPoint >= 0) {
          selPoint = -1;
          render();
          updateMarks();
        } else return false;
        return true;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selPoint >= 0 && cur()) {
        deletePoint();
        return true;
      }
      return false;
    },
  };
}
