import type { EditorState } from './state.ts';
import { ASSETS, type PropDef } from '../world/assets.ts';
import type { MapObjectData, PropValue, Vec3, WorldSettings } from '../world/mapFormat.ts';
import { defaultColorFor } from '../world/materials.ts';
import { modelLabel } from '../world/modelStore.ts';
import { countEvents } from '../scripting/blocks.ts';
import { TYPE_ICONS, icon } from './icons.ts';
import { fmt, h, numberField, pickFile, toast } from './ui.ts';
import { models } from './models.ts';

// Details-Panel (rechts unten): Transform + Eigenschaften des ausgewählten Objekts, Script-Zugang,
// zweiter Tab: World Settings (Himmel, Sonne, Nebel).

type Tab = 'details' | 'world';

export class DetailsPanel {
  private tab: Tab = 'details';
  private body: HTMLElement;
  private tabs: Record<Tab, HTMLElement>;
  private selfUpdate = false;
  private transformInputs: { key: 'pos' | 'rot' | 'scale'; i: number; input: HTMLInputElement }[] = [];
  private collapsed = new Set<string>();
  private scaleLock = false;
  onEditScript?: (id: string) => void;

  constructor(
    root: HTMLElement,
    private state: EditorState,
  ) {
    this.tabs = {
      details: h('div', { class: 'panel-tab active', html: `${icon('details')}Details` }),
      world: h('div', { class: 'panel-tab', html: `${icon('sun')}World Settings` }),
    };
    for (const [k, el] of Object.entries(this.tabs)) el.addEventListener('click', () => this.setTab(k as Tab));
    this.body = h('div', { class: 'panel-body' });
    root.append(h('div', { class: 'panel-tabs' }, this.tabs.details, this.tabs.world), this.body);
    const rerender = () => {
      if (!this.selfUpdate) this.render();
    };
    state.on('selection', rerender);
    state.on('scene', rerender);
    state.on('world', rerender);
    state.on('transform', () => this.refreshTransform());
    models.onChange(rerender);
  }

  setTab(t: Tab): void {
    this.tab = t;
    this.tabs.details.classList.toggle('active', t === 'details');
    this.tabs.world.classList.toggle('active', t === 'world');
    this.render();
  }

  /** Änderung aus dem Panel: Szene aktualisieren, ohne das Panel neu aufzubauen */
  private change(mutate: () => void, live: boolean): void {
    this.selfUpdate = true;
    try {
      this.state.update(mutate, !live);
    } finally {
      this.selfUpdate = false;
    }
  }

  render(): void {
    const scroll = this.body.scrollTop;
    this.transformInputs = [];
    this.body.replaceChildren();
    if (this.tab === 'world') this.renderWorld();
    else this.renderDetails();
    this.body.scrollTop = scroll;
  }

