import type { EditorState } from './state.ts';
import { ASSETS, type PropDef } from '../world/assets.ts';
import type { MapObjectData, PropValue, Vec3, WorldSettings } from '../world/mapFormat.ts';
import { WEATHER_OPTIONS } from '../world/weather.ts';
import { WEATHER_TYPE, findWeather, windAngle, windRotation, quatFromRot as windQuat } from '../world/weatherObject.ts';
import { defaultColorFor } from '../world/materials.ts';
import { modelLabel } from '../world/modelStore.ts';
import { countEvents } from '../scripting/blocks.ts';
import { TYPE_ICONS, icon } from './icons.ts';
import { fmt, h, numberField, pickFile, toast } from './ui.ts';
import { models } from './models.ts';
import { actionButton } from './assetAction.ts';
import { SUN_TYPE, findSun, quatFromRot, sunAngles, sunRotation, writeSunToObject } from '../world/sun.ts';

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
  onEditScreen?: (id: string) => void;
  onSunFromCamera?: () => void;
  onCreateWeather?: () => void;
  private windInput?: HTMLInputElement;
  onCreateSun?: () => void;
  private sunInputs: { azimuth?: HTMLInputElement; elevation?: HTMLInputElement } = {};

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
    this.sunInputs = {};
    this.windInput = undefined;
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
        vecRow('Rotation', 'rot', 1, !!def?.fixedRotation),
        vecRow(def?.rebuildOnScale ? 'Größe (m)' : 'Skalierung', 'scale', 0.05, !!def?.fixedScale),
      ),
    );
    if (o.type === SUN_TYPE) this.body.append(this.sunSection(o));
    if (o.type === WEATHER_TYPE) this.body.append(this.windSection(o));

    // Eigenschaften nach Gruppen
    const groups = new Map<string, PropDef[]>();
    for (const p of def?.props ?? []) {
      if (p.hidden) continue;
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

    // Programmierbarer Bildschirm
    if (o.type === 'screen') {
      const sprites = o.screen?.sprites ?? [];
      const scripted = sprites.filter((s) => s.script).length + (o.screen?.stageScript ? 1 : 0);
      const btn = h('button', { class: 'btn script', html: `${icon('monitor')}Bildschirm programmieren` });
      btn.addEventListener('click', () => this.onEditScreen?.(o.id));
      this.body.append(
        this.section(
          'Bildschirm-Inhalt',
          h('div', { class: 'script-summary' }, h('div', { class: 'events' }, `${sprites.length} Figur${sprites.length === 1 ? '' : 'en'} · ${scripted} mit Blöcken`), btn),
        ),
      );
    }

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
      case 'action':
        return this.row('', actionButton(o, p));
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
    if (o.type === SUN_TYPE) {
      const a = sunAngles(quatFromRot(o.rot));
      const { azimuth, elevation } = this.sunInputs;
      if (azimuth && document.activeElement !== azimuth) azimuth.value = fmt(a.azimuth);
      if (elevation && document.activeElement !== elevation) elevation.value = fmt(a.elevation);
    }
    if (o.type === WEATHER_TYPE && this.windInput && document.activeElement !== this.windInput) {
      this.windInput.value = fmt(windAngle(windQuat(o.rot)));
    }
  }

  /** Sonnenstand als Richtung/Höhe statt Euler-Winkel (setzt die Drehung des Objekts) */
  private sunSection(o: MapObjectData): HTMLElement {
    const a = sunAngles(quatFromRot(o.rot));
    const field = (key: 'azimuth' | 'elevation', min?: number, max?: number) => {
      const f = numberField({
        value: a[key],
        step: 1,
        min,
        max,
        onChange: (v, live) =>
          this.change(() => {
            const cur = sunAngles(quatFromRot(o.rot));
            cur[key] = v;
            o.rot = sunRotation(cur.azimuth, cur.elevation);
            this.refreshTransform();
          }, live),
      });
      this.sunInputs[key] = f.querySelector('input')!;
      return f;
    };
    return this.section(
      'Sonnenstand',
      this.row('Richtung (°)', field('azimuth')),
      this.row('Höhe (°)', field('elevation', -89.5, 89.5)),
      h('div', { class: 'script-summary' }, h('div', { class: 'events' }, 'Drehen (E) bewegt die Sonne, der Pfeil zeigt die Lichtrichtung. Position egal. Strg+L + Maus dreht sie direkt im Viewport.')),
    );
  }

  /** Windrichtung als Winkel statt Euler-Winkel (setzt die Drehung des Wetter-Objekts) */
  private windSection(o: MapObjectData): HTMLElement {
    const f = numberField({
      value: windAngle(windQuat(o.rot)),
      step: 5,
      onChange: (v, live) =>
        this.change(() => {
          o.rot = windRotation(v);
          this.refreshTransform();
        }, live),
    });
    this.windInput = f.querySelector('input')!;
    return this.section(
      'Wind',
      this.row('Windrichtung (°)', f),
      h('div', { class: 'script-summary' }, h('div', { class: 'events' }, 'Drehen (E) ändert die Windrichtung, der Pfeil zeigt, wohin der Wind weht. Position egal. Bei Regen wird der Boden mit der Zeit nass, dann bilden sich Pfützen; unter Dächern bleibt es trocken.')),
    );
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
      cb.addEventListener('change', () => {
        set(k, cb.checked as never, false);
        this.render(); // abhängige Felder ein-/ausblenden
      });
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
    const sunBtn = h('button', { class: 'btn', title: 'Sonne dorthin setzen, wohin die Viewport-Kamera blickt', html: `${icon('sun')}Aus Kamerablick` });
    sunBtn.addEventListener('click', () => this.onSunFromCamera?.());
    const sunObj = findSun(this.state.map.objects);
    const selectSunBtn = h('button', { class: 'btn', html: `${icon('sun')}Auswählen` });
    selectSunBtn.addEventListener('click', () => {
      if (!sunObj) return;
      this.state.select([sunObj.id]);
      this.setTab('details');
    });
    const createSunBtn = h('button', { class: 'btn', title: 'Sonnen-Objekt anlegen (wie Directional Light in UE5): drehen = Sonnenstand', html: `${icon('sun')}Sonnen-Objekt anlegen` });
    createSunBtn.addEventListener('click', () => this.onCreateSun?.());
    const weatherSel = h(
      'select',
      {},
      ...WEATHER_OPTIONS.map((o) => h('option', { value: o.value, selected: o.value === w.weather }, o.label)),
    ) as HTMLSelectElement;
    weatherSel.addEventListener('change', () => set('weather', weatherSel.value as never, false));
    const weatherObj = findWeather(this.state.map.objects);
    const selectWeatherBtn = h('button', { class: 'btn', html: `${icon('cloud')}Auswählen` });
    selectWeatherBtn.addEventListener('click', () => {
      if (!weatherObj) return;
      this.state.select([weatherObj.id]);
      this.setTab('details');
    });
    const createWeatherBtn = h('button', { class: 'btn', title: 'Wetter-Objekt anlegen (wie die Sonne): drehen = Windrichtung', html: `${icon('cloud')}Wetter-Objekt anlegen` });
    createWeatherBtn.addEventListener('click', () => this.onCreateWeather?.());
    this.body.append(
      this.section('Map', this.row('Name', nameInput)),
      this.section(
        'Physik',
        bool('Boden bei y = 0', 'groundPlane'),
        h('div', { class: 'script-summary' }, h('div', { class: 'events' }, 'Unsichtbarer, unendlicher Kollisionsboden. Für Maps mit Landscape oder Löchern im Boden ausschalten.')),
      ),
      this.section('Stimmung', this.presetRow()),
      this.section(
        'Himmel & Umgebung',
        bool('Himmel anzeigen', 'sky'),
        w.sky ? col('Himmel oben', 'skyZenith') : null,
        w.sky ? col('Horizont', 'skyHorizon') : null,
        w.sky ? null : col('Hintergrund', 'background'),
        col('Himmelslicht', 'skyColor'),
        col('Bodenlicht', 'groundColor'),
        num('Umgebungslicht', 'hemiIntensity', 0.05, 0, 10),
        num('Belichtung', 'exposure', 0.05, 0.05, 5),
      ),
      sunObj
        ? this.section(
            'Sonne',
            h('div', { class: 'script-summary' }, h('div', { class: 'events' }, `Die Sonne wird vom Objekt „${sunObj.name}“ gesteuert: drehen = Sonnenstand, Details = Farbe, Intensität, Scheibe, Schatten.`)),
            this.row('Objekt', selectSunBtn, sunBtn),
          )
        : this.section(
            'Sonne',
            col('Farbe', 'sunColor'),
            num('Intensität', 'sunIntensity', 0.05, 0, 20),
            num('Richtung (°)', 'sunAzimuth', 1),
            num('Höhe (°)', 'sunElevation', 1, -90, 90),
            this.row('Ausrichten', sunBtn),
            bool('Sonnenscheibe', 'sunDisc'),
            w.sunDisc ? num('Scheibengröße (°)', 'sunSize', 0.1, 0.2, 20) : null,
            num('Leuchten', 'sunGlow', 0.05, 0, 3),
            bool('Schatten', 'sunShadow'),
            num('Schattendistanz (m)', 'sunShadowDistance', 5, 10, 2000),
            this.row('Als Objekt', createSunBtn),
            h('div', { class: 'script-summary' }, h('div', { class: 'events' }, 'Tipp: Strg+L halten und Maus bewegen, um die Sonne im Viewport zu drehen.')),
          ),
      this.section(
        'Nebel',
        col('Nebelfarbe', 'fogColor'),
        num('Sichtweite (m)', 'viewDistance', 10, 20, 10000),
        bool('Bodennebel-Schicht', 'groundFog'),
        num('Bodennebel Deckkraft', 'groundFogOpacity', 0.01, 0, 1),
        num('Bodennebel Dicke (m)', 'groundFogHeight', 0.05),
        h('div', { class: 'script-summary' }, h('div', { class: 'events' }, 'Sichtweite = Distanznebel bei voller Spieler-Einstellung (Mausrad / Grafik-Menü skaliert sie). Große Landschaften: mehrere hundert Meter bis km. Bodennebel liegt als Höhennebel-Schicht über der ganzen Map (ab y = 0, nach oben dünner). Für lokalen Nebel: Volumetrik → Nebelvolumen.')),
      ),
      weatherObj
        ? this.section(
            'Wetter',
            h('div', { class: 'script-summary' }, h('div', { class: 'events' }, `Das Wetter wird vom Objekt „${weatherObj.name}“ gesteuert: drehen = Windrichtung, Details = Wettertyp, Stärke, Nässe, Pfützen, Schnee.`)),
            this.row('Objekt', selectWeatherBtn),
          )
        : this.section(
            'Wetter',
            this.row('Als Objekt', createWeatherBtn),
            this.row('Wetter', weatherSel),
            num('Stärke', 'weatherIntensity', 0.05, 0, 2),
            num('Windrichtung (°)', 'windDirection', 5),
            num('Windstärke (m/s)', 'windStrength', 0.1, 0, 15),
            num('Anfangsnässe', 'wetness', 0.05, 0, 1),
            num('Pfützen', 'puddles', 0.05, 0, 1),
            num('Anfangs-Schnee', 'snowCover', 0.05, 0, 1),
            num('Zeitfaktor', 'weatherTimeScale', 0.1, 0, 20),
            h(
              'div',
              { class: 'script-summary' },
              h('div', { class: 'events' }, 'Bei Regen wird der Boden mit der Zeit nass, danach bilden sich Pfützen mit Spiegelungen; ohne Regen trocknet alles langsam ab. Unter Dächern bleibt es trocken. Zeitfaktor 0 = Nässe/Schnee eingefroren (Anfangswerte bleiben). Scripts: Welt → „setze Wetter“.'),
            ),
          ),
    );
  }

  /** Schnellauswahl für Himmel, Sonne, Licht und Nebel */
  private presetRow(): HTMLElement {
    const wrap = h('div', { class: 'preset-row' });
    for (const [name, p] of Object.entries(WORLD_PRESETS)) {
      const b = h('button', { class: 'btn preset', title: `Stimmung „${name}“ übernehmen` });
      b.style.setProperty('--sky-top', p.skyZenith);
      b.style.setProperty('--sky-bottom', p.skyHorizon);
      b.style.setProperty('--sun', p.sunColor);
      b.append(h('span', { class: 'swatch' }), h('span', {}, name));
      b.addEventListener('click', () => {
        Object.assign(this.state.map.world, p, { sky: true, background: p.fogColor ?? p.skyHorizon });
        const sun = findSun(this.state.map.objects);
        if (sun) {
          writeSunToObject(this.state.map.world, sun);
          this.state.emit('scene');
        }
        this.state.emit('world');
        this.state.commit();
      });
      wrap.append(b);
    }
    return wrap;
  }
}

