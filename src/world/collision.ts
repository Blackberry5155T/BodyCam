import * as THREE from 'three';

// Referenz-Maßstab (siehe docs/BodyCam-Entwicklungsplan.md, Phase 1):
// Charaktergröße ~1.8m, Türbreite ~1.0m, Deckungshöhe ~1.2m, Korridorbreite ~2.2m.
export const SCALE = {
  playerHeight: 1.8,
  playerRadius: 0.35,
  doorWidth: 1.0,
  doorHeight: 2.1,
  coverHeight: 1.2,
  corridorWidth: 2.2,
};

export interface BoxCollider {
  type: 'box';
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/** Um die Y-Achse gedrehte Box (für im Editor gedrehte Wände/Objekte) */
export interface OrientedBoxCollider {
  type: 'obox';
  center: THREE.Vector3;
  half: THREE.Vector3;
  yaw: number; // Drehung um Y (rad), gleiche Konvention wie Object3D.rotation.y
}

/** Beliebig gedrehte Box (gekippte Rampen, schräge Objekte) — Kollision über Rapier exakt */
export interface RotatedBoxCollider {
  type: 'rbox';
  center: THREE.Vector3;
  half: THREE.Vector3;
  quat: THREE.Quaternion;
}

export interface CylinderCollider {
  type: 'cylinder';
  center: THREE.Vector2; // xz
  radius: number;
  minY: number;
  maxY: number;
  /** blockiert nur die Sicht der KI (Büsche, Baumkronen) — nicht Spieler, Kugeln, Navigation */
  sightOnly?: boolean;
}

/** Höhenfeld (Landscape-Komponente): Mitte, Zellen, Höhen spaltenweise wie Rapier (h[x · (rows+1) + z]) */
export interface HeightfieldCollider {
  type: 'heightfield';
  center: THREE.Vector3;
  /** Zellen entlang Z (Zeilen) und X (Spalten) */
  rows: number;
  cols: number;
  heights: Float32Array;
  sizeX: number;
  sizeZ: number;
  minY: number;
  maxY: number;
}

/** Dreiecksnetz in Weltkoordinaten (Landscape-Komponenten mit Löchern, später Brushes/Modelle) */
export interface TrimeshCollider {
  type: 'trimesh';
  vertices: Float32Array;
  indices: Uint32Array;
  minY: number;
  maxY: number;
}

export type Collider = BoxCollider | OrientedBoxCollider | RotatedBoxCollider | CylinderCollider | HeightfieldCollider | TrimeshCollider;

const _m3 = new THREE.Matrix3();
const _m4 = new THREE.Matrix4();
/** halbe Höhe der achsenparallelen Hülle einer gedrehten Box */
function rboxExtentY(c: RotatedBoxCollider): number {
  const e = _m3.setFromMatrix4(_m4.makeRotationFromQuaternion(c.quat)).elements;
  // Zeile 2 der Rotationsmatrix (column-major: e[1], e[4], e[7])
  return Math.abs(e[1]) * c.half.x + Math.abs(e[4]) * c.half.y + Math.abs(e[7]) * c.half.z;
}

export function colliderMinY(c: Collider): number {
  if (c.type === 'rbox') return c.center.y - rboxExtentY(c);
  return c.type === 'box' ? c.min.y : c.type === 'obox' ? c.center.y - c.half.y : c.minY;
}

export function colliderMaxY(c: Collider): number {
  if (c.type === 'rbox') return c.center.y + rboxExtentY(c);
  return c.type === 'box' ? c.max.y : c.type === 'obox' ? c.center.y + c.half.y : c.maxY;
}
