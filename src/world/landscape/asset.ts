import * as THREE from 'three';
import type { AssetContext, AssetDef, AssetInstance } from '../assets.ts';
import type { MapObjectData, PropValue } from '../mapFormat.ts';
import { blobRef, parseBlobRef, type BlobSource } from '../blobStore.ts';
import { COMPONENT_QUADS, HOLE_SUBS, LandscapeData, MAX_QUADS, decodeGrassMask, decodeHeights, decodeHoles, decodeSplat, encodeGrassMask, encodeHeights, encodeHoles, encodeSplat } from './data.ts';
import { LandscapeRenderer } from './render.ts';
import { LandscapeColliders } from './collision.ts';
import { defaultLayers, parseLayers, type LandscapeLayer } from './layers.ts';

// Asset "landscape": Höhendaten liegen als Blob neben der Map (props.height / props.holes / props.splat /
// props.grass = "blob:<sha256>"), die Material-Layer als JSON in props.layers. Formen Straßen das Gelände, ist
// props.height das fertige Gelände (Spiel) und props.heightBase die gemalten Höhen darunter (nur Editor).
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
  splatRef: string;
  grassRef: string;
  baseRef: string;
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

/** Layer aus den Props; ältere Maps (vor den Layern) bekommen Standard-Layer mit ihrer Fels-Neigung */
function layersOf(o: MapObjectData): LandscapeLayer[] {
  return parseLayers(o.props.layers) ?? defaultLayers(num(o, 'slope', 38));
}

/** gespeicherte Loch-Auflösung (gilt, solange keine Lochdaten vorliegen) */
function holeRes(o: MapObjectData): number {
  const v = num(o, 'holeRes', 1);
  return (HOLE_SUBS as readonly number[]).includes(v) ? v : 1;
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

async function loadData(o: MapObjectData, blobs: BlobSource | undefined, editor = false): Promise<LandscapeData> {
  const { cx, cz, q } = dims(o);
  const hid = parseBlobRef(o.props.height);
  const oid = parseBlobRef(o.props.holes);
  const sid = parseBlobRef(o.props.splat);
  const gid = parseBlobRef(o.props.grass);
  let heights: Float32Array | undefined;
  let holes: Uint8Array | undefined;
  let splat: Uint8Array | null = null;
  let sub = holeRes(o);
  const W = cx * COMPONENT_QUADS;
  const H = cz * COMPONENT_QUADS;
  if (hid) {
    const bytes = await blobs?.get(hid);
    if (!bytes) throw new Error(`Landscape „${o.name}“: Höhendaten fehlen (${hid.slice(0, 8)}…)`);
    heights = decodeHeights(bytes, W, H);
  }
  if (oid) {
    const bytes = await blobs?.get(oid);
    if (bytes) ({ holes, sub } = decodeHoles(bytes, W, H));
  }
  const data = new LandscapeData(cx, cz, q, heights, holes, sub, layersOf(o));
  if (sid) {
    const bytes = await blobs?.get(sid);
    try {
      if (bytes) splat = decodeSplat(bytes, data.SW, data.SH);
    } catch (e) {
      console.warn(`Landscape „${o.name}“: Splatmap unlesbar`, e);
    }
    if (splat) data.splat = splat;
  }
  if (gid) {
    const bytes = await blobs?.get(gid);
    try {
      if (bytes) data.grassMask = decodeGrassMask(bytes, data.SW, data.SH);
    } catch (e) {
      console.warn(`Landscape „${o.name}“: Gras-Maske unlesbar`, e);
    }
  }
  // gemalte Höhen unter den Straßen (die Straßen-Splines setzen ihre Verformungen danach wieder auf)
  const bid = editor ? parseBlobRef(o.props.heightBase) : null;
  if (bid) {
    const bytes = await blobs?.get(bid);
    try {
      if (bytes) data.base = decodeHeights(bytes, W, H);
    } catch (e) {
      console.warn(`Landscape „${o.name}“: Basis-Höhen unlesbar`, e);
    }
  }
  return data;
}

function makeEntry(o: MapObjectData, data: LandscapeData): LandscapeEntry {
  return {
    data,
    renderer: new LandscapeRenderer(data),
    colliders: new LandscapeColliders(data),
    heightRef: str(o, 'height'),
    holesRef: str(o, 'holes'),
    splatRef: str(o, 'splat'),
    grassRef: str(o, 'grass'),
    baseRef: str(o, 'heightBase'),
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
  if (!parseBlobRef(o.props.height) && !parseBlobRef(o.props.holes) && !parseBlobRef(o.props.splat) && !parseBlobRef(o.props.grass)) {
    const e = makeEntry(o, new LandscapeData(dims(o).cx, dims(o).cz, dims(o).q, undefined, undefined, holeRes(o), layersOf(o)));
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
      const splat = encodeSplat(e.data);
      e.splatRef = splat ? blobRef(await put(splat)) : '';
      const grass = encodeGrassMask(e.data);
      e.grassRef = grass ? blobRef(await put(grass)) : '';
      e.baseRef = e.data.base ? blobRef(await put(encodeHeights(e.data, e.data.base))) : '';
      e.savedRev = e.data.revision;
      written++;
    }
    // Auch ohne Änderung: JSON-Undo kann alte Verweise zurückgebracht haben
    o.props.height = e.heightRef;
    o.props.holes = e.holesRef;
    o.props.splat = e.splatRef;
    o.props.grass = e.grassRef;
    o.props.heightBase = e.baseRef;
    o.props.holeRes = e.data.holeSub;
    o.props.layers = JSON.stringify(e.data.layers);
    // alte Material-Props (vor den Layern) nicht weiter mitschleppen
    delete o.props.grassColor;
    delete o.props.rockColor;
    delete o.props.slope;
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
    { key: 'holeRes', label: 'Loch-Auflösung', type: 'number', default: 1, hidden: true },
    { key: 'dataId', label: 'Daten-ID', type: 'text', default: '', hidden: true },
    { key: 'splat', label: 'Splatmap', type: 'text', default: '', hidden: true },
    { key: 'layers', label: 'Layer', type: 'text', default: '', hidden: true },
    { key: 'grass', label: 'Gras-Maske', type: 'text', default: '', hidden: true },
    { key: 'heightBase', label: 'Höhen ohne Straßen', type: 'text', default: '', hidden: true },
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
      ready = loadData(o, ctx.blobs, ctx.editor)
        .catch((err) => {
          console.error(err);
          return new LandscapeData(dims(o).cx, dims(o).cz, dims(o).q, undefined, undefined, 1, layersOf(o));
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
        // Nur Verweise geändert: nichts neu bauen (Layer/Splatmap ändert der Editor direkt an den Daten)
        return !!entry && matches(entry.data, next);
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
  return { compX, compZ, quadSize, height: '', holes: '', holeRes: 1, dataId, splat: '', grass: '', layers: JSON.stringify(defaultLayers()) };
}

/** Landscape-Daten eines gebauten Objekts (Spiel: Scripts, Spawn-Höhe) */
export function landscapeOf(inst: AssetInstance | null | undefined): LandscapeData | null {
  const mesh = inst?.object.children.find((c) => c.userData.landscape) as THREE.Mesh | undefined;
  return (mesh?.userData.landscape as LandscapeRenderer | undefined)?.data ?? null;
}
