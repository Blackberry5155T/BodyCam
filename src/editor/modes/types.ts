import type { EditorState } from '../state.ts';
import type { Viewport } from '../viewport.ts';

// Editor-Modi wie in UE5 („Modes“): Auswahl, Landscape, Foliage, Modeling, Splines, Wasser.
// Ein Modus bringt ein Werkzeug-Panel mit (ersetzt die Details-Spalte) und bekommt die Maus im Viewport,
// bevor Gizmo und Klick-Auswahl sie sehen. Kamera-Navigation (RMB + WASD, Alt-Orbit, MMB, F) bleibt überall gleich.

export type ModeId = 'select' | 'landscape' | 'foliage' | 'modeling' | 'splines' | 'water';

/** Viewport-Eingaben, die ein Modus übernehmen kann (nur außerhalb der Simulation) */
export interface ModeInput {
  /** Linke Maustaste ohne Alt; true = Modus übernimmt den Strich (bis pointerUp) */
  pointerDown?(e: PointerEvent): boolean;
  /** Maus über dem Viewport (Pinsel-Vorschau) oder während eines übernommenen Strichs (`stroke`) */
  pointerMove?(e: PointerEvent, stroke: boolean): void;
  pointerUp?(e: PointerEvent): void;
  /** Mausrad (nicht beim Fliegen); true = verbraucht, z. B. Strg+Rad = Pinselstärke */
  wheel?(e: WheelEvent): boolean;
  /** Maus verlässt den Viewport (Vorschau ausblenden) */
  pointerLeave?(): void;
  /** einmal pro Frame */
  update?(dt: number): void;
}

export interface ModeContext {
  state: EditorState;
  viewport: Viewport;
  status(msg: string, error?: boolean): void;
}

export interface EditorMode extends ModeInput {
  readonly id: ModeId;
  readonly label: string;
  readonly icon: string;
  /** Werkzeug-Panel; null = Details-Panel bleibt sichtbar */
  readonly panel: HTMLElement | null;
  /** Gizmo und Klick-Auswahl im Viewport erlaubt (sonst gehört die linke Maustaste dem Modus) */
  readonly allowsSelection: boolean;
  activate(): void;
  deactivate(): void;
  /** Tastendruck (nur wenn kein Eingabefeld fokussiert ist); true = verbraucht */
  key?(e: KeyboardEvent): boolean;
}
