import * as Blockly from 'blockly';
import { BLOCKLY_THEME, SCREEN_SPRITE_TOOLBOX, SCREEN_STAGE_TOOLBOX, countEvents, generateCode, installBlocks } from '../scripting/blocks.ts';
import type { MapObjectData, ScreenData, ScreenSprite, ScriptData, SpriteShape } from '../world/mapFormat.ts';
import { normalizeScreen } from '../world/mapFormat.ts';
import { SHAPE_LABELS, STAGE_W, defaultScreen, drawStage, newSprite, spriteAt, stageHeight, stageView } from '../world/screen.ts';
import { ScreenRuntime } from '../scripting/screenRuntime.ts';
import { fmt, h, iconEl, numberField, toast } from './ui.ts';

// Bildschirm-Editor wie in Scratch: links Blöcke der ausgewählten Figur (oder der Bühne),
// rechts Bühnen-Vorschau (Figuren anklicken / verschieben), Eigenschaften und Figurenliste.

const PREVIEW_PX = 2;

export class ScreenEditor {
  private back: HTMLElement;
  private title: HTMLElement;
  private host: HTMLElement;
  private placeholder: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private propsEl: HTMLElement;
  private listEl: HTMLElement;
  private testBtn: HTMLButtonElement;
  private coordsEl: HTMLElement;
  private ws: Blockly.WorkspaceSvg | null = null;
  private target: MapObjectData | null = null;
  private data: ScreenData = defaultScreen();
  private stageH = 270;
  /** ausgewählte Figur (null = Bühne) */
  private current: string | null = null;
  private onApply: ((screen: ScreenData) => void) | null = null;
  private drag: { id: string; dx: number; dy: number; moved: boolean } | null = null;
  private test: { rt: ScreenRuntime; raf: number; last: number; keys: Set<string> } | null = null;

