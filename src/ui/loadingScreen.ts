// Ladebalken für Spiel und Editor. Das Markup steht statisch in der HTML-Datei (#loading, Stil: public/loading.css),
// damit es schon beim Herunterladen des JavaScripts sichtbar ist. Fehlt es, wird es hier erzeugt.

/** Wartet, bis der Browser einmal gezeichnet hat (sonst bleibt der Balken bei synchroner Arbeit stehen) */
export const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export class LoadingScreen {
  private el: HTMLElement;
  private bar: HTMLElement;
  private label: HTMLElement;
  private percent: HTMLElement;
  private value = 0;

  constructor(variant: 'game' | 'editor', title = 'BODYCAM') {
    let el = document.getElementById('loading');
    if (!el) {
      el = document.createElement('div');
      el.id = 'loading';
      el.innerHTML = `<div class="ls-box"><div class="ls-title">${title}</div><div class="ls-bar"><i></i></div><div class="ls-row"><span class="ls-label">Lade …</span><span class="ls-pct"></span></div></div>`;
      document.body.append(el);
    }
    el.className = `loading-screen${variant === 'editor' ? ' ls-editor' : ''}`;
    this.el = el;
    this.bar = el.querySelector<HTMLElement>('.ls-bar i')!;
    this.label = el.querySelector<HTMLElement>('.ls-label')!;
    this.percent = el.querySelector<HTMLElement>('.ls-pct')!;
  }

  get visible(): boolean {
    return !this.el.classList.contains('ls-done');
  }

  /** Neu einblenden (z. B. beim Öffnen einer anderen Map im Editor) */
  show(label = 'Lade …'): void {
    this.el.classList.remove('ls-done', 'ls-error');
    this.value = 0;
    this.set(0, label);
  }

  /** Fortschritt 0…1 setzen; geht nie rückwärts */
  set(value: number, label?: string): void {
    this.value = Math.max(this.value, Math.min(1, value));
    this.bar.style.width = `${(this.value * 100).toFixed(1)}%`;
    this.percent.textContent = `${Math.round(this.value * 100)} %`;
    if (label !== undefined) this.label.textContent = label;
  }

  /** Setzt den Fortschritt und lässt den Browser zeichnen, bevor die nächste (synchrone) Phase beginnt */
  async step(value: number, label: string): Promise<void> {
    this.set(value, label);
    await nextPaint();
  }

  /** Wartet auf mehrere Ladevorgänge; jeder fertige schiebt den Balken von `from` Richtung `to` */
  async track(promises: Promise<unknown>[], from: number, to: number, label: string): Promise<void> {
    const total = promises.length;
    if (!total) return this.step(to, label);
    let done = 0;
    const update = () => this.set(from + ((to - from) * done) / total, `${label} (${done}/${total})`);
    update();
    await Promise.all(
      promises.map((p) =>
        p.then(
          () => {},
          (e) => console.warn(e),
        ).finally(() => {
          done++;
          update();
        }),
      ),
    );
  }

  /** Füllt den Balken und blendet aus */
  async finish(): Promise<void> {
    this.set(1, 'Fertig');
    await nextPaint();
    this.el.classList.add('ls-done');
  }

  /** Fehler im Ladebildschirm anzeigen (bleibt sichtbar) */
  fail(message: string): void {
    this.el.classList.remove('ls-done');
    this.el.classList.add('ls-error');
    this.label.textContent = message;
  }
}
