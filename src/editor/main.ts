import './editor.css';
import { EditorState } from './state.ts';
import { Viewport, type GizmoMode, type ViewMode } from './viewport.ts';
import { Outliner } from './outliner.ts';
import { DetailsPanel } from './details.ts';
import { ContentBrowser } from './content.ts';
import { ScriptEditor } from './scriptEditor.ts';
import { icon } from './icons.ts';
import { closeMenus, confirmDialog, dialog, h, initSplitters, isMenuOpen, pickFile, promptText, showMenu, toast, type MenuItem } from './ui.ts';
import { ASSETS, CATEGORIES, PRESETS, defaultProps, type AssetPreset } from '../world/assets.ts';
import { emptyMap, normalizeMap, type MapData, type MapObjectData } from '../world/mapFormat.ts';
import { deleteLocalMap, exportMapFile, importMapFile, listLocalMaps, loadLocalMap, saveLocalMap } from '../world/mapStore.ts';
import { MAPS } from '../maps/index.ts';

// Einstieg des Map-Editors (editor.html). Verdrahtet Zustand, Viewport, Panels, Menüs und Tastenkürzel.

const LAST_KEY = 'bodycam.editor.last';

const state = new EditorState();
state.map = structuredClone(MAPS.start);

const statusMsg = h('span', { class: 'msg' }, 'Bereit');
const statusDirty = h('span', { class: 'dirty' });
const statusCount = h('span');
document.getElementById('statusbar')!.append(statusMsg, statusDirty, statusCount);
let statusTimer = 0;
const status = (msg: string, error = false) => {
  statusMsg.textContent = msg;
  statusMsg.classList.toggle('error', error);
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusMsg.textContent = 'Bereit';
    statusMsg.classList.remove('error');
  }, error ? 9000 : 4000);
};

const viewportEl = document.getElementById('viewport')!;
const viewport = new Viewport(viewportEl, state);
viewport.onStatus = status;
const outliner = new Outliner(document.getElementById('outliner')!, state);
const details = new DetailsPanel(document.getElementById('details')!, state);
const content = new ContentBrowser(document.getElementById('content')!);
const scriptEditor = new ScriptEditor();
initSplitters();

// ---------- Map laden / speichern ----------

function loadMapData(map: MapData): void {
  if (viewport.simulating) viewport.stopSimulation();
  state.load(normalizeMap(structuredClone(map)));
  localStorage.setItem(LAST_KEY, state.map.name);
  viewport.applyWorld();
  viewport.focus([]);
}

async function confirmDiscard(): Promise<boolean> {
  return !state.dirty || confirmDialog('Ungespeicherte Änderungen', `„${state.map.name}“ hat ungespeicherte Änderungen. Verwerfen?`, 'Verwerfen', true);
}

function save(): boolean {
  if (viewport.simulating) viewport.stopSimulation();
  try {
    saveLocalMap(state.map);
  } catch (e) {
    toast((e as Error).message, 'error', 6000);
    return false;
  }
  localStorage.setItem(LAST_KEY, state.map.name);
  state.markSaved();
  status(`„${state.map.name}“ im Browser gespeichert`);
  return true;
}

async function saveAs(): Promise<void> {
  const name = await promptText('Speichern unter', 'Name der Map:', state.map.name);
  if (!name) return;
  if (name !== state.map.name && listLocalMaps().some((m) => m.name === name)) {
    if (!(await confirmDialog('Überschreiben?', `Es gibt bereits eine Map „${name}“. Überschreiben?`, 'Überschreiben', true))) return;
  }
  state.map.name = name;
  if (save()) toast(`Gespeichert als „${name}“`, 'ok');
}

async function newMap(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const name = await promptText('Neue Map', 'Name der neuen Map:', 'Neue Map');
  if (!name) return;
  const map = emptyMap(name);
  const obj = (preset: string, pos: [number, number, number]): MapObjectData => {
    const p = PRESETS.find((x) => x.id === preset)!;
    return { id: `${preset}-1`, name: p.label, type: p.type, pos, rot: [0, 0, 0], scale: p.scale ?? [1, 1, 1], props: defaultProps(p.type, p.props) };
  };
  map.objects.push({ ...obj('floor', [0, -0.05, 0]), scale: [20, 0.1, 20] }, obj('spawn', [0, 0, 4]));
  loadMapData(map);
  state.dirty = true;
  state.emit('meta');
}

