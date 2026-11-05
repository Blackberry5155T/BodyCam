import type { SurfaceId } from '../surfaces.ts';
import { SURFACES } from '../surfaces.ts';

// Foliage-Typen (wie „Foliage Types“ in UE5): was gemalt wird und wie es sich verhält.
// Mesh: prozedurale Platzhalter („proc:…“) oder ein importiertes Modell (glb, LOD-Stufen über Knotennamen „LOD0/1/2“).

export type FoliageCollision = 'none' | 'trunk' | 'full';

export interface FoliageType {
  id: string;
  name: string;
  /** „proc:laubbaum“ … oder Modell-Verweis */
  mesh: string;
  /** Färbung (Laub bzw. Gestein), Hex */
  color: string;
  /** Instanzen je 100 m² beim Malen */
  density: number;
  scaleMin: number;
  scaleMax: number;
  /** zufällige Drehung um die Hochachse */
  randomYaw: boolean;
  /** an der Oberfläche ausrichten (0 = senkrecht, 1 = Normale) */
  align: number;
  /** erlaubte Neigung (Grad) und Höhe (m, Welt) */
  slopeMin: number;
  slopeMax: number;
  heightMin: number;
  heightMax: number;
  /** Mindestabstand zu Instanzen desselben Typs (m) */
  minDist: number;
  /** in den Boden versenken (m) */
  sink: number;
  /** Sichtweite (m) */
  cull: number;
  /** ab hier LOD1 bzw. LOD2 (m) */
  lod1: number;
  lod2: number;
  /** ab hier Impostor (m, 0 = keiner) */
  impostor: number;
  shadow: boolean;
  collision: FoliageCollision;
  /** blockiert die Sicht der KI (Kugeln fliegen durch) */
  sight: boolean;
  /** Auslenkung der Spitze (m) bei 10 m/s Wind */
  wind: number;
  onLandscape: boolean;
  onMeshes: boolean;
  /** Treffer-Oberfläche */
  surface: SurfaceId;
}

export const PROC_MESHES: { value: string; label: string }[] = [
  { value: 'proc:laubbaum', label: 'Laubbaum (Platzhalter)' },
  { value: 'proc:nadelbaum', label: 'Nadelbaum (Platzhalter)' },
  { value: 'proc:busch', label: 'Busch (Platzhalter)' },
  { value: 'proc:fels', label: 'Fels (Platzhalter)' },
  { value: 'proc:gras', label: 'Grasbüschel (Platzhalter)' },
];

const BASE: Omit<FoliageType, 'id' | 'name' | 'mesh'> = {
  color: '#4f7a32',
  density: 1,
  scaleMin: 0.8,
  scaleMax: 1.2,
  randomYaw: true,
  align: 0,
  slopeMin: 0,
  slopeMax: 35,
  heightMin: -10000,
  heightMax: 10000,
  minDist: 3,
  sink: 0.1,
  cull: 1500,
  lod1: 45,
  lod2: 120,
  impostor: 160,
  shadow: true,
  collision: 'trunk',
  sight: true,
  wind: 0.35,
  onLandscape: true,
  onMeshes: false,
  surface: 'holz',
};

export interface FoliagePreset {
  label: string;
  make: () => Omit<FoliageType, 'id'>;
}

