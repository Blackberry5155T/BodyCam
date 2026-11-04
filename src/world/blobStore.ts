// Binär-Daten für Maps (Heightmaps, Splatmaps, Foliage-Instanzen, Fluid-Bakes …).
// Blobs sind inhaltsadressiert: ID = SHA-256 der Bytes (hex). Gleiche Daten werden so nur einmal gespeichert,
// und eine ID verweist immer auf genau einen Inhalt — alte Undo-Stände bleiben dadurch gültig.
// In Map-JSON steht ein Verweis als String "blob:<id>" (siehe blobRef / findBlobRefs).
//
// Quellen:
//  - IndexedDB des Browsers (Editor, Spiel mit ?map=local:<Name>; .bcmap-Import schreibt hierher)
//  - Ordner auf dem Server (public/maps/<id>/blobs/<blob-id>.bin)

export type BlobId = string;

/** Lesezugriff auf Blobs einer Map */
export interface BlobSource {
  get(id: BlobId): Promise<Uint8Array | null>;
}

const REF_PREFIX = 'blob:';
const REF_RE = /blob:([0-9a-f]{64})/g;

export const blobRef = (id: BlobId) => REF_PREFIX + id;

/** "blob:<id>" → id (oder null, wenn der Wert kein Blob-Verweis ist) */
export function parseBlobRef(v: unknown): BlobId | null {
  return typeof v === 'string' && v.startsWith(REF_PREFIX) && /^[0-9a-f]{64}$/.test(v.slice(5)) ? v.slice(5) : null;
}

/** Alle Blob-Verweise in beliebigen JSON-Daten (z. B. einer Map) */
export function findBlobRefs(data: unknown): Set<BlobId> {
  const out = new Set<BlobId>();
  for (const m of JSON.stringify(data).matchAll(REF_RE)) out.add(m[1]);
  return out;
}

export async function hashBytes(data: Uint8Array): Promise<BlobId> {
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- IndexedDB ----------

const DB_NAME = 'bodycam-maps';
export const MAP_STORE = 'maps';
const BLOB_STORE = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openMapDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MAP_STORE)) db.createObjectStore(MAP_STORE);
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Andere Tabs dürfen die DB später upgraden
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB ist blockiert (anderer Tab mit alter Version offen?)'));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/** Promise für eine IDB-Anfrage */
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Promise für das Ende einer Transaktion (erst dann ist alles geschrieben) */
export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaktion abgebrochen'));
  });
}

/** Blobs im Browser (IndexedDB) */
export const browserBlobs = {
  async get(id: BlobId): Promise<Uint8Array | null> {
    const db = await openMapDb();
    const v = await request<ArrayBuffer | undefined>(db.transaction(BLOB_STORE).objectStore(BLOB_STORE).get(id));
    return v ? new Uint8Array(v) : null;
  },

  /** Speichert Bytes (falls noch nicht vorhanden) und liefert die ID */
  async put(data: Uint8Array): Promise<BlobId> {
    const id = await hashBytes(data);
    await browserBlobs.putMany(new Map([[id, data]]));
    return id;
  },

  /** Mehrere Blobs in einer Transaktion; vorhandene IDs werden übersprungen */
  async putMany(blobs: ReadonlyMap<BlobId, Uint8Array>): Promise<void> {
    if (!blobs.size) return;
    const db = await openMapDb();
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    const store = tx.objectStore(BLOB_STORE);
    const finished = done(tx);
    const existing = new Set((await request(store.getAllKeys())).map(String));
    for (const [id, data] of blobs) {
      if (existing.has(id)) continue;
      // Eigene Kopie als ArrayBuffer (keine Views auf fremde, größere Puffer speichern)
      store.put(data.slice().buffer, id);
    }
    await finished;
  },

  async ids(): Promise<BlobId[]> {
    const db = await openMapDb();
    return (await request(db.transaction(BLOB_STORE).objectStore(BLOB_STORE).getAllKeys())).map(String);
  },

  /** Löscht alle Blobs, die nicht in `keep` stehen; liefert die Anzahl gelöschter Blobs */
  async collectGarbage(keep: ReadonlySet<BlobId>): Promise<number> {
    const db = await openMapDb();
    const tx = db.transaction(BLOB_STORE, 'readwrite');
    const store = tx.objectStore(BLOB_STORE);
    const finished = done(tx);
    let n = 0;
    for (const k of await request(store.getAllKeys())) {
      if (keep.has(String(k))) continue;
      store.delete(k);
      n++;
    }
    await finished;
    return n;
  },
};

// ---------- weitere Quellen ----------

/** Blobs aus einem Map-Ordner auf dem Server: <base>/blobs/<id>.bin */
export class UrlBlobs implements BlobSource {
  constructor(private base: string) {}
  async get(id: BlobId): Promise<Uint8Array | null> {
    const res = await fetch(`${this.base}/blobs/${id}.bin`);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  }
}

/** Keine Blobs (kleine Maps aus src/maps) */
export const NO_BLOBS: BlobSource = { get: async () => null };