function openDialog(): void {
  const list = h('div', { class: 'map-list' });
  let close = () => {};
  const entry = (label: string, when: string, load: () => void, del?: () => void) => {
    const row = h('div', { class: 'map-entry', html: `${icon('open', 'width="16" height="16"')}` }, h('span', {}, label), h('span', { class: 'when' }, when));
    row.addEventListener('click', async () => {
      close();
      if (await confirmDiscard()) load();
    });
    if (del) {
      const x = h('span', { class: 'x', title: 'Löschen' }, '✕');
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (await confirmDialog('Map löschen', `„${label}“ endgültig aus dem Browser löschen?`, 'Löschen', true)) {
          del();
          row.remove();
        }
      });
      row.append(x);
    }
    list.append(row);
  };
  for (const m of listLocalMaps()) {
    entry(m.name, new Date(m.updated).toLocaleString('de-DE'), () => {
      const map = loadLocalMap(m.name);
      if (map) loadMapData(map);
      else toast('Map konnte nicht geladen werden', 'error');
    }, () => deleteLocalMap(m.name));
  }
  entry('Startmap (mitgeliefert, src/maps/start.json)', 'Vorlage', () => loadMapData(MAPS.start));
  const body = h('div', {}, h('div', { style: 'color:var(--text-dim)' }, 'Im Browser gespeicherte Maps:'), list);
  close = dialog('Map öffnen', body, [
    {
      label: 'JSON importieren…',
      action: () => {
        void importJson();
      },
    },
    { label: 'Schließen', primary: true },
  ]);
}

async function importJson(): Promise<void> {
  const file = await pickFile('.json,application/json');
  if (!file || !(await confirmDiscard())) return;
  try {
    const map = await importMapFile(file);
    loadMapData(map);
    state.dirty = true;
    state.emit('meta');
    toast(`„${map.name}“ importiert — Strg+S speichert sie im Browser`, 'ok', 4000);
  } catch (e) {
    toast((e as Error).message, 'error', 5000);
  }
}

function play(): void {
  if (!save()) return;
  if (!state.map.objects.some((o) => o.type === 'spawn')) toast('Kein Player Start in der Map — Spieler startet bei 0/0/0', 'info', 4000);
  window.open(`index.html?map=local:${encodeURIComponent(state.map.name)}`, 'bodycam-play');
  status('Spiel geöffnet (Tab „bodycam-play“) — erneutes Speichern lädt es automatisch neu');
}

function toggleSimulation(): void {
  if (viewport.simulating) viewport.stopSimulation();
  else viewport.startSimulation();
}

// ---------- Objekte ----------

function objectFromPreset(p: AssetPreset): MapObjectData {
  return { id: '', name: p.label, type: p.type, pos: [0, 0, 0], rot: p.rot ?? [0, 0, 0], scale: p.scale ?? [1, 1, 1], props: defaultProps(p.type, p.props) };
}

function uniqueConflict(type: string): boolean {
  if (!ASSETS[type]?.unique) return false;
  const existing = state.map.objects.find((o) => o.type === type);
  if (!existing) return false;
  toast(`Nur ein „${ASSETS[type].label}“ pro Map — vorhandenes ausgewählt`);
  state.select([existing.id]);
  return true;
}

function placePreset(p: AssetPreset): void {
  if (viewport.simulating || uniqueConflict(p.type)) return;
  const [o] = state.add([objectFromPreset(p)], false);
  if (!o) return;
  const hit = viewport.centerPoint();
  viewport.placeOnSurface(o.id, hit.point, hit.normal);
  state.commit();
  status(`„${o.name}“ hinzugefügt`);
}
content.onPlace = placePreset;