export const FOLIAGE_PRESETS: FoliagePreset[] = [
  { label: 'Laubbaum', make: () => ({ ...BASE, name: 'Laubbaum', mesh: 'proc:laubbaum', color: '#4f7a32' }) },
  { label: 'Nadelbaum', make: () => ({ ...BASE, name: 'Nadelbaum', mesh: 'proc:nadelbaum', color: '#2f5a32', scaleMin: 0.85, scaleMax: 1.35, wind: 0.3 }) },
  {
    label: 'Busch',
    make: () => ({ ...BASE, name: 'Busch', mesh: 'proc:busch', color: '#4a6e2c', density: 3, minDist: 1.5, cull: 260, lod1: 30, impostor: 0, align: 0.4, slopeMax: 45, collision: 'none', sight: true, wind: 0.12, surface: 'gras' }),
  },
  {
    label: 'Fels',
    make: () => ({ ...BASE, name: 'Fels', mesh: 'proc:fels', color: '#7d7a74', density: 0.4, scaleMin: 0.5, scaleMax: 2.2, minDist: 2.5, sink: 0.25, cull: 700, lod1: 40, impostor: 0, align: 0.8, slopeMax: 70, collision: 'full', sight: true, wind: 0, surface: 'fels' }),
  },
  {
    label: 'Grasbüschel',
    make: () => ({ ...BASE, name: 'Grasbüschel', mesh: 'proc:gras', color: '#5f8a34', density: 60, scaleMin: 0.7, scaleMax: 1.3, minDist: 0.35, sink: 0.02, cull: 70, lod1: 25, impostor: 0, align: 0.6, slopeMax: 50, shadow: false, collision: 'none', sight: false, wind: 0.12, surface: 'gras' }),
  },
];

/** neuer Typ mit eindeutiger ID */
export function makeFoliageType(base: Omit<FoliageType, 'id'>, taken: Iterable<string>): FoliageType {
  const ids = new Set(taken);
  let n = 1;
  while (ids.has(`ft${n}`)) n++;
  return { ...base, id: `ft${n}` };
}

/** Grundwerte für ein importiertes Modell */
export function modelFoliageType(ref: string, name: string): Omit<FoliageType, 'id'> {
  return { ...BASE, name, mesh: ref, color: '#ffffff' };
}

const num = (v: unknown, d: number, min = -Infinity, max = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);

/** Typen aus den Props (JSON), unbekannte Felder ergänzt */
export function parseFoliageTypes(v: unknown): FoliageType[] {
  if (typeof v !== 'string' || !v) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(v);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: FoliageType[] = [];
  const seen = new Set<string>();
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.id !== 'string' || seen.has(r.id)) continue;
    seen.add(r.id);
    const coll = r.collision === 'none' || r.collision === 'trunk' || r.collision === 'full' ? r.collision : BASE.collision;
    const surf = typeof r.surface === 'string' && r.surface in SURFACES ? (r.surface as SurfaceId) : BASE.surface;
    out.push({
      id: r.id,
      name: str(r.name, 'Foliage'),
      mesh: str(r.mesh, 'proc:laubbaum'),
      color: /^#[0-9a-f]{6}$/i.test(String(r.color)) ? String(r.color) : BASE.color,
      density: num(r.density, BASE.density, 0, 2000),
      scaleMin: num(r.scaleMin, BASE.scaleMin, 0.01, 100),
      scaleMax: num(r.scaleMax, BASE.scaleMax, 0.01, 100),
      randomYaw: bool(r.randomYaw, true),
      align: num(r.align, 0, 0, 1),
      slopeMin: num(r.slopeMin, 0, 0, 90),
      slopeMax: num(r.slopeMax, 35, 0, 90),
      heightMin: num(r.heightMin, BASE.heightMin),
      heightMax: num(r.heightMax, BASE.heightMax),
      minDist: num(r.minDist, BASE.minDist, 0, 100),
      sink: num(r.sink, BASE.sink, -10, 10),
      cull: num(r.cull, BASE.cull, 5, 10000),
      lod1: num(r.lod1, BASE.lod1, 1, 10000),
      lod2: num(r.lod2, BASE.lod2, 1, 10000),
      impostor: num(r.impostor, BASE.impostor, 0, 10000),
      shadow: bool(r.shadow, true),
      collision: coll,
      sight: bool(r.sight, BASE.sight),
      wind: num(r.wind, BASE.wind, 0, 5),
      onLandscape: bool(r.onLandscape, true),
      onMeshes: bool(r.onMeshes, false),
      surface: surf,
    });
  }
  return out;
}

/** Dichte-Einstellung darf den Typ ausdünnen (nur Deko ohne Spiel-Einfluss) */
export function thinnable(t: FoliageType): boolean {
  return t.collision === 'none' && !t.sight;
}