const WORLD_PRESETS: Record<string, Partial<WorldSettings> & { skyZenith: string; skyHorizon: string; sunColor: string }> = {
  Bewölkt: {
    skyZenith: '#2c3846', skyHorizon: '#66717d', fogColor: '#353b42', skyColor: '#7d8a99', groundColor: '#1c1915',
    hemiIntensity: 0.55, sunColor: '#aebdd0', sunIntensity: 0.9, sunElevation: 53, sunSize: 2.5, sunGlow: 0.5, sunDisc: true, exposure: 1,
  },
  Tag: {
    skyZenith: '#2f6fc0', skyHorizon: '#b9d3ea', fogColor: '#9fb6c9', skyColor: '#a9c8ea', groundColor: '#3a3226',
    hemiIntensity: 0.8, sunColor: '#fff2dc', sunIntensity: 2.6, sunElevation: 55, sunSize: 1.8, sunGlow: 0.7, sunDisc: true, exposure: 1,
  },
  Abend: {
    skyZenith: '#27304f', skyHorizon: '#e08a4f', fogColor: '#6b5049', skyColor: '#8a7d99', groundColor: '#22160f',
    hemiIntensity: 0.5, sunColor: '#ffad66', sunIntensity: 2, sunElevation: 6, sunSize: 3.2, sunGlow: 1.3, sunDisc: true, exposure: 1.05,
  },
  Nacht: {
    skyZenith: '#03060d', skyHorizon: '#141c29', fogColor: '#0d1118', skyColor: '#2b3a55', groundColor: '#070605',
    hemiIntensity: 0.2, sunColor: '#b8c8ff', sunIntensity: 0.25, sunElevation: 35, sunSize: 1.6, sunGlow: 0.4, sunDisc: true, exposure: 1,
  },
};
