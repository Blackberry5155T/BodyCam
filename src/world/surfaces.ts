// Oberflächentypen (wie Physical Materials in UE5): bestimmen Schrittgeräusche, Einschlag-Effekte und wie
// der Boden auf Nässe reagiert. Landscape-Layer haben je eine Oberfläche; alles andere zählt als Beton.

export type SurfaceId = 'gras' | 'erde' | 'fels' | 'kies' | 'schnee' | 'sand' | 'asphalt' | 'schlamm' | 'beton' | 'holz';

/** Parameter für den synthetischen Schritt (audio/footsteps.ts) */
export interface StepSound {
  /** tiefer Körper (Ferse): Lautstärke 0..1 und Frequenz */
  thump: number;
  thumpHz: number;
  /** Rauschanteil: Lautstärke, Hoch-/Tiefpass (Hz), Abklingzeit (s) */
  noise: number;
  hp: number;
  lp: number;
  dur: number;
  /** Knirschen: Anzahl kurzer Klicks, verteilt über `spread` Sekunden, Hochpass der Klicks */
  grains: number;
  spread: number;
  grainHp: number;
  /** Schmatzen (Schlamm): Bandpass gleitet nach oben */
  squelch?: number;
}

export interface SurfaceDef {
  id: SurfaceId;
  label: string;
  /** Nässe dunkelt poröse Böden stark nach (0 = gar nicht, 1 = voll) */
  porosity: number;
  /** Pfützen-Neigung: > 0 mehr Pfützen (Mulden, Erde), < 0 weniger (Kies versickert) */
  puddle: number;
  /** Einschlag: Staubfarbe, Staubmenge (Faktor), Funken ja/nein, Brocken-Farbe */
  impact: { dust: number; amount: number; sparks: boolean; chips: number };
  step: StepSound;
}

export const SURFACES: Record<SurfaceId, SurfaceDef> = {
  gras: {
    id: 'gras',
    label: 'Gras',
    porosity: 0.7,
    puddle: -0.15,
    impact: { dust: 0x5b5a3a, amount: 0.8, sparks: false, chips: 0x3d4a22 },
    step: { thump: 0.25, thumpHz: 70, noise: 0.32, hp: 1400, lp: 5200, dur: 0.15, grains: 7, spread: 0.1, grainHp: 2600 },
  },
  erde: {
    id: 'erde',
    label: 'Erde',
    porosity: 1,
    puddle: 0.25,
    impact: { dust: 0x6e5a44, amount: 1.4, sparks: false, chips: 0x4a3a2a },
    step: { thump: 0.6, thumpHz: 80, noise: 0.22, hp: 150, lp: 1300, dur: 0.07, grains: 2, spread: 0.04, grainHp: 900 },
  },
  fels: {
    id: 'fels',
    label: 'Fels',
    porosity: 0.45,
    puddle: 0,
    impact: { dust: 0x8a8580, amount: 1, sparks: true, chips: 0x77726b },
    step: { thump: 0.45, thumpHz: 115, noise: 0.38, hp: 900, lp: 6500, dur: 0.045, grains: 1, spread: 0.01, grainHp: 3200 },
  },
  kies: {
    id: 'kies',
    label: 'Kies',
    porosity: 0.6,
    puddle: -0.35,
    impact: { dust: 0x8c8378, amount: 1.1, sparks: true, chips: 0x6f675d },
    step: { thump: 0.35, thumpHz: 90, noise: 0.28, hp: 700, lp: 5200, dur: 0.1, grains: 16, spread: 0.13, grainHp: 1800 },
  },
  schnee: {
    id: 'schnee',
    label: 'Schnee',
    porosity: 0.2,
    puddle: -0.5,
    impact: { dust: 0xe8edf3, amount: 1.6, sparks: false, chips: 0xdfe6ee },
    step: { thump: 0.3, thumpHz: 70, noise: 0.4, hp: 450, lp: 2600, dur: 0.18, grains: 11, spread: 0.16, grainHp: 900 },
  },
  sand: {
    id: 'sand',
    label: 'Sand',
    porosity: 0.8,
    puddle: -0.3,
    impact: { dust: 0xb9a37c, amount: 1.8, sparks: false, chips: 0xa48e66 },
    step: { thump: 0.3, thumpHz: 70, noise: 0.34, hp: 600, lp: 3600, dur: 0.16, grains: 5, spread: 0.1, grainHp: 2000 },
  },
  asphalt: {
    id: 'asphalt',
    label: 'Asphalt',
    porosity: 0.55,
    puddle: 0.1,
    impact: { dust: 0x5d5c5a, amount: 0.9, sparks: true, chips: 0x3a3a3a },
    step: { thump: 0.45, thumpHz: 100, noise: 0.34, hp: 700, lp: 5200, dur: 0.05, grains: 1, spread: 0.01, grainHp: 2600 },
  },
  schlamm: {
    id: 'schlamm',
    label: 'Schlamm',
    porosity: 0.5,
    puddle: 0.45,
    impact: { dust: 0x4a3b2b, amount: 1.2, sparks: false, chips: 0x3a2d20 },
    step: { thump: 0.5, thumpHz: 60, noise: 0.28, hp: 100, lp: 900, dur: 0.16, grains: 0, spread: 0, grainHp: 800, squelch: 0.5 },
  },
  beton: {
    id: 'beton',
    label: 'Beton',
    porosity: 0.6,
    puddle: 0,
    impact: { dust: 0x8a8580, amount: 1, sparks: true, chips: 0x7a7670 },
    step: { thump: 0.45, thumpHz: 105, noise: 0.34, hp: 800, lp: 5600, dur: 0.05, grains: 1, spread: 0.01, grainHp: 2800 },
  },
  holz: {
    id: 'holz',
    label: 'Holz',
    porosity: 0.5,
    puddle: 0,
    impact: { dust: 0x7a6248, amount: 0.9, sparks: false, chips: 0x6b4a2b },
    step: { thump: 0.55, thumpHz: 95, noise: 0.25, hp: 300, lp: 2400, dur: 0.06, grains: 1, spread: 0.02, grainHp: 1500 },
  },
};

export const SURFACE_OPTIONS: { value: SurfaceId; label: string }[] = Object.values(SURFACES).map((s) => ({ value: s.id, label: s.label }));

export function surfaceDef(id: string | undefined): SurfaceDef {
  return SURFACES[(id ?? '') as SurfaceId] ?? SURFACES.beton;
}

/** Wetter verändert den Boden: nasse Erde wird zu Schlamm, Schneedecke überdeckt alles (draußen) */
export function weatherSurface(id: SurfaceId, wetness: number, snowCover: number): SurfaceId {
  if (snowCover > 0.35) return 'schnee';
  if (id === 'erde' && wetness > 0.45) return 'schlamm';
  return id;
}
