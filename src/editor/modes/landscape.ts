import * as THREE from 'three';
import { h, numberField, dialog, pickFile, pickFiles, toast, confirmDialog } from '../ui.ts';
import { icon } from '../icons.ts';
import { deflateSync, inflateSync } from 'fflate';
import { GridRecorder } from '../history.ts';
import type { EditorMode, ModeContext } from './types.ts';
import type { MapNode } from '../../world/mapLoader.ts';
import { newId, type MapObjectData } from '../../world/mapFormat.ts';
import { LANDSCAPE_TYPE, landscapeEntry, landscapeProps, provideLandscapeData, type LandscapeEntry } from '../../world/landscape/asset.ts';
import { COMPONENT_QUADS, HOLE_SUBS, LandscapeData, MAX_QUADS, type Rect } from '../../world/landscape/data.ts';
import {
  applyRamp,
  brushHoleRect,
  brushRect,
  copyRegion,
  mirrorCopy,
  paintHoles,
  pasteRegion,
  rampRect,
  rotateCopy,
  sculptErosion,
  sculptFlatten,
  sculptNoise,
  sculptRaise,
  sculptSmooth,
  type Brush,
  type FalloffShape,
  type FlattenMode,
  type RegionCopy,
} from '../../world/landscape/sculpt.ts';
import { DEFAULT_EROSION, type ErosionKind, type ErosionParams } from '../../world/landscape/erosion.ts';
import { downloadBytes, exportPng16, exportR16, heightsFromMap, readHeightmap, type Heightmap } from '../../world/landscape/heightmap.ts';
import { MAX_LAYERS, cloneLayers, freeChannel, makeLayer, type LandscapeLayer, type LayerAuto } from '../../world/landscape/layers.ts';
import { brushSplatRect, clearChannel, exportWeightmaps, importWeightmaps, paintSplat, upperPlane, type PaintMode } from '../../world/landscape/paint.ts';
import { textureLabel, textureLibrary } from '../../world/landscape/textures.ts';
import { SURFACE_OPTIONS, type SurfaceId } from '../../world/surfaces.ts';
import { GRASS_PRESETS } from '../../world/foliage/grass.ts';

// Landscape-Modus (Phase 1): Landschaft anlegen, formen (Pinsel), Rampe, Erosion, Löcher, Region-Werkzeuge,
// Heightmap-Import/Export. Die linke Maustaste gehört dem Werkzeug; Kamera wie gewohnt (RMB + WASD, Alt, MMB).
// Jeder Strich ist ein Undo-Schritt (nur geänderte 64er-Kacheln, siehe history.ts).

type ToolId = 'sculpt' | 'smooth' | 'flatten' | 'ramp' | 'noise' | 'erosion' | 'holes' | 'region' | 'paint';

const TOOLS: { id: ToolId; label: string; hint: string }[] = [
  { id: 'sculpt', label: 'Formen', hint: 'Anheben, Umschalt = Senken' },
  { id: 'smooth', label: 'Glätten', hint: 'Unebenheiten ausgleichen' },
  { id: 'flatten', label: 'Abflachen', hint: 'auf die Höhe am Strich-Anfang' },
  { id: 'ramp', label: 'Rampe', hint: 'Klick = Anfang, Klick = Ende, Enter = anwenden' },
  { id: 'noise', label: 'Noise', hint: 'Rauschen auftragen, Umschalt = umgekehrt' },
  { id: 'erosion', label: 'Erosion', hint: 'Pinsel oder ganze Region/Landscape' },
  { id: 'holes', label: 'Löcher', hint: 'Löcher malen oder wieder füllen (Höhlen-Eingänge), Umschalt = umkehren' },
  { id: 'region', label: 'Region', hint: 'Rechteck aufziehen: Kopieren, Einfügen, Spiegeln, Drehen' },
  { id: 'paint', label: 'Malen', hint: 'Material-Layer malen, Umschalt = Layer radieren' },
];

/** kleinster Pinsel (m) — klein genug für feine Löcher */
const MIN_RADIUS = 0.1;

const BRUSH_TOOLS = new Set<ToolId>(['sculpt', 'smooth', 'flatten', 'noise', 'erosion', 'holes', 'paint']);

const COLORS: Record<string, THREE.Color> = {
  raise: new THREE.Color(0.35, 1, 0.45),
  lower: new THREE.Color(1, 0.35, 0.3),
  smooth: new THREE.Color(0.4, 0.7, 1),
  flatten: new THREE.Color(1, 0.85, 0.3),
  noise: new THREE.Color(0.8, 0.5, 1),
  erosion: new THREE.Color(1, 0.6, 0.25),
  holes: new THREE.Color(1, 0.25, 0.25),
  paste: new THREE.Color(0.3, 1, 1),
  paint: new THREE.Color(0.35, 0.85, 1),
};

const PREFS_KEY = 'bodycam.editor.landscape';

interface Target {
  obj: MapObjectData;
  node: MapNode;
  entry: LandscapeEntry;
  origin: THREE.Vector3;
}

interface Hover {
  t: Target;
  /** lokale Position (m) */
  lx: number;
  ly: number;
  lz: number;
}

interface Region {
  t: Target;
  /** Gitterpunkte, inklusive */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

interface Prefs {
  tool: ToolId;
  radius: number;
  strength: number;
  falloff: number;
  shape: FalloffShape;
  flattenMode: FlattenMode;
  noiseScale: number;
  noiseAmp: number;
  noiseOctaves: number;
  rampWidth: number;
  rampFalloff: number;
  erosionKind: ErosionKind;
  erosion: ErosionParams;
  pasteRelative: boolean;
  fitMode: 'top' | 'bottom';
  fitMargin: number;
  grid: boolean;
  /** Löcher-Werkzeug: füllen statt malen (Umschalt kehrt um) */
  holeFill: boolean;
  /** Malen: Modus (Umschalt = Radieren) */
  paintMode: PaintMode;
}

const DEFAULT_PREFS: Prefs = {
  tool: 'sculpt',
  radius: 12,
  strength: 0.3,
  falloff: 0.5,
  shape: 'smooth',
  flattenMode: 'both',
  noiseScale: 20,
  noiseAmp: 4,
  noiseOctaves: 4,
  rampWidth: 8,
  rampFalloff: 0.6,
  erosionKind: 'both',
  erosion: { ...DEFAULT_EROSION },
  pasteRelative: true,
  fitMode: 'top',
  fitMargin: 4,
  grid: false,
  holeFill: false,
  paintMode: 'paint',
};

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { ...DEFAULT_PREFS, ...raw, erosion: { ...DEFAULT_EROSION, ...(raw.erosion ?? {}) } };
  } catch {
    return { ...DEFAULT_PREFS, erosion: { ...DEFAULT_EROSION } };
  }
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