// Drag & Drop aus dem Content Browser: Vorschau-Objekt folgt der Maus, Loslassen platziert
let ghost: { id: string; prevSelection: string[] } | null = null;
viewportEl.addEventListener('dragover', (e) => {
  const p = ContentBrowser.dragging;
  if (!p || viewport.simulating) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
  viewportEl.classList.add('vp-drop');
  if (!ghost) {
    if (ASSETS[p.type]?.unique && state.map.objects.some((o) => o.type === p.type)) return;
    const prev = [...state.selection];
    const [o] = state.add([objectFromPreset(p)], false);
    if (!o) return;
    ghost = { id: o.id, prevSelection: prev };
  }
  const hit = viewport.surfacePoint(e.clientX, e.clientY, new Set([ghost.id]));
  viewport.placeOnSurface(ghost.id, hit.point, hit.normal);
});
const cancelGhost = () => {
  viewportEl.classList.remove('vp-drop');
  if (!ghost) return;
  const g = ghost;
  ghost = null;
  state.map.objects = state.map.objects.filter((o) => o.id !== g.id);
  state.selection = g.prevSelection.filter((id) => state.get(id));
  state.emit('scene', 'selection');
};
viewportEl.addEventListener('dragleave', (e) => {
  if (!viewportEl.contains(e.relatedTarget as Node | null)) cancelGhost();
});
viewportEl.addEventListener('drop', (e) => {
  e.preventDefault();
  viewportEl.classList.remove('vp-drop');
  const p = ContentBrowser.dragging;
  if (!ghost) {
    if (p) uniqueConflict(p.type);
    return;
  }
  const name = state.get(ghost.id)?.name;
  ghost = null;
  state.commit();
  status(`„${name}“ platziert`);
  viewportEl.querySelector('canvas')?.focus();
});
window.addEventListener('dragend', () => cancelGhost());

function editScript(id: string): void {
  const obj = state.get(id);
  if (!obj || viewport.simulating) return;
  scriptEditor.open(obj, (script) => {
    state.update(() => {
      const o = state.get(id);
      if (!o) return;
      if (script) o.script = script;
      else delete o.script;
    });
    status(script ? `Script von „${obj.name}“ gespeichert — ▶ Simulieren oder Spielen zum Testen` : `Script von „${obj.name}“ entfernt`);
  });
}
details.onEditScript = editScript;

function deleteSelected(): void {
  const n = state.selection.length;
  if (!n) return;
  state.removeSelected();
  status(`${n} Objekt(e) gelöscht`);
}

function duplicate(): void {
  const n = state.duplicateSelected().length;
  if (n) status(`${n} Objekt(e) dupliziert`);
  else if (state.selection.length) toast('Einzigartige Objekte (Player Start, Terminal) können nicht dupliziert werden');
}

function hideSelected(): void {
  for (const id of state.selection) state.editorHidden.add(id);
  state.emit('scene');
}

function unhideAll(): void {
  state.editorHidden.clear();
  state.emit('scene');
}

function contextItems(): MenuItem[] {
  const sel = state.primary;
  const has = !!sel;
  return [
    { label: 'Fokussieren', key: 'F', disabled: !has, action: () => viewport.focus(state.selection) },
    { label: 'Umbenennen', key: 'F2', disabled: !has, action: () => sel && outliner.rename(sel.id) },
    { label: sel?.script ? 'Script bearbeiten' : 'Script hinzufügen', icon: 'script', disabled: !has, action: () => sel && editScript(sel.id) },
    { separator: true },
    { label: 'Kopieren', key: 'Strg+C', disabled: !has, action: () => state.copy() },
    { label: 'Einfügen', key: 'Strg+V', action: () => state.paste() },
    { label: 'Duplizieren', key: 'Strg+D', disabled: !has, action: duplicate },
    { label: 'Auf Boden setzen', key: 'Ende', disabled: !has, action: () => viewport.snapToFloor() },
    { label: 'Im Editor ausblenden', key: 'H', disabled: !has, action: hideSelected },
    { separator: true },
    { label: 'Löschen', key: 'Entf', icon: 'trash', disabled: !has, action: deleteSelected },
  ];
}
viewport.onContextMenu = (node, x, y) => {
  if (viewport.simulating) return;
  if (!node) {
    showMenu([{ heading: 'Hinzufügen' }, ...addMenuItems().slice(0, 40)], { x, y });
    return;
  }
  showMenu(contextItems(), { x, y });
};
outliner.onContextMenu = (_id, x, y) => showMenu(contextItems(), { x, y });
outliner.onFocus = (id) => viewport.focus([id]);

// ---------- Menüs ----------

function addMenuItems(): MenuItem[] {
  return CATEGORIES.filter((c) => c !== 'Modelle').flatMap((cat) => [
    { heading: cat },
    ...PRESETS.filter((p) => p.category === cat).map((p): MenuItem => ({ label: p.label, icon: p.icon, action: () => placePreset(p) })),
  ]);
}

