import { decode, encode } from 'fast-png';
import { unzipSync, zipSync } from 'fflate';
import { falloffWeight, type Brush } from './sculpt.ts';
import type { LandscapeData, Rect } from './data.ts';

// Layer malen (Splatmap) und Gewichtsmasken als PNG austauschen (wie die Weightmaps in UE5).
// Splat-Koordinaten: ein Texel je splatDiv Gitterpunkte; Ebene 0 = Kanäle 0–3, Ebene 1 (y + SH) = Kanäle 4–7.

export type PaintMode = 'paint' | 'erase' | 'reset';

/** betroffene Splat-Texel eines Pinsels (Ebene 0), null = außerhalb */
export function brushSplatRect(d: LandscapeData, b: Brush): Rect | null {
  const div = d.splatDiv;
  const r = b.radius / div;
  const cx = b.x / div;
  const cz = b.z / div;
  return d.clip({ x: Math.floor(cx - r), y: Math.floor(cz - r), w: Math.ceil(2 * r) + 2, h: Math.ceil(2 * r) + 2 }, d.SW, d.SH);
}

/** gleiche Spalten/Zeilen in Ebene 1 */
export function upperPlane(d: LandscapeData, r: Rect): Rect {
  return { x: r.x, y: r.y + d.SH, w: r.w, h: r.h };
}

/**
 * Malen: Kanal `ch` wächst Richtung 255, die anderen schrumpfen anteilig (Summe bleibt ≤ 255, der Rest gehört den
 * Auto-Regeln). Radieren: nur Kanal `ch` schrumpft. Zurücksetzen: alle Kanäle schrumpfen → wieder Auto-Regeln.
 * Kleine Schritte werden zufällig gerundet, damit auch langsames Malen bei 8 Bit ankommt.
 */
export function paintSplat(d: LandscapeData, b: Brush, r: Rect, ch: number, dt: number, mode: PaintMode): void {
  const s = d.ensureSplat();
  const div = d.splatDiv;
  const SW = d.SW;
  const plane = SW * d.SH * 4;
  const inv = 1 / Math.max(1e-6, b.radius);
  const v = new Float32Array(8);
  const idx = new Int32Array(8);
  for (let sz = r.y; sz < r.y + r.h; sz++) {
    const dz = (sz * div - b.z) * inv;
    for (let sx = r.x; sx < r.x + r.w; sx++) {
      const dx = (sx * div - b.x) * inv;
      const w = falloffWeight(Math.sqrt(dx * dx + dz * dz), b.falloff, b.shape);
      if (w <= 0) continue;
      const a = Math.min(1, w * b.strength * dt * 4);
      const base = (sz * SW + sx) * 4;
      for (let c = 0; c < 8; c++) {
        idx[c] = c < 4 ? base + c : plane + base + c - 4;
        v[c] = s[idx[c]];
      }
      let sum = 0;
      for (let c = 0; c < 8; c++) {
        let t = v[c];
        if (mode === 'paint') t = c === ch ? t + (255 - t) * a : t * (1 - a);
        else if (mode === 'erase') t = c === ch ? t * (1 - a) : t;
        else t *= 1 - a;
        const q = Math.min(255, Math.floor(t + Math.random()));
        v[c] = q;
        sum += q;
      }
      // Rundung kann die Summe über 255 heben: beim Malen gibt der Ziel-Kanal nach, sonst der größte
      while (sum > 255) {
        let k = mode === 'paint' ? ch : 0;
        if (mode !== 'paint' || v[k] === 0) for (let c = 1; c < 8; c++) if (v[c] > v[k]) k = c;
        const cut = Math.min(v[k], sum - 255);
        v[k] -= cut;
        sum -= cut;
      }
      for (let c = 0; c < 8; c++) s[idx[c]] = v[c];
    }
  }
}

/** Kanal komplett leeren (Layer entfernt) */
export function clearChannel(d: LandscapeData, ch: number): void {
  const s = d.splat;
  if (!s) return;
  const off = (ch >> 2) * d.SW * d.SH * 4 + (ch & 3);
  for (let i = 0, n = d.SW * d.SH; i < n; i++) s[off + i * 4] = 0;
}

function fileStem(name: string): string {
  return name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
}

function safeName(name: string): string {
  return name.replace(/[^\wäöüÄÖÜß.\- ]/g, '_') || 'Layer';
}

