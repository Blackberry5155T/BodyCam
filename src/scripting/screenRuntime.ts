import type { ScreenData, SpriteShape } from '../world/mapFormat.ts';
import { SHAPE_LABELS, spriteAt, spriteContains, stageView, drawStage, STAGE_W, type SpriteView, type StageView } from '../world/screen.ts';

// Script-Runtime eines programmierbaren Bildschirms (Scratch-artig): Bühne + Figuren mit eigenen Scripts.
// Wie runtime.ts: Blöcke → JavaScript gegen eine api pro Figur; Schleifen geben pro Durchlauf einen Frame ab.
// Bewusst ohne three.js, damit dieselbe Runtime im Bildschirm-Editor (Vorschau), in der Simulation und im Spiel läuft.

export type ScreenEvent = 'start' | 'tick' | 'click' | 'hover' | 'unhover' | 'use' | 'exit' | 'key' | 'message';

export interface ScreenHost {
  /** Nachricht an alle (Map-Objekte und Bildschirme). Die eigene Runtime bekommt sie über receive() zurück. */
  broadcast(msg: string): void;
  showMessage(text: string, seconds: number): void;
  keyDown(code: string): boolean;
  teleportPlayer?(x: number, y: number, z: number): void;
  objShow?(name: string, show: boolean): void;
  setWeather?(type: string, intensity: number): void;
  log?(msg: string, isError: boolean): void;
  /** Spieler soll den Bildschirm verlassen */
  exit?(): void;
}

interface Handler {
  event: ScreenEvent;
  fn: () => Promise<void>;
  arg?: string | number;
  running: number;
}

interface Target {
  name: string;
  sprite: SpriteView | null;
  handlers: Handler[];
}

interface Glide {
  sprite: SpriteView;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  start: number;
  duration: number;
  resolve: () => void;
}

class StopScript extends Error {}

const SHAPES = Object.keys(SHAPE_LABELS) as SpriteShape[];

export class ScreenRuntime {
  time = 0;
  readonly stage: StageView;
  /** Mauszeiger in Bühnen-Koordinaten (null = kein Zeiger auf dem Bildschirm) */
  cursor: { x: number; y: number } | null = null;
  showCursor = true;
  /** Spieler benutzt den Bildschirm gerade */
  used = false;
  private mouseDown = false;
  private pressed: string | null = null;
  private hover: SpriteView | null = null;
  private targets: Target[] = [];
  private frameWaiters: (() => void)[] = [];
  private timers: { until: number; resolve: () => void }[] = [];
  private glides: Glide[] = [];
  private running = false;

  constructor(
    data: ScreenData,
    readonly stageH: number,
    private host: ScreenHost,
    private label = 'Bildschirm',
  ) {
    this.stage = stageView(data);
    this.compile('Bühne', null, data.stageScript?.code);
    data.sprites.forEach((s, i) => this.compile(s.name, this.stage.sprites[i], s.script?.code));
  }

  get mouseIsDown(): boolean {
    return this.mouseDown;
  }

  get hasScripts(): boolean {
    return this.targets.length > 0;
  }

  start(): void {
    this.running = true;
    this.fireAll('start');
  }

  stop(): void {
    this.running = false;
    this.frameWaiters = [];
    this.timers = [];
    this.glides = [];
  }