const menubar = document.getElementById('menubar')!;
const mapTitle = h('div', { class: 'map-title' });
const menus: Record<string, () => MenuItem[]> = {
  Datei: () => [
    { label: 'Neue Map…', key: 'Strg+N', action: () => void newMap() },
    { label: 'Öffnen…', key: 'Strg+O', icon: 'open', action: openDialog },
    { label: 'Speichern', key: 'Strg+S', icon: 'save', action: save },
    { label: 'Speichern unter…', key: 'Strg+Umsch+S', action: () => void saveAs() },
    { separator: true },
    { label: 'Als JSON exportieren', icon: 'download', action: () => exportMapFile(state.map) },
    { label: 'JSON importieren…', icon: 'upload', action: () => void importJson() },
    { separator: true },
    { label: 'Im Spiel testen', key: 'Alt+P', icon: 'play', action: play },
  ],
  Bearbeiten: () => [
    { label: 'Rückgängig', key: 'Strg+Z', disabled: !state.canUndo, action: () => state.undo() },
    { label: 'Wiederholen', key: 'Strg+Y', disabled: !state.canRedo, action: () => state.redo() },
    { separator: true },
    ...contextItems().slice(4),
    { separator: true },
    { label: 'Alles auswählen', key: 'Strg+A', action: () => state.select(state.map.objects.map((o) => o.id)) },
    { label: 'Auswahl aufheben', key: 'Esc', action: () => state.select([]) },
    { label: 'Alle einblenden', key: 'Strg+H', action: unhideAll },
  ],
  Ansicht: () => {
    const vm = (label: string, m: ViewMode): MenuItem => ({ label, checked: viewport.viewMode === m, action: () => setViewMode(m) });
    return [
      vm('Beleuchtet (wie im Spiel)', 'lit'),
      vm('Aufgehellt', 'bright'),
      vm('Drahtgitter', 'wire'),
      { separator: true },
      { label: 'Editor-Hilfen (Icons, Volumen)', key: 'G', checked: viewport.showHelpers, action: () => viewport.setShowHelpers(!viewport.showHelpers) },
      { label: 'Raster', checked: viewport.showGrid, action: () => viewport.setShowGrid(!viewport.showGrid) },
      { label: 'Nebel', checked: viewport.showFog, action: () => viewport.setShowFog(!viewport.showFog) },
      { label: 'Bloom', checked: viewport.bloomEnabled, action: () => viewport.setBloom(!viewport.bloomEnabled) },
      { separator: true },
      { label: 'Content Browser', key: 'Strg+Leer', checked: !contentEl.classList.contains('hidden'), action: toggleContent },
      { label: 'Auswahl fokussieren', key: 'F', action: () => viewport.focus(state.selection) },
      { label: 'Ganze Map zeigen', action: () => viewport.focus([]) },
    ];
  },
  Hinzufügen: addMenuItems,
  Hilfe: () => [
    { label: 'Tastenkürzel', action: showShortcuts },
    { label: 'Scripts (Blöcke) — Kurzanleitung', action: showScriptHelp },
  ],
};
menubar.append(h('div', { class: 'logo' }, h('i'), 'BODYCAM'));
for (const [name, items] of Object.entries(menus)) {
  const btn = h('div', { class: 'menu-button' }, name);
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (btn.classList.contains('open')) {
      closeMenus();
      return;
    }
    btn.classList.add('open');
    showMenu(items(), btn, () => btn.classList.remove('open'));
  });
  btn.addEventListener('pointerenter', () => {
    if (isMenuOpen() && !btn.classList.contains('open')) {
      closeMenus();
      btn.classList.add('open');
      showMenu(items(), btn, () => btn.classList.remove('open'));
    }
  });
  menubar.append(btn);
}
menubar.append(mapTitle);

// ---------- Toolbar ----------

