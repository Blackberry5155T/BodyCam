import * as THREE from 'three';
import { deflateSync, inflateSync } from 'fflate';
import type { DataEdit } from '../../editor/history.ts';
import type { FoliageType } from './types.ts';

// Foliage-Instanzen: je Typ in 64-m-Zellen (lokale Koordinaten des Foliage-Objekts).
// Eine Instanz = 7 Floats: x, y, z, Drehung (rad), Skalierung, Hochachse x/z (Ausrichtung an der Oberfläche).
// Adressierbar als (Typ, Zelle, Index) — Index ändert sich beim Löschen (Swap-Remove).

export const CELL = 64;
export const STRIDE = 7;

export interface FoliageCell {
  data: Float32Array;
  n: number;
  /** zwischengespeicherte Instanz-Matrizen (16 Floats je Instanz), null = veraltet */
  mats: Float32Array | null;
}

export const cellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);
export const cellX = (key: number) => Math.floor(key / 65536) - 32768;
export const cellZ = (key: number) => (key % 65536) - 32768;
export const cellOf = (v: number) => Math.floor(v / CELL);

export type FoliageChange = 'instances' | 'types';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);

export class FoliageData {
  types: FoliageType[];
  /** Typ-ID → Zellen */
  readonly cells = new Map<string, Map<number, FoliageCell>>();
  revision = 0;
  private listeners = new Set<(kind: FoliageChange) => void>();

  constructor(types: FoliageType[] = []) {
    this.types = types;
  }

  type(id: string): FoliageType | undefined {
    return this.types.find((t) => t.id === id);
  }

  onChange(fn: (kind: FoliageChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(kind: FoliageChange = 'instances'): void {
    this.revision++;
    for (const fn of this.listeners) fn(kind);
  }

  setTypes(types: FoliageType[]): void {
    this.types = types;
    for (const id of [...this.cells.keys()]) if (!types.some((t) => t.id === id)) this.cells.delete(id);
    this.changed('types');
  }

  cellsOf(typeId: string): Map<number, FoliageCell> {
    let m = this.cells.get(typeId);
    if (!m) this.cells.set(typeId, (m = new Map()));
    return m;
  }

  getCell(typeId: string, key: number): FoliageCell | undefined {
    return this.cells.get(typeId)?.get(key);
  }

  /** Inhalt einer Zelle (Kopie) — für Undo */
  snapshot(typeId: string, key: number): Float32Array | null {
    const c = this.getCell(typeId, key);
    return c && c.n ? c.data.slice(0, c.n * STRIDE) : null;
  }

  /** Zelle ersetzen (Undo/Redo, Laden) */
  setCell(typeId: string, key: number, data: Float32Array | null): void {
    const m = this.cellsOf(typeId);
    if (!data || !data.length) {
      m.delete(key);
      return;
    }
    m.set(key, { data: data.slice(), n: Math.floor(data.length / STRIDE), mats: null });
  }

  add(typeId: string, x: number, y: number, z: number, yaw: number, scale: number, upX: number, upZ: number): void {
    const key = cellKey(cellOf(x), cellOf(z));
    const m = this.cellsOf(typeId);
    let c = m.get(key);
    if (!c) m.set(key, (c = { data: new Float32Array(STRIDE * 16), n: 0, mats: null }));
    if ((c.n + 1) * STRIDE > c.data.length) {
      const bigger = new Float32Array(c.data.length * 2);
      bigger.set(c.data);
      c.data = bigger;
    }
    const o = c.n * STRIDE;
    const d = c.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = yaw;
    d[o + 4] = scale;
    d[o + 5] = upX;
    d[o + 6] = upZ;
    c.n++;
    c.mats = null;
  }

  /** Instanz i einer Zelle entfernen (letzte rückt nach) */
  removeAt(typeId: string, key: number, i: number): void {
    const c = this.getCell(typeId, key);
    if (!c || i >= c.n) return;
    c.n--;
    if (i !== c.n) c.data.copyWithin(i * STRIDE, c.n * STRIDE, c.n * STRIDE + STRIDE);
    c.mats = null;
    if (!c.n) this.cells.get(typeId)!.delete(key);
  }

  /** Zellen-Schlüssel, die einen Kreis (x, z, r) berühren */
  keysInCircle(x: number, z: number, r: number): number[] {
    const out: number[] = [];
    const x0 = cellOf(x - r);
    const x1 = cellOf(x + r);
    const z0 = cellOf(z - r);
    const z1 = cellOf(z + r);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) out.push(cellKey(cx, cz));
    return out;
  }

  /** gibt es eine Instanz des Typs näher als r? */
  anyWithin(typeId: string, x: number, z: number, r: number): boolean {
    if (r <= 0) return false;
    const m = this.cells.get(typeId);
    if (!m) return false;
    const r2 = r * r;
    for (const k of this.keysInCircle(x, z, r)) {
      const c = m.get(k);
      if (!c) continue;
      const d = c.data;
      for (let i = 0, o = 0; i < c.n; i++, o += STRIDE) {
        const dx = d[o] - x;
        const dz = d[o + 2] - z;
        if (dx * dx + dz * dz < r2) return true;
      }
    }
    return false;
  }

  count(typeId?: string): number {
    let n = 0;
    for (const [id, m] of this.cells) {
      if (typeId && id !== typeId) continue;
      for (const c of m.values()) n += c.n;
    }
    return n;
  }

  /** Instanz-Matrizen einer Zelle (lazy, bleiben bis zur nächsten Änderung) */
  matrices(c: FoliageCell): Float32Array {
    if (c.mats && c.mats.length >= c.n * 16) return c.mats;
    const out = new Float32Array(Math.max(16, c.n * 16));
    const d = c.data;
    for (let i = 0, o = 0; i < c.n; i++, o += STRIDE) {
      composeInstance(d, o, _m);
      _m.toArray(out, i * 16);
    }
    c.mats = out;
    return out;
  }

  clone(): FoliageData {
    const d = new FoliageData(this.types.map((t) => ({ ...t })));
    for (const [id, m] of this.cells) {
      const cm = d.cellsOf(id);
      for (const [k, c] of m) cm.set(k, { data: c.data.slice(0, c.n * STRIDE), n: c.n, mats: null });
    }
    return d;
  }
}

/** Matrix einer Instanz: T · Ausrichtung · Drehung · Skalierung */
export function composeInstance(d: Float32Array, o: number, out: THREE.Matrix4): THREE.Matrix4 {
  const ux = d[o + 5];
  const uz = d[o + 6];
  const uy = Math.sqrt(Math.max(0, 1 - ux * ux - uz * uz));
  _qy.setFromAxisAngle(_Y, d[o + 3]);
  if (ux || uz) _q.setFromUnitVectors(_Y, _up.set(ux, uy, uz)).multiply(_qy);
  else _q.copy(_qy);
  const s = d[o + 4];
  return out.compose(_pos.set(d[o], d[o + 1], d[o + 2]), _q, _scl.set(s, s, s));
}

// ---------- Blob ----------

const MAGIC = 0x314c4f46; // "FOL1"

/** alle Instanzen → komprimierter Blob (null, wenn leer) */
export function encodeFoliage(data: FoliageData): Uint8Array | null {
  const enc = new TextEncoder();
  const parts: { id: Uint8Array; floats: Float32Array }[] = [];
  for (const [id, m] of data.cells) {
    let n = 0;
    for (const c of m.values()) n += c.n;
    if (!n) continue;
    const floats = new Float32Array(n * STRIDE);
    let o = 0;
    for (const c of m.values()) {
      floats.set(c.data.subarray(0, c.n * STRIDE), o);
      o += c.n * STRIDE;
    }
    parts.push({ id: enc.encode(id), floats });
  }
  if (!parts.length) return null;
  let size = 8;
  for (const p of parts) size += 8 + Math.ceil(p.id.length / 4) * 4 + p.floats.byteLength;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, parts.length, true);
  let o = 8;
  for (const p of parts) {
    dv.setUint32(o, p.id.length, true);
    dv.setUint32(o + 4, p.floats.length / STRIDE, true);
    bytes.set(p.id, o + 8);
    o += 8 + Math.ceil(p.id.length / 4) * 4;
    bytes.set(new Uint8Array(p.floats.buffer, p.floats.byteOffset, p.floats.byteLength), o);
    o += p.floats.byteLength;
  }
  return deflateSync(bytes, { level: 6 });
}

