import { normalizeMap, type MapData } from './mapFormat.ts';

// Lokaler Map-Speicher im Browser (localStorage) + Export/Import als JSON-Datei.
// Spiel und Editor laufen auf demselben Origin und teilen sich diesen Speicher.

const INDEX_KEY = 'bodycam.maps';
const MAP_PREFIX = 'bodycam.map:';

export interface MapEntry {
  name: string;
  updated: string;
}

function readIndex(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export const mapStorageKey = (name: string) => MAP_PREFIX + name;

export function listLocalMaps(): MapEntry[] {
  return Object.entries(readIndex())
    .map(([name, updated]) => ({ name, updated }))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export function loadLocalMap(name: string): MapData | null {
  const raw = localStorage.getItem(mapStorageKey(name));
  if (!raw) return null;
  try {
    return normalizeMap(JSON.parse(raw));
  } catch (e) {
    console.warn(`Map "${name}" ist beschädigt`, e);
    return null;
  }
}

export function saveLocalMap(map: MapData): void {
  try {
    localStorage.setItem(mapStorageKey(map.name), JSON.stringify(map));
  } catch {
    throw new Error('Speichern fehlgeschlagen: Browser-Speicher voll. Exportiere die Map als Datei.');
  }
  const index = readIndex();
  index[map.name] = new Date().toISOString();
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

export function deleteLocalMap(name: string): void {
  localStorage.removeItem(mapStorageKey(name));
  const index = readIndex();
  delete index[name];
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

export function exportMapFile(map: MapData): void {
  const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${map.name.replace(/[^\w\- ]/g, '_') || 'map'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importMapFile(file: File): Promise<MapData> {
  const text = await file.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Datei ist kein gültiges JSON');
  }
  return normalizeMap(raw);
}
