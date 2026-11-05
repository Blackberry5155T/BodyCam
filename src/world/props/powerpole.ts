import * as THREE from 'three';
import type { AssetDef, AssetInstance } from '../assets.ts';
import type { MapObjectData } from '../mapFormat.ts';
import { getMaterial } from '../materials.ts';

// Strommast (Holz/Beton/Stahl) mit Querträger und Isolatoren. Die Isolator-Spitzen sind Ankerpunkte
// (userData.sockets, lokal zum Objekt): Kabel-Punkte, die im Splines-Modus auf einen Mast geklickt werden,
// rasten dort ein und wandern mit, wenn der Mast verschoben oder gedreht wird.

export const POWERPOLE_TYPE = 'powerpole';

const num = (o: MapObjectData, k: string, d: number) => (typeof o.props[k] === 'number' && Number.isFinite(o.props[k]) ? (o.props[k] as number) : d);
const str = (o: MapObjectData, k: string, d: string) => (typeof o.props[k] === 'string' && o.props[k] ? (o.props[k] as string) : d);

const POLE_MATERIALS: Record<string, { material: string; color: string; top: number; bottom: number }> = {
  holz: { material: 'holz', color: '#8a7a66', top: 0.11, bottom: 0.15 },
  beton: { material: 'beton_dunkel', color: '#cfcfcf', top: 0.1, bottom: 0.17 },
  stahl: { material: 'metall', color: '#6f7578', top: 0.08, bottom: 0.12 },
};

/** Ankerpunkte (lokal) für Höhe/Ausleger — auch ohne Mesh abfragbar (Editor) */
export function powerPoleSockets(o: MapObjectData): THREE.Vector3[] {
  const h = Math.max(3, num(o, 'height', 9));
  const arms = str(o, 'arms', 'single');
  const span = Math.max(0.6, num(o, 'armWidth', 2.2));
  const out: THREE.Vector3[] = [];
  const level = (y: number) => {
    for (const x of [-span / 2 + 0.15, 0, span / 2 - 0.15]) out.push(new THREE.Vector3(x, y + 0.24, x === 0 ? 0.12 : 0));
  };
  if (arms === 'none') out.push(new THREE.Vector3(0, h - 0.25, 0.16));
  else {
    level(h - 0.45);
    if (arms === 'double') level(h - 1.45);
  }
  return out;
}

function createPowerPole(o: MapObjectData, aniso: number): AssetInstance {
  const object = new THREE.Group();
  const h = Math.max(3, num(o, 'height', 9));
  const kind = POLE_MATERIALS[str(o, 'material', 'holz')] ?? POLE_MATERIALS.holz;
  const arms = str(o, 'arms', 'single');
  const span = Math.max(0.6, num(o, 'armWidth', 2.2));
  const geos: THREE.BufferGeometry[] = [];
  const mk = (g: THREE.BufferGeometry, m: THREE.Material) => {
    geos.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    object.add(mesh);
    return mesh;
  };

  const poleMat = getMaterial({ material: kind.material, color: str(o, 'color', '#ffffff') }, aniso);
  // 1 m im Boden, damit der Mast auf unebenem Gelände nicht schwebt
  const pole = mk(new THREE.CylinderGeometry(kind.top, kind.bottom, h + 1, 12).translate(0, (h + 1) / 2 - 1, 0), poleMat);
  pole.userData.collider = 'cylinder';
  pole.userData.foliageSurface = kind.material === 'holz' ? 'holz' : 'beton';

  const armMat = getMaterial({ material: kind.material === 'beton_dunkel' ? 'metall' : kind.material, color: kind.material === 'holz' ? '#7a6a58' : '#5c6266' }, aniso);
  const insMat = new THREE.MeshStandardMaterial({ color: '#7d5a43', roughness: 0.25, metalness: 0 });
  const ins = new THREE.CylinderGeometry(0.035, 0.05, 0.22, 10).translate(0, 0.11, 0);
  geos.push(ins);
  const sockets = powerPoleSockets(o);
  const levels = arms === 'none' ? [] : arms === 'double' ? [h - 0.45, h - 1.45] : [h - 0.45];
  for (const y of levels) {
    mk(new THREE.BoxGeometry(span, 0.1, 0.1).translate(0, y - 0.05, 0.16), armMat);
    // Streben
    for (const s of [-1, 1]) {
      const len = Math.hypot(span * 0.3, 0.6);
      const g = new THREE.BoxGeometry(0.04, len, 0.04);
      g.rotateZ(s * Math.atan2(span * 0.3, 0.6));
      g.translate(s * span * 0.15, y - 0.4, 0.16);
      mk(g, armMat);
    }
  }
  for (const p of sockets) {
    const m = new THREE.Mesh(ins, insMat);
    m.position.set(p.x, p.y - 0.24, p.z + (arms === 'none' ? -0.04 : 0));
    m.castShadow = true;
    object.add(m);
  }
  if (arms === 'none') mk(new THREE.BoxGeometry(0.08, 0.06, 0.14).translate(0, h - 0.5, 0.08), armMat);
  object.userData.sockets = sockets;

  return {
    object,
    dispose() {
      for (const g of geos) g.dispose();
      insMat.dispose();
    },
  };
}

export const POWERPOLE_ASSET: AssetDef = {
  label: 'Strommast',
  category: 'Props',
  fixedScale: true,
  props: [
    { key: 'height', label: 'Höhe (m)', type: 'number', default: 9, min: 3, max: 30, step: 0.5 },
    {
      key: 'material',
      label: 'Material',
      type: 'select',
      default: 'holz',
      options: [
        { value: 'holz', label: 'Holz' },
        { value: 'beton', label: 'Beton' },
        { value: 'stahl', label: 'Stahl' },
      ],
    },
    { key: 'color', label: 'Farbe (Tönung)', type: 'color', default: '#ffffff' },
    {
      key: 'arms',
      label: 'Querträger',
      type: 'select',
      default: 'single',
      options: [
        { value: 'single', label: 'Einer (3 Leiter)' },
        { value: 'double', label: 'Zwei (6 Leiter)' },
        { value: 'none', label: 'Keiner (Telefonmast)' },
      ],
    },
    { key: 'armWidth', label: 'Querträger-Breite (m)', type: 'number', default: 2.2, min: 0.6, max: 6, step: 0.1 },
  ],
  create: (o, ctx) => createPowerPole(o, ctx.anisotropy),
};
