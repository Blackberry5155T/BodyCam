import * as THREE from 'three';
import type { MapObjectData, PropValue, Vec3, WorldSettings } from './mapFormat.ts';

// Sonne als Map-Objekt (wie Directional Light in UE5): Die Drehung des Objekts bestimmt den Sonnenstand,
// seine Eigenschaften Farbe, Intensität, Sonnenscheibe und Schatten. Gibt es kein Sonnen-Objekt,
// gelten die Werte aus den World Settings.
// Konvention: lokale +Z-Achse zeigt zur Sonne, das Licht fällt entlang -Z (Pfeil im Editor).

export const SUN_TYPE = 'sun';
const DEG = THREE.MathUtils.DEG2RAD;

/** Eigenschaften des Sonnen-Objekts ↔ Felder der World Settings */
const PROP_MAP = {
  color: 'sunColor',
  intensity: 'sunIntensity',
  disc: 'sunDisc',
  size: 'sunSize',
  glow: 'sunGlow',
  shadow: 'sunShadow',
  shadowDistance: 'sunShadowDistance',
} as const satisfies Record<string, keyof WorldSettings>;

export function findSun(objects: MapObjectData[]): MapObjectData | undefined {
  return objects.find((o) => o.type === SUN_TYPE);
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

export function quatFromRot(rot: Vec3, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromEuler(_e.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, 'XYZ'));
}

/** Sonnenstand (Grad) aus der Objekt-Drehung */
export function sunAngles(q: THREE.Quaternion): { azimuth: number; elevation: number } {
  _v.set(0, 0, 1).applyQuaternion(q);
  const az = THREE.MathUtils.radToDeg(Math.atan2(_v.x, _v.z));
  const el = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(_v.y, -1, 1)));
  return { azimuth: Math.round((((az % 360) + 360) % 360) * 10) / 10, elevation: Math.round(el * 10) / 10 };
}

/** Objekt-Drehung (Euler XYZ, Grad) für einen Sonnenstand, ohne Rollen */
export function sunRotation(azimuth: number, elevation: number): Vec3 {
  _q.setFromEuler(_e.set(-elevation * DEG, azimuth * DEG, 0, 'YXZ'));
  _e.setFromQuaternion(_q, 'XYZ');
  const r = (v: number) => Math.round(THREE.MathUtils.radToDeg(v) * 100) / 100;
  return [r(_e.x), r(_e.y), r(_e.z)];
}

/** World Settings mit den Werten des Sonnen-Objekts (q: aktuelle Drehung, falls abweichend von den Daten) */
export function sunWorld(w: WorldSettings, sun: MapObjectData, q?: THREE.Quaternion): WorldSettings {
  const a = sunAngles(q ?? quatFromRot(sun.rot, _q));
  const out: WorldSettings = { ...w, sunAzimuth: a.azimuth, sunElevation: a.elevation };
  const rec = out as unknown as Record<string, PropValue>;
  for (const [prop, key] of Object.entries(PROP_MAP)) {
    const v = sun.props[prop];
    if (typeof v === typeof w[key]) rec[key] = v;
  }
  return out;
}

/** Sonnen-Werte der World Settings ins Objekt übernehmen (Presets, Strg+L, neues Sonnen-Objekt) */
export function writeSunToObject(w: WorldSettings, sun: MapObjectData): void {
  sun.rot = sunRotation(w.sunAzimuth, w.sunElevation);
  for (const [prop, key] of Object.entries(PROP_MAP)) sun.props[prop] = w[key];
}
