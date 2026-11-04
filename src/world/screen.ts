import type { ScreenData, ScreenSprite, SpriteShape } from './mapFormat.ts';
import { newId } from './mapFormat.ts';

// Programmierbarer Bildschirm: Bühne mit Figuren (wie in Scratch).
// Koordinaten: Bühnenmitte = 0/0, x nach rechts, y nach oben, Bühne ist STAGE_W Einheiten breit.
// Dieses Modul zeichnet die Bühne (Editor-Vorschau, 3D-Bildschirm, Spiel) und testet Klicks auf Figuren.

export const SCREEN_TYPE = 'screen';
export const STAGE_W = 480;
/** Pixel pro Bühnen-Einheit auf der Bildschirm-Textur */
export const SCREEN_PX = 2;

export const ASPECTS: Record<string, number> = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '9:16': 9 / 16 };
export const stageHeight = (aspect: string) => Math.round(STAGE_W / (ASPECTS[aspect] ?? 16 / 9));

export const SHAPE_LABELS: Record<SpriteShape, string> = {
  button: 'Knopf',
  rect: 'Rechteck',
  round: 'Abgerundet',
  circle: 'Kreis / Ellipse',
  text: 'Nur Text',
};

/** Laufzeit-Zustand einer Figur (Daten + Effekte, die Scripts ändern) */
export interface SpriteView extends ScreenSprite {
  /** Größe in % */
  scale: number;
  /** Transparenz 0..100 */
  ghost: number;
  say: string;
}

export interface StageView {
  background: string;
  sprites: SpriteView[];
}

export interface DrawOptions {
  /** Figur unter dem Mauszeiger (Knöpfe leuchten auf) */
  hover?: string | null;
  /** gedrückte Figur */
  pressed?: string | null;
  /** im Editor ausgewählte Figur (gestrichelter Rahmen) */
  selected?: string | null;
  /** Mauszeiger in Bühnen-Koordinaten */
  cursor?: { x: number; y: number } | null;
}

export function spriteView(s: ScreenSprite): SpriteView {
  return { ...s, scale: 100, ghost: 0, say: '' };
}

export function stageView(data: ScreenData): StageView {
  return { background: data.background, sprites: data.sprites.map(spriteView) };
}

const DEG = Math.PI / 180;

