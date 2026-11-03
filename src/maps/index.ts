import { normalizeMap, type MapData } from '../world/mapFormat.ts';
import startMap from './start.json';

// Mitgelieferte Maps (JSON aus dem Map-Editor). Neue Map: im Editor exportieren,
// Datei nach src/maps/<name>.json legen und hier eintragen. Aufruf im Spiel: /?map=<id>
export const MAPS: Record<string, MapData> = {
  start: normalizeMap(startMap),
};

export type MapId = keyof typeof MAPS;