  private section(title: string, ...rows: (HTMLElement | null)[]): HTMLElement {
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

  // ---------- Objekt ----------

  private renderDetails(): void {
    const sel = this.state.selected;
    const o = this.state.primary;
    if (!o) {
      this.body.append(h('div', { class: 'empty-hint' }, 'Nichts ausgewählt.', h('br'), 'Klicke ein Objekt im Viewport oder Outliner an.'));
      return;
    }
    const def = ASSETS[o.type];
    const same = sel.filter((s) => s.type === o.type);
    const nameInput = h('input', { class: 'name', type: 'text', value: o.name, spellcheck: 'false' });
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') nameInput.blur();
    });
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v) this.change(() => (o.name = v), false);
    });
    this.body.append(
      h('div', { class: 'details-header' }, h('span', { class: 'icon', html: icon(o.type === 'model' ? 'model' : TYPE_ICONS[o.type] ?? 'cube') }), nameInput),
      h('div', { class: 'details-sub' }, `${def?.label ?? o.type}${sel.length > 1 ? ` · ${sel.length} ausgewählt (Eigenschaften gelten für alle ${same.length} vom Typ „${def?.label ?? o.type}“)` : ''}`),
    );

    // Transform
    const vecRow = (label: string, key: 'pos' | 'rot' | 'scale', step: number, disabled = false) => {
      const fields = [0, 1, 2].map((i) => {
        const f = numberField({
          value: o[key][i],
          step,
          axis: (['x', 'y', 'z'] as const)[i],
          onChange: (v, live) =>
            this.change(() => {
              const vec = o[key] as Vec3;
              if (key === 'scale' && this.scaleLock && vec[i] !== 0) {
                const k = v / vec[i];
                for (let j = 0; j < 3; j++) vec[j] = j === i ? v : Math.round(vec[j] * k * 10000) / 10000;
                this.refreshTransform();
              } else vec[i] = v;
            }, live),
        });
        const input = f.querySelector('input')!;
        if (disabled) {
          input.disabled = true;
          f.style.opacity = '0.4';
        }
        this.transformInputs.push({ key, i, input });
        return f;
      });
      const extra: Node[] = [];
      if (key === 'scale') {
        const lock = h('span', { class: `lock${this.scaleLock ? ' on' : ''}`, title: 'Proportional skalieren', html: icon(this.scaleLock ? 'lock' : 'unlock') });
        lock.addEventListener('click', () => {
          this.scaleLock = !this.scaleLock;
          lock.classList.toggle('on', this.scaleLock);
          lock.innerHTML = icon(this.scaleLock ? 'lock' : 'unlock');
        });
        extra.push(lock);
      }
      return this.row(label, ...fields, ...extra);
    };
    this.body.append(
      this.section(
        'Transform',
        vecRow('Position', 'pos', 0.1),
        vecRow('Rotation', 'rot', 1),
        vecRow(def?.rebuildOnScale ? 'Größe (m)' : 'Skalierung', 'scale', 0.05, !!def?.fixedScale),
      ),
    );

    // Eigenschaften nach Gruppen
    const groups = new Map<string, PropDef[]>();
    for (const p of def?.props ?? []) {
      const g = p.group ?? 'Eigenschaften';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(p);
    }
    for (const [g, props] of groups) {
      this.body.append(this.section(g, ...props.map((p) => this.propRow(p, o, same))));
    }

    // Allgemein
    const visible = h('input', { type: 'checkbox' }) as HTMLInputElement;
    visible.checked = !o.hidden;
    visible.addEventListener('change', () =>
      this.change(() => {
        for (const s of sel) {
          if (visible.checked) delete s.hidden;
          else s.hidden = true;
        }
      }, false),
    );
    this.body.append(
      this.section(
        'Allgemein',
        this.row('Im Spiel sichtbar', visible, h('span', { class: 'hex' }, 'Scripts: „zeige dich“')),
        this.row('ID', h('span', { class: 'hex', style: 'user-select:text' }, o.id)),
      ),
    );

    // Script
    const events = o.script ? countEvents(o.script.blocks) : 0;
    const edit = h('button', { class: 'btn script', html: `${icon('script')}${o.script ? 'Blöcke bearbeiten' : 'Script hinzufügen'}` });
    edit.addEventListener('click', () => this.onEditScript?.(o.id));
    const summary = h('div', { class: 'script-summary' }, h('div', { class: 'events' }, o.script ? `${events} Ereignis${events === 1 ? '' : 'se'} · ${o.script.code.split('\n').length} Zeilen Code` : 'Noch kein Script. Programmiere das Objekt mit Blöcken (wie Scratch).'), edit);
    if (o.script) {
      const del = h('button', { class: 'btn danger', html: `${icon('trash')}Entfernen` });
      del.addEventListener('click', () => this.change(() => delete o.script, false));
      summary.append(del);
    }
    const sec = this.section('Script', summary);
    this.body.append(sec);
  }

  private propRow(p: PropDef, o: MapObjectData, targets: MapObjectData[]): HTMLElement {
    const value = o.props[p.key] ?? p.default;
    const set = (v: PropValue, live = false) =>
      this.change(() => {
        for (const t of targets) {
          t.props[p.key] = v;
          if (p.key === 'material' && typeof v === 'string') t.props.color = defaultColorFor(v);
        }
      }, live);
    switch (p.type) {
      case 'number':
        return this.row(p.label, numberField({ value: Number(value), step: p.step ?? 0.1, min: p.min, max: p.max, onChange: (v, live) => set(v, live) }));
      case 'bool': {
        const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = !!value;
        cb.addEventListener('change', () => set(cb.checked));
        return this.row(p.label, cb);
      }
      case 'color':
        return this.row(p.label, ...this.colorInput(String(value), (v, live) => set(v, live)));
      case 'select': {
        const s = h('select', {}, ...(p.options ?? []).map((opt) => h('option', { value: opt.value, selected: opt.value === value }, opt.label)));
        s.addEventListener('change', () => {
          set(s.value);
          if (p.key === 'material') this.render();
        });
        return this.row(p.label, s);
      }
      case 'model': {
        const all = models.all;
        const s = h(
          'select',
          {},
          h('option', { value: '' }, '— kein Modell —'),
          ...all.map((ref) => h('option', { value: ref, selected: ref === value }, `${ref.startsWith('idb:') ? '⬆ ' : ''}${modelLabel(ref)}`)),
        );
        if (value && !all.includes(String(value))) s.append(h('option', { value: String(value), selected: true }, `${modelLabel(String(value))} (fehlt)`));
        s.addEventListener('change', () => set(s.value));
        const imp = h('button', { class: 'btn', title: '.glb-Datei importieren', html: icon('upload') });
        imp.addEventListener('click', async () => {
          const file = await pickFile('.glb');
          if (!file) return;
          try {
            const ref = await models.import(file);
            set(ref);
            toast(`Modell „${modelLabel(ref)}“ importiert`, 'ok');
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        });
        return this.row(p.label, s, imp);
      }
      default: {
        const t = h('input', { type: 'text', value: String(value), spellcheck: 'false' });
        t.addEventListener('keydown', (e) => e.stopPropagation());
        t.addEventListener('change', () => set(t.value));
        return this.row(p.label, t);
      }
    }
  }

  private colorInput(value: string, onChange: (v: string, live: boolean) => void): HTMLElement[] {
    const c = h('input', { type: 'color', value }) as HTMLInputElement;
    const hex = h('span', { class: 'hex' }, value.toUpperCase());
    c.addEventListener('input', () => {
      hex.textContent = c.value.toUpperCase();
      onChange(c.value, true);
    });
    c.addEventListener('change', () => onChange(c.value, false));
    return [c, hex];
  }

  /** Transform-Felder nachziehen (während Gizmo-Ziehen), ohne neu aufzubauen */
  private refreshTransform(): void {
    const o = this.state.primary;
    if (!o || this.tab !== 'details') return;
    for (const t of this.transformInputs) {
      if (document.activeElement !== t.input) t.input.value = fmt(o[t.key][t.i]);
    }
  }

  // ---------- World Settings ----------

  private renderWorld(): void {
    const w = this.state.map.world;
    const set = <K extends keyof WorldSettings>(k: K, v: WorldSettings[K], live: boolean) => {
      this.selfUpdate = true;
      try {
        w[k] = v;
        this.state.emit('world');
        if (!live) this.state.commit();
      } finally {
        this.selfUpdate = false;
      }
    };
    const num = (label: string, k: keyof WorldSettings, step: number, min?: number, max?: number) =>
      this.row(label, numberField({ value: w[k] as number, step, min, max, onChange: (v, live) => set(k, v as never, live) }));
    const col = (label: string, k: keyof WorldSettings) => this.row(label, ...this.colorInput(w[k] as string, (v, live) => set(k, v as never, live)));
    const bool = (label: string, k: keyof WorldSettings) => {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = !!w[k];
      cb.addEventListener('change', () => set(k, cb.checked as never, false));
      return this.row(label, cb);
    };
    const nameInput = h('input', { type: 'text', value: this.state.map.name, spellcheck: 'false' });
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (!v) return;
      this.state.map.name = v;
      this.state.commit();
      this.state.emit('meta');
    });
    this.body.append(
      this.section('Map', this.row('Name', nameInput)),
      this.section('Himmel & Umgebung', col('Hintergrund', 'background'), col('Himmelslicht', 'skyColor'), col('Bodenlicht', 'groundColor'), num('Umgebungslicht', 'hemiIntensity', 0.05, 0, 10), num('Belichtung', 'exposure', 0.05, 0.05, 5)),
      this.section(
        'Sonne',
        col('Farbe', 'sunColor'),
        num('Intensität', 'sunIntensity', 0.05, 0, 20),
        num('Richtung (°)', 'sunAzimuth', 1),
        num('Höhe (°)', 'sunElevation', 1, -90, 90),
        bool('Schatten', 'sunShadow'),
        num('Schattenbereich (m)', 'sunShadowArea', 1, 5, 200),
      ),
      this.section(
        'Nebel',
        col('Nebelfarbe', 'fogColor'),
        bool('Bodennebel-Schicht', 'groundFog'),
        num('Bodennebel Deckkraft', 'groundFogOpacity', 0.01, 0, 1),
        num('Bodennebel Höhe', 'groundFogHeight', 0.05),
        num('Bodennebel Größe', 'groundFogSize', 1, 1, 500),
        h('div', { class: 'script-summary' }, h('div', { class: 'events' }, 'Die Sichtweite des Distanznebels stellt der Spieler im Spiel ein (Mausrad / Grafik-Menü). Für lokalen Nebel: Volumetrik → Nebelvolumen.')),
      ),
    );
  }
}
