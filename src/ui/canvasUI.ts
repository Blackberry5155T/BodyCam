// Minimales Immediate-Mode-UI für einen Canvas, der als Textur auf einem In-World-Bildschirm liegt.
// Jeder Frame zeichnet alle Widgets neu; Klicks werden direkt beim Zeichnen ausgewertet.

export const THEME = {
  bg: '#061015',
  panel: '#0c1a21',
  panelHover: '#123039',
  line: '#1d3a46',
  text: '#d3ebf2',
  dim: '#6d8b97',
  accent: '#3fc4ff',
  accentDim: '#1b5e78',
  warn: '#ffb547',
  danger: '#ff5a5a',
  ok: '#5dff9a',
  font: 'Consolas, "Courier New", monospace',
};

export class CanvasUI {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly cursor = { x: 0, y: 0 };
  cursorVisible = false;
  private down = false;
  private pressed = false;
  private released = false;
  private active: string | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
    this.cursor.x = width / 2;
    this.cursor.y = height / 2;
  }

  moveCursor(dx: number, dy: number): void {
    this.cursor.x = Math.min(this.width - 1, Math.max(0, this.cursor.x + dx));
    this.cursor.y = Math.min(this.height - 1, Math.max(0, this.cursor.y + dy));
  }

  pointerDown(): void {
    this.down = true;
    this.pressed = true;
  }

  pointerUp(): void {
    this.down = false;
    this.released = true;
  }

  /** Nach dem Zeichnen aufrufen: Ein-Frame-Events zurücksetzen */
  endFrame(): void {
    this.pressed = false;
    if (this.released) this.active = null;
    this.released = false;
  }

  hover(x: number, y: number, w: number, h: number): boolean {
    if (!this.cursorVisible) return false;
    const c = this.cursor;
    return c.x >= x && c.x <= x + w && c.y >= y && c.y <= y + h;
  }

  clicked(x: number, y: number, w: number, h: number): boolean {
    return this.pressed && this.hover(x, y, w, h);
  }

  // --- Zeichenhilfen ---
  text(str: string, x: number, y: number, size = 22, color = THEME.text, align: CanvasTextAlign = 'left', weight = ''): void {
    const c = this.ctx;
    c.font = `${weight} ${size}px ${THEME.font}`;
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.fillText(str, x, y);
  }

  rect(x: number, y: number, w: number, h: number, fill: string, stroke?: string): void {
    const c = this.ctx;
    c.fillStyle = fill;
    c.fillRect(x, y, w, h);
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = 2;
      c.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }
  }

  // --- Widgets ---
  button(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    opts: { primary?: boolean; danger?: boolean; selected?: boolean; align?: CanvasTextAlign; size?: number } = {},
  ): boolean {
    const hov = this.hover(x, y, w, h);
    const color = opts.danger ? THEME.danger : THEME.accent;
    let fill = hov ? THEME.panelHover : THEME.panel;
    if (opts.primary) fill = hov ? color : opts.danger ? '#5a1d1d' : THEME.accentDim;
    if (opts.selected) fill = THEME.panelHover;
    this.rect(x, y, w, h, fill, opts.selected || hov ? color : THEME.line);
    if (opts.selected) this.rect(x, y, 6, h, color);
    const textColor = opts.primary && hov ? THEME.bg : opts.selected ? THEME.text : opts.danger ? THEME.danger : THEME.text;
    const align = opts.align ?? 'center';
    const tx = align === 'left' ? x + 24 : x + w / 2;
    this.text(label, tx, y + h / 2 + 1, opts.size ?? 22, textColor, align, opts.primary ? 'bold' : '');
    return this.clicked(x, y, w, h);
  }

  /** Beschriftete Zeile mit Inhalt rechts; liefert die x-Position und Breite des Inhaltsbereichs */
  private row(x: number, y: number, w: number, h: number, label: string): { cx: number; cw: number } {
    const hov = this.hover(x, y, w, h);
    this.rect(x, y, w, h, hov ? THEME.panelHover : THEME.panel, hov ? THEME.accentDim : undefined);
    this.text(label, x + 20, y + h / 2 + 1, 21, THEME.text);
    const cx = x + Math.min(360, w * 0.42);
    return { cx, cw: x + w - 20 - cx };
  }

  slider(
    id: string,
    x: number,
    y: number,
    w: number,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
  ): number {
    const h = 50;
    const { cx, cw } = this.row(x, y, w, h, label);
    const trackX = cx;
    const trackW = cw - 110;
    const trackY = y + h / 2;
    if (this.pressed && this.hover(trackX - 10, y, trackW + 20, h)) this.active = id;
    if (this.active === id && this.down) {
      const t = Math.min(1, Math.max(0, (this.cursor.x - trackX) / trackW));
      value = Math.round((min + t * (max - min)) / step) * step;
      value = Math.min(max, Math.max(min, Number(value.toFixed(4))));
    }
    const t = (value - min) / (max - min);
    this.rect(trackX, trackY - 3, trackW, 6, THEME.line);
    this.rect(trackX, trackY - 3, trackW * t, 6, THEME.accent);
    const knobHot = this.active === id || this.hover(trackX + trackW * t - 12, y, 24, h);
    this.rect(trackX + trackW * t - 7, trackY - 13, 14, 26, knobHot ? THEME.text : THEME.accent);
    this.text(format(value), x + w - 20, trackY + 1, 21, THEME.accent, 'right');
    return value;
  }

  toggle(x: number, y: number, w: number, label: string, value: boolean): boolean {
    const h = 50;
    const { cx } = this.row(x, y, w, h, label);
    const bx = cx;
    const by = y + 12;
    this.rect(bx, by, 64, 26, value ? THEME.accentDim : THEME.line, value ? THEME.accent : undefined);
    this.rect(value ? bx + 38 : bx + 4, by + 4, 22, 18, value ? THEME.accent : THEME.dim);
    this.text(value ? 'AN' : 'AUS', bx + 82, y + h / 2 + 1, 20, value ? THEME.accent : THEME.dim);
    return this.clicked(x, y, w, h) ? !value : value;
  }

  select(x: number, y: number, w: number, label: string, options: string[], index: number): number {
    const h = 50;
    const { cx, cw } = this.row(x, y, w, h, label);
    const leftHot = this.hover(cx, y, 44, h);
    const rightHot = this.hover(cx + cw - 44, y, 44, h);
    this.text('◀', cx + 16, y + h / 2 + 1, 20, leftHot ? THEME.text : THEME.accent, 'center');
    this.text('▶', cx + cw - 16, y + h / 2 + 1, 20, rightHot ? THEME.text : THEME.accent, 'center');
    this.text(options[index] ?? '—', cx + cw / 2, y + h / 2 + 1, 21, THEME.text, 'center');
    if (this.clicked(cx, y, 44, h)) return (index - 1 + options.length) % options.length;
    if (this.clicked(x, y, w, h)) return (index + 1) % options.length;
    return index;
  }

  drawCursor(): void {
    if (!this.cursorVisible) return;
    const c = this.ctx;
    const { x, y } = this.cursor;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x, y + 26);
    c.lineTo(x + 7, y + 20);
    c.lineTo(x + 12, y + 31);
    c.lineTo(x + 17, y + 29);
    c.lineTo(x + 12, y + 18);
    c.lineTo(x + 20, y + 18);
    c.closePath();
    c.fillStyle = '#ffffff';
    c.strokeStyle = '#000000';
    c.lineWidth = 2;
    c.fill();
    c.stroke();
  }
}