export function decodeFoliage(blob: Uint8Array, into: FoliageData): void {
  const bytes = inflateSync(blob);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Foliage-Daten: unbekanntes Format');
  const n = dv.getUint32(4, true);
  const dec = new TextDecoder();
  let o = 8;
  for (let p = 0; p < n; p++) {
    const idLen = dv.getUint32(o, true);
    const count = dv.getUint32(o + 4, true);
    const id = dec.decode(bytes.subarray(o + 8, o + 8 + idLen));
    o += 8 + Math.ceil(idLen / 4) * 4;
    const floats = new Float32Array(bytes.buffer.slice(bytes.byteOffset + o, bytes.byteOffset + o + count * STRIDE * 4));
    o += count * STRIDE * 4;
    for (let i = 0; i < count; i++) {
      const b = i * STRIDE;
      into.add(id, floats[b], floats[b + 1], floats[b + 2], floats[b + 3], floats[b + 4], floats[b + 5], floats[b + 6]);
    }
  }
}

// ---------- Undo ----------

/** Merkt sich betroffene Zellen vor einer Änderung; finish() liefert den Undo-Schritt */
export class CellRecorder {
  private before = new Map<string, { typeId: string; key: number; data: Float32Array | null }>();

  constructor(private readonly data: FoliageData) {}

  touch(typeId: string, key: number): void {
    const k = `${typeId}|${key}`;
    if (!this.before.has(k)) this.before.set(k, { typeId, key, data: this.data.snapshot(typeId, key) });
  }

  get empty(): boolean {
    return this.before.size === 0;
  }

  finish(label: string, onApply: () => void = () => {}): DataEdit | null {
    if (!this.before.size) return null;
    const data = this.data;
    const entries = [...this.before.values()].map((b) => ({ ...b, after: data.snapshot(b.typeId, b.key) }));
    let bytes = 0;
    for (const e of entries) bytes += ((e.data?.byteLength ?? 0) + (e.after?.byteLength ?? 0)) + 32;
    const apply = (which: 'data' | 'after') => {
      for (const e of entries) data.setCell(e.typeId, e.key, e[which]);
      data.changed('instances');
      onApply();
    };
    this.before.clear();
    return { label, bytes, undo: () => apply('data'), redo: () => apply('after') };
  }
}
