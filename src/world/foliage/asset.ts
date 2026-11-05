import * as THREE from 'three';
import type { AssetContext, AssetDef, AssetInstance } from '../assets.ts';
import type { MapObjectData, PropValue } from '../mapFormat.ts';
import { blobRef, parseBlobRef, type BlobSource } from '../blobStore.ts';
import { FoliageData, decodeFoliage, encodeFoliage } from './data.ts';
import { FoliageRenderer } from './render.ts';
import { parseFoliageTypes } from './types.ts';

// Asset "foliage" (höchstens eins je Map): Typen als JSON in props.types, Instanzen als Blob (props.instances).
// Wie beim Landscape hält der Editor einen Cache je Objekt-ID, damit Malen nicht bei jedem Strich
// gespeichert werden muss; flushFoliage() schreibt vor dem Speichern.

export const FOLIAGE_TYPE = 'foliage';

export interface FoliageEntry {
  data: FoliageData;
  renderer: FoliageRenderer;
  instancesRef: string;
  savedRev: number;
  dataId: string;
}

const cache = new Map<string, FoliageEntry>();

const str = (o: MapObjectData, k: string) => (typeof o.props[k] === 'string' ? (o.props[k] as string) : '');

export function foliageEntry(id: string): FoliageEntry | undefined {
  return cache.get(id);
}

/** Editor: beim Laden einer anderen Map */
export function clearFoliageCache(): void {
  for (const e of cache.values()) e.renderer.dispose();
  cache.clear();
}

async function loadData(o: MapObjectData, blobs: BlobSource | undefined): Promise<FoliageData> {
  const data = new FoliageData(parseFoliageTypes(o.props.types));
  const id = parseBlobRef(o.props.instances);
  if (id) {
    const bytes = await blobs?.get(id);
    if (!bytes) throw new Error(`Foliage „${o.name}“: Instanzdaten fehlen (${id.slice(0, 8)}…)`);
    decodeFoliage(bytes, data);
  }
  // unbekannte Typen (z. B. von Hand gelöscht) verwerfen
  for (const tid of [...data.cells.keys()]) if (!data.type(tid)) data.cells.delete(tid);
  return data;
}

function makeEntry(o: MapObjectData, data: FoliageData): FoliageEntry {
  return { data, renderer: new FoliageRenderer(data), instancesRef: str(o, 'instances'), savedRev: data.revision, dataId: str(o, 'dataId') };
}

function acquireSync(o: MapObjectData): FoliageEntry | null {
  const hit = cache.get(o.id);
  if (hit) return hit;
  const dataId = str(o, 'dataId');
  if (dataId)
    for (const e of cache.values())
      if (e.dataId === dataId) {
        const copy = makeEntry(o, e.data.clone());
        copy.savedRev = e.savedRev === e.data.revision ? copy.data.revision : -1;
        cache.set(o.id, copy);
        return copy;
      }
  if (!parseBlobRef(o.props.instances)) {
    const e = makeEntry(o, new FoliageData(parseFoliageTypes(o.props.types)));
    cache.set(o.id, e);
    return e;
  }
  return null;
}

/** Editor: geänderte Instanzen als Blob schreiben, Typen als JSON (ohne Undo-Schritt) */
export async function flushFoliage(objects: MapObjectData[], put: (bytes: Uint8Array) => Promise<string>): Promise<number> {
  let written = 0;
  for (const o of objects) {
    if (o.type !== FOLIAGE_TYPE) continue;
    const e = cache.get(o.id);
    if (!e) continue;
    if (e.savedRev !== e.data.revision) {
      const blob = encodeFoliage(e.data);
      e.instancesRef = blob ? blobRef(await put(blob)) : '';
      e.savedRev = e.data.revision;
      written++;
    }
    o.props.instances = e.instancesRef;
    o.props.types = JSON.stringify(e.data.types);
  }
  return written;
}

export const FOLIAGE_ASSET: AssetDef = {
  label: 'Foliage',
  category: 'Geometrie',
  fixedScale: true,
  fixedRotation: true,
  unique: true,
  props: [
    { key: 'types', label: 'Typen', type: 'text', default: '[]', hidden: true },
    { key: 'instances', label: 'Instanzen', type: 'text', default: '', hidden: true },
    { key: 'dataId', label: 'Daten-ID', type: 'text', default: '', hidden: true },
  ],
  create(o: MapObjectData, ctx: AssetContext): AssetInstance {
    const object = new THREE.Group();
    object.userData.noOutline = true;
    let entry: FoliageEntry | null = null;
    let disposed = false;

    const attach = (e: FoliageEntry) => {
      entry = e;
      e.renderer.setEditor(ctx.editor);
      e.renderer.attach();
      object.add(e.renderer.group);
    };

    let ready: Promise<void> | undefined;
    const sync = ctx.editor ? acquireSync(o) : null;
    if (sync) attach(sync);
    else {
      ready = loadData(o, ctx.blobs)
        .catch((err) => {
          console.error(err);
          return new FoliageData(parseFoliageTypes(o.props.types));
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
      // Typen und Instanzen ändert der Foliage-Modus direkt an den Daten
      updateProps: () => !!entry,
      dispose() {
        disposed = true;
        if (!entry) return;
        object.remove(entry.renderer.group);
        entry.renderer.detach();
        if (!ctx.editor) entry.renderer.dispose();
      },
    };
  },
};

export function foliageProps(dataId: string): Record<string, PropValue> {
  return { types: '[]', instances: '', dataId };
}

/** Foliage-Renderer eines gebauten Objekts */
export function foliageOf(inst: AssetInstance | null | undefined): FoliageRenderer | null {
  const g = inst?.object.children.find((c) => c.userData.foliage);
  return (g?.userData.foliage as FoliageRenderer | undefined) ?? null;
}
