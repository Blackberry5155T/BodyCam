// Datenformat für Maps aus dem Map-Editor (JSON). Wird vom Spiel (mapLoader.ts) und vom Editor gelesen.
// Einheiten: Meter, Rotation in Grad (Euler XYZ), Farben als CSS-Hex-String.
// Version 2: große Binär-Daten (Heightmaps, Splatmaps, Foliage …) liegen nicht im JSON, sondern als Blobs;
// das JSON verweist mit "blob:<sha256>" darauf (siehe world/blobStore.ts). v1-Maps werden beim Laden hochgestuft.

export type Vec3 = [number, number, number];
export type PropValue = number | string | boolean;

export interface ScriptData {
  /** Blockly-Workspace (Blockly.serialization.workspaces.save) */
  blocks: unknown;
  /** Generiertes JavaScript, wird von der Script-Runtime ausgeführt */
  code: string;
}

/** Form einer Bildschirm-Figur */
export type SpriteShape = 'button' | 'rect' | 'round' | 'circle' | 'text';

/** Figur auf einem programmierbaren Bildschirm (Koordinaten wie Scratch: Mitte = 0/0, y nach oben) */
export interface ScreenSprite {
  id: string;
  name: string;
  shape: SpriteShape;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Drehung in Grad (im Uhrzeigersinn) */
  rot: number;
  color: string;
  text: string;
  textColor: string;
  fontSize: number;
  visible: boolean;
  script?: ScriptData;
}

/** Inhalt eines programmierbaren Bildschirms: Bühne (Hintergrund + Script) und Figuren */
export interface ScreenData {
  background: string;
  stageScript?: ScriptData;
  sprites: ScreenSprite[];
}

export interface MapObjectData {
  id: string;
  name: string;
  /** Asset-Typ, siehe ASSETS in world/assets.ts */
  type: string;
  pos: Vec3;
  rot: Vec3;
  scale: Vec3;
  props: Record<string, PropValue>;
  hidden?: boolean;
  script?: ScriptData;
  /** Nur für Bildschirme (Typ "screen"): Figuren + Bühnen-Script */
  screen?: ScreenData;
}

export interface WorldSettings {
  /** Hintergrundfarbe, wenn der Himmel ausgeschaltet ist */
  background: string;
  sky: boolean;
  skyZenith: string;
  skyHorizon: string;
  fogColor: string;
  skyColor: string;
  groundColor: string;
  hemiIntensity: number;
  sunColor: string;
  sunIntensity: number;
  sunAzimuth: number; // Grad, 0 = +Z, 90 = +X
  sunElevation: number; // Grad über dem Horizont
  sunShadow: boolean;
  sunShadowDistance: number; // Reichweite der Schattenkaskaden ab der Kamera (m)
  sunDisc: boolean; // Sonnenscheibe am Himmel sichtbar
  sunSize: number; // Winkeldurchmesser in Grad
  sunGlow: number;
  groundPlane: boolean; // unsichtbarer, unendlicher Kollisionsboden bei y = 0
  /** Distanznebel bei voller Spieler-Sichtweite (m); große Landschaften brauchen mehr als 60 m */
  viewDistance: number;
  groundFog: boolean;
  groundFogOpacity: number;
  groundFogHeight: number;
  groundFogSize: number;
  exposure: number;
  /** Wettertyp: klar | niesel | regen | gewitter | schnee */
  weather: string;
  weatherIntensity: number; // 0..2
  windDirection: number; // Grad, 0 = +Z
  windStrength: number; // m/s
  wetness: number; // Anfangsnässe 0..1
  puddles: number; // Menge der Pfützen 0..1
  snowCover: number; // Anfangs-Schneedecke 0..1
  weatherTimeScale: number; // wie schnell Boden nass wird/trocknet (0 = eingefroren)
}

/** Aktuelle Version des Map-Formats */
export const MAP_VERSION = 2;

export interface MapData {
  format: 'bodycam-map';
  version: typeof MAP_VERSION;
  name: string;
  world: WorldSettings;
  objects: MapObjectData[];
}