  update(dt: number): void {
    if (!this.running) return;
    this.time += dt;
    const t = this.time;

    for (let i = this.glides.length - 1; i >= 0; i--) {
      const g = this.glides[i];
      const k = g.duration <= 0 ? 1 : Math.min(1, (t - g.start) / g.duration);
      const e = k * k * (3 - 2 * k);
      g.sprite.x = g.fx + (g.tx - g.fx) * e;
      g.sprite.y = g.fy + (g.ty - g.fy) * e;
      if (k >= 1) {
        this.glides.splice(i, 1);
        g.resolve();
      }
    }

    const frames = this.frameWaiters;
    this.frameWaiters = [];
    for (const r of frames) r();
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].until <= t) {
        const w = this.timers[i];
        this.timers.splice(i, 1);
        w.resolve();
      }
    }

    for (const tg of this.targets) for (const h of tg.handlers) if (h.event === 'tick' && h.running === 0) this.run(tg, h);

    // Mauszeiger über Figuren
    const over = this.cursor ? spriteAt(this.stage, this.cursor.x, this.cursor.y) : null;
    if (over !== this.hover) {
      const old = this.hover;
      this.hover = over;
      if (old) this.fireSprite(old, 'unhover');
      if (over) this.fireSprite(over, 'hover');
    }
  }

  /** Bühne zeichnen; px = Pixel pro Bühnen-Einheit */
  draw(c: CanvasRenderingContext2D, px: number): void {
    drawStage(c, this.stage, this.stageH, px, {
      hover: this.hover?.id ?? null,
      pressed: this.pressed,
      cursor: this.showCursor ? this.cursor : null,
    });
  }

  // ---------- Eingaben ----------

  setCursor(x: number, y: number): void {
    const hw = STAGE_W / 2;
    const hh = this.stageH / 2;
    this.cursor = { x: Math.max(-hw, Math.min(hw, x)), y: Math.max(-hh, Math.min(hh, y)) };
  }

  /** Bildschirm-Koordinaten als UV (0..1, v nach oben) */
  setCursorUV(u: number, v: number): void {
    this.setCursor((u - 0.5) * STAGE_W, (v - 0.5) * this.stageH);
  }

  moveCursor(dx: number, dy: number): void {
    const c = this.cursor ?? { x: 0, y: 0 };
    this.setCursor(c.x + dx, c.y - dy);
  }

  clearCursor(): void {
    this.cursor = null;
    this.pointerUp();
  }

  pointerDown(): void {
    if (!this.cursor) return;
    this.mouseDown = true;
    const s = spriteAt(this.stage, this.cursor.x, this.cursor.y);
    this.pressed = s?.id ?? null;
    if (s) this.fireSprite(s, 'click');
    else {
      const stage = this.targets.find((t) => !t.sprite);
      if (stage) this.fire(stage, 'click');
    }
  }

  pointerUp(): void {
    this.mouseDown = false;
    this.pressed = null;
  }

  enter(): void {
    this.used = true;
    if (!this.cursor) this.cursor = { x: 0, y: 0 };
    this.fireAll('use');
  }

  exit(): void {
    if (!this.used) return;
    this.used = false;
    this.pointerUp();
    this.fireAll('exit');
  }

  keyPressed(code: string): void {
    for (const t of this.targets) for (const h of t.handlers) if (h.event === 'key' && h.arg === code) this.run(t, h);
  }

  /** Nachricht (von irgendwo) empfangen */
  receive(msg: string): void {
    for (const t of this.targets) for (const h of t.handlers) if (h.event === 'message' && h.arg === msg) this.run(t, h);
  }

  // ---------- intern ----------

  private compile(name: string, sprite: SpriteView | null, code: string | undefined): void {
    if (!code?.trim()) return;
    const target: Target = { name, sprite, handlers: [] };
    try {
      new Function('api', `"use strict";\n${code}`)(this.makeApi(target));
    } catch (e) {
      this.report(target, e);
      return;
    }
    if (target.handlers.length) this.targets.push(target);
  }

  private fireAll(event: ScreenEvent): void {
    for (const t of this.targets) this.fire(t, event);
  }

  private fireSprite(s: SpriteView, event: ScreenEvent): void {
    const t = this.targets.find((x) => x.sprite === s);
    if (t) this.fire(t, event);
  }

  private fire(t: Target, event: ScreenEvent): void {
    for (const h of t.handlers) if (h.event === event) this.run(t, h);
  }

  private run(t: Target, h: Handler): void {
    if (!this.running) return;
    h.running++;
    h.fn()
      .catch((e) => {
        if (!(e instanceof StopScript)) this.report(t, e);
      })
      .finally(() => h.running--);
  }

  private report(t: Target, e: unknown): void {
    const msg = `Script-Fehler in „${this.label}“ › ${t.name}: ${e instanceof Error ? e.message : String(e)}`;
    console.warn(msg, e);
    this.host.log?.(msg, true);
  }

  private frame(): Promise<void> {
    if (!this.running) return new Promise(() => {});
    return new Promise((r) => this.frameWaiters.push(r));
  }

  private wait(sec: number): Promise<void> {
    if (!this.running) return new Promise(() => {});
    return new Promise((resolve) => this.timers.push({ until: this.time + Math.max(0, sec), resolve }));
  }

  private glide(s: SpriteView, x: number, y: number, sec: number): Promise<void> {
    this.glides = this.glides.filter((g) => {
      if (g.sprite !== s) return true;
      g.resolve();
      return false;
    });
    return new Promise((resolve) => this.glides.push({ sprite: s, fx: s.x, fy: s.y, tx: x, ty: y, start: this.time, duration: sec, resolve }));
  }

  private makeApi(t: Target) {
    const s = t.sprite;
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
    const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    const other = (name: unknown) => this.stage.sprites.find((x) => x.name === String(name)) ?? null;
    let sayToken = 0;

    return {
      on: (event: ScreenEvent, fn: () => Promise<void>, arg?: string | number) => {
        t.handlers.push({ event, fn, arg, running: 0 });
      },
      frame: () => this.frame(),
      wait: (sec: unknown) => this.wait(num(sec)),
      stop: () => {
        throw new StopScript();
      },
      // Bewegung (2D)
      goTo: (x: unknown, y: unknown) => {
        if (s) [s.x, s.y] = [num(x), num(y)];
      },
      goToMouse: () => {
        if (s && this.cursor) [s.x, s.y] = [this.cursor.x, this.cursor.y];
      },
      changeX: (v: unknown) => s && (s.x += num(v)),
      changeY: (v: unknown) => s && (s.y += num(v)),
      setX: (v: unknown) => s && (s.x = num(v)),
      setY: (v: unknown) => s && (s.y = num(v)),
      glide: (x: unknown, y: unknown, sec: unknown) => (s ? this.glide(s, num(x), num(y), num(sec)) : this.wait(num(sec))),
      turn: (v: unknown) => s && (s.rot += num(v)),
      setRot: (v: unknown) => s && (s.rot = num(v)),
      x: () => s?.x ?? 0,
      y: () => s?.y ?? 0,
      rot: () => s?.rot ?? 0,
      // Aussehen
      show: () => s && (s.visible = true),
      hide: () => s && (s.visible = false),
      setText: (v: unknown) => s && (s.text = str(v)),
      setColor: (c: unknown) => s && (s.color = str(c)),
      setTextColor: (c: unknown) => s && (s.textColor = str(c)),
      setFontSize: (v: unknown) => s && (s.fontSize = Math.max(4, num(v))),
      setScale: (v: unknown) => s && (s.scale = Math.max(0, num(v))),
      changeScale: (v: unknown) => s && (s.scale = Math.max(0, s.scale + num(v))),
      setSize: (w: unknown, h: unknown) => s && ([s.w, s.h] = [Math.max(0, num(w)), Math.max(0, num(h))]),
      setGhost: (v: unknown) => s && (s.ghost = Math.max(0, Math.min(100, num(v)))),
      setShape: (v: unknown) => {
        if (s && SHAPES.includes(v as SpriteShape)) s.shape = v as SpriteShape;
      },
      front: () => {
        if (!s) return;
        const list = this.stage.sprites;
        list.splice(list.indexOf(s), 1);
        list.push(s);
      },
      say: (v: unknown) => {
        if (s) {
          sayToken++;
          s.say = str(v);
        }
      },
      sayFor: async (v: unknown, sec: unknown) => {
        if (!s) return this.wait(num(sec));
        const token = ++sayToken;
        s.say = str(v);
        await this.wait(num(sec));
        if (token === sayToken) s.say = '';
      },
      text: () => s?.text ?? '',
      scale: () => s?.scale ?? 100,
      setBackground: (c: unknown) => (this.stage.background = str(c)),
      // Fühlen
      mouseX: () => Math.round(this.cursor?.x ?? 0),
      mouseY: () => Math.round(this.cursor?.y ?? 0),
      mouseDown: () => this.mouseDown,
      touchingMouse: () => !!(s && this.cursor && spriteContains(s, this.cursor.x, this.cursor.y)),
      screenUsed: () => this.used,
      spriteProp: (name: unknown, prop: unknown) => {
        const o = other(name);
        if (!o) return 0;
        switch (prop) {
          case 'x':
            return o.x;
          case 'y':
            return o.y;
          case 'rot':
            return o.rot;
          case 'scale':
            return o.scale;
          case 'text':
            return o.text;
          case 'visible':
            return o.visible;
        }
        return 0;
      },
      keyDown: (code: string) => this.host.keyDown(code),
      time: () => this.time,
      // Welt
      broadcast: (msg: unknown) => this.host.broadcast(str(msg)),
      showText: (text: unknown, sec: unknown) => this.host.showMessage(str(text), num(sec)),
      teleportPlayer: (x: unknown, y: unknown, z: unknown) => this.host.teleportPlayer?.(num(x), num(y), num(z)),
      objShow: (name: unknown, show: boolean) => this.host.objShow?.(str(name), !!show),
      setWeather: (type: unknown, intensity: unknown) => this.host.setWeather?.(str(type), num(intensity)),
      log: (v: unknown) => this.host.log?.(`[${this.label} › ${t.name}] ${str(v)}`, false),
      exitScreen: () => this.host.exit?.(),
    };
  }
}
