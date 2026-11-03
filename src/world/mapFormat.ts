// Datenformat für Maps aus dem Map-Editor (JSON). Wird vom Spiel (mapLoader.ts) und vom Editor gelesen.
// Einheiten: Meter, Rotation in Grad (Euler XYZ), Farben als CSS-Hex-String.

export type Vec3 = [number, number, number];
export type PropValue = number | string | boolean;

export interface ScriptData {
  /** Blockly-Workspace (Blockly.serialization.workspaces.save) */
  blocks: unknown;
  /** Generiertes JavaScript, wird von der Script-Runtime ausgeführt */
  code: string;
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
}

export interface WorldSettings {
  background: string;
  fogColor: string;
  skyColor: string;
  groundColor: string;
  hemiIntensity: number;
  sunColor: string;
  sunIntensity: number;
  sunAzimuth: number; // Grad, 0 = +Z, 90 = +X
  sunElevation: number; // Grad über dem Horizont
  sunShadow: boolean;
  sunShadowArea: number; // halbe Kantenlänge des Schattenbereichs (m)
  groundFog: boolean;
  groundFogOpacity: number;
  groundFogHeight: number;
  groundFogSize: number;
  exposure: number;
}

export interface MapData {
  format: 'bodycam-map';
  version: 1;
  name: string;
  world: WorldSettings;
  objects: MapObjectData[];
}

export const DEFAULT_WORLD: WorldSettings = {
  background: '#353b42',
  fogColor: '#353b42',
  skyColor: '#7d8a99',
  groundColor: '#1c1915',
  hemiIntensity: 0.55,
  sunColor: '#aebdd0',
  sunIntensity: 0.9,
  sunAzimuth: 63.4,
  sunElevation: 53.3,
  sunShadow: true,
  sunShadowArea: 25,
  groundFog: true,
  groundFogOpacity: 0.22,
  groundFogHeight: 0.4,
  groundFogSize: 40,
  exposure: 1,
};

let idCounter = 0;
export function newId(): string {
  idCounter = (idCounter + 1) % 1296;
  return Date.now().toString(36) + idCounter.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6);
}

export function emptyMap(name = 'Neue Map'): MapData {
  return { format: 'bodycam-map', version: 1, name, world: { ...DEFAULT_WORLD }, objects: [] };
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && isFinite(n));

/** Prüft und vervollständigt eingelesene Map-Daten (fehlende Felder bekommen Standardwerte) */
export function normalizeMap(raw: unknown): MapData {
  if (!raw || typeof raw !== 'object') throw new Error('Keine gültige Map-Datei');
  const r = raw as Partial<MapData>;
  if (r.format !== 'bodycam-map') throw new Error('Keine BodyCam-Map (Feld "format" fehlt)');
  const world = { ...DEFAULT_WORLD, ...(r.world ?? {}) };
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
    });
  }
  return { format: 'bodycam-map', version: 1, name: typeof r.name === 'string' ? r.name : 'Map', world, objects };
}

export function cloneObject(o: MapObjectData): MapObjectData {
  return JSON.parse(JSON.stringify(o)) as MapObjectData;
}
