import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import projectModels from 'virtual:bodycam-models';
import { getMaterial } from './materials.ts';

// 3D-Modelle für Maps:
//  - Projekt-Modelle: Dateien in public/assets/models/ (Liste kommt vom Vite-Plugin), Referenz = "/assets/models/x.glb"
//  - Importierte Modelle: im Editor hochgeladen, liegen in IndexedDB dieses Browsers, Referenz = "idb:<name>"
//  - Eigene Modelle aus dem Modeler: ebenfalls IndexedDB, Referenz = "idb:modeler/<Name>.glb"

export const PROJECT_MODELS: string[] = projectModels;

const DB_NAME = 'bodycam-assets';
const STORE = 'models';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listImportedModels(): Promise<string[]> {
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    return keys.map((k) => `idb:${String(k)}`).sort();
  } catch {
    return [];
  }
}

/** Speichert eine .glb-Datei im Browser und liefert die Referenz für Map-Objekte */
export async function importModelFile(file: File): Promise<string> {
  if (!/\.glb$/i.test(file.name)) throw new Error('Bitte eine .glb-Datei wählen (glTF-Binär, Texturen eingebettet).');
  const name = file.name.replace(/[^\w.\- ]/g, '_');
  await tx('readwrite', (s) => s.put(file, name));
  blobUrls.delete(`idb:${name}`);
  cache.delete(`idb:${name}`);
  return `idb:${name}`;
}

export async function deleteImportedModel(ref: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(ref.slice(4)));
  invalidateModel(ref);
}

/** Präfix der im Modeler erstellten Modelle */
export const MODELER_PREFIX = 'idb:modeler/';

export const isModelerRef = (ref: string): boolean => ref.startsWith(MODELER_PREFIX);

/** Modell (glb) unter einem Schlüssel speichern, z. B. "modeler/Kiste.glb"; liefert die Referenz */
export async function putModel(key: string, blob: Blob): Promise<string> {
  await tx('readwrite', (s) => s.put(blob, key));
  const ref = `idb:${key}`;
  invalidateModel(ref);
  return ref;
}

/** Rohdaten eines Modells (glb) holen */
export async function getModelBlob(ref: string): Promise<Blob | null> {
  if (ref.startsWith('idb:')) return (await tx<Blob | undefined>('readonly', (s) => s.get(ref.slice(4)))) ?? null;
  try {
    const res = await fetch(ref);
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

/** Zwischenspeicher eines Modells verwerfen (nach dem Überschreiben) */
export function invalidateModel(ref: string): void {
  cache.delete(ref);
  const url = blobUrls.get(ref);
  if (url) URL.revokeObjectURL(url);
  blobUrls.delete(ref);
}

/** Kollision, die im Modeler für das Modell festgelegt wurde (an der Wurzel des geladenen Modells) */
export function modelCollision(root: THREE.Object3D): string | undefined {
  return root.userData.bodycamCollision as string | undefined;
}

export function modelLabel(ref: string): string {
  return ref.split('/').pop()!.replace(/^idb:/, '').replace(/\.(glb|gltf)$/i, '');
}

const blobUrls = new Map<string, string>();

async function resolveUrl(ref: string): Promise<string | null> {
  if (!ref.startsWith('idb:')) return ref;
  const existing = blobUrls.get(ref);
  if (existing) return existing;
  const blob = await tx<Blob | undefined>('readonly', (s) => s.get(ref.slice(4)));
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  blobUrls.set(ref, url);
  return url;
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group | null>>();

/** Lädt ein Modell (zwischengespeichert) und liefert eine eigene Kopie */
export async function loadModel(ref: string): Promise<THREE.Object3D | null> {
  let p = cache.get(ref);
  if (!p) {
    p = (async () => {
      const url = await resolveUrl(ref);
      if (!url) return null;
      const gltf = await loader.loadAsync(url);
      gltf.scene.traverse((o) => {
        // Modeler-Daten: Bearbeitungsstand weglassen (groß, wird beim Klonen kopiert), Kollision behalten
        const bc = o.userData.bodycam as { collision?: string } | undefined;
        if (bc) {
          if (bc.collision) gltf.scene.userData.bodycamCollision = bc.collision;
          delete o.userData.bodycam;
        }
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
          // Modeler-Materialien durch die echten (texturierten) Level-Materialien ersetzen
          const swap = (mat: THREE.Material) => {
            const d = mat.userData?.bcMat as { material: string; color: string; roughness?: number; metalness?: number } | undefined;
            if (!d) return mat;
            mat.dispose();
            return getMaterial({ material: d.material, color: d.color, roughness: d.roughness, metalness: d.metalness });
          };
          m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material);
        }
      });
      return gltf.scene;
    })().catch((e) => {
      console.warn(`Modell ${ref} konnte nicht geladen werden`, e);
      return null;
    });
    cache.set(ref, p);
  }
  const src = await p;
  return src ? cloneSkinned(src) : null;
}
