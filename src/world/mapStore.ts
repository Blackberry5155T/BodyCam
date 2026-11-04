import { strFromU8, strToU8, unzip, zip, type AsyncZippable } from 'fflate';
import { normalizeMap, type MapData } from './mapFormat.ts';
import { MAP_STORE, browserBlobs, done, findBlobRefs, hashBytes, openMapDb, request, type BlobId } from './blobStore.ts';

// Lokaler Map-Speicher im Browser (IndexedDB) + Export/Import als Datei.
// Spiel und Editor laufen auf demselben Origin und teilen sich diesen Speicher.
//  - Map-JSON im Store "maps" (Schlüssel = Name), Binär-Daten im Store "blobs" (siehe blobStore.ts)
//  - Export: .bcmap = ZIP mit map.json + blobs/<id>.bin; .json nur für Maps ohne Blobs (z. B. für src/maps)
//  - Maps aus der alten localStorage-Ablage werden beim ersten Zugriff übernommen (die alten Einträge bleiben liegen)

export interface MapEntry {
  name: string;
  updated: string;
}

interface StoredMap {
  updated: string;
  map: MapData;
}

// ---------- Übernahme aus localStorage (bis Format v1) ----------

const LEGACY_INDEX = 'bodycam.maps';
const LEGACY_PREFIX = 'bodycam.map:';
const MIGRATED_KEY = 'bodycam.maps.migrated';

let migration: Promise<void> | null = null;

function migrateLegacy(): Promise<void> {
  migration ??= (async () => {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    let index: Record<string, string> = {};
    try {
      index = JSON.parse(localStorage.getItem(LEGACY_INDEX) ?? '{}') as Record<string, string>;
    } catch {
      /* kaputter Index → nichts zu übernehmen */
    }
    const db = await openMapDb();
    const tx = db.transaction(MAP_STORE, 'readwrite');
    const store = tx.objectStore(MAP_STORE);
    const finished = done(tx);
    const existing = new Set((await request(store.getAllKeys())).map(String));
    let n = 0;
    for (const [name, updated] of Object.entries(index)) {
      if (existing.has(name)) continue;
      const raw = localStorage.getItem(LEGACY_PREFIX + name);
      if (!raw) continue;
      try {
        store.put({ updated, map: normalizeMap(JSON.parse(raw)) } satisfies StoredMap, name);
        n++;
      } catch (e) {
        console.warn(`Alte Map "${name}" ist beschädigt und wird nicht übernommen`, e);
      }
    }
    await finished;
    localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
    if (n) console.info(`${n} Map(s) aus localStorage nach IndexedDB übernommen`);
  })().catch((e) => {
    migration = null;
    throw e;
  });
  return migration;
}

async function mapStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  await migrateLegacy();
  const db = await openMapDb();
  return db.transaction(MAP_STORE, mode).objectStore(MAP_STORE);
}

// ---------- Änderungen an andere Tabs melden (Spiel lädt bei erneutem Speichern neu) ----------

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('bodycam-maps') : null;

export function onMapSaved(fn: (name: string) => void): void {
  channel?.addEventListener('message', (e: MessageEvent<{ type: string; name: string }>) => {
    if (e.data?.type === 'saved') fn(e.data.name);
  });
}

// ---------- Maps im Browser ----------

export async function listLocalMaps(): Promise<MapEntry[]> {
  const store = await mapStore('readonly');
  const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll() as IDBRequest<StoredMap[]>)]);
  return keys.map((k, i) => ({ name: String(k), updated: values[i].updated })).sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function loadLocalMap(name: string): Promise<MapData | null> {
  try {
    const v = await request((await mapStore('readonly')).get(name) as IDBRequest<StoredMap | undefined>);
    return v ? normalizeMap(v.map) : null;
  } catch (e) {
    console.warn(`Map "${name}" konnte nicht geladen werden`, e);
    return null;
  }
}

/**
 * Speichert die Map (und neue Blobs, falls angegeben). Blobs zuerst, damit eine gespeicherte Map nie auf
 * fehlende Daten verweist.
 */
export async function saveLocalMap(map: MapData, blobs?: ReadonlyMap<BlobId, Uint8Array>): Promise<void> {
  try {
    if (blobs) await browserBlobs.putMany(blobs);
    const store = await mapStore('readwrite');
    const finished = done(store.transaction);
    store.put({ updated: new Date().toISOString(), map: JSON.parse(JSON.stringify(map)) as MapData } satisfies StoredMap, map.name);
    await finished;
  } catch (e) {
    const quota = e instanceof DOMException && e.name === 'QuotaExceededError';
    throw new Error(quota ? 'Speichern fehlgeschlagen: Browser-Speicher voll. Exportiere die Map als .bcmap-Datei.' : `Speichern fehlgeschlagen: ${(e as Error).message}`);
  }
  channel?.postMessage({ type: 'saved', name: map.name });
}

