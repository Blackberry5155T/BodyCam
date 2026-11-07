import * as THREE from 'three';
import { confirmDialog, h, numberField, toast } from '../ui.ts';
import { icon } from '../icons.ts';
import type { EditorMode, ModeContext } from './types.ts';
import { ASSETS, defaultProps, type PropDef } from '../../world/assets.ts';
import { newId, type MapObjectData, type PropValue, type Vec3 } from '../../world/mapFormat.ts';
import { MATERIAL_OPTIONS } from '../../world/materials.ts';
import { blobRef, browserBlobs } from '../../world/blobStore.ts';
import {
  BRUSH_OPS,
  BRUSH_PRESETS,
  BRUSH_TYPE,
  STATICMESH_TYPE,
  brushOp,
  brushShape,
  encodeBaked,
  faceMaterial,
  faceNames,
  parseFaces,
  stairSteps,
  stringifyFaces,
  type BrushPreset,
  type FaceOverride,
} from '../../world/brushes/asset.ts';
import { BRUSH_SHAPES, shapeEdges, type BrushShape } from '../../world/brushes/shapes.ts';
import type { BrushOp } from '../../world/brushes/csg.ts';
import { brushClusterIds, brushesBusy, lastBrushMs, onBrushesUpdated } from '../../world/brushes/manager.ts';

// Modeling-Modus (Phase 5, wie UE5 BSP-/Geometry-Brushes):
//  - „Neu“: Form wählen (+ Addieren / Abziehen / Schnitt), Klick in die Szene setzt den Brush
//    (auf Böden steht er auf der Fläche, an Wänden liegt er an; Abziehen-Brushes sitzen mittig in der Fläche)
//  - ausgewählter Brush: Form, Modus, Maße, Reihenfolge (Outliner = Reihenfolge der Verrechnung), „Hohl machen“
//  - Flächen: im Viewport anklicken (Flächen-Auswahl an) oder in der Liste; Material/Farbe/Textur je Fläche
//  - „In statisches Mesh umwandeln“: Brushes (samt überlappender) backen → Objekt „Statisches Mesh“
// Verschieben/Drehen/Skalieren geht wie gewohnt mit dem Gizmo; das Ergebnis rechnet im Hintergrund nach.

const DEG = Math.PI / 180;
const SHAPE_ICONS: Record<BrushShape, string> = { box: 'cube', cylinder: 'cylinder', wedge: 'wedge', stairs: 'stairs', sphere: 'sphere' };
const OP_ICONS: Record<BrushOp, string> = { add: 'plus', subtract: 'subtract', intersect: 'intersect' };
const r2 = (v: number) => Math.round(v * 100) / 100;

interface Armed {
  preset: BrushPreset;
  op: BrushOp;
}

