import * as THREE from 'three';
import type { AssetContext, AssetDef, AssetInstance } from '../assets.ts';
import type { MapObjectData, PropValue } from '../mapFormat.ts';
import { blobRef, parseBlobRef, type BlobSource } from '../blobStore.ts';
import { COMPONENT_QUADS, LandscapeData, MAX_QUADS, decodeHeights, decodeHoles, encodeHeights, encodeHoles } from './data.ts';
import { LandscapeRenderer, type LandscapeLook } from './render.ts';
import { LandscapeColliders } from './collision.ts';

// Asset "landscape": Höhendaten liegen als Blob neben der Map (props.height / props.holes = "blob:<sha256>").
// Im Editor hält ein Cache (je Objekt-ID) Daten + GPU-Texturen: Neuaufbau des Objekts (Simulation beenden,
// Löschen rückgängig, Undo) kostet so nichts, und Pinselstriche müssen nicht bei jedem Schritt gespeichert werden.
// Vor dem Speichern schreibt flushLandscapes() geänderte Daten als Blobs und setzt die Verweise.

export const LANDSCAPE_TYPE = 'landscape';

export interface LandscapeEntry {
  data: LandscapeData;
  renderer: LandscapeRenderer;
  colliders: LandscapeColliders;
  /** Blob-Verweise des zuletzt gespeicherten Stands */
  heightRef: string;
  holesRef: string;
  savedRev: number;
  dataId: string;
}

const cache = new Map<string, LandscapeEntry>();
/** Daten frisch angelegter Landscapes (z. B. aus Heightmap-Import), bis ihr Objekt gebaut wird */
const pending = new Map<string, LandscapeData>();

const num = (o: MapObjectData, k: string, d: number) => (typeof o.props[k] === 'number' ? (o.props[k] as number) : d);
const str = (o: MapObjectData, k: string) => (typeof o.props[k] === 'string' ? (o.props[k] as string) : '');

function dims(o: MapObjectData): { cx: number; cz: number; q: number } {
  const max = MAX_QUADS / COMPONENT_QUADS;
  return {
    cx: Math.max(1, Math.min(max, Math.round(num(o, 'compX', 8)))),
    cz: Math.max(1, Math.min(max, Math.round(num(o, 'compZ', 8)))),
    q: Math.max(0.25, Math.min(4, num(o, 'quadSize', 1))),
  };
}

function look(o: MapObjectData): LandscapeLook {
  return { grass: str(o, 'grassColor') || '#4d5a32', rock: str(o, 'rockColor') || '#6b655c', slope: num(o, 'slope', 38) };
}

function matches(d: LandscapeData, o: MapObjectData): boolean {
  const { cx, cz, q } = dims(o);
  return d.compX === cx && d.compZ === cz && d.quadSize === q;
}

/** Vor dem Bauen einer neuen Landscape: Startdaten hinterlegen (Schlüssel = props.dataId) */
export function provideLandscapeData(dataId: string, data: LandscapeData): void {
  pending.set(dataId, data);
}

export function landscapeEntry(id: string): LandscapeEntry | undefined {
  return cache.get(id);
}

/** Editor: beim Laden einer anderen Map */
export function clearLandscapeCache(): void {
  for (const e of cache.values()) {
    e.renderer.dispose();
    e.colliders.dispose();
  }
  cache.clear();
  pending.clear();
}

async function loadData(o: MapObjectData, blobs: BlobSource | undefined): Promise<LandscapeData> {
  const { cx, cz, q } = dims(o);
  const hid = parseBlobRef(o.props.height);
  const oid = parseBlobRef(o.props.holes);
  let heights: Float32Array | undefined;
  let holes: Uint8Array | undefined;
  const W = cx * COMPONENT_QUADS;
  const H = cz * COMPONENT_QUADS;
  if (hid) {
    const bytes = await blobs?.get(hid);
    if (!bytes) throw new Error(`Landscape „${o.name}“: Höhendaten fehlen (${hid.slice(0, 8)}…)`);
    heights = decodeHeights(bytes, W, H);
  }
  if (oid) {
    const bytes = await blobs?.get(oid);
    if (bytes) holes = decodeHoles(bytes, W, H);
  }
  return new LandscapeData(cx, cz, q, heights, holes);
}

function makeEntry(o: MapObjectData, data: LandscapeData): LandscapeEntry {
  return {
    data,
    renderer: new LandscapeRenderer(data, look(o)),
    colliders: new LandscapeColliders(data),
    heightRef: str(o, 'height'),
    holesRef: str(o, 'holes'),
    savedRev: data.revision,
    dataId: str(o, 'dataId'),
  };
}