export const DEFAULT_WORLD: WorldSettings = {
  background: '#353b42',
  sky: true,
  skyZenith: '#2c3846',
  skyHorizon: '#66717d',
  fogColor: '#353b42',
  skyColor: '#7d8a99',
  groundColor: '#1c1915',
  hemiIntensity: 0.55,
  sunColor: '#aebdd0',
  sunIntensity: 0.9,
  sunAzimuth: 63.4,
  sunElevation: 53.3,
  sunShadow: true,
  sunShadowDistance: 120,
  sunDisc: true,
  sunSize: 2.5,
  sunGlow: 0.5,
  viewDistance: 60,
  groundFog: true,
  groundFogOpacity: 0.22,
  groundFogHeight: 0.4,
  groundFogSize: 40,
  exposure: 1,
  groundPlane: true,
  weather: 'klar',
  weatherIntensity: 1,
  windDirection: 30,
  windStrength: 1.5,
  wetness: 0,
  puddles: 0.6,
  snowCover: 0,
  weatherTimeScale: 1,
};

let idCounter = 0;
export function newId(): string {
  idCounter = (idCounter + 1) % 1296;
  return Date.now().toString(36) + idCounter.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6);
}

export function emptyMap(name = 'Neue Map'): MapData {
  return { format: 'bodycam-map', version: MAP_VERSION, name, world: { ...DEFAULT_WORLD }, objects: [] };
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));

/** Prüft und vervollständigt eingelesene Map-Daten (fehlende Felder bekommen Standardwerte) */
export function normalizeMap(raw: unknown): MapData {
  if (!raw || typeof raw !== 'object') throw new Error('Keine gültige Map-Datei');
  const r = raw as Partial<MapData>;
  if (r.format !== 'bodycam-map') throw new Error('Keine BodyCam-Map (Feld "format" fehlt)');
  const version = typeof r.version === 'number' ? r.version : 1;
  if (version > MAP_VERSION) throw new Error(`Map hat Format-Version ${version}, dieser Editor kann nur bis ${MAP_VERSION} — bitte aktualisieren`);
  const world = { ...DEFAULT_WORLD, ...(r.world ?? {}) };
  // v1 → v2: Struktur bleibt gleich, nur Altlasten fallen weg
  delete (world as Partial<Record<string, unknown>>).sunShadowArea; // fester Schattenbereich (jetzt Kaskaden)
  const objects: MapObjectData[] = [];
  const seen = new Set<string>();
  for (const o of Array.isArray(r.objects) ? r.objects : []) {
    if (!o || typeof o.type !== 'string') continue;
    let id = typeof o.id === 'string' && o.id ? o.id : newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    objects.push({
      id,
      name: typeof o.name === 'string' ? o.name : o.type,
      type: o.type,
      pos: isVec3(o.pos) ? o.pos : [0, 0, 0],
      rot: isVec3(o.rot) ? o.rot : [0, 0, 0],
      scale: isVec3(o.scale) ? o.scale : [1, 1, 1],
      props: o.props && typeof o.props === 'object' ? { ...o.props } : {},
      ...(o.hidden ? { hidden: true } : {}),
      ...(o.script && typeof o.script.code === 'string' ? { script: o.script } : {}),
      ...(o.screen ? { screen: normalizeScreen(o.screen) } : {}),
    });
  }
  return { format: 'bodycam-map', version: MAP_VERSION, name: typeof r.name === 'string' ? r.name : 'Map', world, objects };
}

const isScript = (v: unknown): v is ScriptData => !!v && typeof (v as ScriptData).code === 'string';
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const numOr = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
const SHAPES: SpriteShape[] = ['button', 'rect', 'round', 'circle', 'text'];

/** Prüft Bildschirm-Daten und ergänzt fehlende Felder */
export function normalizeScreen(raw: unknown): ScreenData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ScreenData>;
  const sprites: ScreenSprite[] = [];
  for (const s of Array.isArray(r.sprites) ? r.sprites : []) {
    if (!s || typeof s !== 'object') continue;
    sprites.push({
      id: str(s.id, newId()),
      name: str(s.name, 'Figur'),
      shape: SHAPES.includes(s.shape) ? s.shape : 'button',
      x: numOr(s.x, 0),
      y: numOr(s.y, 0),
      w: numOr(s.w, 120),
      h: numOr(s.h, 50),
      rot: numOr(s.rot, 0),
      color: str(s.color, '#3fc4ff'),
      text: str(s.text, ''),
      textColor: str(s.textColor, '#ffffff'),
      fontSize: numOr(s.fontSize, 22),
      visible: s.visible !== false,
      ...(isScript(s.script) ? { script: s.script } : {}),
    });
  }
  return {
    background: str(r.background, '#061015'),
    ...(isScript(r.stageScript) ? { stageScript: r.stageScript } : {}),
    sprites,
  };
}

export function cloneObject(o: MapObjectData): MapObjectData {
  return JSON.parse(JSON.stringify(o)) as MapObjectData;
}
