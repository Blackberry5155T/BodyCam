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

export interface CylinderCollider {
  type: 'cylinder';
  center: THREE.Vector2; // xz
  radius: number;
  minY: number;
  maxY: number;
}

export type Collider = BoxCollider | OrientedBoxCollider | CylinderCollider;

export function colliderMinY(c: Collider): number {
  return c.type === 'box' ? c.min.y : c.type === 'obox' ? c.center.y - c.half.y : c.minY;
}

export function colliderMaxY(c: Collider): number {
  return c.type === 'box' ? c.max.y : c.type === 'obox' ? c.center.y + c.half.y : c.maxY;
}

const out = { dx: 0, dz: 0, distSq: 0 };

/**
 * Abstand (XZ) eines Punkts zur Grundfläche des Colliders.
 * Liefert den Vektor vom nächsten Punkt der Fläche zum Punkt (Welt-Koordinaten).
 * Für Zylinder ist der Abstand zum Mittelpunkt gemeint (Radius nicht abgezogen).
 */
export function closestXZ(c: Collider, x: number, z: number): { dx: number; dz: number; distSq: number } {
  if (c.type === 'box') {
    out.dx = x - THREE.MathUtils.clamp(x, c.min.x, c.max.x);
    out.dz = z - THREE.MathUtils.clamp(z, c.min.z, c.max.z);
  } else if (c.type === 'obox') {
    const cos = Math.cos(c.yaw);
    const sin = Math.sin(c.yaw);
    const wx = x - c.center.x;
    const wz = z - c.center.z;
    // Welt -> lokal (inverse Drehung um Y)
    const lx = wx * cos - wz * sin;
    const lz = wx * sin + wz * cos;
    const ex = lx - THREE.MathUtils.clamp(lx, -c.half.x, c.half.x);
    const ez = lz - THREE.MathUtils.clamp(lz, -c.half.z, c.half.z);
    // lokal -> Welt
    out.dx = ex * cos + ez * sin;
    out.dz = -ex * sin + ez * cos;
  } else {
    out.dx = x - c.center.x;
    out.dz = z - c.center.y;
  }
  out.distSq = out.dx * out.dx + out.dz * out.dz;
  return out;
}
