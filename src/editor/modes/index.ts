import { h } from '../ui.ts';
import type { EditorMode, ModeContext, ModeId } from './types.ts';
import { PLANNED, createPlannedMode } from './planned.ts';

export type { EditorMode, ModeContext, ModeId, ModeInput } from './types.ts';

// Verwaltet den aktiven Editor-Modus: Viewport-Eingaben umleiten, Werkzeug-Panel über der Details-Spalte zeigen.

const selectMode: EditorMode = {
  id: 'select',
  label: 'Auswahl',
  icon: 'select',
  panel: null,
  allowsSelection: true,
  activate() {},
  deactivate() {},
};

/** Reihenfolge = Tastenkürzel Umschalt+1 … Umschalt+6 */
export const MODE_ORDER: ModeId[] = ['select', 'landscape', 'foliage', 'modeling', 'splines', 'water'];

export class ModeManager {
  readonly modes = new Map<ModeId, EditorMode>();
  private current: EditorMode = selectMode;
  private overlay: HTMLElement;
  private listeners: ((m: EditorMode) => void)[] = [];

  constructor(
    private ctx: ModeContext,
    /** Details-Spalte; das Werkzeug-Panel liegt im Modus darüber */
    panelHost: HTMLElement,
  ) {
    this.modes.set('select', selectMode);
    for (const p of PLANNED) this.modes.set(p.id, createPlannedMode(p));
    this.overlay = h('div', { class: 'mode-panel hidden' });
    panelHost.classList.add('mode-host');
    panelHost.append(this.overlay);
  }

  /** Modus ersetzen, sobald seine Werkzeuge fertig sind (Phase 1 ff.) */
  register(mode: EditorMode): void {
    const active = this.current.id === mode.id;
    if (active) this.set('select');
    this.modes.set(mode.id, mode);
    if (active) this.set(mode.id);
  }

  get active(): EditorMode {
    return this.current;
  }

  onChange(fn: (m: EditorMode) => void): void {
    this.listeners.push(fn);
  }

  set(id: ModeId): void {
    const next = this.modes.get(id);
    if (!next || next === this.current) return;
    this.current.deactivate();
    this.current.pointerLeave?.();
    this.current = next;
    const vp = this.ctx.viewport;
    vp.modeInput = next.id === 'select' ? null : next;
    vp.setSelectionEnabled(next.allowsSelection);
    this.overlay.replaceChildren(...(next.panel ? [next.panel] : []));
    this.overlay.classList.toggle('hidden', !next.panel);
    next.activate();
    this.ctx.status(`Modus: ${next.label}`);
    for (const fn of this.listeners) fn(next);
  }

  /** Tastenkürzel: Umschalt+1…6 = Modus, sonst an den aktiven Modus weiterreichen */
  key(e: KeyboardEvent): boolean {
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const m = /^Digit([1-6])$/.exec(e.code);
      if (m) {
        this.set(MODE_ORDER[Number(m[1]) - 1]);
        return true;
      }
    }
    return this.current.key?.(e) ?? false;
  }
}