function shade(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `rgb(${r},${g},${b})`;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/**
 * Zeichnet die Bühne in einen 2D-Kontext. px = Pixel pro Bühnen-Einheit.
 * Der Kontext wird nicht skaliert übergeben; die Funktion setzt ihre Transformation selbst.
 */
export function drawStage(c: CanvasRenderingContext2D, stage: StageView, stageH: number, px: number, opts: DrawOptions = {}): void {
  c.save();
  c.setTransform(px, 0, 0, px, 0, 0);
  c.fillStyle = stage.background;
  c.fillRect(0, 0, STAGE_W, stageH);
  c.textAlign = 'center';
  c.textBaseline = 'middle';

  for (const s of stage.sprites) {
    if (!s.visible) continue;
    const k = s.scale / 100;
    const w = s.w * k;
    const h = s.h * k;
    const hover = opts.hover === s.id;
    const pressed = opts.pressed === s.id;
    c.save();
    c.translate(STAGE_W / 2 + s.x, stageH / 2 - s.y);
    c.rotate(s.rot * DEG);
    c.globalAlpha = Math.max(0, Math.min(1, 1 - s.ghost / 100));
    switch (s.shape) {
      case 'button': {
        const off = pressed ? 2 : 0;
        roundRect(c, -w / 2, -h / 2 + 3, w, h, Math.min(12, h / 3));
        c.fillStyle = shade(s.color, -0.55);
        c.fill();
        roundRect(c, -w / 2, -h / 2 + off, w, h, Math.min(12, h / 3));
        const g = c.createLinearGradient(0, -h / 2, 0, h / 2);
        const base = pressed ? shade(s.color, -0.2) : hover ? shade(s.color, 0.2) : s.color;
        g.addColorStop(0, shade(base, 0.18));
        g.addColorStop(1, base);
        c.fillStyle = g;
        c.fill();
        c.lineWidth = hover ? 2.5 : 1.5;
        c.strokeStyle = hover ? 'rgba(255,255,255,0.85)' : shade(s.color, 0.45);
        c.stroke();
        c.translate(0, off);
        break;
      }
      case 'rect':
        c.fillStyle = s.color;
        c.fillRect(-w / 2, -h / 2, w, h);
        break;
      case 'round':
        roundRect(c, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.22);
        c.fillStyle = s.color;
        c.fill();
        break;
      case 'circle':
        c.beginPath();
        c.ellipse(0, 0, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        c.fillStyle = s.color;
        c.fill();
        break;
      case 'text':
        break;
    }
    if (s.text) {
      const size = Math.max(4, s.fontSize * k);
      c.font = `${s.shape === 'button' ? 'bold ' : ''}${size}px "Segoe UI", Roboto, sans-serif`;
      c.fillStyle = s.textColor;
      const lines = String(s.text).split('\n');
      const lh = size * 1.18;
      lines.forEach((line, i) => c.fillText(line, 0, (i - (lines.length - 1) / 2) * lh));
    }
    c.restore();
    if (opts.selected === s.id) {
      c.save();
      c.translate(STAGE_W / 2 + s.x, stageH / 2 - s.y);
      c.rotate(s.rot * DEG);
      c.setLineDash([5, 4]);
      c.lineWidth = 1.5;
      c.strokeStyle = '#ffbf00';
      c.strokeRect(-w / 2 - 4, -h / 2 - 4, w + 8, h + 8);
      c.restore();
    }
  }

  // Sprechblasen über allen Figuren
  for (const s of stage.sprites) {
    if (!s.visible || !s.say) continue;
    drawBubble(c, s, stageH);
  }

  if (opts.cursor) drawCursor(c, STAGE_W / 2 + opts.cursor.x, stageH / 2 - opts.cursor.y);
  c.restore();
}

function drawBubble(c: CanvasRenderingContext2D, s: SpriteView, stageH: number): void {
  c.save();
  c.font = '15px "Segoe UI", Roboto, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const text = String(s.say);
  const tw = Math.min(260, c.measureText(text).width);
  const bw = tw + 20;
  const bh = 30;
  const sx = STAGE_W / 2 + s.x;
  const top = stageH / 2 - s.y - (s.h * s.scale) / 200;
  const bx = Math.max(2, Math.min(STAGE_W - bw - 2, sx - bw / 2));
  const by = Math.max(2, top - bh - 12);
  roundRect(c, bx, by, bw, bh, 10);
  c.fillStyle = '#ffffff';
  c.fill();
  c.strokeStyle = '#999';
  c.lineWidth = 1;
  c.stroke();
  c.beginPath();
  const tx = Math.max(bx + 12, Math.min(bx + bw - 12, sx));
  c.moveTo(tx - 6, by + bh - 0.5);
  c.lineTo(tx, by + bh + 9);
  c.lineTo(tx + 6, by + bh - 0.5);
  c.fill();
  c.fillStyle = '#222';
  c.fillText(text, bx + bw / 2, by + bh / 2, tw);
  c.restore();
}

function drawCursor(c: CanvasRenderingContext2D, x: number, y: number): void {
  c.save();
  c.translate(x, y);
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(0, 17);
  c.lineTo(4.5, 13);
  c.lineTo(8, 20);
  c.lineTo(10.5, 19);
  c.lineTo(7, 12);
  c.lineTo(12.5, 12);
  c.closePath();
  c.fillStyle = '#ffffff';
  c.fill();
  c.strokeStyle = '#000000';
  c.lineWidth = 1.2;
  c.stroke();
  c.restore();
}

/** Liegt der Bühnen-Punkt (x/y) auf der Figur? */
export function spriteContains(s: SpriteView, x: number, y: number): boolean {
  if (!s.visible) return false;
  const k = s.scale / 100;
  const hw = Math.abs(s.w * k) / 2;
  const hh = Math.abs(s.h * k) / 2;
  // In lokalen Raum der Figur zurückdrehen (Bildschirm-y zeigt nach unten → Vorzeichen beachten)
  const dx = x - s.x;
  const dy = -(y - s.y);
  const a = -s.rot * DEG;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  if (s.shape === 'circle') return hw > 0 && hh > 0 && (lx * lx) / (hw * hw) + (ly * ly) / (hh * hh) <= 1;
  return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
}

/** Oberste Figur an der Stelle (oder null) */
export function spriteAt(stage: StageView, x: number, y: number): SpriteView | null {
  for (let i = stage.sprites.length - 1; i >= 0; i--) if (spriteContains(stage.sprites[i], x, y)) return stage.sprites[i];
  return null;
}

export function newSprite(shape: SpriteShape, index: number): ScreenSprite {
  const base: ScreenSprite = {
    id: newId(),
    name: `Figur${index}`,
    shape,
    x: 0,
    y: 0,
    w: 140,
    h: 50,
    rot: 0,
    color: '#2f8fd8',
    text: '',
    textColor: '#ffffff',
    fontSize: 22,
    visible: true,
  };
  switch (shape) {
    case 'button':
      return { ...base, name: `Knopf${index}`, text: 'KNOPF' };
    case 'text':
      return { ...base, name: `Text${index}`, w: 220, h: 40, text: 'Text', textColor: '#9fe2ff', fontSize: 26 };
    case 'circle':
      return { ...base, w: 60, h: 60, color: '#46d36b' };
    case 'round':
      return { ...base, w: 160, h: 90, color: '#9966ff' };
    default:
      return { ...base, w: 120, h: 80, color: '#e0522d' };
  }
}

/** Startinhalt eines neu platzierten Bildschirms: Titel + Knopf mit Beispiel-Script */
export function defaultScreen(): ScreenData {
  const title: ScreenSprite = { ...newSprite('text', 1), name: 'Titel', y: 70, text: 'MEIN BILDSCHIRM', fontSize: 30 };
  const button: ScreenSprite = {
    ...newSprite('button', 1),
    y: -30,
    w: 180,
    h: 56,
    text: 'START',
    script: {
      blocks: {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'sc_when_clicked',
              x: 40,
              y: 40,
              next: {
                block: {
                  type: 'sc_say_for',
                  inputs: {
                    TEXT: { shadow: { type: 'text', fields: { TEXT: 'Gedrückt!' } } },
                    S: { shadow: { type: 'math_number', fields: { NUM: 1 } } },
                  },
                },
              },
            },
          ],
        },
      },
      code: "api.on('click', async () => {\n  await api.sayFor('Gedrückt!', 1);\n});\n",
    },
  };
  return { background: '#061015', sprites: [title, button] };
}