  constructor() {
    this.title = h('div', { class: 'title' });
    this.host = h('div', { class: 'script-blockly' });
    this.placeholder = h('div', { class: 'script-placeholder' });
    this.host.append(this.placeholder);

    this.canvas = h('canvas', { class: 'screen-stage' });
    this.ctx = this.canvas.getContext('2d')!;
    this.coordsEl = h('div', { class: 'screen-coords' }, 'x 0 · y 0');
    this.propsEl = h('div', { class: 'screen-props' });
    this.listEl = h('div', { class: 'screen-list' });

    this.testBtn = h('button', { class: 'btn primary', html: `${iconEl('play').outerHTML}Testen` });
    this.testBtn.addEventListener('click', () => (this.test ? this.stopTest() : this.startTest()));
    const cancel = h('button', { class: 'btn' }, 'Abbrechen');
    cancel.addEventListener('click', () => this.close(false));
    const apply = h('button', { class: 'btn primary' }, 'Übernehmen & Schließen');
    apply.addEventListener('click', () => this.close(true));

    const side = h(
      'div',
      { class: 'screen-side' },
      h('div', { class: 'screen-stage-wrap' }, this.canvas),
      h('div', { class: 'screen-stage-bar' }, this.testBtn, this.coordsEl),
      this.propsEl,
      this.listEl,
    );
    const win = h(
      'div',
      { class: 'script-window' },
      h('div', { class: 'script-bar' }, iconEl('monitor'), this.title, h('div', { class: 'tb-spacer' }), cancel, apply),
      h('div', { class: 'script-main' }, this.host, side),
    );
    this.back = h('div', { class: 'modal-back hidden' }, win);
    document.body.append(this.back);

    this.bindStage();
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (this.test) {
        if (e.key === 'Escape') {
          this.stopTest();
          e.preventDefault();
          return;
        }
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
          if (!e.repeat) this.test.rt.keyPressed(e.code);
          this.test.keys.add(e.code);
        }
        return;
      }
      if (e.key !== 'Escape') return;
      if (document.querySelector('.blocklyDropDownDiv[style*="display: block"], .blocklyWidgetDiv[style*="display: block"]')) return;
      this.close(true);
    });
    window.addEventListener('keyup', (e) => this.test?.keys.delete(e.code));
  }

  get isOpen(): boolean {
    return this.target !== null;
  }

  open(obj: MapObjectData, onApply: (screen: ScreenData) => void): void {
    installBlocks();
    this.target = obj;
    this.onApply = onApply;
    this.data = normalizeScreen(structuredClone(obj.screen ?? defaultScreen()));
    this.stageH = stageHeight(String(obj.props.aspect ?? '16:9'));
    this.canvas.width = STAGE_W * PREVIEW_PX;
    this.canvas.height = this.stageH * PREVIEW_PX;
    this.title.innerHTML = '';
    this.title.append(h('span', { class: 'tag' }, 'BILDSCHIRM'), obj.name);
    this.back.classList.remove('hidden');
    if (!this.ws) {
      this.ws = Blockly.inject(this.host, {
        toolbox: SCREEN_SPRITE_TOOLBOX,
        renderer: 'zelos',
        theme: BLOCKLY_THEME(),
        trashcan: true,
        sounds: false,
        grid: { spacing: 24, length: 2, colour: '#2a2a2a', snap: true },
        zoom: { controls: true, wheel: true, startScale: 0.75, maxScale: 2, minScale: 0.3, scaleSpeed: 1.15 },
        move: { scrollbars: true, drag: true, wheel: false },
      });
      this.ws.addChangeListener((e) => {
        if (e.isUiEvent || !this.ws) return;
        this.placeholder.classList.toggle('hidden', this.ws.getTopBlocks(false).length > 0);
      });
    }
    this.current = null;
    this.select(this.data.sprites[this.data.sprites.length - 1]?.id ?? null, false);
  }

  // ---------- Auswahl / Scripts ----------

  private sprite(id: string | null): ScreenSprite | undefined {
    return id ? this.data.sprites.find((s) => s.id === id) : undefined;
  }

  /** Blöcke des aktuellen Ziels in die Daten zurückschreiben. false = Syntaxfehler */
  private saveCurrent(): boolean {
    if (!this.ws) return true;
    const code = generateCode(this.ws);
    try {
      new Function('api', code);
    } catch (e) {
      toast(`Script-Fehler: ${(e as Error).message}`, 'error', 5000);
      return false;
    }
    const script: ScriptData | undefined = this.ws.getTopBlocks(false).length ? { blocks: Blockly.serialization.workspaces.save(this.ws), code } : undefined;
    const s = this.sprite(this.current);
    if (s) {
      if (script) s.script = script;
      else delete s.script;
    } else if (this.current === null) {
      if (script) this.data.stageScript = script;
      else delete this.data.stageScript;
    }
    return true;
  }

  private select(id: string | null, save = true): void {
    if (save && !this.saveCurrent()) return;
    if (id !== null && !this.sprite(id)) id = null;
    this.current = id;
    const ws = this.ws!;
    const s = this.sprite(id);
    ws.updateToolbox(s ? SCREEN_SPRITE_TOOLBOX : SCREEN_STAGE_TOOLBOX);
    ws.clear();
    const script = s ? s.script : this.data.stageScript;
    if (script?.blocks) {
      try {
        Blockly.serialization.workspaces.load(script.blocks as object, ws);
      } catch (e) {
        toast(`Script konnte nicht geladen werden: ${(e as Error).message}`, 'error');
      }
    }
    this.placeholder.innerHTML = s
      ? `Blöcke für <b>${escapeHtml(s.name)}</b><br>z. B. <b style="color:#ffbf00">„Wenn ich angeklickt werde“</b>`
      : 'Blöcke für die <b>Bühne</b><br>z. B. <b style="color:#ffbf00">„Wenn Spieler den Bildschirm benutzt“</b>';
    this.placeholder.classList.toggle('hidden', ws.getTopBlocks(false).length > 0);
    requestAnimationFrame(() => {
      Blockly.svgResize(ws);
      if (ws.getTopBlocks(false).length) ws.scrollCenter();
    });
    this.renderProps();
    this.renderList();
    this.draw();
  }

  // ---------- Bühne ----------

  private draw(): void {
    if (this.test) return;
    drawStage(this.ctx, stageView(this.data), this.stageH, PREVIEW_PX, { selected: this.current });
  }

  private stagePoint(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    return { x: (u - 0.5) * STAGE_W, y: (0.5 - v) * this.stageH };
  }

  private bindStage(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const pt = this.stagePoint(e);
      if (this.test) {
        this.test.rt.setCursor(pt.x, pt.y);
        this.test.rt.pointerDown();
        c.setPointerCapture(e.pointerId);
        return;
      }
      const hit = spriteAt(stageView(this.data), pt.x, pt.y);
      if (hit) {
        if (hit.id !== this.current) this.select(hit.id);
        if (this.current !== hit.id) return;
        this.drag = { id: hit.id, dx: hit.x - pt.x, dy: hit.y - pt.y, moved: false };
        c.setPointerCapture(e.pointerId);
      } else if (this.current !== null) this.select(null);
    });
    c.addEventListener('pointermove', (e) => {
      const pt = this.stagePoint(e);
      this.coordsEl.textContent = `x ${Math.round(pt.x)} · y ${Math.round(pt.y)}`;
      if (this.test) {
        this.test.rt.setCursor(pt.x, pt.y);
        return;
      }
      if (!this.drag) return;
      const s = this.sprite(this.drag.id);
      if (!s) return;
      const snap = e.shiftKey ? 10 : 1;
      s.x = Math.round((pt.x + this.drag.dx) / snap) * snap;
      s.y = Math.round((pt.y + this.drag.dy) / snap) * snap;
      this.drag.moved = true;
      this.draw();
    });
    const up = () => {
      if (this.test) {
        this.test.rt.pointerUp();
        return;
      }
      if (this.drag?.moved) this.renderProps();
      this.drag = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => {
      if (this.test && !this.test.rt.mouseIsDown) this.test.rt.clearCursor();
    });
  }

  // ---------- Testen ----------

  private startTest(): void {
    if (!this.saveCurrent()) return;
    this.drag = null;
    const keys = new Set<string>();
    let rt: ScreenRuntime;
    rt = new ScreenRuntime(structuredClone(this.data), this.stageH, {
      broadcast: (msg) => rt.receive(msg),
      showMessage: (text, s) => toast(text, 'info', Math.max(800, s * 1000)),
      keyDown: (code) => keys.has(code),
      objShow: (name, show) => toast(`(Welt) Objekt „${name}“ ${show ? 'zeigen' : 'verstecken'}`),
      teleportPlayer: (x, y, z) => toast(`(Welt) Spieler teleportieren nach ${fmt(x)} / ${fmt(y)} / ${fmt(z)}`),
      setWeather: (type) => toast(`(Welt) Wetter: ${type}`),
      log: (msg, err) => (err ? toast(msg, 'error', 5000) : console.log('[Bildschirm]', msg)),
      exit: () => toast('Spieler verlässt den Bildschirm'),
    }, this.target?.name ?? 'Bildschirm');
    rt.showCursor = false;
    const loop = (now: number) => {
      if (!this.test) return;
      const dt = Math.min(0.1, (now - this.test.last) / 1000);
      this.test.last = now;
      rt.update(dt);
      rt.draw(this.ctx, PREVIEW_PX);
      this.test.raf = requestAnimationFrame(loop);
    };
    this.test = { rt, raf: 0, last: performance.now(), keys };
    rt.start();
    rt.enter();
    this.test.raf = requestAnimationFrame(loop);
    this.testBtn.innerHTML = `${iconEl('stop').outerHTML}Stopp`;
    this.testBtn.classList.add('danger');
    this.canvas.classList.add('testing');
  }

  private stopTest(): void {
    if (!this.test) return;
    cancelAnimationFrame(this.test.raf);
    this.test.rt.exit();
    this.test.rt.stop();
    this.test = null;
    this.testBtn.innerHTML = `${iconEl('play').outerHTML}Testen`;
    this.testBtn.classList.remove('danger');
    this.canvas.classList.remove('testing');
    this.draw();
  }

  // ---------- Eigenschaften ----------

  private renderProps(): void {
    const el = this.propsEl;
    el.innerHTML = '';
    const s = this.sprite(this.current);
    const row = (label: string, ...ctrl: (Node | string)[]) => h('div', { class: 'screen-row' }, h('label', {}, label), h('div', { class: 'ctrl' }, ...ctrl));
    const color = (value: string, set: (v: string) => void) => {
      const input = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000' });
      input.addEventListener('input', () => {
        set(input.value);
        this.draw();
        if (!s) this.renderList();
      });
      return input;
    };
    const num = (value: number, set: (v: number) => void, step = 1, min?: number, max?: number) =>
      numberField({
        value,
        step,
        min,
        max,
        onChange: (v) => {
          set(v);
          this.draw();
        },
      });

    if (!s) {
      el.append(h('div', { class: 'screen-props-head' }, 'Bühne'), row('Hintergrund', color(this.data.background, (v) => (this.data.background = v))));
      el.append(h('div', { class: 'screen-hint' }, `Bühne ${STAGE_W} × ${this.stageH} · Mitte = 0/0 · y zeigt nach oben`));
      return;
    }
    const name = h('input', { type: 'text', value: s.name, spellcheck: 'false' });
    name.addEventListener('change', () => {
      const v = name.value.trim() || s.name;
      s.name = v;
      name.value = v;
      this.renderList();
    });
    const shape = h('select');
    for (const [k, label] of Object.entries(SHAPE_LABELS)) shape.append(h('option', { value: k, selected: k === s.shape }, label));
    shape.addEventListener('change', () => {
      s.shape = shape.value as SpriteShape;
      this.draw();
      this.renderList();
    });
    const text = h('textarea', { rows: 2, spellcheck: 'false' });
    text.value = s.text;
    text.addEventListener('input', () => {
      s.text = text.value;
      this.draw();
    });
    const visible = h('input', { type: 'checkbox', checked: s.visible });
    visible.addEventListener('change', () => {
      s.visible = visible.checked;
      this.draw();
    });
    const dup = h('button', { class: 'btn' }, 'Duplizieren');
    dup.addEventListener('click', () => {
      if (!this.saveCurrent()) return;
      const copy: ScreenSprite = { ...structuredClone(s), id: newSprite('rect', 0).id, name: uniqueName(this.data, s.name), x: s.x + 20, y: s.y - 20 };
      this.data.sprites.push(copy);
      this.select(copy.id, false);
    });
    const del = h('button', { class: 'btn danger', html: `${iconEl('trash').outerHTML}Löschen` });
    del.addEventListener('click', () => {
      this.data.sprites = this.data.sprites.filter((x) => x.id !== s.id);
      this.current = null;
      this.select(null, false);
    });
    el.append(
      h('div', { class: 'screen-props-head' }, 'Figur', h('div', { class: 'tb-spacer' }), dup, del),
      row('Name', name),
      row('Form', shape),
      row('Position', h('span', { class: 'lbl' }, 'x'), num(s.x, (v) => (s.x = v)), h('span', { class: 'lbl' }, 'y'), num(s.y, (v) => (s.y = v))),
      row('Größe', h('span', { class: 'lbl' }, 'B'), num(s.w, (v) => (s.w = v), 1, 1), h('span', { class: 'lbl' }, 'H'), num(s.h, (v) => (s.h = v), 1, 1)),
      row('Drehung', num(s.rot, (v) => (s.rot = v), 1)),
      row('Farbe', color(s.color, (v) => (s.color = v))),
      row('Text', text),
      row('Textfarbe', color(s.textColor, (v) => (s.textColor = v)), h('span', { class: 'lbl' }, 'Größe'), num(s.fontSize, (v) => (s.fontSize = v), 1, 4, 200)),
      row('Sichtbar', visible),
    );
  }

  // ---------- Figurenliste ----------

  private renderList(): void {
    const el = this.listEl;
    el.innerHTML = '';
    const tile = (id: string | null, label: string, sub: string, swatch: string, hasScript: boolean) => {
      const t = h(
        'div',
        { class: `screen-tile${this.current === id ? ' active' : ''}` },
        h('div', { class: 'swatch', style: `background:${swatch}` }),
        h('div', { class: 'name' }, label),
        h('div', { class: 'sub' }, sub),
      );
      if (hasScript) t.append(h('div', { class: 'badge', title: 'Hat ein Script' }, iconEl('script')));
      t.addEventListener('click', () => {
        if (this.current !== id) this.select(id);
      });
      return t;
    };
    el.append(tile(null, 'Bühne', 'Hintergrund', this.data.background, !!this.data.stageScript));
    for (const s of this.data.sprites) {
      const events = s.script ? countEvents(s.script.blocks) : 0;
      el.append(tile(s.id, s.name, SHAPE_LABELS[s.shape], s.shape === 'text' ? s.textColor : s.color, events > 0));
    }
    const add = h('div', { class: 'screen-tile add' }, h('div', { class: 'plus' }, iconEl('plus')), h('div', { class: 'name' }, 'Figur'));
    const menu = h('div', { class: 'screen-add-menu hidden' });
    for (const [k, label] of Object.entries(SHAPE_LABELS)) {
      const b = h('button', { class: 'btn' }, label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.saveCurrent()) return;
        const sp = newSprite(k as SpriteShape, this.data.sprites.length + 1);
        sp.name = uniqueName(this.data, sp.name.replace(/\d+$/, ''));
        this.data.sprites.push(sp);
        this.select(sp.id, false);
      });
      menu.append(b);
    }
    add.addEventListener('click', () => menu.classList.toggle('hidden'));
    add.append(menu);
    el.append(add);
  }

  private close(apply: boolean): void {
    if (!this.target || !this.ws) return;
    this.stopTest();
    if (apply) {
      if (!this.saveCurrent()) return;
      this.onApply?.(this.data);
    }
    Blockly.hideChaff();
    this.target = null;
    this.onApply = null;
    this.back.classList.add('hidden');
  }
}

function uniqueName(data: ScreenData, base: string): string {
  const stem = base.replace(/\d+$/, '') || 'Figur';
  const names = new Set(data.sprites.map((s) => s.name));
  for (let i = 1; ; i++) if (!names.has(`${stem}${i}`)) return `${stem}${i}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