export function createLandscapeMode(ctx: ModeContext): EditorMode {
  const { state, viewport: vp } = ctx;
  const prefs = loadPrefs();
  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* egal */
    }
  };

  const panel = h('div', { class: 'mode-panel-body landscape-panel' });
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let active = false;
  let shift = false;
  let hover: Hover | null = null;
  /** Löcher-Werkzeug füllt gerade (Panel-Modus, Umschalt kehrt um) */
  const filling = () => prefs.holeFill !== shift;
  let lastPointer: { x: number; y: number } | null = null;

  // Strich
  let stroke: { t: Target; heights: GridRecorder; holes: GridRecorder; splat: GridRecorder; flatten: number; acc: number } | null = null;
  /** gewählter Layer (id) zum Malen/Bearbeiten */
  let selLayer = '';
  // Rampe
  let rampA: Hover | null = null;
  let rampB: Hover | null = null;
  // Region
  let region: Region | null = null;
  let regionDrag: { t: Target; x: number; z: number } | null = null;
  let clipboard: RegionCopy | null = null;
  let pasting = false;
  // Erosion im Worker
  let job: { worker: Worker; progress: number; label: string } | null = null;

  // ---------- Ziele ----------

  function targets(): Target[] {
    const out: Target[] = [];
    for (const obj of state.map.objects) {
      if (obj.type !== LANDSCAPE_TYPE || state.editorHidden.has(obj.id)) continue;
      const node = vp.nodeById(obj.id);
      const entry = landscapeEntry(obj.id);
      if (!node || !entry || !entry.renderer.mesh.parent) continue;
      node.root.updateMatrixWorld(true);
      out.push({ obj, node, entry, origin: new THREE.Vector3().setFromMatrixPosition(node.root.matrixWorld) });
    }
    return out;
  }

  /** gleiche Landscape (Objekt kann neu gebaut worden sein) */
  function refresh(t: Target): Target | null {
    return targets().find((x) => x.obj.id === t.obj.id && x.entry === t.entry) ?? null;
  }

  function cast(x: number, y: number, only?: Target): Hover | null {
    const r = vp.renderer.domElement.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, vp.camera);
    raycaster.far = Infinity;
    let best: Hover | null = null;
    let bestD = Infinity;
    for (const t of only ? [only] : targets()) {
      const lr = t.entry.renderer;
      // Löcher-Werkzeug: Lochstellen sind treffbar, sonst ließe sich ein Loch nur vom Rand her füllen
      lr.pickThroughHoles = prefs.tool === 'holes';
      const hit = raycaster.intersectObject(lr.mesh, false)[0];
      lr.pickThroughHoles = false;
      if (!hit || hit.distance >= bestD) continue;
      bestD = hit.distance;
      best = { t, lx: hit.point.x - t.origin.x, ly: hit.point.y - t.origin.y, lz: hit.point.z - t.origin.z };
    }
    return best;
  }

  // ---------- Overlay ----------

  function brushColor(): THREE.Color {
    switch (prefs.tool) {
      case 'sculpt':
        return shift ? COLORS.lower : COLORS.raise;
      case 'holes':
        return filling() ? COLORS.raise : COLORS.holes;
      case 'paint':
        return paintMode() === 'paint' ? COLORS.paint : paintMode() === 'erase' ? COLORS.holes : COLORS.flatten;
      default:
        return COLORS[prefs.tool] ?? COLORS.raise;
    }
  }

  function updateOverlay(): void {
    for (const t of targets()) {
      const d = t.entry.data;
      const mine = (x: { t: Target } | null) => !!x && x.t.obj.id === t.obj.id;
      let brush = null;
      let reg = null;
      let ramp = null;
      if (active && hover && mine(hover)) {
        if (BRUSH_TOOLS.has(prefs.tool)) brush = { x: hover.lx, z: hover.lz, radius: prefs.radius, falloff: prefs.falloff, color: brushColor() };
        if (prefs.tool === 'region' && pasting && clipboard) {
          const gx = Math.round(d.toGridX(hover.lx)) - (clipboard.w >> 1);
          const gz = Math.round(d.toGridZ(hover.lz)) - (clipboard.h >> 1);
          reg = { x0: d.fromGridX(gx), z0: d.fromGridZ(gz), x1: d.fromGridX(gx + clipboard.w - 1), z1: d.fromGridZ(gz + clipboard.h - 1) };
        }
      }
      if (active && prefs.tool === 'region' && !reg && region && mine(region)) {
        reg = { x0: d.fromGridX(region.x0), z0: d.fromGridZ(region.z0), x1: d.fromGridX(region.x1), z1: d.fromGridZ(region.z1) };
      }
      if (active && prefs.tool === 'ramp' && rampA && mine(rampA)) {
        const b = rampB ?? (hover && mine(hover) ? hover : rampA);
        ramp = { ax: rampA.lx, az: rampA.lz, bx: b.lx, bz: b.lz, width: prefs.rampWidth };
      }
      t.entry.renderer.setOverlay({ brush, region: reg, ramp, grid: active && prefs.grid, holeGhost: prefs.tool === 'holes' && filling() });
    }
  }

  // ---------- Pinsel ----------

  function makeBrush(d: LandscapeData, hv: Hover): Brush {
    return { x: d.toGridX(hv.lx), z: d.toGridZ(hv.lz), radius: prefs.radius / d.quadSize, falloff: prefs.falloff, shape: prefs.shape, strength: prefs.strength };
  }

  function recorders(d: LandscapeData) {
    return {
      heights: new GridRecorder(() => d.editHeights, d.VW, d.VH, 1, (r) => d.changed(r, 'height')),
      // Lochraster wird bei Auflösungswechsel ersetzt → immer das aktuelle nehmen
      holes: new GridRecorder(() => d.holes, d.HW, d.HH, 1, (r) => d.changed(r, 'holes')),
      // Splatmap entsteht erst beim ersten Malen (ensureSplat) und kann beim Import ersetzt werden
      splat: new GridRecorder(() => d.ensureSplat(), d.SW, d.SH * 2, 4, (r) => d.changed(r, 'splat')),
    };
  }

  /** Malen: Panel-Modus, Umschalt = Radieren (bzw. zurück zum Malen) */
  function paintMode(): PaintMode {
    if (!shift) return prefs.paintMode;
    return prefs.paintMode === 'erase' ? 'paint' : 'erase';
  }

  /** gewählter Layer der Landscape (fällt auf den obersten zurück) */
  function currentLayer(d: LandscapeData): LandscapeLayer | null {
    return d.layers.find((l) => l.id === selLayer) ?? d.layers[d.layers.length - 1] ?? null;
  }

  function applyBrush(dt: number): void {
    if (!stroke || !hover || hover.t.obj.id !== stroke.t.obj.id) return;
    const d = stroke.t.entry.data;
    const b = makeBrush(d, hover);
    if (prefs.tool === 'paint') {
      const layer = currentLayer(d);
      const r = brushSplatRect(d, b);
      if (!r || !layer) return;
      const r1 = upperPlane(d, r);
      stroke.splat.touch(r);
      stroke.splat.touch(r1);
      paintSplat(d, b, r, layer.ch, dt, paintMode());
      d.changed(r, 'splat');
      d.changed(r1, 'splat');
      return;
    }
    if (prefs.tool === 'holes') {
      const r = brushHoleRect(d, b);
      if (!r) return;
      stroke.holes.touch(r);
      paintHoles(d, b, r, !filling());
      d.changed(r, 'holes');
      return;
    }
    const r = brushRect(d, b);
    if (!r) return;
    stroke.heights.touch(r);
    switch (prefs.tool) {
      case 'sculpt':
        sculptRaise(d, b, r, dt, shift ? -1 : 1);
        break;
      case 'smooth':
        sculptSmooth(d, b, r, dt);
        break;
      case 'flatten':
        sculptFlatten(d, b, r, dt, stroke.flatten, prefs.flattenMode);
        break;
      case 'noise':
        sculptNoise(d, b, r, dt * (shift ? -1 : 1), { scale: prefs.noiseScale, amplitude: prefs.noiseAmp, octaves: prefs.noiseOctaves, seed: 7 });
        break;
      case 'erosion':
        sculptErosion(d, b, r, dt, prefs.erosionKind, prefs.erosion);
        break;
    }
    d.changed(r, 'height');
  }

  function endStroke(): void {
    if (!stroke) return;
    const label = TOOLS.find((t) => t.id === prefs.tool)?.label ?? 'Pinsel';
    state.commitData(stroke.heights.finish(`Landscape: ${label}`));
    state.commitData(stroke.holes.finish(`Landscape: ${label}`));
    state.commitData(stroke.splat.finish(`Landscape: ${label}`));
    stroke = null;
  }

  /** Einmalige Änderung an Höhen (Rampe, Region, Import …) als ein Undo-Schritt */
  function editHeights(t: Target, rects: Rect[], label: string, fn: () => void, holes = false): void {
    const d = t.entry.data;
    const rec = recorders(d);
    // Gitterpunkte → Loch-Zellen der eingeschlossenen Quads
    const s = d.holeSub;
    const cells = (r: Rect): Rect => ({ x: r.x * s, y: r.y * s, w: Math.max(1, r.w - 1) * s, h: Math.max(1, r.h - 1) * s });
    for (const r of rects) {
      rec.heights.touch(r);
      if (holes) rec.holes.touch(cells(r));
    }
    fn();
    for (const r of rects) {
      d.changed(r, 'height');
      if (holes) d.changed(cells(r), 'holes');
    }
    state.commitData(rec.heights.finish(label));
    state.commitData(rec.holes.finish(label));
  }

  // ---------- Rampe ----------

  function applyRampNow(): void {
    if (!rampA || !rampB) return;
    const t = refresh(rampA.t);
    if (!t) return;
    const d = t.entry.data;
    const ramp = {
      ax: d.toGridX(rampA.lx),
      az: d.toGridZ(rampA.lz),
      ah: rampA.ly,
      bx: d.toGridX(rampB.lx),
      bz: d.toGridZ(rampB.lz),
      bh: rampB.ly,
      width: prefs.rampWidth / d.quadSize,
      falloff: prefs.rampFalloff,
    };
    const rect = rampRect(d, ramp);
    if (!rect) return;
    editHeights(t, [rect], 'Landscape: Rampe', () => applyRamp(d, ramp, rect));
    rampA = rampB = null;
    ctx.status('Rampe angewendet');
    render();
    updateOverlay();
  }

  // ---------- Region ----------

  function regionRect(r: Region): Rect {
    return { x: Math.min(r.x0, r.x1), y: Math.min(r.z0, r.z1), w: Math.abs(r.x1 - r.x0) + 1, h: Math.abs(r.z1 - r.z0) + 1 };
  }

  function regionTarget(): { t: Target; rect: Rect } | null {
    if (!region) return null;
    const t = refresh(region.t);
    if (!t) {
      region = null;
      return null;
    }
    return { t, rect: regionRect(region) };
  }

  function regionCopy(): void {
    const rt = regionTarget();
    if (!rt) return void ctx.status('Erst eine Region aufziehen', true);
    clipboard = copyRegion(rt.t.entry.data, rt.rect);
    ctx.status(`Region kopiert (${rt.rect.w - 1} × ${rt.rect.h - 1} Quads)`);
    render();
  }

  function regionTransform(kind: 'mx' | 'mz' | 'rot'): void {
    const rt = regionTarget();
    if (!rt) return void ctx.status('Erst eine Region aufziehen', true);
    const d = rt.t.entry.data;
    const src = copyRegion(d, rt.rect);
    const out = kind === 'rot' ? rotateCopy(src) : mirrorCopy(src, kind === 'mx' ? 'x' : 'z');
    const cx = rt.rect.x + ((rt.rect.w - 1) >> 1);
    const cz = rt.rect.y + ((rt.rect.h - 1) >> 1);
    const nx = kind === 'rot' ? cx - ((out.w - 1) >> 1) : rt.rect.x;
    const nz = kind === 'rot' ? cz - ((out.h - 1) >> 1) : rt.rect.y;
    const dst = d.clip({ x: nx, y: nz, w: out.w, h: out.h });
    if (!dst) return;
    const label = kind === 'rot' ? 'Landscape: Region drehen' : 'Landscape: Region spiegeln';
    editHeights(rt.t, [rt.rect, dst], label, () => pasteRegion(d, out, nx, nz, 0, true), true);
    if (kind === 'rot' && region) {
      region = { t: rt.t, x0: dst.x, z0: dst.y, x1: dst.x + dst.w - 1, z1: dst.y + dst.h - 1 };
    }
    updateOverlay();
  }

  function pasteAt(hv: Hover): void {
    if (!clipboard) return;
    const d = hv.t.entry.data;
    const gx = Math.round(d.toGridX(hv.lx)) - (clipboard.w >> 1);
    const gz = Math.round(d.toGridZ(hv.lz)) - (clipboard.h >> 1);
    const dst = d.clip({ x: gx, y: gz, w: clipboard.w, h: clipboard.h });
    if (!dst) return;
    const offset = prefs.pasteRelative ? hv.ly - clipboard.base : 0;
    const c = clipboard;
    editHeights(hv.t, [dst], 'Landscape: Region einfügen', () => pasteRegion(d, c, gx, gz, offset, true), true);
    region = { t: hv.t, x0: dst.x, z0: dst.y, x1: dst.x + dst.w - 1, z1: dst.y + dst.h - 1 };
    pasting = false;
    ctx.status('Region eingefügt');
    render();
    updateOverlay();
  }

  /** Landscape an ausgewählte Objekte anpassen (Oberseite oder Unterseite), mit weichem Übergang */
  function fitToMesh(): void {
    const roots: THREE.Object3D[] = [];
    for (const o of state.selected) {
      if (o.type === LANDSCAPE_TYPE) continue;
      const n = vp.nodeById(o.id);
      if (n?.instance && n.root.visible) roots.push(n.instance.object);
    }
    if (!roots.length) return void ctx.status('Erst Objekte auswählen (Outliner), an die sich die Landscape anpassen soll', true);
    const box = new THREE.Box3();
    for (const r of roots) box.union(new THREE.Box3().setFromObject(r));
    if (box.isEmpty()) return;
    let changed = 0;
    const down = new THREE.Vector3(0, -1, 0);
    const up = new THREE.Vector3(0, 1, 0);
    const o = new THREE.Vector3();
    const top = prefs.fitMode === 'top';
    const ray = new THREE.Raycaster();
    ray.far = box.max.y - box.min.y + 2;
    for (const t of targets()) {
      const d = t.entry.data;
      const q = d.quadSize;
      const margin = Math.max(0, prefs.fitMargin) / q;
      const rect = d.clip({
        x: Math.floor(d.toGridX(box.min.x - t.origin.x) - margin),
        y: Math.floor(d.toGridZ(box.min.z - t.origin.z) - margin),
        w: Math.ceil((box.max.x - box.min.x) / q + 2 * margin) + 2,
        h: Math.ceil((box.max.z - box.min.z) / q + 2 * margin) + 2,
      });
      if (!rect) continue;
      // Begrenzung: höchstens ~4 Mio. Strahlen
      if (rect.w * rect.h > 4_000_000) return void ctx.status('Auswahl zu groß zum Anpassen', true);
      const n = rect.w * rect.h;
      const hit = new Float32Array(n).fill(NaN);
      let hits = 0;
      for (let z = 0; z < rect.h; z++) {
        for (let x = 0; x < rect.w; x++) {
          const wx = t.origin.x + d.fromGridX(rect.x + x);
          const wz = t.origin.z + d.fromGridZ(rect.y + z);
          if (wx < box.min.x || wx > box.max.x || wz < box.min.z || wz > box.max.z) continue;
          if (top) ray.set(o.set(wx, box.max.y + 1, wz), down);
          else ray.set(o.set(wx, box.min.y - 1, wz), up);
          const first = ray.intersectObjects(roots, true).find((i) => (i.object as THREE.Mesh).isMesh);
          if (first) {
            hit[z * rect.w + x] = first.point.y - t.origin.y;
            hits++;
          }
        }
      }
      if (!hits) continue;
      // Abstand zum nächsten Treffer (Chamfer 3-4) und dessen Höhe → weicher Übergang
      const dist = new Float32Array(n).fill(1e9);
      const near = new Float32Array(n);
      for (let i = 0; i < n; i++)
        if (!Number.isNaN(hit[i])) {
          dist[i] = 0;
          near[i] = hit[i];
        }
      const W = rect.w;
      const relax = (i: number, j: number, c: number) => {
        if (dist[j] + c < dist[i]) {
          dist[i] = dist[j] + c;
          near[i] = near[j];
        }
      };
      for (let z = 0; z < rect.h; z++)
        for (let x = 0; x < W; x++) {
          const i = z * W + x;
          if (x > 0) relax(i, i - 1, 3);
          if (z > 0) {
            relax(i, i - W, 3);
            if (x > 0) relax(i, i - W - 1, 4);
            if (x < W - 1) relax(i, i - W + 1, 4);
          }
        }
      for (let z = rect.h - 1; z >= 0; z--)
        for (let x = W - 1; x >= 0; x--) {
          const i = z * W + x;
          if (x < W - 1) relax(i, i + 1, 3);
          if (z < rect.h - 1) {
            relax(i, i + W, 3);
            if (x < W - 1) relax(i, i + W + 1, 4);
            if (x > 0) relax(i, i + W - 1, 4);
          }
        }
      const r = rect;
      editHeights(t, [r], 'Landscape: An Mesh anpassen', () => {
        for (let z = 0; z < r.h; z++)
          for (let x = 0; x < W; x++) {
            const i = z * W + x;
            const k = (r.y + z) * d.VW + r.x + x;
            const dd = dist[i] / 3;
            if (dd === 0) d.editHeights[k] = hit[i];
            else if (margin > 0 && dd < margin) {
              const w = 1 - smoothstep(dd / margin);
              d.editHeights[k] += (near[i] - d.editHeights[k]) * w;
            }
          }
      });
      changed++;
    }
    ctx.status(changed ? 'Landscape an Auswahl angepasst' : 'Auswahl liegt nicht über einer Landscape', !changed);
  }

  // ---------- Erosion (Worker) ----------

  function erodeArea(): void {
    if (job) return;
    let t: Target | null;
    let rect: Rect;
    let fade = 0;
    const rt = regionTarget();
    if (rt) {
      t = rt.t;
      rect = rt.rect;
      fade = Math.max(2, Math.min(24, Math.floor(Math.min(rect.w, rect.h) / 6)));
    } else {
      t = selectedTarget();
      if (!t) return void ctx.status('Keine Landscape', true);
      const d = t.entry.data;
      rect = { x: 0, y: 0, w: d.VW, h: d.VH };
    }
    const target = t;
    const d = target.entry.data;
    const src = new Float32Array(rect.w * rect.h);
    for (let y = 0; y < rect.h; y++) src.set(d.editHeights.subarray((rect.y + y) * d.VW + rect.x, (rect.y + y) * d.VW + rect.x + rect.w), y * rect.w);
    const work = src.slice();
    const worker = new Worker(new URL('../../world/landscape/erosion.worker.ts', import.meta.url), { type: 'module' });
    job = { worker, progress: 0, label: rt ? 'Region' : 'ganze Landscape' };
    render();
    worker.onmessage = (e: MessageEvent<{ progress?: number; done?: boolean; heights?: Float32Array }>) => {
      if (!job || job.worker !== worker) return;
      if (e.data.progress !== undefined) {
        job.progress = e.data.progress;
        updateProgress();
        return;
      }
      const out = e.data.heights!;
      worker.terminate();
      job = null;
      if (!refresh(target)) return render();
      editHeights(target, [rect], 'Landscape: Erosion', () => {
        for (let y = 0; y < rect.h; y++)
          for (let x = 0; x < rect.w; x++) {
            const i = y * rect.w + x;
            let w = 1;
            if (fade) {
              const e = Math.min(x, y, rect.w - 1 - x, rect.h - 1 - y);
              w = e >= fade ? 1 : smoothstep(e / fade);
            }
            d.editHeights[(rect.y + y) * d.VW + rect.x + x] = src[i] + (out[i] - src[i]) * w;
          }
      });
      ctx.status('Erosion fertig');
      render();
    };
    worker.onerror = (err) => {
      worker.terminate();
      job = null;
      ctx.status(`Erosion fehlgeschlagen: ${err.message}`, true);
      render();
    };
    worker.postMessage({ heights: work, w: rect.w, h: rect.h, q: d.quadSize, kind: prefs.erosionKind, params: prefs.erosion, seed: (Math.random() * 1e9) | 0 }, [work.buffer]);
  }

  function cancelJob(): void {
    if (!job) return;
    job.worker.terminate();
    job = null;
    ctx.status('Erosion abgebrochen');
    render();
  }

  let progressEl: HTMLElement | null = null;
  function updateProgress(): void {
    if (progressEl && job) progressEl.style.width = `${Math.round(job.progress * 100)}%`;
  }

  // ---------- Anlegen / Import / Export ----------

  function selectedTarget(): Target | null {
    const all = targets();
    const sel = state.primary;
    return all.find((t) => t.obj.id === sel?.id) ?? (hover ? (all.find((t) => t.obj.id === hover!.t.obj.id) ?? null) : null) ?? all[0] ?? null;
  }

  function createDialog(fromMap?: Heightmap): void {
    let cx = 8;
    let cz = 8;
    let q = 1;
    let min = fromMap?.min ?? 0;
    let max = fromMap?.max ?? 256;
    if (fromMap) {
      // Komponenten so wählen, dass die Heightmap ungefähr 1:1 passt
      cx = Math.max(1, Math.min(MAX_QUADS / COMPONENT_QUADS, Math.round((fromMap.width - 1) / COMPONENT_QUADS)));
      cz = Math.max(1, Math.min(MAX_QUADS / COMPONENT_QUADS, Math.round((fromMap.height - 1) / COMPONENT_QUADS)));
    }
    const info = h('div', { class: 'mode-note dim' });
    const upd = () => {
      const w = cx * COMPONENT_QUADS;
      const hq = cz * COMPONENT_QUADS;
      const mb = ((w + 1) * (hq + 1) * 4 * 2.5) / 1e6;
      info.textContent = `${fmtLen(w * q)} × ${fmtLen(hq * q)} · ${w} × ${hq} Quads · ${((w + 1) * (hq + 1) / 1e6).toFixed(1)} Mio. Gitterpunkte · ca. ${Math.round(mb)} MB Speicher${fromMap && (fromMap.width !== w + 1 || fromMap.height !== hq + 1) ? ` · Heightmap ${fromMap.width} × ${fromMap.height} wird angepasst` : ''}`;
    };
    const maxComp = MAX_QUADS / COMPONENT_QUADS;
    const row = (label: string, el: HTMLElement) => h('div', { class: 'prop-row' }, h('label', {}, label), h('div', { class: 'value' }, el));
    const body = h(
      'div',
      { class: 'landscape-create' },
      row('Komponenten X', numberField({ value: cx, step: 1, min: 1, max: maxComp, onChange: (v) => ((cx = Math.round(v)), upd()) })),
      row('Komponenten Z', numberField({ value: cz, step: 1, min: 1, max: maxComp, onChange: (v) => ((cz = Math.round(v)), upd()) })),
      row('Quad-Größe (m)', numberField({ value: q, step: 0.25, min: 0.25, max: 4, onChange: (v) => ((q = v), upd()) })),
      fromMap ? row('Höhe min (m)', numberField({ value: min, step: 1, onChange: (v) => (min = v) })) : null,
      fromMap ? row('Höhe max (m)', numberField({ value: max, step: 1, onChange: (v) => (max = v) })) : null,
      h('div', { class: 'mode-note dim' }, `Eine Komponente = ${COMPONENT_QUADS} × ${COMPONENT_QUADS} Quads. Beispiele: 32 × 32 bei 1 m = 4 × 4 km, 64 × 64 bei 2 m = 16 × 16 km (Maximum ${MAX_QUADS} Quads je Seite).`),
      info,
    );
    upd();
    dialog(fromMap ? 'Landscape aus Heightmap' : 'Neue Landscape', body, [
      { label: 'Abbrechen' },
      {
        label: 'Anlegen',
        primary: true,
        action: () => {
          createLandscape(cx, cz, q, fromMap ? { map: fromMap, min, max } : undefined);
        },
      },
    ]);
  }

  function createLandscape(cx: number, cz: number, q: number, from?: { map: Heightmap; min: number; max: number }): void {
    const dataId = newId();
    if (from) {
      const W = cx * COMPONENT_QUADS;
      const H = cz * COMPONENT_QUADS;
      provideLandscapeData(dataId, new LandscapeData(cx, cz, q, heightsFromMap(from.map, W + 1, H + 1, from.min, from.max)));
    }
    const first = !state.map.objects.some((o) => o.type === LANDSCAPE_TYPE);
    const size = Math.max(cx, cz) * COMPONENT_QUADS * q;
    let added: MapObjectData[] = [];
    state.update(() => {
      added = state.add([{ id: '', name: 'Landscape', type: LANDSCAPE_TYPE, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], props: landscapeProps(cx, cz, q, dataId) }], false);
      const w = state.map.world;
      // Erste Landscape: unendlicher Boden bei y = 0 würde Täler blockieren; Sichtweite für große Flächen
      if (first) w.groundPlane = false;
      w.viewDistance = Math.max(w.viewDistance ?? 60, Math.min(3000, Math.round(size * 0.6)));
      if (w.sunShadowDistance < 200) w.sunShadowDistance = 200;
    });
    state.emit('world');
    if (added[0]) {
      vp.applyWorld();
      ctx.status(`Landscape angelegt (${fmtLen(cx * COMPONENT_QUADS * q)} × ${fmtLen(cz * COMPONENT_QUADS * q)})${first ? ' — unendlicher Boden ausgeschaltet' : ''}`);
      // Kamera über die Mitte
      vp.camera.position.set(0, Math.min(400, size * 0.15) + 20, Math.min(400, size * 0.2));
      vp.lookAt(new THREE.Vector3(0, 0, 0));
    }
    render();
  }

  async function importDialog(): Promise<void> {
    const file = await pickFile('.png,.r16,.raw');
    if (!file) return;
    let map: Heightmap;
    try {
      map = await readHeightmap(file);
    } catch (e) {
      toast((e as Error).message, 'error', 5000);
      return;
    }
    const t = selectedTarget();
    if (!t) return createDialog(map);
    let min = map.min ?? 0;
    let max = map.max ?? 256;
    const fromName = /_h(-?[\d.]+)_(-?[\d.]+)\./.exec(file.name);
    if (map.min === undefined && fromName) {
      min = Number(fromName[1]);
      max = Number(fromName[2]);
    }
    const d = t.entry.data;
    const row = (label: string, el: HTMLElement) => h('div', { class: 'prop-row' }, h('label', {}, label), h('div', { class: 'value' }, el));
    const body = h(
      'div',
      {},
      h('div', { class: 'mode-note dim' }, `${file.name}: ${map.width} × ${map.height} → „${t.obj.name}“ (${d.VW} × ${d.VH})${map.width !== d.VW || map.height !== d.VH ? ', wird angepasst' : ''}`),
      row('Höhe min (m)', numberField({ value: min, step: 1, onChange: (v) => (min = v) })),
      row('Höhe max (m)', numberField({ value: max, step: 1, onChange: (v) => (max = v) })),
    );
    dialog('Heightmap importieren', body, [
      { label: 'Abbrechen' },
      { label: 'Als neue Landscape', action: () => createDialog({ ...map, min, max }) },
      {
        label: 'Ersetzen',
        primary: true,
        action: () => {
          const heights = heightsFromMap(map, d.VW, d.VH, min, max);
          editHeights(t, [{ x: 0, y: 0, w: d.VW, h: d.VH }], 'Landscape: Heightmap importieren', () => d.editHeights.set(heights));
          ctx.status('Heightmap importiert');
        },
      },
    ]);
  }

  function exportHeightmap(kind: 'png' | 'r16'): void {
    const t = selectedTarget();
    if (!t) return void ctx.status('Keine Landscape', true);
    const d = t.entry.data;
    const res = kind === 'png' ? exportPng16(d) : exportR16(d);
    if (kind === 'r16' && d.VW !== d.VH) toast('RAW ist nur für quadratische Landscapes eindeutig — beim Import wird quadratisch angenommen', 'info', 5000);
    const stem = `${state.map.name}_${t.obj.name}`.replace(/[^\w.-]+/g, '_');
    const name = `${stem}_h${round2(res.min)}_${round2(res.max)}.${kind}`;
    downloadBytes(res.bytes, name, kind === 'png' ? 'image/png' : 'application/octet-stream');
    ctx.status(`Heightmap exportiert (${d.VW} × ${d.VH}, Höhe ${round2(res.min)} … ${round2(res.max)} m)`);
  }

  // ---------- Panel ----------

  const section = (title: string, ...rows: (HTMLElement | null | false)[]) =>
    h('div', { class: 'section' }, h('div', { class: 'section-head' }, title), h('div', { class: 'section-body' }, ...rows.filter((r): r is HTMLElement => !!r)));
  const row = (label: string, ...el: (Node | string)[]) => h('div', { class: 'prop-row' }, h('label', { title: label }, label), h('div', { class: 'value' }, ...el));
  const num = (label: string, get: () => number, set: (v: number) => void, step: number, min?: number, max?: number) =>
    row(label, numberField({ value: get(), step, min, max, onChange: (v) => (set(v), savePrefs(), updateOverlay()) }));
  const select = <T extends string>(label: string, value: T, options: [T, string][], set: (v: T) => void) => {
    const s = h('select', {}, ...options.map(([v, l]) => h('option', { value: v, ...(v === value ? { selected: '' } : {}) }, l))) as HTMLSelectElement;
    s.value = value;
    s.addEventListener('change', () => {
      set(s.value as T);
      savePrefs();
      render();
    });
    return row(label, s);
  };
  const check = (label: string, value: boolean, set: (v: boolean) => void) => {
    const c = h('input', { type: 'checkbox' }) as HTMLInputElement;
    c.checked = value;
    c.addEventListener('change', () => {
      set(c.checked);
      savePrefs();
      updateOverlay();
    });
    return row(label, c);
  };
  const button = (label: string, fn: () => void, cls = 'btn', ico?: string) => {
    const b = h('button', { class: cls, html: `${ico ? icon(ico) : ''}${label}` });
    b.addEventListener('click', fn);
    return b;
  };

  // ---------- Material-Layer ----------

  /** Layer-Liste ändern (ein Undo-Schritt); optional mit Splatmap vorher/nachher (Layer entfernen) */
  function commitLayers(t: Target, label: string, before: LandscapeLayer[], after: LandscapeLayer[], splat?: { before: Uint8Array | null; after: Uint8Array | null }): void {
    const d = t.entry.data;
    const pack = (s: Uint8Array | null | undefined) => (s ? deflateSync(s, { level: 1 }) : null);
    const sb = splat ? pack(splat.before) : null;
    const sa = splat ? pack(splat.after) : null;
    const apply = (l: LandscapeLayer[], s: Uint8Array | null) => {
      d.setLayers(cloneLayers(l));
      if (splat) d.setSplat(s ? inflateSync(s) : null);
      render();
    };
    state.commitData({
      label,
      bytes: 2048 + (sb?.byteLength ?? 0) + (sa?.byteLength ?? 0),
      undo: () => apply(before, sb),
      redo: () => apply(after, sa),
    });
  }

  /** einzelne Eigenschaft ändern; live = während des Ziehens (Undo erst beim Loslassen) */
  let liveBefore: LandscapeLayer[] | null = null;
  function editLayer(t: Target, id: string, label: string, fn: (l: LandscapeLayer) => void, live = false): void {
    const d = t.entry.data;
    const before = liveBefore ?? cloneLayers(d.layers);
    const next = cloneLayers(d.layers);
    const l = next.find((x) => x.id === id);
    if (!l) return;
    fn(l);
    d.setLayers(next);
    if (live) {
      liveBefore = before;
      return;
    }
    liveBefore = null;
    commitLayers(t, `Landscape: ${label}`, before, cloneLayers(next));
  }

  function addLayer(t: Target): void {
    const d = t.entry.data;
    const ch = freeChannel(new Set(d.layers.map((l) => l.ch)));
    if (ch < 0) return void toast(`Höchstens ${MAX_LAYERS} Layer`, 'error');
    const before = cloneLayers(d.layers);
    const l = makeLayer(ch, `Layer ${d.layers.length + 1}`, 'proc:erde', 'erde', 3);
    const after = [...cloneLayers(d.layers), l];
    d.setLayers(after);
    selLayer = l.id;
    commitLayers(t, 'Landscape: Layer hinzufügen', before, cloneLayers(after));
    render();
  }

  async function removeLayer(t: Target, id: string): Promise<void> {
    const d = t.entry.data;
    const l = d.layers.find((x) => x.id === id);
    if (!l) return;
    if (d.layers.length <= 1) return void toast('Die Basis-Layer muss bleiben', 'error');
    if (!(await confirmDialog('Layer entfernen', `„${l.name}“ entfernen? Gemalte Bereiche dieses Layers gehen verloren (Rückgängig möglich).`, 'Entfernen', true))) return;
    const before = cloneLayers(d.layers);
    const sBefore = d.splat ? d.splat.slice() : null;
    const after = cloneLayers(d.layers).filter((x) => x.id !== id);
    d.setLayers(after);
    if (d.splat) {
      clearChannel(d, l.ch);
      d.setSplat(d.splat);
    }
    commitLayers(t, `Landscape: Layer „${l.name}“ entfernen`, before, cloneLayers(after), { before: sBefore, after: d.splat ? d.splat.slice() : null });
    render();
  }

  /** dir = +1: nach oben (über andere Layer), -1: nach unten (Index 0 = Basis) */
  function moveLayer(t: Target, id: string, dir: number): void {
    const d = t.entry.data;
    const i = d.layers.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.layers.length) return;
    const before = cloneLayers(d.layers);
    const after = cloneLayers(d.layers);
    [after[i], after[j]] = [after[j], after[i]];
    d.setLayers(after);
    commitLayers(t, 'Landscape: Layer verschieben', before, cloneLayers(after));
    render();
  }

  // Content Browser: Doppelklick auf eine Textur weist sie dem gewählten Layer zu
  textureLibrary().onPick((ref) => {
    if (!active || prefs.tool !== 'paint') return;
    const t = selectedTarget();
    const l = t && currentLayer(t.entry.data);
    if (!t || !l) return;
    editLayer(t, l.id, 'Layer-Textur', (x) => (x.texture = ref));
    ctx.status(`„${l.name}“: Textur ${textureLabel(ref)}`);
    render();
  });
  textureLibrary().onChange(() => {
    if (active && prefs.tool === 'paint') queueRender();
  });

  function exportMasks(t: Target): void {
    const d = t.entry.data;
    ctx.status('Gewichtsmasken werden berechnet …');
    // einen Frame Luft für die Statusmeldung
    setTimeout(() => {
      const zip = exportWeightmaps(d);
      const stem = `${state.map.name}_${t.obj.name}_layer`.replace(/[^\w.-]+/g, '_');
      downloadBytes(zip, `${stem}.zip`, 'application/zip');
      ctx.status(`${d.layers.length} Gewichtsmasken exportiert (${d.SW} × ${d.SH})`);
    }, 30);
  }

  async function importMasks(t: Target): Promise<void> {
    const files = await pickFiles('.png,.zip');
    if (!files.length) return;
    const d = t.entry.data;
    try {
      const res = await importWeightmaps(d, files);
      if (!res.matched.length) throw new Error(`Keine Datei passt zu einem Layer-Namen (${res.unmatched.join(', ')}).`);
      const before = cloneLayers(d.layers);
      const sBefore = d.splat ? d.splat.slice() : null;
      d.setSplat(res.splat);
      commitLayers(t, 'Landscape: Gewichtsmasken importieren', before, cloneLayers(d.layers), { before: sBefore, after: res.splat.slice() });
      toast(`Importiert: ${res.matched.join(', ')}${res.unmatched.length ? ` · ohne passenden Layer: ${res.unmatched.join(', ')}` : ''}`, 'ok', 5000);
    } catch (e) {
      toast((e as Error).message, 'error', 6000);
    }
  }

  async function clearPainted(t: Target): Promise<void> {
    const d = t.entry.data;
    if (!d.splat) return;
    if (!(await confirmDialog('Gemaltes löschen', 'Alle gemalten Layer-Bereiche entfernen? Danach gelten nur noch die Auto-Regeln.', 'Löschen', true))) return;
    const layers = cloneLayers(d.layers);
    const sBefore = d.splat.slice();
    d.setSplat(null);
    commitLayers(t, 'Landscape: Gemaltes löschen', layers, cloneLayers(layers), { before: sBefore, after: null });
  }

  function layerSections(t: Target, d: LandscapeData): HTMLElement[] {
    const cur = currentLayer(d);
    const lib = textureLibrary();
    // Liste: oberster Layer zuerst (wie in UE5), Basis unten
    const list = h('div', { class: 'ls-layers' });
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const l = d.layers[i];
      const img = h('img', { class: 'ls-layer-thumb', alt: '' }) as HTMLImageElement;
      void lib.thumbnail(l.texture).then((u) => (img.src = u));
      const item = h(
        'div',
        { class: `ls-layer${cur?.id === l.id ? ' on' : ''}`, title: i === 0 ? 'Basis-Layer: bekommt alles, was weder gemalt noch von Auto-Regeln belegt ist' : '' },
        img,
        h('div', { class: 'ls-layer-name' }, l.name, h('span', { class: 'dim' }, i === 0 ? ' · Basis' : l.auto.on ? ' · Auto' : '')),
        h('div', { class: 'ls-layer-sub dim' }, `${textureLabel(l.texture)} · ${SURFACE_OPTIONS.find((s) => s.value === l.surface)?.label ?? l.surface}`),
      );
      item.addEventListener('click', () => {
        selLayer = l.id;
        render();
      });
      list.append(item);
    }
    const idx = cur ? d.layers.indexOf(cur) : -1;
    const btn = (label: string, fn: () => void, enabled: boolean, ico?: string) => {
      const b = button(label, fn, 'btn', ico);
      b.toggleAttribute('disabled', !enabled);
      return b;
    };
    const out: HTMLElement[] = [
      section(
        'Malen',
        select<PaintMode>(
          'Modus',
          prefs.paintMode,
          [
            ['paint', 'Layer malen'],
            ['erase', 'Layer radieren'],
            ['reset', 'Auf Auto zurücksetzen'],
          ],
          (v) => {
            prefs.paintMode = v;
            updateOverlay();
          },
        ),
        h('div', { class: 'mode-note dim' }, 'Umschalt = Radieren. Gemaltes ersetzt die Auto-Regeln; „Zurücksetzen“ gibt die Stelle wieder an sie zurück.'),
      ),
      section(
        `Layer (${d.layers.length}/${MAX_LAYERS})`,
        list,
        h(
          'div',
          { class: 'ls-buttons' },
          btn('Neu', () => addLayer(t), d.layers.length < MAX_LAYERS, 'plus'),
          btn('Nach oben', () => cur && moveLayer(t, cur.id, 1), idx >= 0 && idx < d.layers.length - 1),
          btn('Nach unten', () => cur && moveLayer(t, cur.id, -1), idx > 0),
          btn('Entfernen', () => cur && void removeLayer(t, cur.id), d.layers.length > 1 && !!cur),
        ),
      ),
    ];
    if (cur) out.push(layerProps(t, cur, idx === 0));
    out.push(
      section(
        'Gewichtsmasken',
        h(
          'div',
          { class: 'ls-buttons' },
          button('Export (PNG je Layer)', () => exportMasks(t), 'btn', 'download'),
          button('Import…', () => void importMasks(t), 'btn', 'upload'),
          btn('Gemaltes löschen', () => void clearPainted(t), !!d.splat),
        ),
        h('div', { class: 'mode-note dim' }, `Graustufen-PNGs (Dateiname = Layer-Name), z. B. aus World Machine/Gaea. Andere Auflösungen werden angepasst; Raster ${d.SW} × ${d.SH}.`),
      ),
    );
    return out;
  }

  function layerProps(t: Target, l: LandscapeLayer, isBase: boolean): HTMLElement {
    const id = l.id;
    const lnum = (label: string, get: (l: LandscapeLayer) => number, set: (l: LandscapeLayer, v: number) => void, step: number, min?: number, max?: number) =>
      row(label, numberField({ value: get(l), step, min, max, onChange: (v, live) => editLayer(t, id, label, (x) => set(x, v), live) }));
    const anum = (label: string, key: keyof Omit<LayerAuto, 'on'>, step: number, min?: number, max?: number) => lnum(label, (x) => x.auto[key], (x, v) => (x.auto[key] = v), step, min, max);

    const name = h('input', { type: 'text', value: l.name, spellcheck: 'false' }) as HTMLInputElement;
    name.addEventListener('change', () => editLayer(t, id, 'Layer-Name', (x) => (x.name = name.value.trim() || 'Layer')));

    const tex = h('select', {}) as HTMLSelectElement;
    const groups: Record<string, string> = { proc: 'Prozedural', project: 'Projekt (assets/textures)', idb: 'Importiert' };
    for (const g of ['proc', 'project', 'idb'] as const) {
      const es = textureLibrary()
        .entries()
        .filter((e) => e.group === g);
      if (!es.length) continue;
      tex.append(h('optgroup', { label: groups[g] }, ...es.map((e) => h('option', { value: e.ref }, e.label))));
    }
    if (![...tex.options].some((o) => o.value === l.texture)) tex.append(h('option', { value: l.texture }, `${textureLabel(l.texture)} (fehlt)`));
    tex.value = l.texture;
    tex.addEventListener('change', () => editLayer(t, id, 'Layer-Textur', (x) => (x.texture = tex.value)));

    const tint = h('input', { type: 'color', value: l.tint }) as HTMLInputElement;
    tint.addEventListener('input', () => editLayer(t, id, 'Layer-Farbton', (x) => (x.tint = tint.value), true));
    tint.addEventListener('change', () => editLayer(t, id, 'Layer-Farbton', (x) => (x.tint = tint.value)));

    const surf = h('select', {}, ...SURFACE_OPTIONS.map((s) => h('option', { value: s.value }, s.label))) as HTMLSelectElement;
    surf.value = l.surface;
    surf.addEventListener('change', () => editLayer(t, id, 'Layer-Oberfläche', (x) => (x.surface = surf.value as SurfaceId)));

    const grass = h('select', {}, h('option', { value: '' }, 'Kein Gras'), ...GRASS_PRESETS.map((g) => h('option', { value: g.id }, g.label))) as HTMLSelectElement;
    grass.value = GRASS_PRESETS.some((g) => g.id === l.grass.type) ? l.grass.type : '';
    grass.addEventListener('change', () => {
      editLayer(t, id, 'Layer-Gras', (x) => (x.grass.type = grass.value));
      render();
    });

    const autoOn = h('input', { type: 'checkbox' }) as HTMLInputElement;
    autoOn.checked = l.auto.on;
    autoOn.addEventListener('change', () => {
      editLayer(t, id, autoOn.checked ? 'Auto-Regel an' : 'Auto-Regel aus', (x) => (x.auto.on = autoOn.checked));
      render();
    });

    const rows: (HTMLElement | null)[] = [
      row('Name', name),
      row('Textur', tex),
      h('div', { class: 'mode-note dim' }, 'Oder im Content Browser (Ordner „Texturen“) doppelklicken.'),
      lnum('Kachelgröße (m)', (x) => x.tile, (x, v) => (x.tile = v), 0.25, 0.1, 200),
      row('Farbton', tint),
      lnum('Rauheit ×', (x) => x.rough, (x, v) => (x.rough = v), 0.05, 0, 2),
      lnum('Normalen-Stärke', (x) => x.normal, (x, v) => (x.normal = v), 0.05, 0, 3),
      row('Oberfläche', surf),
      row('Gras', grass),
      l.grass.type ? lnum('Gras-Dichte', (x) => x.grass.density, (x, v) => (x.grass.density = v), 0.05, 0, 1) : null,
      l.grass.type ? h('div', { class: 'mode-note dim' }, 'Gras wächst automatisch nach Layer-Gewicht (nur nahe der Kamera). Einzelne Stellen ohne Gras: im Foliage-Modus radieren.') : null,
    ];
    if (isBase) rows.push(h('div', { class: 'mode-note dim' }, 'Basis-Layer: füllt alles, was nicht gemalt und keiner Auto-Regel zugeordnet ist.'));
    else {
      rows.push(row('Auto-Regel', autoOn));
      if (l.auto.on) {
        rows.push(
          anum('Neigung ab (°)', 'slopeMin', 1, 0, 90),
          anum('Neigung bis (°)', 'slopeMax', 1, 0, 90),
          anum('Höhe ab (m)', 'heightMin', 1, -10000, 10000),
          anum('Höhe bis (m)', 'heightMax', 1, -10000, 10000),
          anum('Krümmung', 'curv', 0.05, -1, 1),
          anum('Weichheit', 'soft', 0.05, 0, 1),
          anum('Rand-Rauschen', 'noise', 0.05, 0, 1),
          h('div', { class: 'mode-note dim' }, 'Neigung 0 / 90 und Höhe ±10000 = keine Grenze. Krümmung: −1 nur Mulden/Täler, +1 nur Kuppen/Grate. Obere Layer liegen über unteren.'),
        );
      }
    }
    return section(`Layer „${l.name}“`, ...rows);
  }

  // ---------- Loch-Auflösung ----------

  /** Loch-Auflösung ändern (eigener Undo-Schritt mit vollständigem Lochraster vorher/nachher) */
  function setHoleRes(t: Target, sub: number): void {
    const d = t.entry.data;
    if (sub === d.holeSub || stroke) return;
    const before = { sub: d.holeSub, holes: deflateSync(d.holes, { level: 1 }) };
    d.setHoleSub(sub);
    const after = { sub, holes: deflateSync(d.holes, { level: 1 }) };
    const apply = (x: typeof before) => {
      d.setHoleSub(x.sub, inflateSync(x.holes));
      render();
    };
    const label = `Landscape: Loch-Auflösung ${sub}×${sub}`;
    state.commitData({ label, bytes: before.holes.byteLength + after.holes.byteLength + 64, undo: () => apply(before), redo: () => apply(after) });
    ctx.status(`Loch-Auflösung: ${subLabel(sub)} (${fmtCell(d.quadSize / sub)})`);
    render();
  }

  function holeResSection(t: Target, d: LandscapeData): HTMLElement {
    const max = d.maxHoleSub();
    const opts = HOLE_SUBS.filter((s) => s <= max).map((s): [string, string] => [String(s), `${subLabel(s)} (${fmtCell(d.quadSize / s)})`]);
    const mb = (d.W * d.H * d.holeSub * d.holeSub) / 1e6;
    return section(
      'Loch-Auflösung',
      select<string>('Zelle', String(d.holeSub), opts, (v) => setHoleRes(t, Number(v))),
      h(
        'div',
        { class: 'mode-note dim' },
        `Feiner = genauere Lochränder (Höhlen, Bunker-Eingänge). Bestehende Löcher werden umgerechnet. Speicher: ${mb < 1 ? '< 1' : Math.round(mb)} MB` +
          (max < 8 ? ` · feiner als ${max}×${max} geht bei dieser Landscape-Größe nicht` : ''),
      ),
    );
  }

  function render(): void {
    const all = targets();
    const t = selectedTarget();
    const children: (HTMLElement | null)[] = [h('div', { class: 'mode-head', html: `${icon('mountain')}<span>Landscape</span>` })];

    if (!all.length) {
      children.push(
        h('div', { class: 'mode-note' }, 'Noch keine Landscape in dieser Map.'),
        h('div', { class: 'ls-buttons' }, button('Neue Landscape…', () => createDialog(), 'btn primary', 'plus'), button('Aus Heightmap…', () => void importDialog(), 'btn', 'upload')),
      );
      panel.replaceChildren(...children.filter((c): c is HTMLElement => !!c));
      return;
    }

    const d = t?.entry.data;
    children.push(
      h(
        'div',
        { class: 'mode-note dim' },
        t && d ? `„${t.obj.name}“: ${fmtLen(d.sizeX)} × ${fmtLen(d.sizeZ)}, ${d.quadSize} m je Quad, Höhe ${round2(d.minHeight)} … ${round2(d.maxHeight)} m${all.length > 1 ? ` · ${all.length} Landscapes` : ''}` : '',
      ),
    );

    // Werkzeuge
    const grid = h('div', { class: 'ls-tools' });
    TOOLS.forEach((tool, i) => {
      const b = h('button', { class: `btn ls-tool${prefs.tool === tool.id ? ' on' : ''}`, title: `${tool.hint} (Taste ${i + 1})` }, tool.label);
      b.addEventListener('click', () => setTool(tool.id));
      grid.append(b);
    });
    children.push(grid, h('div', { class: 'mode-note dim' }, TOOLS.find((x) => x.id === prefs.tool)?.hint ?? ''));

    // Pinsel
    if (BRUSH_TOOLS.has(prefs.tool)) {
      children.push(
        section(
          'Pinsel',
          num('Größe (m)', () => prefs.radius, (v) => (prefs.radius = v), 0.5, MIN_RADIUS, 500),
          prefs.tool !== 'holes' ? num('Stärke', () => prefs.strength, (v) => (prefs.strength = v), 0.01, 0.01, 2) : null,
          prefs.tool !== 'holes' ? num('Abfall', () => prefs.falloff, (v) => (prefs.falloff = v), 0.05, 0, 1) : null,
          prefs.tool !== 'holes'
            ? select<FalloffShape>('Abfall-Form', prefs.shape, [['smooth', 'Weich'], ['linear', 'Linear'], ['spherical', 'Kugel'], ['tip', 'Spitz']], (v) => (prefs.shape = v))
            : null,
          h('div', { class: 'mode-note dim' }, '[ / ] oder Strg+Mausrad = Größe, Strg+Umschalt+Mausrad = Stärke'),
        ),
      );
    }
    if (prefs.tool === 'holes') {
      children.push(
        section(
          'Löcher',
          select<'paint' | 'fill'>('Modus', prefs.holeFill ? 'fill' : 'paint', [['paint', 'Loch malen'], ['fill', 'Loch füllen']], (v) => {
            prefs.holeFill = v === 'fill';
            updateOverlay();
          }),
          h('div', { class: 'mode-note dim' }, 'Umschalt halten = jeweils das andere. Beim Füllen zeigt die Schraffur, was zugemacht wird.'),
        ),
      );
    }
    if (prefs.tool === 'holes' && t && d) children.push(holeResSection(t, d));
    if (prefs.tool === 'paint' && t && d) children.push(...layerSections(t, d));

    if (prefs.tool === 'flatten') {
      children.push(section('Abflachen', select<FlattenMode>('Richtung', prefs.flattenMode, [['both', 'Anheben und Senken'], ['raise', 'Nur anheben'], ['lower', 'Nur senken']], (v) => (prefs.flattenMode = v))));
    }
    if (prefs.tool === 'noise') {
      children.push(
        section(
          'Noise',
          num('Wellenlänge (m)', () => prefs.noiseScale, (v) => (prefs.noiseScale = v), 1, 0.5, 2000),
          num('Höhe (m/s)', () => prefs.noiseAmp, (v) => (prefs.noiseAmp = v), 0.1, 0.05, 200),
          num('Oktaven', () => prefs.noiseOctaves, (v) => (prefs.noiseOctaves = Math.round(v)), 1, 1, 8),
        ),
      );
    }
    if (prefs.tool === 'ramp') {
      const apply = button('Rampe anwenden', applyRampNow, 'btn primary');
      apply.toggleAttribute('disabled', !(rampA && rampB));
      children.push(
        section(
          'Rampe',
          num('Breite (m)', () => prefs.rampWidth, (v) => (prefs.rampWidth = v), 0.5, 0.5, 500),
          num('Übergang', () => prefs.rampFalloff, (v) => (prefs.rampFalloff = v), 0.05, 0, 4),
          h('div', { class: 'mode-note dim' }, rampA ? (rampB ? 'Anfang und Ende gesetzt — Enter oder Knopf wendet an, Esc verwirft.' : 'Ende anklicken …') : 'Anfang anklicken …'),
          h('div', { class: 'ls-buttons' }, apply, button('Verwerfen', () => ((rampA = rampB = null), render(), updateOverlay()))),
        ),
      );
    }
    if (prefs.tool === 'erosion') {
      const e = prefs.erosion;
      const hyd = prefs.erosionKind !== 'thermal';
      const th = prefs.erosionKind !== 'hydraulic';
      const area = job
        ? h(
            'div',
            { class: 'ls-job' },
            h('div', { class: 'mode-note' }, `Erosion läuft (${job.label}) …`),
            h('div', { class: 'ls-progress' }, (progressEl = h('div', { class: 'bar' }))),
            button('Abbrechen', cancelJob, 'btn danger'),
          )
        : h('div', { class: 'ls-buttons' }, button(region ? 'Region erodieren' : 'Ganze Landscape erodieren', erodeArea, 'btn primary'));
      children.push(
        section(
          'Erosion',
          select<ErosionKind>('Art', prefs.erosionKind, [['both', 'Wasser + Hang'], ['hydraulic', 'Wasser (hydraulisch)'], ['thermal', 'Hang (thermisch)']], (v) => (prefs.erosionKind = v)),
          hyd ? num('Regen (Tropfen/Punkt)', () => e.droplets, (v) => (e.droplets = v), 0.05, 0.01, 4) : null,
          hyd ? num('Abtrag', () => e.erode, (v) => (e.erode = v), 0.05, 0.01, 1) : null,
          hyd ? num('Ablagerung', () => e.deposit, (v) => (e.deposit = v), 0.05, 0.01, 1) : null,
          hyd ? num('Kapazität', () => e.capacity, (v) => (e.capacity = v), 0.5, 0.5, 32) : null,
          th ? num('Schüttwinkel (°)', () => e.talus, (v) => (e.talus = v), 1, 5, 80) : null,
          th ? num('Durchgänge', () => e.thermalIterations, (v) => (e.thermalIterations = Math.round(v)), 1, 1, 500) : null,
          area,
          h('div', { class: 'mode-note dim' }, 'Pinsel wirkt lokal. Mit einer Region (Werkzeug „Region“) wird nur diese erodiert, sonst die ganze Landscape im Hintergrund.'),
        ),
      );
      updateProgress();
    }
    if (prefs.tool === 'region') {
      const rr = region ? regionRect(region) : null;
      const has = !!rr;
      const btn = (label: string, fn: () => void, enabled: boolean) => {
        const b = button(label, fn);
        b.toggleAttribute('disabled', !enabled);
        return b;
      };
      children.push(
        section(
          'Region',
          h('div', { class: 'mode-note dim' }, rr && region ? `${rr.w - 1} × ${rr.h - 1} Quads (${fmtLen((rr.w - 1) * region.t.entry.data.quadSize)} × ${fmtLen((rr.h - 1) * region.t.entry.data.quadSize)})` : 'Mit gedrückter Maustaste ein Rechteck aufziehen.'),
          h(
            'div',
            { class: 'ls-buttons' },
            btn('Kopieren', regionCopy, has),
            btn(pasting ? 'Ziel anklicken …' : 'Einfügen', () => ((pasting = !pasting), render(), updateOverlay()), !!clipboard),
            btn('Spiegeln X', () => regionTransform('mx'), has),
            btn('Spiegeln Z', () => regionTransform('mz'), has),
            btn('Drehen 90°', () => regionTransform('rot'), has),
            btn('Aufheben', () => ((region = null), (pasting = false), render(), updateOverlay()), has),
          ),
          check('Relativ einfügen', prefs.pasteRelative, (v) => (prefs.pasteRelative = v)),
          h('div', { class: 'mode-note dim' }, 'Relativ: Höhe der kopierten Mitte wird an die Zielhöhe angeglichen. Erosion auf die Region: Werkzeug „Erosion“.'),
        ),
        section(
          'An Mesh anpassen',
          select<'top' | 'bottom'>('Fläche', prefs.fitMode, [['top', 'Oberseite (Felsen, Hügel)'], ['bottom', 'Unterseite (Gebäude)']], (v) => (prefs.fitMode = v)),
          num('Übergang (m)', () => prefs.fitMargin, (v) => (prefs.fitMargin = v), 0.5, 0, 200),
          h('div', { class: 'ls-buttons' }, button('An Auswahl anpassen', fitToMesh, 'btn primary')),
          h('div', { class: 'mode-note dim' }, 'Objekte im Outliner auswählen; die Landscape darunter wird an ihre Form angeglichen.'),
        ),
      );
    }

    children.push(
      section(
        'Landscape',
        check('Komponenten-Raster', prefs.grid, (v) => (prefs.grid = v)),
        h(
          'div',
          { class: 'ls-buttons' },
          button('Heightmap importieren…', () => void importDialog(), 'btn', 'upload'),
          button('Export PNG 16-bit', () => exportHeightmap('png'), 'btn', 'download'),
          button('Export RAW (.r16)', () => exportHeightmap('r16'), 'btn', 'download'),
          button('Neue Landscape…', () => createDialog(), 'btn', 'plus'),
        ),
      ),
      h('div', { class: 'mode-note dim' }, 'Kamera: rechte Maustaste + WASD (Mausrad im Flug = Tempo), Alt + Maus = Orbit. Umschalt+1 = Auswahl-Modus.'),
    );
    panel.replaceChildren(...children.filter((c): c is HTMLElement => !!c));
  }

  function setTool(id: ToolId): void {
    if (stroke) endStroke();
    prefs.tool = id;
    pasting = false;
    savePrefs();
    render();
    updateOverlay();
  }

  // Panel aktuell halten (Auswahl, Undo, neue Landscapes)
  let renderQueued = false;
  const queueRender = () => {
    if (!active || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (active) {
        render();
        updateOverlay();
      }
    });
  };
  state.on('scene', queueRender);
  state.on('selection', queueRender);
  // Undo/Redo und abgeschlossene Striche ändern die Höhen-Info
  state.on('meta', queueRender);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Shift') {
      shift = e.type === 'keydown';
      updateOverlay();
    }
  };

  return {
    id: 'landscape',
    label: 'Landscape',
    icon: 'mountain',
    panel,
    allowsSelection: false,
    activate() {
      active = true;
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      render();
      updateOverlay();
    },
    deactivate() {
      if (stroke) endStroke();
      active = false;
      hover = null;
      regionDrag = null;
      pasting = false;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      updateOverlay();
    },
    pointerDown(e) {
      shift = e.shiftKey;
      const hv = cast(e.clientX, e.clientY);
      if (!hv) return false;
      hover = hv;
      if (BRUSH_TOOLS.has(prefs.tool)) {
        const rec = recorders(hv.t.entry.data);
        stroke = { t: hv.t, ...rec, flatten: hv.ly, acc: 0 };
        applyBrush(1 / 60);
        return true;
      }
      if (prefs.tool === 'ramp') {
        if (!rampA || rampB || rampA.t.obj.id !== hv.t.obj.id) {
          rampA = hv;
          rampB = null;
        } else rampB = hv;
        render();
        updateOverlay();
        return true;
      }
      if (prefs.tool === 'region') {
        if (pasting && clipboard) {
          pasteAt(hv);
          return true;
        }
        const d = hv.t.entry.data;
        const gx = clampInt(Math.round(d.toGridX(hv.lx)), 0, d.W);
        const gz = clampInt(Math.round(d.toGridZ(hv.lz)), 0, d.H);
        regionDrag = { t: hv.t, x: gx, z: gz };
        region = { t: hv.t, x0: gx, z0: gz, x1: gx, z1: gz };
        updateOverlay();
        return true;
      }
      return false;
    },
    pointerMove(e, inStroke) {
      shift = e.shiftKey;
      lastPointer = { x: e.clientX, y: e.clientY };
      const only = inStroke ? (stroke?.t ?? regionDrag?.t) : undefined;
      hover = cast(e.clientX, e.clientY, only);
      if (regionDrag && hover && region) {
        const d = hover.t.entry.data;
        region.x1 = clampInt(Math.round(d.toGridX(hover.lx)), 0, d.W);
        region.z1 = clampInt(Math.round(d.toGridZ(hover.lz)), 0, d.H);
      }
      updateOverlay();
    },
    pointerUp() {
      if (stroke) endStroke();
      if (regionDrag) {
        regionDrag = null;
        if (region && (region.x0 === region.x1 || region.z0 === region.z1)) region = null;
        render();
      }
    },
    pointerLeave() {
      hover = null;
      lastPointer = null;
      updateOverlay();
    },
    wheel(e) {
      if (!e.ctrlKey) return false;
      const k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      if (e.shiftKey) prefs.strength = THREE.MathUtils.clamp(prefs.strength * k, 0.01, 2);
      else prefs.radius = THREE.MathUtils.clamp(prefs.radius * k, MIN_RADIUS, 500);
      savePrefs();
      ctx.status(e.shiftKey ? `Pinselstärke ${prefs.strength.toFixed(2)}` : `Pinselgröße ${fmtRadius(prefs.radius)}`);
      render();
      updateOverlay();
      return true;
    },
    update(dt) {
      if (!stroke) return;
      // Erosion ist teurer: höchstens ~15× pro Sekunde
      if (prefs.tool === 'erosion') {
        stroke.acc += dt;
        if (stroke.acc < 1 / 15) return;
        dt = stroke.acc;
        stroke.acc = 0;
      }
      // Kamera kann sich während des Strichs bewegen → Treffer neu bestimmen
      if (lastPointer) hover = cast(lastPointer.x, lastPointer.y, stroke.t) ?? hover;
      applyBrush(Math.min(dt, 0.1));
      updateOverlay();
    },
    key(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      if (e.key === '[' || e.key === ']') {
        prefs.radius = THREE.MathUtils.clamp(prefs.radius * (e.key === ']' ? 1.15 : 1 / 1.15), MIN_RADIUS, 500);
        savePrefs();
        ctx.status(`Pinselgröße ${fmtRadius(prefs.radius)}`);
        render();
        updateOverlay();
        return true;
      }
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m && !e.shiftKey) {
        setTool(TOOLS[Number(m[1]) - 1].id);
        return true;
      }
      if (e.key === 'Enter' && prefs.tool === 'ramp' && rampA && rampB) {
        applyRampNow();
        return true;
      }
      if (e.key === 'Escape' && (rampA || region || pasting)) {
        rampA = rampB = null;
        if (pasting) pasting = false;
        else region = null;
        render();
        updateOverlay();
        return true;
      }
      return false;
    },
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function fmtCell(m: number): string {
  return m >= 1 ? `${Math.round(m * 100) / 100} m` : `${Math.round(m * 1000) / 10} cm`;
}

function subLabel(s: number): string {
  return s === 1 ? '1 je Quad' : `${s}×${s} je Quad`;
}

function fmtRadius(m: number): string {
  return `${m < 1 ? m.toFixed(2) : m.toFixed(1)} m`;
}

function fmtLen(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 2)} km` : `${Math.round(m * 10) / 10} m`;
}
