import { ACTIONS, type Action, type Settings } from './settings.ts';

// Tastatur-/Maustasten-Eingabe über Aktionen statt fester Tasten (Belegung aus den Settings).
// Maustasten werden wie Tasten mit dem Code "Mouse<n>" geführt (0 = links, 2 = rechts).
export class Input {
  private keys = new Set<string>();
  private captureFn: ((code: string) => void) | null = null;
  private pressListeners: ((action: Action) => void)[] = [];

  constructor(private settings: Settings) {
    window.addEventListener('keydown', (e) => {
      // Neubelegung: nächste Taste abfangen (Escape gibt der Browser für Pointer Lock frei)
      if (this.captureFn) {
        e.preventDefault();
        const fn = this.captureFn;
        this.captureFn = null;
        if (e.code !== 'Escape') fn(e.code);
        return;
      }
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
      // Strg ist Schleichen: Browser-Kürzel (Strg+S, Strg+D, Strg+F …) im Spiel unterdrücken.
      // Strg+W/T/N lässt der Browser nicht abfangen → siehe beforeunload-Schutz in main.ts
      if (e.ctrlKey && document.pointerLockElement) e.preventDefault();
      this.press(e.code, e.repeat);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('mousedown', (e) => {
      // Neubelegung per Maustaste (außer links — damit wird das Menü bedient)
      if (this.captureFn && e.button !== 0) {
        e.preventDefault();
        const fn = this.captureFn;
        this.captureFn = null;
        fn(`Mouse${e.button}`);
        return;
      }
      this.press(`Mouse${e.button}`, false);
    });
    window.addEventListener('mouseup', (e) => this.keys.delete(`Mouse${e.button}`));
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => this.keys.clear());
  }

  private press(code: string, repeat: boolean): void {
    this.keys.add(code);
    if (repeat) return;
    for (const a of ACTIONS) {
      if (this.settings.data.bindings[a] === code) for (const fn of this.pressListeners) fn(a);
    }
  }

  down(action: Action): boolean {
    return this.keys.has(this.settings.data.bindings[action]);
  }

  /** Rohe Taste (KeyboardEvent.code), z. B. für Map-Scripts */
  keyDown(code: string): boolean {
    return this.keys.has(code);
  }

  onPress(fn: (action: Action) => void): void {
    this.pressListeners.push(fn);
  }

  capture(fn: (code: string) => void): void {
    this.captureFn = fn;
  }

  cancelCapture(): void {
    this.captureFn = null;
  }

  get isCapturing(): boolean {
    return this.captureFn !== null;
  }

  clear(): void {
    this.keys.clear();
  }
}