export async function deleteLocalMap(name: string): Promise<void> {
  const store = await mapStore('readwrite');
  const finished = done(store.transaction);
  store.delete(name);
  await finished;
}

/**
 * Entfernt Blobs, auf die keine gespeicherte Map mehr verweist. `keep` schützt zusätzliche IDs
 * (z. B. aus der Undo-Historie des offenen Editors). Liefert die Anzahl gelöschter Blobs.
 */
export async function collectBlobGarbage(keep: Iterable<BlobId> = []): Promise<number> {
  const store = await mapStore('readonly');
  const maps = await request(store.getAll() as IDBRequest<StoredMap[]>);
  const used = new Set<BlobId>(keep);
  for (const m of maps) for (const id of findBlobRefs(m.map)) used.add(id);
  return browserBlobs.collectGarbage(used);
}

/** Bittet den Browser, den Speicher nicht automatisch zu räumen (IndexedDB kann sonst bei Platzmangel gelöscht werden) */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) || ((await navigator.storage?.persist?.()) ?? false);
  } catch {
    return false;
  }
}

// ---------- Export / Import ----------

const fileStem = (map: MapData) => map.name.replace(/[^\w\- ]/g, '_') || 'map';

function download(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Map als reines JSON (für src/maps). Wirft, wenn die Map Blobs braucht — dann .bcmap verwenden. */
export function exportMapJson(map: MapData): void {
  const refs = findBlobRefs(map);
  if (refs.size) throw new Error(`Map enthält ${refs.size} Binär-Datei(en) — bitte als .bcmap exportieren`);
  download(new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' }), `${fileStem(map)}.json`);
}

/** Paket-Inhalt: map.json + alle referenzierten Blobs */
export async function buildMapPackage(map: MapData): Promise<Uint8Array> {
  const files: AsyncZippable = { 'map.json': strToU8(JSON.stringify(map, null, 2)) };
  const missing: BlobId[] = [];
  for (const id of findBlobRefs(map)) {
    const data = await browserBlobs.get(id);
    if (data) files[`blobs/${id}.bin`] = data;
    else missing.push(id);
  }
  if (missing.length) throw new Error(`Export abgebrochen: ${missing.length} Binär-Datei(en) fehlen im Browser-Speicher (${missing[0].slice(0, 12)}…)`);
  // Kompression im Worker (fflate), damit große Heightmaps den Editor nicht einfrieren
  return new Promise((resolve, reject) => zip(files, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))));
}

export async function exportMapPackage(map: MapData): Promise<void> {
  const bytes = await buildMapPackage(map);
  download(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), `${fileStem(map)}.bcmap`);
}

/** Entpackt ein .bcmap-Paket, prüft die Blobs und legt sie im Browser ab; liefert die Map */
export async function readMapPackage(bytes: Uint8Array): Promise<MapData> {
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(bytes, (err, out) => (err ? reject(new Error('Paket ist kein gültiges ZIP')) : resolve(out))),
  );
  const json = files['map.json'];
  if (!json) throw new Error('Paket enthält keine map.json');
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(json));
  } catch {
    throw new Error('map.json im Paket ist kein gültiges JSON');
  }
  const map = normalizeMap(raw);
  const blobs = new Map<BlobId, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    const m = /^blobs\/([0-9a-f]{64})\.bin$/.exec(path);
    if (!m) continue;
    if ((await hashBytes(data)) !== m[1]) throw new Error(`Paket beschädigt: ${path} passt nicht zur Prüfsumme`);
    blobs.set(m[1], data);
  }
  const missing = [...findBlobRefs(map)].filter((id) => !blobs.has(id));
  if (missing.length) throw new Error(`Paket unvollständig: ${missing.length} Binär-Datei(en) fehlen`);
  await browserBlobs.putMany(blobs);
  return map;
}

/** Importiert .json (Format v1/v2) oder .bcmap */
export async function importMapFile(file: File): Promise<MapData> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // ZIP erkennt man an "PK\x03\x04", unabhängig von der Dateiendung
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return readMapPackage(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(bytes));
  } catch {
    throw new Error('Datei ist weder eine .bcmap noch gültiges JSON');
  }
  const map = normalizeMap(raw);
  const refs = findBlobRefs(map);
  if (refs.size) {
    const have = new Set(await browserBlobs.ids());
    const missing = [...refs].filter((id) => !have.has(id)).length;
    if (missing) throw new Error(`JSON verweist auf ${missing} Binär-Datei(en), die fehlen — bitte die .bcmap-Datei importieren`);
  }
  return map;
}