/** Editor: passenden Cache-Eintrag finden oder (synchron, falls möglich) anlegen */
function acquireSync(o: MapObjectData): LandscapeEntry | null {
  const hit = cache.get(o.id);
  if (hit && matches(hit.data, o)) return hit;
  if (hit) {
    // Größe geändert (sollte nicht vorkommen): neu beginnen
    hit.renderer.dispose();
    hit.colliders.dispose();
    cache.delete(o.id);
  }
  const dataId = str(o, 'dataId');
  const fresh = dataId ? pending.get(dataId) : undefined;
  if (fresh && matches(fresh, o)) {
    pending.delete(dataId);
    const e = makeEntry(o, fresh);
    // Neue Daten sind noch nicht gespeichert
    e.savedRev = -1;
    cache.set(o.id, e);
    return e;
  }
  // Duplikat/Einfügen: Daten einer Landscape mit gleicher Daten-ID übernehmen
  if (dataId) {
    for (const e of cache.values()) {
      if (e.dataId === dataId && matches(e.data, o)) {
        const copy = makeEntry(o, e.data.clone());
        copy.savedRev = e.savedRev === e.data.revision ? copy.data.revision : -1;
        cache.set(o.id, copy);
        return copy;
      }
    }
  }
  // Leer und ohne Blob: flach
  if (!parseBlobRef(o.props.height) && !parseBlobRef(o.props.holes)) {
    const e = makeEntry(o, new LandscapeData(dims(o).cx, dims(o).cz, dims(o).q));
    cache.set(o.id, e);
    return e;
  }
  return null;
}

/** Editor: geänderte Landscapes als Blobs schreiben und Verweise in den Map-Daten setzen (ohne Undo-Schritt) */
export async function flushLandscapes(objects: MapObjectData[], put: (bytes: Uint8Array) => Promise<string>): Promise<number> {
  let written = 0;
  for (const o of objects) {
    if (o.type !== LANDSCAPE_TYPE) continue;
    const e = cache.get(o.id);
    if (!e) continue;
    if (e.savedRev !== e.data.revision) {
      e.heightRef = blobRef(await put(encodeHeights(e.data)));
      const holes = encodeHoles(e.data);
      e.holesRef = holes ? blobRef(await put(holes)) : '';
      e.savedRev = e.data.revision;
      written++;
    }
    // Auch ohne Änderung: JSON-Undo kann alte Verweise zurückgebracht haben
    o.props.height = e.heightRef;
    o.props.holes = e.holesRef;
  }
  return written;
}

const _origin = new THREE.Vector3();

export const LANDSCAPE_ASSET: AssetDef = {
  label: 'Landscape',
  category: 'Geometrie',
  fixedScale: true,
  fixedRotation: true,
  props: [
    { key: 'compX', label: 'Komponenten X', type: 'number', default: 8, hidden: true },
    { key: 'compZ', label: 'Komponenten Z', type: 'number', default: 8, hidden: true },
    { key: 'quadSize', label: 'Quad-Größe (m)', type: 'number', default: 1, hidden: true },
    { key: 'height', label: 'Höhendaten', type: 'text', default: '', hidden: true },
    { key: 'holes', label: 'Löcher', type: 'text', default: '', hidden: true },
    { key: 'dataId', label: 'Daten-ID', type: 'text', default: '', hidden: true },
    { key: 'grassColor', label: 'Gras', type: 'color', default: '#4d5a32', group: 'Material (vorläufig)' },
    { key: 'rockColor', label: 'Fels', type: 'color', default: '#6b655c', group: 'Material (vorläufig)' },
    { key: 'slope', label: 'Fels ab Neigung (°)', type: 'number', default: 38, min: 5, max: 85, step: 1, group: 'Material (vorläufig)' },
  ],
  create(o: MapObjectData, ctx: AssetContext): AssetInstance {
    const object = new THREE.Group();
    object.userData.noOutline = true;
    let entry: LandscapeEntry | null = null;
    let disposed = false;

    const attach = (e: LandscapeEntry) => {
      entry = e;
      e.renderer.attach();
      object.add(e.renderer.mesh);
    };

    let ready: Promise<void> | undefined;
    const sync = ctx.editor ? acquireSync(o) : null;
    if (sync) attach(sync);
    else {
      ready = loadData(o, ctx.blobs)
        .catch((err) => {
          console.error(err);
          return new LandscapeData(dims(o).cx, dims(o).cz, dims(o).q);
        })
        .then((data) => {
          if (disposed) return;
          const e = makeEntry(o, data);
          if (ctx.editor) cache.set(o.id, e);
          attach(e);
        });
    }

    return {
      object,
      ready,
      updateProps(next) {
        // Nur Aussehen/Verweise geändert: nichts neu bauen
        if (!entry || !matches(entry.data, next)) return false;
        entry.renderer.setLook(look(next));
        return true;
      },
      colliders(root) {
        if (!entry) return [];
        root.updateMatrixWorld(true);
        _origin.setFromMatrixPosition(root.matrixWorld);
        return entry.colliders.build(_origin);
      },
      dispose() {
        disposed = true;
        if (!entry) return;
        object.remove(entry.renderer.mesh);
        entry.renderer.detach();
        // Im Editor bleibt der Eintrag im Cache (Undo, Simulation), im Spiel wird alles freigegeben
        if (!ctx.editor) {
          entry.renderer.dispose();
          entry.colliders.dispose();
        }
      },
    };
  },
};

/** Startwerte für eine neue Landscape */
export function landscapeProps(compX: number, compZ: number, quadSize: number, dataId: string): Record<string, PropValue> {
  return { compX, compZ, quadSize, height: '', holes: '', dataId, grassColor: '#4d5a32', rockColor: '#6b655c', slope: 38 };
}

/** Landscape-Daten eines gebauten Objekts (Spiel: Scripts, Spawn-Höhe) */
export function landscapeOf(inst: AssetInstance | null | undefined): LandscapeData | null {
  const mesh = inst?.object.children.find((c) => c.userData.landscape) as THREE.Mesh | undefined;
  return (mesh?.userData.landscape as LandscapeRenderer | undefined)?.data ?? null;
}
