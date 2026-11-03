import type { EditorState } from './state.ts';
import { ASSETS } from '../world/assets.ts';
import { TYPE_ICONS, icon } from './icons.ts';
import { h } from './ui.ts';

// Outliner (rechts oben): Liste aller Objekte der Map, Auswahl, Umbenennen, Sichtbarkeit im Editor.

export class Outliner {
  private list: HTMLElement;
  private footer: HTMLElement;
  private search: HTMLInputElement;
  private lastClicked: string | null = null;
  onContextMenu?: (id: string, x: number, y: number) => void;
  onFocus?: (id: string) => void;
  onVisibility?: () => void;

  constructor(
    root: HTMLElement,
    private state: EditorState,
  ) {
    this.search = h('input', { class: 'search', type: 'text', placeholder: 'Suchen…', spellcheck: 'false' });
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.list = h('div', { class: 'panel-body' });
    this.footer = h('div', { class: 'panel-footer' });
    root.append(
      h('div', { class: 'panel-tabs' }, h('div', { class: 'panel-tab active', html: `${icon('outliner')}Outliner` })),
      h('div', { class: 'panel-toolbar' }, this.search),
      h('div', { class: 'outliner-head' }, h('span', { style: 'text-align:center', html: icon('eye', 'width="13" height="13"') }), h('span'), h('span', {}, 'Name'), h('span', {}, 'Typ')),
      this.list,
      this.footer,
    );
    state.on('scene', () => this.render());
    state.on('selection', () => this.render());
    state.on('meta', () => this.render());
  }

  render(): void {
    const q = this.search.value.trim().toLowerCase();
    const sel = new Set(this.state.selection);
    const primary = this.state.selection[this.state.selection.length - 1];
    const objects = this.state.map.objects.filter((o) => !q || o.name.toLowerCase().includes(q) || (ASSETS[o.type]?.label ?? o.type).toLowerCase().includes(q));
    this.list.replaceChildren(
      ...objects.map((o) => {
        const hidden = this.state.editorHidden.has(o.id);
        const eye = h('span', { class: `eye${hidden ? ' off' : ''}`, title: 'Im Editor ein-/ausblenden', html: icon(hidden ? 'eyeOff' : 'eye') });
        eye.addEventListener('click', (e) => {
          e.stopPropagation();
          if (hidden) this.state.editorHidden.delete(o.id);
          else this.state.editorHidden.add(o.id);
          this.state.emit('scene');
          this.onVisibility?.();
        });
        const name = h('span', { class: 'name' }, o.name, o.script?.code ? h('span', { class: 'script-badge', title: 'Hat ein Script' }, 'S') : '');
        const row = h(
          'div',
          { class: `outliner-row${sel.has(o.id) ? ' selected' : ''}${o.id === primary ? ' primary' : ''}`, 'data-id': o.id },
          eye,
          h('span', { class: 'icon', html: icon(o.type === 'model' ? 'model' : TYPE_ICONS[o.type] ?? 'cube') }),
          name,
          h('span', { class: 'type' }, ASSETS[o.type]?.label ?? o.type),
        );
        row.addEventListener('click', (e) => {
          if (e.shiftKey && this.lastClicked) {
            const ids = objects.map((x) => x.id);
            const a = ids.indexOf(this.lastClicked);
            const b = ids.indexOf(o.id);
            if (a >= 0 && b >= 0) {
              const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
              if (a > b) range.reverse();
              this.state.select(range, e.ctrlKey ? 'add' : 'set');
              return;
            }
          }
          this.lastClicked = o.id;
          this.state.select([o.id], e.ctrlKey || e.metaKey ? 'toggle' : 'set');
        });
        row.addEventListener('dblclick', (e) => {
          if ((e.target as HTMLElement).closest('.name')) this.rename(o.id);
          else this.onFocus?.(o.id);
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (!sel.has(o.id)) this.state.select([o.id]);
          this.onContextMenu?.(o.id, e.clientX, e.clientY);
        });
        return row;
      }),
    );
    if (!this.state.map.objects.length) {
      this.list.append(h('div', { class: 'empty-hint' }, 'Die Map ist leer.', h('br'), 'Ziehe Assets aus dem Content Browser in den Viewport.'));
    }
    const n = this.state.map.objects.length;
    this.footer.textContent = `${n} Objekt${n === 1 ? '' : 'e'}${sel.size ? ` (${sel.size} ausgewählt)` : ''}`;
  }

  /** Inline-Umbenennen (Doppelklick / F2) */
  rename(id: string): void {
    const row = this.list.querySelector<HTMLElement>(`[data-id="${id}"]`);
    const obj = this.state.get(id);
    if (!row || !obj) return;
    row.scrollIntoView({ block: 'nearest' });
    const nameEl = row.querySelector('.name')!;
    const input = h('input', { type: 'text', value: obj.name, spellcheck: 'false' });
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (apply: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (apply && v && v !== obj.name) this.state.update(() => (obj.name = v));
      else this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }
}
