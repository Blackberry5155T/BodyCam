// Zentrale, persistente Spieleinstellungen (localStorage). Änderungen werden an Listener gemeldet.

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'crouch'
  | 'aim'
  | 'jump'
  | 'flashlight'
  | 'interact'
  | 'fog'
  | 'hud';

export const ACTIONS: Action[] = ['forward', 'back', 'left', 'right', 'sprint', 'crouch', 'aim', 'jump', 'flashlight', 'interact', 'fog', 'hud'];

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Vorwärts',
  back: 'Rückwärts',
  left: 'Links',
  right: 'Rechts',
  sprint: 'Sprinten',
  crouch: 'Schleichen / Ducken',
  aim: 'Zielen',
  jump: 'Springen',
  flashlight: 'Taschenlampe',
  interact: 'Benutzen',
  fog: 'Nebel (Debug)',
  hud: 'Debug-Text',
};

export const DEFAULT_BINDINGS: Record<Action, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft',
  crouch: 'ControlLeft',
  aim: 'Mouse2',
  jump: 'Space',
  flashlight: 'KeyF',
  interact: 'KeyE',
  fog: 'KeyN',
  hud: 'KeyH',
};

export const QUALITY_LABELS = ['Niedrig', 'Mittel', 'Hoch', 'Ultra', 'Benutzerdefiniert'];
export const SHADOW_LABELS = ['Aus', 'Niedrig', 'Hoch'];
export const REFLECTION_LABELS = ['Aus', 'Niedrig', 'Hoch'];
export const VOLUMETRIC_LABELS = ['Niedrig', 'Mittel', 'Hoch'];
export const TERRAIN_LABELS = ['Niedrig', 'Mittel', 'Hoch', 'Ultra'];
/** Detail-Faktor der Landscape-LODs (Abstand, ab dem eine gröbere Stufe benutzt wird) */
export const TERRAIN_DETAIL = [1.5, 2, 2.5, 3.5];
export const MM_MODES = ['Team Deathmatch', 'Extraction', 'Horde (Koop)', 'Hunt (PvE)'];
export const MM_REGIONS = ['Automatisch', 'EU-West', 'EU-Ost', 'Nordamerika', 'Asien'];
export const MM_PARTY = ['Solo', 'Duo', 'Squad (4)'];

export interface SettingsData {
  bindings: Record<Action, string>;
  // Maus & Kamera
  mouseSensitivity: number; // Faktor
  invertY: boolean;
  fov: number;
  cameraShake: number; // Faktor für Kopfwippen/Wackeln
  // Grafik
  quality: number; // Index in QUALITY_LABELS
  shadows: number; // Index in SHADOW_LABELS
  renderScale: number; // Faktor auf devicePixelRatio
  bloom: boolean;
  reflections: number; // Index in REFLECTION_LABELS (Pfützen-Spiegelungen)
  volumetrics: number; // Index in VOLUMETRIC_LABELS (Nebel-Schritte, Partikelmenge)
  terrainDetail: number; // Index in TERRAIN_LABELS (Landscape-LOD)
  brightness: number;
  fogEnabled: boolean;
  viewDistance: number;
  // Bodycam-Effekt
  lensDistortion: number;
  grain: number;
  aberration: number;
  vignette: number;
  hudOverlay: boolean;
  // Matchmaking
  mmMode: number;
  mmRegion: number;
  mmParty: number;
}

export const QUALITY_PRESETS: Pick<SettingsData, 'shadows' | 'renderScale' | 'bloom' | 'reflections' | 'volumetrics' | 'terrainDetail'>[] = [
  { shadows: 0, renderScale: 0.75, bloom: false, reflections: 0, volumetrics: 0, terrainDetail: 0 },
  { shadows: 1, renderScale: 1.0, bloom: true, reflections: 1, volumetrics: 1, terrainDetail: 1 },
  { shadows: 2, renderScale: 1.0, bloom: true, reflections: 2, volumetrics: 2, terrainDetail: 2 },
  { shadows: 2, renderScale: 1.5, bloom: true, reflections: 2, volumetrics: 2, terrainDetail: 3 },
];

