import * as THREE from 'three';
import type { MapObjectData, PropValue, Vec3, WorldSettings } from './mapFormat.ts';

// Wetter als Map-Objekt (wie die Sonne, siehe sun.ts): Die Drehung um die Hochachse bestimmt die
// Windrichtung, die Eigenschaften Wettertyp, Stärke, Nässe usw. Gibt es kein Wetter-Objekt,
// gelten die Werte aus den World Settings.
// Konvention: Der Wind weht entlang der lokalen -Z-Achse (Pfeil im Editor), wie das Licht der Sonne.

export const WEATHER_TYPE = 'weather';
const DEG = THREE.MathUtils.DEG2RAD;

/** Eigenschaften des Wetter-Objekts ↔ Felder der World Settings */
const PROP_MAP = {
  weather: 'weather',
  intensity: 'weatherIntensity',
  windStrength: 'windStrength',
  wetness: 'wetness',
  puddles: 'puddles',
  snowCover: 'snowCover',
  timeScale: 'weatherTimeScale',
} as const satisfies Record<string, keyof WorldSettings>;

export function findWeather(objects: MapObjectData[]): MapObjectData | undefined {
  return objects.find((o) => o.type === WEATHER_TYPE);
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

/** Windrichtung (Grad, 0 = weht nach +Z, 90 = nach +X) aus der Objekt-Drehung */
export function windAngle(q: THREE.Quaternion): number {
  _v.set(0, 0, -1).applyQuaternion(q);
  if (_v.x * _v.x + _v.z * _v.z < 1e-8) return 0;
  const az = THREE.MathUtils.radToDeg(Math.atan2(_v.x, _v.z));
  return Math.round((((az % 360) + 360) % 360) * 10) / 10;
}

/** Objekt-Drehung (Euler XYZ, Grad) für eine Windrichtung */
export function windRotation(direction: number): Vec3 {
  // -Z soll in Richtung (sin a, 0, cos a) zeigen → Drehung um Y um a + 180°
  const y = (((direction + 180) % 360) + 360) % 360;
  return [0, Math.round((y > 180 ? y - 360 : y) * 100) / 100, 0];
}

export function quatFromRot(rot: Vec3, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromEuler(_e.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, 'XYZ'));
}

/** World Settings mit den Werten des Wetter-Objekts (q: aktuelle Drehung, falls abweichend von den Daten) */
export function weatherWorld(w: WorldSettings, obj: MapObjectData, q?: THREE.Quaternion): WorldSettings {
  const out: WorldSettings = { ...w, windDirection: windAngle(q ?? quatFromRot(obj.rot, _q)) };
  const rec = out as unknown as Record<string, PropValue>;
  for (const [prop, key] of Object.entries(PROP_MAP)) {
    const v = obj.props[prop];
    if (typeof v === typeof w[key]) rec[key] = v;
  }
  return out;
}

/** Wetter-Werte der World Settings ins Objekt übernehmen (neues Wetter-Objekt) */
export function writeWeatherToObject(w: WorldSettings, obj: MapObjectData): void {
  obj.rot = windRotation(w.windDirection);
  for (const [prop, key] of Object.entries(PROP_MAP)) obj.props[prop] = w[key];
}