const tb = (label: string, ic: string, title: string, action: () => void, cls = '') => {
  const b = h('button', { class: `tb-button ${cls}`, title, html: `${icon(ic)}${label ? `<span>${label}</span>` : ''}` });
  b.addEventListener('click', action);
  return b;
};
const btnPlay = tb('Spielen', 'play', 'Map speichern und im Spiel öffnen (Alt+P)', play, 'tb-play');
const btnSim = tb('Simulieren', 'simulate', 'Scripts im Editor laufen lassen (Alt+S)', toggleSimulation, 'tb-play');
const btnStop = tb('', 'stop', 'Simulation beenden (Esc)', () => viewport.stopSimulation(), 'tb-stop');
const btnUndo = tb('', 'rotate', 'Rückgängig (Strg+Z)', () => state.undo());
btnUndo.style.transform = 'scaleX(-1)';
const btnRedo = tb('', 'rotate', 'Wiederholen (Strg+Y)', () => state.redo());
const addBtn = tb('Hinzufügen', 'plus', 'Asset hinzufügen', () => showMenu(addMenuItems(), addBtn));
document.getElementById('toolbar')!.append(
  tb('Speichern', 'save', 'Im Browser speichern (Strg+S)', save),
  tb('Öffnen', 'open', 'Map öffnen (Strg+O)', openDialog),
  h('div', { class: 'tb-sep' }),
  addBtn,
  tb('Script', 'script', 'Blöcke des ausgewählten Objekts bearbeiten', () => state.primary && editScript(state.primary.id)),
  h('div', { class: 'tb-sep' }),
  btnUndo,
  btnRedo,
  h('div', { class: 'tb-spacer' }),
  h('div', { class: 'tb-group' }, btnPlay, btnSim, btnStop),
  h('div', { class: 'tb-spacer' }),
  tb('Export', 'download', 'Map als JSON-Datei herunterladen', () => exportMapFile(state.map)),
);
viewport.onSimulationChange = updateToolbar;

function updateToolbar(): void {
  const sim = viewport.simulating;
  btnSim.classList.toggle('active', sim);
  btnStop.disabled = !sim;
  btnUndo.disabled = !state.canUndo || sim;
  btnRedo.disabled = !state.canRedo || sim;
}

// ---------- Viewport-Overlays (wie UE5: links Ansicht, rechts Gizmo/Snapping) ----------

const vpBtn = (html: string, title: string, action: (b: HTMLElement) => void) => {
  const b = h('div', { class: 'vp-btn', title, html });
  b.addEventListener('click', () => action(b));
  return b;
};
const viewLabels: Record<ViewMode, string> = { lit: 'Beleuchtet', bright: 'Aufgehellt', wire: 'Drahtgitter' };
const viewBtn = vpBtn('', 'Ansichtsmodus', (b) => showMenu((['lit', 'bright', 'wire'] as ViewMode[]).map((m) => ({ label: viewLabels[m], checked: viewport.viewMode === m, action: () => setViewMode(m) })), b));
function setViewMode(m: ViewMode): void {
  viewport.setViewMode(m);
  viewBtn.innerHTML = `${icon('eyeView')}${viewLabels[m]} ▾`;
}
setViewMode('lit');
const showBtn = vpBtn(`${icon('details')}Anzeigen ▾`, 'Anzeigeoptionen', (b) => showMenu(menus.Ansicht().slice(4, 8), b));
viewportEl.append(h('div', { class: 'vp-overlay left' }, vpBtn(`${icon('camera')}Perspektive`, 'Perspektivische Kamera', () => {}), viewBtn, showBtn));

const modeBtns: Record<GizmoMode, HTMLElement> = {
  select: vpBtn(icon('select'), 'Auswählen (Q)', () => setMode('select')),
  translate: vpBtn(icon('move'), 'Verschieben (W)', () => setMode('translate')),
  rotate: vpBtn(icon('rotate'), 'Drehen (E)', () => setMode('rotate')),
  scale: vpBtn(icon('scale'), 'Skalieren (R)', () => setMode('scale')),
};
function setMode(m: GizmoMode): void {
  viewport.setMode(m);
  for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle('active', k === m);
}
const spaceBtn = vpBtn('', 'Welt-/Lokales Koordinatensystem (Strg+^)', () => setSpace(viewport.space === 'world' ? 'local' : 'world'));
function setSpace(s: 'world' | 'local'): void {
  viewport.setSpace(s);
  spaceBtn.innerHTML = icon(s === 'world' ? 'world' : 'local');
  spaceBtn.title = s === 'world' ? 'Welt-Koordinaten (klicken für Lokal)' : 'Lokale Koordinaten (klicken für Welt)';
}
setSpace('world');

