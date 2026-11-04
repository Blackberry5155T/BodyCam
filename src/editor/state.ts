import { cloneObject, newId, type MapData, type MapObjectData } from '../world/mapFormat.ts';
import { ASSETS } from '../world/assets.ts';
import type { DataEdit } from './history.ts';

// Zentraler Editor-Zustand: Map-Daten, Auswahl, Undo/Redo. Panels und Viewport hören auf Ereignisse.
// Undo/Redo kennt zwei Arten von Schritten:
//  - JSON-Snapshot der ganzen Map (normale Objekt-Änderungen, klein)
//  - DataEdit (Pinselstriche auf Heightmaps/Splatmaps …): nur die geänderten Kacheln, siehe history.ts
// Die Historie ist nach Anzahl UND Speicher begrenzt; die ältesten Schritte fallen heraus.

export type EditorEvent =
  | 'scene' // Objekte hinzugefügt/entfernt/geändert → Viewport gleicht ab
  | 'transform' // Transform live geändert (Gizmo), nur Anzeigen aktualisieren
  | 'selection'
  | 'world' // World Settings geändert
  | 'meta'; // Name, ungespeichert-Status

const MAX_HISTORY = 300;
const HISTORY_BUDGET = 256 * 1024 * 1024; // Bytes

type HistoryEntry = { kind: 'json'; json: string } | { kind: 'data'; edit: DataEdit };

const entryBytes = (e: HistoryEntry) => (e.kind === 'json' ? e.json.length * 2 : e.edit.bytes);
const CLIPBOARD_KEY = 'bodycam.editor.clipboard';

export class EditorState {
  map!: MapData;
  /** Ausgewählte IDs, letzte = primär (Gizmo-Pivot, Details-Panel) */
  selection: string[] = [];
  dirty = false;
  /** Im Editor ausgeblendete Objekte (Auge im Outliner) — nicht Teil der Map */
  editorHidden = new Set<string>();
  simulating = false;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private snapshot = '';
  private listeners = new Map<EditorEvent, Set<() => void>>();

  on(event: EditorEvent, fn: () => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  emit(...events: EditorEvent[]): void {
    for (const e of events) for (const fn of this.listeners.get(e) ?? []) fn();
  }

  load(map: MapData): void {
    this.map = map;
    this.selection = [];
    this.editorHidden.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.snapshot = JSON.stringify(map);
    this.dirty = false;
    this.emit('scene', 'world', 'selection', 'meta');
  }

  get(id: string): MapObjectData | undefined {
    return this.map.objects.find((o) => o.id === id);
  }

  get primary(): MapObjectData | undefined {
    const id = this.selection[this.selection.length - 1];
    return id ? this.get(id) : undefined;
  }

  get selected(): MapObjectData[] {
    return this.selection.map((id) => this.get(id)).filter((o): o is MapObjectData => !!o);
  }

  // ---------- Historie ----------

  /** Aktuellen Stand als Undo-Schritt festhalten (nach jeder abgeschlossenen Änderung) */
  commit(): void {
    if (this.simulating) return;
    const now = JSON.stringify(this.map);
    if (now === this.snapshot) return;
    this.push({ kind: 'json', json: this.snapshot });
    this.snapshot = now;
  }

  /** Abgeschlossene Änderung an Binär-Daten als Undo-Schritt festhalten (Daten sind bereits geändert) */
  commitData(edit: DataEdit | null): void {
    if (this.simulating || !edit) return;
    this.push({ kind: 'data', edit });
  }

  private push(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    this.redoStack = [];
    let total = 0;
    for (const e of this.undoStack) total += entryBytes(e);
    while (this.undoStack.length > 1 && (this.undoStack.length > MAX_HISTORY || total > HISTORY_BUDGET)) total -= entryBytes(this.undoStack.shift()!);
    this.dirty = true;
    this.emit('meta');
  }

  /** Daten ändern, Szene abgleichen, optional Undo-Schritt */
  update(mutate: () => void, commit = true): void {
    if (this.simulating) return;
    mutate();
    this.emit('scene');
    if (commit) this.commit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    this.restore(this.undoStack, this.redoStack, true);
  }

  redo(): void {
    this.restore(this.redoStack, this.undoStack, false);
  }

  private restore(from: HistoryEntry[], to: HistoryEntry[], undo: boolean): void {
    if (this.simulating) return;
    const entry = from.pop();
    if (!entry) return;
    this.dirty = true;
    if (entry.kind === 'data') {
      if (undo) entry.edit.undo();
      else entry.edit.redo();
      to.push(entry);
      this.emit('meta');
      return;
    }
    to.push({ kind: 'json', json: JSON.stringify(this.map) });
    this.snapshot = entry.json;
    this.map = JSON.parse(entry.json) as MapData;
    this.selection = this.selection.filter((id) => this.get(id));
    this.emit('scene', 'world', 'selection', 'meta');
  }

  markSaved(): void {
    this.dirty = false;
    this.emit('meta');
  }

  // ---------- Auswahl ----------

  select(ids: string[], mode: 'set' | 'toggle' | 'add' = 'set'): void {
    if (mode === 'set') this.selection = [...ids];
    else if (mode === 'add') this.selection = [...this.selection.filter((i) => !ids.includes(i)), ...ids];
    else {
      for (const id of ids) {
        const i = this.selection.indexOf(id);
        if (i >= 0) this.selection.splice(i, 1);
        else this.selection.push(id);
      }
    }
    this.emit('selection');
  }

  // ---------- Objekte ----------

  uniqueName(base: string): string {
    const names = new Set(this.map.objects.map((o) => o.name));
    if (!names.has(base)) return base;
    const stem = base.replace(/\s*\d+$/, '');
    for (let i = 2; ; i++) if (!names.has(`${stem} ${i}`)) return `${stem} ${i}`;
  }

  /** Fügt Objekte hinzu (neue IDs/Namen), wählt sie aus; liefert null bei Einzigartigkeits-Konflikt */
  add(objects: MapObjectData[], commit = true): MapObjectData[] {
    const added: MapObjectData[] = [];
    for (const src of objects) {
      const def = ASSETS[src.type];
      if (def?.unique && this.map.objects.some((o) => o.type === src.type)) continue;
      const o = cloneObject(src);
      o.id = newId();
      o.name = this.uniqueName(o.name);
      this.map.objects.push(o);
      added.push(o);
    }
    if (!added.length) return added;
    this.selection = added.map((o) => o.id);
    this.emit('scene', 'selection');
    if (commit) this.commit();
    return added;
  }

  removeSelected(): void {
    if (!this.selection.length) return;
    const ids = new Set(this.selection);
    this.update(() => {
      this.map.objects = this.map.objects.filter((o) => !ids.has(o.id));
      this.selection = [];
    });
    this.emit('selection');
  }

  duplicateSelected(commit = true): MapObjectData[] {
    return this.add(this.selected, commit);
  }

  copy(): number {
    const sel = this.selected;
    if (sel.length) localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(sel));
    return sel.length;
  }

  paste(): number {
    try {
      const list = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) ?? '[]') as MapObjectData[];
      return this.add(list).length;
    } catch {
      return 0;
    }
  }
}