export function createModelingMode(ctx: ModeContext): EditorMode {
  const { state, viewport: vp } = ctx;
  const panel = h('div', { class: 'mode-panel-body modeling-panel' });
  const raycaster = new THREE.Raycaster();
  let active = false;
  let armed: Armed | null = null;
  let faceMode = false;
  /** gewählte Flächen des Haupt-Brushes */
  let faceSel = { id: '', faces: new Set<number>() };
  let hollowWall = 0.3;
  let pointer: { x: number; y: number } | null = null;

  const isBrush = (o: MapObjectData | undefined): o is MapObjectData => o?.type === BRUSH_TYPE;
  const cur = () => (isBrush(state.primary) ? state.primary : undefined);
  const targets = () => state.selected.filter(isBrush);

  // ---------- Overlays: Platzier-Vorschau, gewählte Flächen ----------

  const ghost = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
  ghost.matrixAutoUpdate = false;
  let ghostKey = '';
  const faceHl = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xffc23d, transparent: true, opacity: 0.38, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide, toneMapped: false }),
  );
  for (const m of [ghost, faceHl]) {
    m.renderOrder = 998;
    m.frustumCulled = false;
    m.visible = false;
    m.userData.noWeather = true;
    m.userData.noPick = true;
    m.userData.editorHelper = true;
    vp.scene.add(m);
  }

  /** Ergebnis-Meshes eines Brushes (Weltlage aktuell) */
  function brushMeshes(id: string): THREE.Mesh[] {
    const node = vp.nodeById(id);
    if (!node?.instance || !node.root.visible) return [];
    node.root.updateMatrixWorld(true);
    return node.instance.object.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh && !!c.userData.brushFaces);
  }

  function updateFaceHighlight(): void {
    const o = cur();
    if (!active || !o || faceSel.id !== o.id || !faceSel.faces.size) {
      faceHl.visible = false;
      return;
    }
    const out: number[] = [];
    const v = new THREE.Vector3();
    for (const m of brushMeshes(o.id)) {
      const faces = m.userData.brushFaces as Uint8Array;
      const p = m.geometry.attributes.position;
      for (let t = 0; t < faces.length; t++) {
        if (!faceSel.faces.has(faces[t])) continue;
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(p, t * 3 + k).applyMatrix4(m.matrixWorld);
          out.push(v.x, v.y, v.z);
        }
      }
    }
    faceHl.geometry.dispose();
    faceHl.geometry = new THREE.BufferGeometry();
    faceHl.geometry.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    faceHl.visible = out.length > 0;
  }

  // ---------- Platzieren ----------

  function rayAt(x: number, y: number): void {
    const r = vp.renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), vp.camera);
  }

  /** Lage eines neuen Brushes an der Mausposition */
  function placement(a: Armed, x: number, y: number): { pos: Vec3; rot: Vec3; scale: Vec3 } {
    const hit = vp.surfacePoint(x, y);
    const n = hit.normal.clone();
    const p = hit.point.clone();
    const s = new THREE.Vector3(...a.preset.scale);
    const up = Math.abs(n.y) > 0.7;
    let yaw: number;
    if (up) {
      // Böden: lokale −Z zeigt von der Kamera weg (Treppen/Rampen steigen nach hinten an), auf 90° gerastet
      const f = vp.camera.getWorldDirection(new THREE.Vector3());
      yaw = Math.round(Math.atan2(-f.x, -f.z) / (Math.PI / 2)) * (Math.PI / 2);
    } else {
      n.y = 0;
      n.normalize();
      yaw = Math.atan2(n.x, n.z); // lokale +Z zeigt aus der Wand heraus
    }
    const qPre = new THREE.Quaternion().setFromEuler(new THREE.Euler(...((a.preset.rot ?? [0, 0, 0]).map((d) => d * DEG) as Vec3), 'XYZ'));
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiply(qPre);
    const dir = up ? new THREE.Vector3(0, Math.sign(hit.normal.y) || 1, 0) : n;
    // halbe Ausdehnung entlang der Flächennormale (gedrehte Box)
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const ax = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    m.extractBasis(ax[0], ax[1], ax[2]);
    const half = (Math.abs(ax[0].dot(dir)) * s.x + Math.abs(ax[1].dot(dir)) * s.y + Math.abs(ax[2].dot(dir)) * s.z) / 2;
    if (a.op === 'add') p.addScaledVector(dir, half);
    // Rasten quer zur Fläche (entlang der Normale bleibt die Lage exakt)
    if (vp.snap.translate) {
      const st = vp.snap.translateStep;
      // Höhe: Unterkante rasten (Türen/Fenster stehen so auf einem Rastermaß), quer dazu die Mitte
      const hy = (Math.abs(ax[0].y) * s.x + Math.abs(ax[1].y) * s.y + Math.abs(ax[2].y) * s.z) / 2;
      for (const k of ['x', 'z'] as const) if (Math.abs(dir[k]) < 0.3) p[k] = Math.round(p[k] / st) * st;
      if (Math.abs(dir.y) < 0.3) p.y = Math.round((p.y - hy) / st) * st + hy;
    }
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    return { pos: [r2(p.x), r2(p.y), r2(p.z)], rot: [r2(e.x / DEG), r2(e.y / DEG), r2(e.z / DEG)], scale: [...a.preset.scale] };
  }

  function updateGhost(): void {
    if (!active || !armed || !pointer) {
      ghost.visible = false;
      return;
    }
    const pl = placement(armed, pointer.x, pointer.y);
    const shape = (armed.preset.props.shape as BrushShape) ?? 'box';
    const key = `${armed.preset.id}|${shape}`;
    if (key !== ghostKey) {
      ghostKey = key;
      ghost.geometry.dispose();
      ghost.geometry = shapeEdges({ shape, segments: 24, steps: Math.max(1, Math.round(pl.scale[1] / 0.18)) });
    }
    (ghost.material as THREE.LineBasicMaterial).color.set(armed.op === 'add' ? '#4da3ff' : armed.op === 'subtract' ? '#ffb347' : '#c48cff');
    ghost.matrix.compose(
      new THREE.Vector3(...pl.pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(pl.rot[0] * DEG, pl.rot[1] * DEG, pl.rot[2] * DEG, 'XYZ')),
      new THREE.Vector3(...pl.scale),
    );
    ghost.matrixWorldNeedsUpdate = true;
    ghost.visible = true;
  }

  function place(x: number, y: number, keep: boolean): void {
    if (!armed) return;
    const pl = placement(armed, x, y);
    const pr = armed.preset;
    const opLabel = armed.op === 'add' ? '' : armed.op === 'subtract' ? ' (−)' : ' (∩)';
    const [o] = state.add([
      { id: '', name: `Brush ${pr.label}${opLabel}`, type: BRUSH_TYPE, ...pl, props: defaultProps(BRUSH_TYPE, { ...pr.props, op: armed.op }) },
    ]);
    if (!keep) disarm();
    ctx.status(o ? `${o.name} gesetzt — Gizmo: verschieben/drehen/skalieren` : 'Brush konnte nicht gesetzt werden', !o);
    queueRender();
  }

  function arm(pr: BrushPreset): void {
    armed = { preset: pr, op: (pr.props.op as BrushOp) ?? 'add' };
    faceMode = false;
    ghostKey = '';
    ctx.status(`${pr.label}: Klick in die Szene setzt den Brush (Umschalt: mehrere), Esc bricht ab`);
    render();
  }

  function disarm(): void {
    armed = null;
    ghost.visible = false;
    render();
  }

  // ---------- Bearbeiten ----------

  /** Eigenschaft für alle gewählten Brushes setzen */
  function setProp(key: string, v: PropValue, live = false): void {
    const ts = targets();
    if (!ts.length) return;
    state.update(() => ts.forEach((o) => (o.props[key] = v)), !live);
  }

  function setOp(op: BrushOp): void {
    const ts = targets();
    state.update(() =>
      ts.forEach((o) => {
        const before = brushOp(o);
        o.props.op = op;
        // Namen mit Kennzeichen (−)/(∩) nachziehen
        o.name = o.name.replace(/ \((−|∩)\)$/, '') + (op === 'subtract' ? ' (−)' : op === 'intersect' ? ' (∩)' : '');
        void before;
      }),
    );
    render();
  }

  /** Brush in der Reihenfolge um eine Brush-Position nach vorn (−1) oder hinten (+1) schieben */
  function move(dir: -1 | 1): void {
    const o = cur();
    if (!o) return;
    const objs = state.map.objects;
    const i = objs.indexOf(o);
    let j = i + dir;
    while (j >= 0 && j < objs.length && objs[j].type !== BRUSH_TYPE) j += dir;
    if (j < 0 || j >= objs.length) return;
    state.update(() => {
      objs.splice(i, 1);
      objs.splice(j, 0, o);
    });
    ctx.status(`Reihenfolge: ${brushIndex(o) + 1} von ${brushCount()}`);
    render();
  }

  const brushCount = () => state.map.objects.filter((o) => o.type === BRUSH_TYPE).length;
  const brushIndex = (o: MapObjectData) => state.map.objects.filter((x) => x.type === BRUSH_TYPE).indexOf(o);

  /** Innen-Brush (Abziehen) mit Wandstärke direkt hinter dem Brush einfügen */
  function hollow(): void {
    const ts = targets().filter((o) => brushOp(o) === 'add');
    if (!ts.length) return;
    const t = hollowWall;
    const added: string[] = [];
    state.update(() => {
      for (const o of ts) {
        const s = o.scale.map((v) => Math.round(Math.max(0.05, Math.abs(v) - 2 * t) * 1e4) / 1e4) as Vec3;
        const inner: MapObjectData = {
          id: newId(),
          name: state.uniqueName(`${o.name} innen (−)`),
          type: BRUSH_TYPE,
          pos: [...o.pos],
          rot: [...o.rot],
          scale: s,
          props: { ...o.props, op: 'subtract', faces: '{}' },
        };
        state.map.objects.splice(state.map.objects.indexOf(o) + 1, 0, inner);
        added.push(inner.id);
      }
    });
    state.select(added);
    ctx.status(`${added.length} Brush${added.length === 1 ? '' : 'es'} hohl gemacht (Wandstärke ${t} m)`);
  }

  function setSize(axis: 0 | 1 | 2, v: number, live: boolean): void {
    const o = cur();
    if (!o) return;
    state.update(() => (o.scale[axis] = Math.sign(o.scale[axis] || 1) * Math.max(0.01, v)), !live);
  }

  // ---------- Flächen ----------

  function pickFace(x: number, y: number): { id: string; face: number } | null {
    rayAt(x, y);
    const list: { mesh: THREE.Mesh; id: string }[] = [];
    for (const o of state.map.objects) if (o.type === BRUSH_TYPE) for (const mesh of brushMeshes(o.id)) list.push({ mesh, id: o.id });
    const hits = raycaster.intersectObjects(
      list.map((l) => l.mesh),
      false,
    );
    const hit = hits[0];
    if (!hit || hit.faceIndex == null) return null;
    const owner = list.find((l) => l.mesh === hit.object);
    if (!owner) return null;
    return { id: owner.id, face: (hit.object.userData.brushFaces as Uint8Array)[hit.faceIndex] };
  }

  function toggleFace(id: string, face: number, add: boolean): void {
    if (faceSel.id !== id) faceSel = { id, faces: new Set() };
    if (!add) {
      const only = faceSel.faces.size === 1 && faceSel.faces.has(face);
      faceSel.faces.clear();
      if (!only) faceSel.faces.add(face);
    } else if (faceSel.faces.has(face)) faceSel.faces.delete(face);
    else faceSel.faces.add(face);
    if (state.primary?.id !== id) state.select([id]);
    updateFaceHighlight();
    render();
  }

  function editFaces(fn: (f: FaceOverride) => void, live = false): void {
    const o = cur();
    if (!o || faceSel.id !== o.id || !faceSel.faces.size) return;
    const faces = parseFaces(o);
    for (const i of faceSel.faces) {
      const f = { ...(faces[String(i)] ?? {}) };
      fn(f);
      for (const k of Object.keys(f) as (keyof FaceOverride)[]) if (f[k] === undefined || f[k] === '') delete f[k];
      if (Object.keys(f).length) faces[String(i)] = f;
      else delete faces[String(i)];
    }
    state.update(() => (o.props.faces = stringifyFaces(faces)), !live);
  }

  // ---------- Backen ----------

  async function bake(): Promise<void> {
    const sel = targets().map((o) => o.id);
    if (!sel.length) return;
    const ids = brushClusterIds(sel);
    const extra = ids.size - sel.length;
    const ok = await confirmDialog(
      'In statisches Mesh umwandeln',
      `${ids.size} Brush${ids.size === 1 ? '' : 'es'} werden zu einem statischen Mesh gebacken${extra > 0 ? ` (davon ${extra} überlappende, die mit verrechnet werden)` : ''}. ` +
        'Die Brushes werden entfernt; Rückgängig mit Strg+Z.',
      'Umwandeln',
    );
    if (!ok) return;
    for (let t = 0; brushesBusy() && t < 300; t++) await new Promise((r) => setTimeout(r, 50));
    const meshes = [...ids].flatMap((id) => brushMeshes(id));
    if (!meshes.length) {
      toast('Nichts zu backen — das Ergebnis ist leer', 'error');
      return;
    }
    const box = new THREE.Box3();
    for (const m of meshes) box.expandByObject(m);
    const c = box.getCenter(new THREE.Vector3());
    const origin = new THREE.Vector3(r2(c.x), r2(box.min.y), r2(c.z));
    const { bytes, parts } = encodeBaked(meshes, origin);
    let blob: string;
    try {
      blob = await browserBlobs.put(bytes);
    } catch (e) {
      toast(`Speichern fehlgeschlagen: ${(e as Error).message}`, 'error');
      return;
    }
    const first = state.get(sel[0]);
    const tris = parts.reduce((s, p) => s + p.n / 3, 0);
    state.update(() => {
      state.map.objects = state.map.objects.filter((o) => !ids.has(o.id));
      state.selection = [];
    }, false);
    state.add([
      {
        id: '',
        name: 'Statisches Mesh',
        type: STATICMESH_TYPE,
        pos: [origin.x, origin.y, origin.z],
        rot: [0, 0, 0],
        scale: [1, 1, 1],
        props: defaultProps(STATICMESH_TYPE, {
          mesh: blobRef(blob),
          parts: JSON.stringify(parts),
          collision: first?.props.collision !== false,
          castShadow: first?.props.castShadow !== false,
        }),
      },
    ]);
    faceSel = { id: '', faces: new Set() };
    ctx.status(`${ids.size} Brush${ids.size === 1 ? '' : 'es'} → Statisches Mesh (${tris} Dreiecke, ${(bytes.length / 1024).toFixed(0)} KB)`);
  }

  // ---------- Panel ----------

  const section = (title: string, ...rows: (HTMLElement | null | false)[]) =>
    h('div', { class: 'section' }, h('div', { class: 'section-head' }, title), h('div', { class: 'section-body' }, ...rows.filter((r): r is HTMLElement => !!r)));
  const row = (label: string, ...el: (Node | string)[]) => h('div', { class: 'prop-row' }, h('label', { title: label }, label), h('div', { class: 'value' }, ...el));
  const button = (label: string, fn: () => void, cls = 'btn', ico?: string, enabled = true, title?: string) => {
    const b = h('button', { class: cls, html: `${ico ? icon(ico) : ''}${label}` });
    if (title) b.title = title;
    b.addEventListener('click', fn);
    b.toggleAttribute('disabled', !enabled);
    return b;
  };

  function propRow(o: MapObjectData, p: PropDef): HTMLElement {
    const value = o.props[p.key] ?? p.default;
    switch (p.type) {
      case 'number':
        return row(p.label, numberField({ value: Number(value), step: p.step ?? 0.1, min: p.min, max: p.max, onChange: (v, live) => setProp(p.key, v, live) }));
      case 'bool': {
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = !!value;
        cb.addEventListener('change', () => setProp(p.key, cb.checked));
        return row(p.label, cb);
      }
      case 'color': {
        const c = h('input', { type: 'color', value: String(value) }) as HTMLInputElement;
        c.addEventListener('input', () => setProp(p.key, c.value, true));
        c.addEventListener('change', () => setProp(p.key, c.value));
        return row(p.label, c);
      }
      default: {
        const s = h('select', {}, ...(p.options ?? []).map((opt) => h('option', { value: opt.value, selected: opt.value === value }, opt.label)));
        s.addEventListener('change', () => {
          setProp(p.key, s.value);
          render();
        });
        return row(p.label, s);
      }
    }
  }

  function brushSections(o: MapObjectData): HTMLElement[] {
    const out: HTMLElement[] = [];
    const shape = brushShape(o);
    const op = brushOp(o);
    const n = targets().length;
    const props = ASSETS[BRUSH_TYPE].props;
    const prop = (k: string) => props.find((p) => p.key === k)!;

    const shapes = h('div', { class: 'ls-tools' });
    for (const s of BRUSH_SHAPES) shapes.append(button(s.label.replace(' (Rampe)', ''), () => (setProp('shape', s.value), render()), `btn ls-tool${s.value === shape ? ' on' : ''}`, SHAPE_ICONS[s.value]));
    const ops = h('div', { class: 'ls-buttons' });
    for (const b of BRUSH_OPS) ops.append(button(b.label, () => setOp(b.value), `btn${b.value === op ? ' primary' : ''}`, OP_ICONS[b.value]));
    const size = ([0, 1, 2] as const).map((i) =>
      numberField({ value: Math.abs(o.scale[i]), step: 0.05, min: 0.01, axis: (['x', 'y', 'z'] as const)[i], onChange: (v, live) => setSize(i, v, live) }),
    );
    out.push(
      section(
        n > 1 ? `${n} Brushes` : o.name,
        h('div', { class: 'mode-note dim' }, `Reihenfolge ${brushIndex(o) + 1} von ${brushCount()}${n > 1 ? ' · Änderungen gelten für alle gewählten' : ''}`),
        shapes,
        ops,
        row('Maße (m)', ...size),
        shape === 'cylinder' || shape === 'sphere' ? propRow(o, prop('segments')) : null,
        shape === 'stairs' ? propRow(o, prop('stepHeight')) : null,
        shape === 'stairs' ? h('div', { class: 'mode-note dim' }, `${stairSteps(o, o.scale[1])} Stufen`) : null,
        h(
          'div',
          { class: 'ls-buttons' },
          button('Nach vorn', () => move(-1), 'btn', undefined, brushIndex(o) > 0, 'Früher verrechnen (Outliner weiter oben)'),
          button('Nach hinten', () => move(1), 'btn', undefined, brushIndex(o) < brushCount() - 1, 'Später verrechnen (Outliner weiter unten)'),
        ),
        op === 'add'
          ? row(
              'Hohl machen',
              h(
                'div',
                { class: 'ls-buttons' },
                numberField({ value: hollowWall, step: 0.05, min: 0.02, max: 5, onChange: (v) => (hollowWall = v) }),
                button('Hohl', hollow, 'btn', undefined, true, 'Abziehen-Brush mit dieser Wandstärke einfügen'),
              ),
            )
          : null,
      ),
    );
    out.push(section('Material', ...['material', 'color', 'roughness', 'metalness', 'uvScale'].map((k) => propRow(o, prop(k)))));
    out.push(faceSection(o));
    out.push(section('Rendering & Physik', propRow(o, prop('castShadow')), propRow(o, prop('collision'))));
    return out;
  }

  function faceSection(o: MapObjectData): HTMLElement {
    const names = faceNames(o);
    if (faceSel.id !== o.id) faceSel = { id: o.id, faces: new Set() };
    for (const f of [...faceSel.faces]) if (f >= names.length) faceSel.faces.delete(f);
    const faces = parseFaces(o);
    const label = (m: string) => MATERIAL_OPTIONS.find((x) => x.value === m)?.label ?? m;
    const list = h('div', { class: 'ls-layers' });
    names.forEach((name, i) => {
      const fm = faceMaterial(o, i, faces);
      const own = !!faces[String(i)];
      const el = h(
        'div',
        { class: `ls-layer brush-face${faceSel.faces.has(i) ? ' on' : ''}` },
        h('span', { class: 'ls-layer-name' }, h('span', { class: 'fol-swatch', style: `background:${fm.color}` }), name),
        h('span', { class: 'ls-layer-sub dim' }, own ? `${label(fm.material)} · eigenes Material` : label(fm.material)),
      );
      el.addEventListener('click', (e) => toggleFace(o.id, i, e.shiftKey || e.ctrlKey));
      list.append(el);
    });
    const rows: (HTMLElement | null)[] = [
      h(
        'div',
        { class: 'ls-buttons' },
        button(faceMode ? 'Flächen-Auswahl an' : 'Flächen im Viewport wählen', () => {
          faceMode = !faceMode;
          if (faceMode) armed = null;
          ghost.visible = false;
          ctx.status(faceMode ? 'Klick wählt eine Fläche, Umschalt+Klick weitere — Esc beendet' : 'Flächen-Auswahl aus');
          render();
        }, `btn${faceMode ? ' primary' : ''}`, 'select'),
      ),
      list,
    ];
    if (faceSel.faces.size) {
      const first = [...faceSel.faces][0];
      const ov = faces[String(first)] ?? {};
      const fm = faceMaterial(o, first, faces);
      const sel = h(
        'select',
        {},
        h('option', { value: '', selected: !ov.material }, '— wie Brush —'),
        ...MATERIAL_OPTIONS.map((m) => h('option', { value: m.value, selected: m.value === ov.material }, m.label)),
      );
      sel.addEventListener('change', () => {
        editFaces((f) => {
          f.material = sel.value || undefined;
          f.color = undefined;
        });
        render();
      });
      const col = h('input', { type: 'color', value: fm.color }) as HTMLInputElement;
      col.addEventListener('input', () => editFaces((f) => (f.color = col.value), true));
      col.addEventListener('change', () => editFaces((f) => (f.color = col.value)));
      rows.push(
        h('div', { class: 'mode-note dim' }, `${faceSel.faces.size} Fläche${faceSel.faces.size === 1 ? '' : 'n'} gewählt`),
        row('Material', sel),
        row('Farbe / Tönung', col),
        row('Textur-Skalierung', numberField({ value: fm.uvScale, step: 0.1, min: 0.05, max: 20, onChange: (v, live) => editFaces((f) => (f.uvScale = v), live) })),
        h(
          'div',
          { class: 'ls-buttons' },
          button('Zurücksetzen', () => {
            editFaces((f) => {
              delete f.material;
              delete f.color;
              delete f.uvScale;
            });
            render();
          }),
          button('Auswahl aufheben', () => {
            faceSel.faces.clear();
            updateFaceHighlight();
            render();
          }),
        ),
      );
    }
    return section('Flächen', ...rows);
  }

  function render(): void {
    if (!active) return;
    const children: (HTMLElement | null)[] = [h('div', { class: 'mode-head', html: `${icon('brush')}<span>Modeling</span>` })];
    const grid = h('div', { class: 'ls-tools' });
    for (const pr of BRUSH_PRESETS) {
      const b = button(pr.label, () => (armed?.preset.id === pr.id ? disarm() : arm(pr)), `btn ls-tool${armed?.preset.id === pr.id ? ' on' : ''}`, pr.icon);
      grid.append(b);
    }
    const newRows: HTMLElement[] = [grid];
    if (armed) {
      const ops = h('div', { class: 'ls-buttons' });
      for (const b of BRUSH_OPS)
        ops.append(
          button(b.label, () => {
            if (armed) armed.op = b.value;
            render();
          }, `btn${armed.op === b.value ? ' primary' : ''}`, OP_ICONS[b.value]),
        );
      newRows.push(ops, h('div', { class: 'mode-note' }, 'Klick in die Szene setzt den Brush (Umschalt: mehrere). Esc bricht ab.'));
    }
    children.push(section('Neu', ...newRows));

    const o = cur();
    if (o) children.push(...brushSections(o));
    else if (!armed) children.push(h('div', { class: 'mode-note' }, 'Brush im Viewport anklicken oder oben einen neuen setzen.'));

    const sel = targets();
    const all = brushCount();
    children.push(
      section(
        'Backen',
        h('div', { class: 'mode-note dim' }, `${all} Brush${all === 1 ? '' : 'es'} in der Map${lastBrushMs() ? ` · letzte Berechnung ${lastBrushMs().toFixed(0)} ms` : ''}`),
        h('div', { class: 'ls-buttons' }, button('In statisches Mesh umwandeln', () => void bake(), 'btn', 'bake', sel.length > 0, 'Gewählte Brushes (samt überlappender) zu einem festen Mesh backen')),
      ),
      section(
        'Bedienung',
        h(
          'ul',
          { class: 'mode-list' },
          h('li', {}, 'Brushes werden in Outliner-Reihenfolge verrechnet: Addieren füllt, Abziehen schneidet Löcher, Schnitt behält nur die Überlappung'),
          h('li', {}, 'Gizmo: verschieben, drehen, skalieren (Skalierung = Maße in Metern)'),
          h('li', {}, 'Abziehen-Brush an eine Wand klicken: sitzt mittig in der Wand (Tür, Fenster)'),
          h('li', {}, 'Flächen-Auswahl: Klick = Fläche, Umschalt+Klick = weitere; eigenes Material je Fläche'),
          h('li', {}, 'Strg+D dupliziert, Entf löscht — wie im Auswahl-Modus'),
        ),
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
      updateFaceHighlight();
      if (!panel.contains(document.activeElement)) render();
    });
  }
  state.on('scene', queueRender);
  state.on('selection', queueRender);
  onBrushesUpdated(() => {
    if (!active) return;
    updateFaceHighlight();
  });

  return {
    id: 'modeling',
    label: 'Modeling',
    icon: 'brush',
    panel,
    allowsSelection: true,
    activate() {
      active = true;
      render();
      updateFaceHighlight();
    },
    deactivate() {
      active = false;
      armed = null;
      faceMode = false;
      ghost.visible = faceHl.visible = false;
    },
    pointerDown(e) {
      if (armed) {
        place(e.clientX, e.clientY, e.shiftKey);
        return true;
      }
      if (faceMode) {
        const f = pickFace(e.clientX, e.clientY);
        if (f) toggleFace(f.id, f.face, e.shiftKey || e.ctrlKey);
        else if (!e.shiftKey) {
          faceSel.faces.clear();
          updateFaceHighlight();
          render();
        }
        return true;
      }
      return false;
    },
    pointerMove(e) {
      pointer = { x: e.clientX, y: e.clientY };
    },
    pointerLeave() {
      pointer = null;
      ghost.visible = false;
    },
    update() {
      if (armed) updateGhost();
    },
    key(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      if (e.key === 'Escape') {
        if (armed) disarm();
        else if (faceMode) {
          faceMode = false;
          render();
        } else if (faceSel.faces.size) {
          faceSel.faces.clear();
          updateFaceHighlight();
          render();
        } else return false;
        return true;
      }
      return false;
    },
  };
}
