import { decode, encode } from 'fast-png';
import type { LandscapeData } from './data.ts';

// Heightmap-Import/Export: 16-bit Graustufen-PNG und RAW (.r16, little-endian, quadratisch).
// Werte 0..65535 bilden den Bereich min..max (Meter) ab; im PNG stehen min/max zusätzlich als Text-Chunk,
// damit ein Re-Import ohne Nachfragen die gleichen Höhen ergibt.

export interface Heightmap {
  width: number;
  height: number;
  /** 0..1, Zeile für Zeile (+Z = nach unten im Bild) */
  values: Float32Array;
  /** aus dem PNG (falls von hier exportiert) */
  min?: number;
  max?: number;
}

const TEXT_MIN = 'bodycam:min';
const TEXT_MAX = 'bodycam:max';

function range(d: LandscapeData): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of d.heights) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 1e-3) max = min + 1;
  return { min, max };
}

function quantize(d: LandscapeData, min: number, max: number): Uint16Array {
  const out = new Uint16Array(d.heights.length);
  const k = 65535 / (max - min);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(65535, Math.round((d.heights[i] - min) * k)));
  return out;
}

export function exportPng16(d: LandscapeData): { bytes: Uint8Array; min: number; max: number } {
  const { min, max } = range(d);
  const bytes = encode({ width: d.VW, height: d.VH, data: quantize(d, min, max), depth: 16, channels: 1, text: { [TEXT_MIN]: String(min), [TEXT_MAX]: String(max) } });
  return { bytes, min, max };
}

export function exportR16(d: LandscapeData): { bytes: Uint8Array; min: number; max: number } {
  const { min, max } = range(d);
  const q = quantize(d, min, max);
  const bytes = new Uint8Array(q.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < q.length; i++) view.setUint16(i * 2, q[i], true);
  return { bytes, min, max };
}

export async function readHeightmap(file: File): Promise<Heightmap> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith('.png')) {
    const png = decode(bytes);
    const n = png.width * png.height;
    const values = new Float32Array(n);
    const max = png.depth === 16 ? 65535 : (1 << png.depth) - 1;
    const ch = png.channels;
    // Mehrkanal: erster Kanal (Graustufen-Export aus anderen Programmen ist meist RGB mit gleichen Werten)
    for (let i = 0; i < n; i++) values[i] = png.data[i * ch] / max;
    const tmin = Number(png.text?.[TEXT_MIN]);
    const tmax = Number(png.text?.[TEXT_MAX]);
    return { width: png.width, height: png.height, values, ...(Number.isFinite(tmin) && Number.isFinite(tmax) && png.text?.[TEXT_MIN] !== undefined ? { min: tmin, max: tmax } : {}) };
  }
  if (name.endsWith('.r16') || name.endsWith('.raw')) {
    const n = bytes.byteLength / 2;
    const side = Math.round(Math.sqrt(n));
    if (side * side !== n) throw new Error('RAW-Datei ist nicht quadratisch (erwartet: Seite × Seite × 16 bit)');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) values[i] = view.getUint16(i * 2, true) / 65535;
    return { width: side, height: side, values };
  }
  throw new Error('Unbekanntes Format — erwartet .png (16 bit) oder .r16/.raw');
}

/** Heightmap auf das Gitter der Landscape abbilden (bilinear, falls die Größe nicht passt) */
export function heightsFromMap(m: Heightmap, VW: number, VH: number, min: number, max: number): Float32Array {
  const out = new Float32Array(VW * VH);
  const sx = (m.width - 1) / Math.max(1, VW - 1);
  const sy = (m.height - 1) / Math.max(1, VH - 1);
  const range = max - min;
  for (let z = 0; z < VH; z++) {
    const fy = z * sy;
    const y0 = Math.min(m.height - 1, Math.floor(fy));
    const y1 = Math.min(m.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < VW; x++) {
      const fx = x * sx;
      const x0 = Math.min(m.width - 1, Math.floor(fx));
      const x1 = Math.min(m.width - 1, x0 + 1);
      const tx = fx - x0;
      const v =
        (m.values[y0 * m.width + x0] * (1 - tx) + m.values[y0 * m.width + x1] * tx) * (1 - ty) +
        (m.values[y1 * m.width + x0] * (1 - tx) + m.values[y1 * m.width + x1] * tx) * ty;
      out[z * VW + x] = min + v * range;
    }
  }
  return out;
}

export function downloadBytes(bytes: Uint8Array, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