const snapCtl = (ic: string, title: string, key: 'translate' | 'rotate' | 'scale', values: number[], unit: string) => {
  const stepKey = `${key}Step` as const;
  const toggle = vpBtn('', `${title} an/aus`, () => {
    viewport.snap[key] = !viewport.snap[key];
    update();
  });
  const value = vpBtn('', `${title}-Schritt`, (b) =>
    showMenu(values.map((v) => ({ label: `${v}${unit}`, checked: viewport.snap[stepKey] === v, action: () => ((viewport.snap[stepKey] = v), (viewport.snap[key] = true), update()) })), b),
  );
  const update = () => {
    toggle.innerHTML = icon(ic);
    toggle.classList.toggle('active', viewport.snap[key]);
    value.textContent = `${viewport.snap[stepKey]}${unit}`;
    viewport.applySnap();
  };
  update();
  return h('div', { class: 'vp-seg' }, toggle, value);
};
const speedBtn = vpBtn('', 'Kamerageschwindigkeit (Mausrad bei gedrückter rechter Maustaste)', (b) =>
  showMenu([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ label: `Stufe ${n}`, checked: viewport.speedIndex === n - 1, action: () => ((viewport.speedIndex = n - 1), updateSpeed()) })), b),
);
const updateSpeed = () => (speedBtn.innerHTML = `${icon('camera')}${viewport.speedIndex + 1}`);
updateSpeed();
viewportEl.addEventListener('wheel', () => requestAnimationFrame(updateSpeed));
viewportEl.append(
  h(
    'div',
    { class: 'vp-overlay right' },
    h('div', { class: 'vp-seg' }, ...Object.values(modeBtns)),
    spaceBtn,
    snapCtl('grid', 'Raster-Snapping', 'translate', [0.05, 0.1, 0.25, 0.5, 1, 2, 5], ' m'),
    snapCtl('angle', 'Winkel-Snapping', 'rotate', [1, 5, 10, 15, 30, 45, 90], '°'),
    snapCtl('scale', 'Skalierungs-Snapping', 'scale', [0.05, 0.1, 0.25, 0.5, 1], ''),
    speedBtn,
  ),
);
setMode('translate');

const contentEl = document.getElementById('content')!;
const contentSplit = document.querySelector<HTMLElement>('[data-split="content"]')!;
function toggleContent(): void {
  const hidden = contentEl.classList.toggle('hidden');
  contentSplit.classList.toggle('hidden', hidden);
}

// ---------- Statusanzeigen ----------

state.on('meta', () => {
  mapTitle.innerHTML = '';
  mapTitle.append('Map:', h('b', {}, state.map.name + (state.dirty ? ' *' : '')));
  document.title = `${state.dirty ? '* ' : ''}${state.map.name} — BodyCam Map-Editor`;
  statusDirty.textContent = state.dirty ? '● Ungespeichert' : '';
  updateToolbar();
});
const updateCount = () => {
  const scripts = state.map.objects.filter((o) => o.script?.code).length;
  statusCount.textContent = `${state.map.objects.length} Objekte · ${scripts} mit Script`;
};
state.on('scene', updateCount);
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});

// ---------- Tastenkürzel ----------

function showShortcuts(): void {
  const rows: [string, string][] = [
    ['RMT halten + WASD / Q E', 'Fliegen (Mausrad: Geschwindigkeit, Shift: schneller)'],
    ['Mausrad', 'Vor / zurück'],
    ['MMT ziehen', 'Kamera verschieben'],
    ['Alt + LMT ziehen', 'Um Auswahl kreisen'],
    ['F', 'Auswahl fokussieren'],
    ['Q / W / E / R', 'Auswählen / Verschieben / Drehen / Skalieren'],
    ['Leertaste', 'Gizmo-Modus wechseln'],
    ['Strg + ^', 'Welt / Lokal umschalten'],
    ['Alt + Gizmo ziehen', 'Duplizieren und verschieben'],
    ['Strg/Shift + Klick', 'Mehrfachauswahl'],
    ['Strg + D', 'Duplizieren'],
    ['Strg + C / V / X', 'Kopieren / Einfügen / Ausschneiden'],
    ['Entf', 'Löschen'],
    ['Ende', 'Auf Boden setzen'],
    ['F2', 'Umbenennen'],
    ['H / Strg + H', 'Ausblenden / Alle einblenden'],
    ['G', 'Spielansicht (Editor-Hilfen aus)'],
    ['Strg + Z / Y', 'Rückgängig / Wiederholen'],
    ['Strg + S', 'Speichern'],
    ['Alt + P', 'Im Spiel testen'],
    ['Alt + S / Esc', 'Simulieren / Stopp'],
    ['Strg + Leertaste', 'Content Browser ein/aus'],
  ];
  dialog('Tastenkürzel', h('div', { class: 'shortcuts' }, ...rows.flatMap(([k, v]) => [h('kbd', {}, k), h('span', {}, v)])), [{ label: 'OK', primary: true }]);
}

