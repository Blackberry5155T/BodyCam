import * as THREE from 'three';
import { concrete, floorTiles, pbrMaterial, woodPlanks, type PBRSet } from '../textures/procedural.ts';

// Benannte Materialien für Map-Objekte. Texturen werden erst bei Bedarf erzeugt und zwischengespeichert,
// Materialien je Kombination aus Basis + Farbe + Leuchten geteilt.

export interface MaterialDef {
  label: string;
  /** Prozedurales Textur-Set; ohne = einfarbiges Material */
  textures?: () => PBRSet;
  roughness?: number;
  metalness?: number;
  /** Grundfarbe, falls ohne Texturen */
  color?: string;
}

export const MATERIALS: Record<string, MaterialDef> = {
  wand_beton: { label: 'Beton (Schalung)', textures: () => concrete(11, [0.62, 0.63, 0.64], { seams: true }) },
  bodenfliesen: { label: 'Bodenfliesen', textures: () => floorTiles(21) },
  holz: { label: 'Holzbretter', textures: () => woodPlanks(31) },
  beton_dunkel: { label: 'Beton (dunkel)', textures: () => concrete(41, [0.5, 0.52, 0.55]) },
  beton_gelb: { label: 'Beton (gelb lackiert)', textures: () => concrete(51, [0.72, 0.6, 0.3], { roughness: 0.7 }) },
  decke: { label: 'Beton (Decke)', textures: () => concrete(61, [0.4, 0.41, 0.42]) },
  metall: { label: 'Metall', color: '#3a3d40', roughness: 0.45, metalness: 0.8 },
  farbe: { label: 'Einfarbig', color: '#808080', roughness: 0.75, metalness: 0 },
};

export const MATERIAL_OPTIONS = Object.entries(MATERIALS).map(([value, d]) => ({ value, label: d.label }));

export interface MaterialParams {
  material: string;
  color: string; // Tönung (Texturen) bzw. Farbe (einfarbig)
  emissive?: string;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  side?: THREE.Side;
}

const textureCache = new Map<string, PBRSet>();
const materialCache = new Map<string, THREE.MeshStandardMaterial>();

function texturesFor(key: string, def: MaterialDef, anisotropy: number): PBRSet | null {
  if (!def.textures) return null;
  let set = textureCache.get(key);
  if (!set) {
    set = def.textures();
    for (const t of [set.map, set.normalMap, set.roughnessMap]) t.anisotropy = anisotropy;
    textureCache.set(key, set);
  }
  return set;
}

/** Geteiltes Material (nicht verändern — für Script-Änderungen erst klonen) */
export function getMaterial(p: MaterialParams, anisotropy = 8): THREE.MeshStandardMaterial {
  const key = MATERIALS[p.material] ? p.material : 'farbe';
  const def = MATERIALS[key];
  const cacheKey = [key, p.color, p.emissive, p.emissiveIntensity, p.roughness, p.metalness, p.side].join('|');
  let mat = materialCache.get(cacheKey);
  if (mat) return mat;

  const tex = texturesFor(key, def, anisotropy);
  if (tex) {
    mat = pbrMaterial(tex, anisotropy);
    mat.color.set(p.color || '#ffffff');
  } else {
    mat = new THREE.MeshStandardMaterial({
      color: p.color || def.color || '#808080',
      roughness: p.roughness ?? def.roughness ?? 0.75,
      metalness: p.metalness ?? def.metalness ?? 0,
    });
  }
  if (p.emissive && (p.emissiveIntensity ?? 0) > 0) {
    mat.emissive.set(p.emissive);
    mat.emissiveIntensity = p.emissiveIntensity ?? 1;
  }
  if (p.side !== undefined) mat.side = p.side;
  mat.userData.shared = true;
  materialCache.set(cacheKey, mat);
  return mat;
}

/** Standardfarbe eines Materials (für neue Objekte im Editor) */
export function defaultColorFor(material: string): string {
  const def = MATERIALS[material];
  return def?.textures ? '#ffffff' : def?.color ?? '#808080';
}