/** ZIP mit einer 8-Bit-Graustufen-PNG je Layer (Dateiname = Layer-Name), Auflösung SW × SH */
export function exportWeightmaps(d: LandscapeData): Uint8Array {
  const n = d.SW * d.SH;
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  const w = new Float32Array(d.layers.length);
  const maps = d.layers.map(() => new Uint8Array(n));
  // tatsächliche Gewichte (gemalt + Auto) exportieren, nicht nur das Gemalte: so sieht man, was der Shader zeigt
  for (let sz = 0; sz < d.SH; sz++) {
    for (let sx = 0; sx < d.SW; sx++) {
      const lw = d.layerWeights(sx * d.splatDiv, sz * d.splatDiv);
      for (let i = 0; i < lw.length; i++) w[i] = lw[i];
      const k = sz * d.SW + sx;
      for (let i = 0; i < maps.length; i++) maps[i][k] = Math.round(Math.min(1, Math.max(0, w[i])) * 255);
    }
  }
  d.layers.forEach((l, i) => {
    let name = safeName(l.name);
    while (used.has(name.toLowerCase())) name += '_';
    used.add(name.toLowerCase());
    files[`${name}.png`] = encode({ width: d.SW, height: d.SH, data: maps[i], depth: 8, channels: 1 });
  });
  return zipSync(files, { level: 0 });
}

export interface WeightmapImport {
  /** neue Splatmap (komplett) */
  splat: Uint8Array;
  /** zugeordnete Layer-Namen */
  matched: string[];
  /** Dateien ohne passenden Layer */
  unmatched: string[];
}

/**
 * Gewichtsmasken einlesen (PNG-Dateien oder ein ZIP davon). Zuordnung über den Dateinamen (= Layer-Name, ohne
 * Groß-/Kleinschreibung; "Landscape_Fels.png" passt auch). Andere Auflösungen werden bilinear umgerechnet.
 * Layer ohne Datei behalten ihre gemalten Werte; Summen über 100 % werden anteilig gekürzt.
 */
export async function importWeightmaps(d: LandscapeData, files: File[]): Promise<WeightmapImport> {
  const pngs: { name: string; bytes: Uint8Array }[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) {
      for (const [name, b] of Object.entries(unzipSync(bytes))) if (/\.png$/i.test(name)) pngs.push({ name, bytes: b });
    } else if (/\.png$/i.test(f.name)) pngs.push({ name: f.name, bytes });
  }
  if (!pngs.length) throw new Error('Keine PNG-Dateien gefunden.');
  const SW = d.SW;
  const SH = d.SH;
  const n = SW * SH;
  const out = d.splat ? d.splat.slice() : new Uint8Array(n * 8);
  const plane = n * 4;
  const matched: string[] = [];
  const unmatched: string[] = [];
  const replaced = new Set<number>();
  for (const p of pngs) {
    const stem = fileStem(p.name).toLowerCase();
    const layer =
      d.layers.find((l) => safeName(l.name).toLowerCase() === stem || l.name.toLowerCase() === stem) ??
      d.layers.find((l) => stem.endsWith('_' + l.name.toLowerCase()) || stem.endsWith('_' + safeName(l.name).toLowerCase()));
    if (!layer || replaced.has(layer.ch)) {
      unmatched.push(fileStem(p.name));
      continue;
    }
    const img = decode(p.bytes);
    const max = img.depth === 16 ? 65535 : (1 << img.depth) - 1;
    const ch = img.channels;
    const src = img.data;
    const at = (x: number, y: number) => src[(y * img.width + x) * ch] / max;
    const off = (layer.ch >> 2) * plane + (layer.ch & 3);
    for (let sz = 0; sz < SH; sz++) {
      const fy = SH > 1 ? (sz / (SH - 1)) * (img.height - 1) : 0;
      const y0 = Math.floor(fy);
      const y1 = Math.min(img.height - 1, y0 + 1);
      const ty = fy - y0;
      for (let sx = 0; sx < SW; sx++) {
        const fx = SW > 1 ? (sx / (SW - 1)) * (img.width - 1) : 0;
        const x0 = Math.floor(fx);
        const x1 = Math.min(img.width - 1, x0 + 1);
        const tx = fx - x0;
        const val = (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
        out[off + (sz * SW + sx) * 4] = Math.round(val * 255);
      }
    }
    replaced.add(layer.ch);
    matched.push(layer.name);
  }
  // Summe je Texel auf ≤ 255 begrenzen
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < 8; c++) sum += out[(c >> 2) * plane + i * 4 + (c & 3)];
    if (sum <= 255) continue;
    const k = 255 / sum;
    for (let c = 0; c < 8; c++) {
      const j = (c >> 2) * plane + i * 4 + (c & 3);
      out[j] = Math.floor(out[j] * k);
    }
  }
  return { splat: out, matched, unmatched };
}
