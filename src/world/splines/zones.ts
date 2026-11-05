import * as THREE from 'three';
import type { SurfaceId } from '../surfaces.ts';

// Straßen-Zonen (Welt-Koordinaten): Spiel und Editor fragen hier, ob an einer Stelle eine Straße liegt —
// Layer-Gras wächst dort nicht, Schritte klingen nach dem Belag der Straße.

export interface RoadZone {
  /** Mittellinie (Welt): x, y, z je Stützstelle */
  line: Float32Array;
  /** halbe Breite je Stützstelle (m) */
  half: Float32Array;
  /** zusätzlicher Rand ohne Gras (m) */
  margin: number;
  /** Belag (Schritte, Einschläge) */
  surface: SurfaceId;
  /** Gras unter der Straße entfernen */
  clearGrass: boolean;
  /** Hülle (inkl. Rand) */
  box: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Teilhüllen je 16 Segmente (Beschleunigung) */
  chunks: { from: number; to: number; minX: number; maxX: number; minZ: number; maxZ: number }[];
}

type ZoneListener = (box: { minX: number; maxX: number; minZ: number; maxZ: number }) => void;

const zones = new Map<string, RoadZone>();
const listeners = new Set<ZoneListener>();

/** Zone aus Mittellinie und halben Breiten bauen */
export function makeRoadZone(points: THREE.Vector3[], half: number[], margin: number, surface: SurfaceId, clearGrass: boolean): RoadZone {
  const n = points.length;
  const line = new Float32Array(n * 3);
  const hw = new Float32Array(n);
  let maxHalf = 0;
  for (let i = 0; i < n; i++) {
    line[i * 3] = points[i].x;
    line[i * 3 + 1] = points[i].y;
    line[i * 3 + 2] = points[i].z;
    hw[i] = half[i];
    maxHalf = Math.max(maxHalf, half[i]);
  }
  const pad = maxHalf + margin;
  const chunks: RoadZone['chunks'] = [];
  const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let a = 0; a < n - 1; a += 16) {
    const b = Math.min(n - 1, a + 16);
    const c = { from: a, to: b, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (let i = a; i <= b; i++) {
      c.minX = Math.min(c.minX, line[i * 3] - pad);
      c.maxX = Math.max(c.maxX, line[i * 3] + pad);
      c.minZ = Math.min(c.minZ, line[i * 3 + 2] - pad);
      c.maxZ = Math.max(c.maxZ, line[i * 3 + 2] + pad);
    }
    chunks.push(c);
    box.minX = Math.min(box.minX, c.minX);
    box.maxX = Math.max(box.maxX, c.maxX);
    box.minZ = Math.min(box.minZ, c.minZ);
    box.maxZ = Math.max(box.maxZ, c.maxZ);
  }
  return { line, half: hw, margin, surface, clearGrass, box, chunks };
}

/** Zone setzen/ersetzen (null = entfernen); meldet den betroffenen Bereich */
export function setRoadZone(id: string, z: RoadZone | null): void {
  const old = zones.get(id);
  if (!old && !z) return;
  if (z) zones.set(id, z);
  else zones.delete(id);
  const boxes = [old?.box, z?.box].filter((b): b is RoadZone['box'] => !!b && Number.isFinite(b.minX));
  for (const b of boxes) for (const fn of listeners) fn(b);
}

export function onRoadZonesChanged(fn: ZoneListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Seitlicher Abstand zur Mittellinie minus halbe Breite (≤ 0 = auf der Straße) und Höhe der Mittellinie dort.
 * null, wenn die Stelle außerhalb von `pad` liegt.
 */
function query(z: RoadZone, x: number, zz: number, pad: number): { d: number; y: number } | null {
  const b = z.box;
  if (x < b.minX || x > b.maxX || zz < b.minZ || zz > b.maxZ) return null;
  const L = z.line;
  let best: { d: number; y: number } | null = null;
  for (const c of z.chunks) {
    if (x < c.minX || x > c.maxX || zz < c.minZ || zz > c.maxZ) continue;
    for (let i = c.from; i < c.to; i++) {
      const ax = L[i * 3];
      const az = L[i * 3 + 2];
      const bx = L[i * 3 + 3];
      const bz = L[i * 3 + 5];
      const vx = bx - ax;
      const vz = bz - az;
      const len2 = vx * vx + vz * vz;
      let u = len2 > 1e-9 ? ((x - ax) * vx + (zz - az) * vz) / len2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = x - (ax + vx * u);
      const dz = zz - (az + vz * u);
      const d = Math.sqrt(dx * dx + dz * dz) - (z.half[i] * (1 - u) + z.half[i + 1] * u);
      if (d <= pad && (!best || d < best.d)) best = { d, y: L[i * 3 + 1] * (1 - u) + L[i * 3 + 4] * u };
    }
  }
  return best;
}

/** Anteil (0..1), um den Layer-Gras an der Stelle (Welt) entfernt wird */
export function grassClearAt(x: number, z: number): number {
  let clear = 0;
  for (const zone of zones.values()) {
    if (!zone.clearGrass) continue;
    const q = query(zone, x, z, zone.margin);
    if (!q) continue;
    const c = q.d <= 0 ? 1 : 1 - q.d / Math.max(0.01, zone.margin);
    if (c > clear) clear = c;
    if (clear >= 1) return 1;
  }
  return clear;
}

/** Belag einer Straße unter den Füßen (Welt), sonst null */
export function roadSurfaceAt(p: THREE.Vector3): SurfaceId | null {
  for (const zone of zones.values()) {
    const q = query(zone, p.x, p.z, 0.05);
    if (q && Math.abs(p.y - q.y) < 1.2) return zone.surface;
  }
  return null;
}

/** alles verwerfen (Map-Wechsel) */
export function clearRoadZones(): void {
  for (const id of [...zones.keys()]) setRoadZone(id, null);
}