const DEFAULTS: SettingsData = {
  bindings: { ...DEFAULT_BINDINGS },
  mouseSensitivity: 1,
  invertY: false,
  fov: 80,
  cameraShake: 1,
  quality: 2,
  shadows: 2,
  renderScale: 1,
  bloom: true,
  reflections: 2,
  volumetrics: 2,
  terrainDetail: 2,
  brightness: 1,
  fogEnabled: true,
  viewDistance: 25,
  lensDistortion: 1,
  grain: 1,
  aberration: 1,
  vignette: 1,
  hudOverlay: true,
  mmMode: 0,
  mmRegion: 0,
  mmParty: 0,
};

const STORAGE_KEY = 'bodycam.settings.v1';

type Listener = (key: keyof SettingsData) => void;

export class Settings {
  data: SettingsData;
  /** Faktor der Map auf die Sichtweite (große Landscapes: Map-Sichtweite / 60); nur Anzeige */
  viewScale = 1;
  private listeners: Listener[] = [];

  constructor() {
    this.data = structuredClone(DEFAULTS);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SettingsData>;
        this.data = { ...this.data, ...parsed, bindings: { ...DEFAULT_BINDINGS, ...(parsed.bindings ?? {}) } };
      }
    } catch {
      // Speicher nicht verfügbar → Standardwerte
    }
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    if (this.data[key] === value) return;
    this.data[key] = value;
    // Einzelne Grafikoption geändert → Preset wird "Benutzerdefiniert"
    if (key === 'shadows' || key === 'renderScale' || key === 'bloom' || key === 'reflections' || key === 'volumetrics' || key === 'terrainDetail') {
      const d = this.data;
      const match = QUALITY_PRESETS.findIndex(
        (p) =>
          p.shadows === d.shadows &&
          p.renderScale === d.renderScale &&
          p.bloom === d.bloom &&
          p.reflections === d.reflections &&
          p.volumetrics === d.volumetrics &&
          p.terrainDetail === d.terrainDetail,
      );
      this.data.quality = match === -1 ? QUALITY_LABELS.length - 1 : match;
    }
    this.save();
    this.emit(key);
  }

  applyQuality(index: number): void {
    const preset = QUALITY_PRESETS[index];
    if (!preset) return;
    this.data.quality = index;
    Object.assign(this.data, preset);
    this.save();
    this.emit('shadows');
    this.emit('renderScale');
    this.emit('bloom');
    this.emit('reflections');
    this.emit('volumetrics');
    this.emit('terrainDetail');
    this.emit('quality');
  }

  /** Belegt eine Aktion neu; hatte eine andere Aktion dieselbe Taste, werden beide getauscht */
  setBinding(action: Action, code: string): void {
    const b = this.data.bindings;
    const other = ACTIONS.find((a) => a !== action && b[a] === code);
    if (other) b[other] = b[action];
    b[action] = code;
    this.save();
    this.emit('bindings');
  }

  resetBindings(): void {
    this.data.bindings = { ...DEFAULT_BINDINGS };
    this.save();
    this.emit('bindings');
  }

  resetAll(): void {
    this.data = structuredClone(DEFAULTS);
    this.save();
    for (const k of Object.keys(DEFAULTS) as (keyof SettingsData)[]) this.emit(k);
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(key: keyof SettingsData): void {
    for (const fn of this.listeners) fn(key);
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // ignorieren
    }
  }
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Leertaste',
  ShiftLeft: 'L-Shift',
  ShiftRight: 'R-Shift',
  ControlLeft: 'L-Strg',
  ControlRight: 'R-Strg',
  AltLeft: 'L-Alt',
  AltRight: 'Alt Gr',
  Tab: 'Tab',
  CapsLock: 'Feststell',
  Enter: 'Enter',
  Backspace: 'Rücktaste',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Mouse0: 'Linksklick',
  Mouse1: 'Mausrad-Klick',
  Mouse2: 'Rechtsklick',
  Mouse3: 'Maus 4',
  Mouse4: 'Maus 5',
};

export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