function showScriptHelp(): void {
  dialog(
    'Scripts mit Blöcken',
    `<p>Jedes Objekt kann ein Script bekommen: auswählen → <b>Details › Script hinzufügen</b> (oder Rechtsklick → Script).</p>
     <p>Ein Script beginnt immer mit einem gelben <b>Ereignis</b>-Block („Wenn …“). Darunter hängst du Aktionen, z. B.:</p>
     <p style="padding-left:12px">Wenn Spieler mich benutzt, Hinweis „Tür öffnen“<br>→ drehe in 1 Sek. um y 90°</p>
     <p>Mit <b>sende Nachricht</b> / <b>Wenn ich Nachricht empfange</b> sprechen Objekte miteinander (z. B. Schalter → Lampe).
     Trigger-Volumen + „Wenn Spieler meinen Bereich betritt“ lösen Ereignisse beim Betreten aus.</p>
     <p><b>Simulieren</b> führt Scripts direkt im Editor aus (Kamera = Spieler, Klick = Benutzen, Shift+Klick = Treffer).
     <b>Spielen</b> öffnet die Map im Spiel.</p>`,
    [{ label: 'OK', primary: true }],
  );
}

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (scriptEditor.isOpen || document.querySelector('.modal-back:not(.hidden)')) return;
  if (t.closest('input, select, textarea, .blocklyWidgetDiv')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.code;
  const run = (fn: () => void) => {
    e.preventDefault();
    fn();
  };

  if (ctrl) {
    if (key === 'KeyS') return run(() => (e.shiftKey ? void saveAs() : save()));
    if (key === 'KeyO') return run(openDialog);
    if (key === 'KeyN') return run(() => void newMap());
    if (key === 'KeyZ') return run(() => (e.shiftKey ? state.redo() : state.undo()));
    if (key === 'KeyY') return run(() => state.redo());
    if (key === 'KeyD') return run(duplicate);
    if (key === 'KeyC') return run(() => state.copy() && status(`${state.selection.length} Objekt(e) kopiert`));
    if (key === 'KeyV') return run(() => state.paste());
    if (key === 'KeyX') return run(() => state.copy() && deleteSelected());
    if (key === 'KeyA') return run(() => state.select(state.map.objects.map((o) => o.id)));
    if (key === 'KeyH') return run(unhideAll);
    if (key === 'Space') return run(toggleContent);
    if (key === 'Backquote' || key === 'Backslash') return run(() => setSpace(viewport.space === 'world' ? 'local' : 'world'));
    return;
  }
  if (e.altKey) {
    if (key === 'KeyP') return run(play);
    if (key === 'KeyS') return run(toggleSimulation);
    return;
  }
  if (viewport.isFlying) return; // WASDQE gehören der Kamera
  if (viewport.simulating) {
    if (key === 'Escape') run(() => viewport.stopSimulation());
    return;
  }
  switch (key) {
    case 'Escape':
      return run(() => state.select([]));
    case 'KeyQ':
      return run(() => setMode('select'));
    case 'KeyW':
      return run(() => setMode('translate'));
    case 'KeyE':
      return run(() => setMode('rotate'));
    case 'KeyR':
      return run(() => setMode('scale'));
    case 'Space': {
      const order: GizmoMode[] = ['translate', 'rotate', 'scale'];
      return run(() => setMode(order[(order.indexOf(viewport.mode) + 1) % 3]));
    }
    case 'KeyF':
      return run(() => viewport.focus(state.selection));
    case 'KeyG':
      return run(() => viewport.setShowHelpers(!viewport.showHelpers));
    case 'KeyH':
      return run(hideSelected);
    case 'F2':
      return run(() => state.primary && outliner.rename(state.primary.id));
    case 'End':
      return run(() => viewport.snapToFloor());
    case 'Delete':
    case 'Backspace':
      return run(deleteSelected);
  }
});

// ---------- Start ----------

const last = localStorage.getItem(LAST_KEY);
const lastMap = last ? loadLocalMap(last) : null;
loadMapData(lastMap ?? MAPS.start);
updateCount();
status(lastMap ? `„${lastMap.name}“ geladen` : 'Startmap geladen — Strg+S speichert sie im Browser, ▶ Spielen testet sie im Spiel');
void details;
