import * as THREE from 'three';
import { deflateSync, inflateSync } from 'fflate';
import type { SurfaceId } from '../surfaces.ts';
import { MAX_LAYERS, autoCoverage, autoNoise, cloneLayers, defaultLayers, type LandscapeLayer } from './layers.ts';

// Höhendaten einer Landscape (wie in UE5: Raster aus Komponenten à 128 × 128 Quads).
// Koordinaten: lokales Raster, Ursprung = Mitte der Landscape (Objektposition), x nach +X, z nach +Z.
// Gitterpunkt (ix, iz) liegt bei ((ix - W/2) · q, h, (iz - H/2) · q).
// heights: (W+1)·(H+1) Werte, zeilenweise (iz · (W+1) + ix), Meter relativ zur Objekthöhe.
// holes: Loch-Zellen, 1 = Loch (kein Rendering, keine Kollision). Jedes Quad ist in holeSub × holeSub Zellen
// geteilt (Loch-Auflösung, je Landscape einstellbar): HW = W · holeSub Zellen je Zeile, HH = H · holeSub Zeilen.
// layers/splat: Material-Layer und gemalte Gewichte (Splatmap). Die Splatmap hat SW × SH Punkte (bei großen
// Landscapes jeder zweite Gitterpunkt) und 8 Kanäle in zwei RGBA-Ebenen übereinander: Zeilen 0..SH-1 = Kanäle
// 0–3, Zeilen SH..2·SH-1 = Kanäle 4–7. Summe der Kanäle ≤ 255; der Rest gehört den Auto-Regeln.
// grassMask: im Foliage-Modus radiertes Layer-Gras, SW × SH Bytes (0 = Gras wie vom Layer, 255 = kein Gras).
// base/deforms (nur Editor): Straßen-Splines formen das Gelände nicht-destruktiv. Solange Verformungen aktiv sind,
// hält `base` die gemalten Höhen und `heights` ist base + Verformungen (gespeichert wird beides, das Spiel nutzt
// nur heights). Werkzeuge schreiben deshalb in `editHeights`.

export const COMPONENT_QUADS = 128;
/** Kantenlänge eines Min/Max-Blocks (= kleinster CDLOD-Knoten) in Quads */
export const BLOCK = 32;
export const MAX_QUADS = 8192;
/** mögliche Loch-Unterteilungen je Quad-Kante */
export const HOLE_SUBS = [1, 2, 4, 8] as const;
/** Obergrenzen für das Loch-Raster (1 Byte je Zelle in CPU + GPU; maximale Texturgröße) */
export const MAX_HOLE_CELLS = 1 << 26;
export const MAX_HOLE_DIM = 16384;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * height: Rechteck in Gitterpunkten · holes: in Loch-Zellen · holeRes: Loch-Auflösung geändert (ganze Fläche)
 * splat: Rechteck in Splat-Texeln (beide Ebenen, y bis 2·SH) · layers: Layer-Liste geändert
 * grass: Rechteck in Splat-Texeln (Gras-Maske, eine Ebene)
 */
export type ChangeKind = 'height' | 'holes' | 'holeRes' | 'splat' | 'layers' | 'grass';
export type ChangeListener = (r: Rect, kind: ChangeKind) => void;

/** Höhen-Verformung (z. B. Straße): zieht das Gelände im Rechteck mit `weight` auf `target` */
export interface HeightDeform {
  /** Rechteck in Gitterpunkten */
  rect: Rect;
  /** Zielhöhe (m, lokal) und Gewicht 0..1 je Gitterpunkt im Rechteck (zeilenweise, rect.w breit) */
  target: Float32Array;
  weight: Float32Array;
  /** Reihenfolge (kleinere zuerst, spätere gewinnen) */
  order: number;
}

export class LandscapeData {
  readonly W: number;
  readonly H: number;
  readonly VW: number;
  readonly VH: number;
  readonly heights: Float32Array;
  holes: Uint8Array;
  /** Loch-Zellen je Quad-Kante (1, 2, 4, 8) */
  holeSub: number;
  /** Min/Max je BLOCK×BLOCK-Quads, Pyramide: Stufe 0 = Blöcke, jede weitere Stufe halbiert */
  readonly minMax: { w: number; h: number; min: Float32Array; max: Float32Array }[] = [];
  /** Anzahl Loch-Zellen je Komponente (für Kollision: Heightfield oder Trimesh) */
  readonly compHoles: Uint32Array;
  readonly compX: number;
  readonly compZ: number;
  private listeners = new Set<ChangeListener>();
  /** Erhöht sich bei jeder Änderung (für "muss gespeichert werden") */
  revision = 0;
  /** Material-Layer (Index 0 = Basis) */
  layers: LandscapeLayer[];
  /** gemalte Layer-Gewichte; null = noch nichts gemalt (nur Auto-Regeln) */
  splat: Uint8Array | null = null;
  /** radiertes Layer-Gras (SW × SH, 255 = entfernt); null = nichts radiert */
  grassMask: Uint8Array | null = null;
  /** gemalte Höhen, solange Verformungen aktiv sind (sonst null: heights sind die gemalten Höhen) */
  base: Float32Array | null = null;
  /** aktive Verformungen (Straßen-Splines) */
  readonly deforms = new Map<string, HeightDeform>();

  constructor(
    compX: number,
    compZ: number,
    public quadSize: number,
    heights?: Float32Array,
    holes?: Uint8Array,
    holeSub = 1,
    layers?: LandscapeLayer[],
    splat?: Uint8Array | null,
  ) {
    this.compX = compX;
    this.compZ = compZ;
    this.W = compX * COMPONENT_QUADS;
    this.H = compZ * COMPONENT_QUADS;
    this.VW = this.W + 1;
    this.VH = this.H + 1;
    this.heights = heights ?? new Float32Array(this.VW * this.VH);
    this.holeSub = holeSub;
    this.holes = holes ?? new Uint8Array(this.HW * this.HH);
    if (this.holes.length !== this.HW * this.HH) throw new Error('Lochdaten passen nicht zur Loch-Auflösung');
    this.compHoles = new Uint32Array(compX * compZ);
    this.layers = layers ?? defaultLayers();
    if (splat && splat.length === this.SW * this.SH * 8) this.splat = splat;
    let bw = this.W / BLOCK;
    let bh = this.H / BLOCK;
    for (;;) {
      this.minMax.push({ w: bw, h: bh, min: new Float32Array(bw * bh), max: new Float32Array(bw * bh) });
      if (bw === 1 && bh === 1) break;
      bw = Math.ceil(bw / 2);
      bh = Math.ceil(bh / 2);
    }
    this.updateBounds({ x: 0, y: 0, w: this.VW, h: this.VH });
    this.updateHoleCounts({ x: 0, y: 0, w: this.HW, h: this.HH });
  }

  /** Loch-Zellen je Zeile / Anzahl Zeilen */
  get HW(): number {
    return this.W * this.holeSub;
  }
  get HH(): number {
    return this.H * this.holeSub;
  }

  /** Feinste Loch-Auflösung, die für diese Landscape-Größe erlaubt ist */
  maxHoleSub(): number {
    let best = 1;
    for (const s of HOLE_SUBS) if (this.W * s * this.H * s <= MAX_HOLE_CELLS && Math.max(this.W, this.H) * s <= MAX_HOLE_DIM) best = s;
    return best;
  }

  /**
   * Loch-Auflösung ändern. Ohne `holes` wird das bestehende Raster umgerechnet (feiner: exakt;
   * gröber: Zelle wird Loch, wenn mindestens die Hälfte ihrer Teilzellen Loch war).
   */
  setHoleSub(sub: number, holes?: Uint8Array): void {
    if (sub === this.holeSub && !holes) return;
    const nw = this.W * sub;
    const nh = this.H * sub;
    const out = holes ?? resampleHoles(this.holes, this.HW, this.HH, this.holeSub, sub);
    if (out.length !== nw * nh) throw new Error('Lochdaten passen nicht zur Loch-Auflösung');
    this.holeSub = sub;
    this.holes = out;
    this.revision++;
    const full = { x: 0, y: 0, w: nw, h: nh };
    this.updateHoleCounts(full);
    for (const fn of this.listeners) fn(full, 'holeRes');
  }

  get sizeX(): number {
    return this.W * this.quadSize;
  }
  get sizeZ(): number {
    return this.H * this.quadSize;
  }

  clone(): LandscapeData {
    const c = new LandscapeData(this.compX, this.compZ, this.quadSize, this.heights.slice(), this.holes.slice(), this.holeSub, cloneLayers(this.layers), this.splat?.slice() ?? null);
    c.grassMask = this.grassMask?.slice() ?? null;
    c.base = this.base?.slice() ?? null;
    return c;
  }

  // ---------- Verformungen (Straßen) ----------

  /** Höhen, in die Werkzeuge schreiben (gemalte Höhen ohne Straßen) */
  get editHeights(): Float32Array {
    return this.base ?? this.heights;
  }

  /** Verformung setzen/ersetzen (null = entfernen) und den betroffenen Bereich neu zusammensetzen */
  setDeform(id: string, def: HeightDeform | null): void {
    const old = this.deforms.get(id);
    if (!old && !def) return;
    if (!this.base) this.base = this.heights.slice();
    if (def) this.deforms.set(id, def);
    else this.deforms.delete(id);
    let r = old?.rect ?? def!.rect;
    if (old && def) {
      const x0 = Math.min(old.rect.x, def.rect.x);
      const y0 = Math.min(old.rect.y, def.rect.y);
      r = { x: x0, y: y0, w: Math.max(old.rect.x + old.rect.w, def.rect.x + def.rect.w) - x0, h: Math.max(old.rect.y + old.rect.h, def.rect.y + def.rect.h) - y0 };
    }
    const c = this.clip(r);
    if (c) this.recompose(c);
    if (!this.deforms.size) this.base = null;
    if (!c) return;
    this.revision++;
    this.updateBounds(c);
    for (const fn of this.listeners) fn(c, 'height');
  }

  /** alle Verformungen entfernen (heights = gemalte Höhen) */
  clearDeforms(): void {
    if (!this.base) return;
    this.deforms.clear();
    this.heights.set(this.base);
    this.base = null;
    const full = { x: 0, y: 0, w: this.VW, h: this.VH };
    this.revision++;
    this.updateBounds(full);
    for (const fn of this.listeners) fn(full, 'height');
  }

  /** heights = base + Verformungen im Rechteck */
  private recompose(r: Rect): void {
    const base = this.base;
    if (!base) return;
    const hs = this.heights;
    const VW = this.VW;
    for (let z = r.y; z < r.y + r.h; z++) {
      const row = z * VW;
      hs.set(base.subarray(row + r.x, row + r.x + r.w), row + r.x);
    }
    const list = [...this.deforms.values()].sort((a, b) => a.order - b.order);
    for (const d of list) {
      const x0 = Math.max(r.x, d.rect.x);
      const z0 = Math.max(r.y, d.rect.y);
      const x1 = Math.min(r.x + r.w, d.rect.x + d.rect.w);
      const z1 = Math.min(r.y + r.h, d.rect.y + d.rect.h);
      for (let z = z0; z < z1; z++) {
        const row = z * VW;
        const drow = (z - d.rect.y) * d.rect.w - d.rect.x;
        for (let x = x0; x < x1; x++) {
          const w = d.weight[drow + x];
          if (w > 0) hs[row + x] += (d.target[drow + x] - hs[row + x]) * w;
        }
      }
    }
  }

  // ---------- Gras-Maske ----------

  /** Gras-Maske anlegen, falls noch keine existiert (vor dem ersten Radieren) */
  ensureGrassMask(): Uint8Array {
    if (!this.grassMask) this.grassMask = new Uint8Array(this.SW * this.SH);
    return this.grassMask;
  }

  /** ganze Gras-Maske ersetzen (Import) */
  setGrassMask(m: Uint8Array | null): void {
    if (m && m.length !== this.SW * this.SH) throw new Error('Gras-Maske passt nicht zur Landscape-Größe');
    this.grassMask = m;
    this.revision++;
    for (const fn of this.listeners) fn({ x: 0, y: 0, w: this.SW, h: this.SH }, 'grass');
  }

  /** verbleibender Gras-Anteil (0..1) an einer Gitterkoordinate, bilinear */
  grassAt(gx: number, gz: number): number {
    const m = this.grassMask;
    if (!m) return 1;
    const div = this.splatDiv;
    const SW = this.SW;
    const x = Math.min(SW - 1, Math.max(0, gx / div));
    const z = Math.min(this.SH - 1, Math.max(0, gz / div));
    const ix = Math.min(SW - 2, Math.floor(x));
    const iz = Math.min(this.SH - 2, Math.floor(z));
    const fx = x - ix;
    const fz = z - iz;
    const i = iz * SW + ix;
    const v = (m[i] * (1 - fx) + m[i + 1] * fx) * (1 - fz) + (m[i + SW] * (1 - fx) + m[i + SW + 1] * fx) * fz;
    return 1 - v / 255;
  }

  // ---------- Layer & Splatmap ----------

  /** Gitterpunkte je Splat-Texel (große Landscapes: 2) */
  get splatDiv(): number {
    return Math.max(this.W, this.H) > 4096 ? 2 : 1;
  }
  get SW(): number {
    return this.W / this.splatDiv + 1;
  }
  get SH(): number {
    return this.H / this.splatDiv + 1;
  }

  /** Byte-Index von Kanal `ch` am Splat-Texel (sx, sz) */
  splatIndex(ch: number, sx: number, sz: number): number {
    return (((ch >> 2) * this.SH + sz) * this.SW + sx) * 4 + (ch & 3);
  }

  /** Splatmap anlegen, falls noch keine existiert (vor dem ersten Malen) */
  ensureSplat(): Uint8Array {
    if (!this.splat) {
      this.splat = new Uint8Array(this.SW * this.SH * 8);
      for (const fn of this.listeners) fn({ x: 0, y: 0, w: this.SW, h: this.SH * 2 }, 'splat');
    }
    return this.splat;
  }

  /** ganze Splatmap ersetzen (Import, Rückgängig) */
  setSplat(splat: Uint8Array | null): void {
    if (splat && splat.length !== this.SW * this.SH * 8) throw new Error('Splatmap passt nicht zur Landscape-Größe');
    this.splat = splat;
    this.revision++;
    for (const fn of this.listeners) fn({ x: 0, y: 0, w: this.SW, h: this.SH * 2 }, 'splat');
  }

  setLayers(layers: LandscapeLayer[]): void {
    this.layers = layers.slice(0, MAX_LAYERS);
    this.revision++;
    for (const fn of this.listeners) fn({ x: 0, y: 0, w: this.VW, h: this.VH }, 'layers');
  }

  /** Abstand (Gitterpunkte) für die Krümmungsmessung der Auto-Regeln: ca. 4 m */
  curvStep(): number {
    return Math.max(1, Math.round(4 / this.quadSize));
  }

  /** Neigung (Grad), Höhe, Krümmung (> 0 Kuppe) und Rauschen an einer Gitterkoordinate — wie im Shader */
  autoInputs(gx: number, gz: number): { slope: number; height: number; curv: number; noise: number } {
    const q = this.quadSize;
    const e = 0.5;
    const dx = (this.heightAtGrid(gx + e, gz) - this.heightAtGrid(gx - e, gz)) / (2 * e * q);
    const dz = (this.heightAtGrid(gx, gz + e) - this.heightAtGrid(gx, gz - e)) / (2 * e * q);
    const slope = (Math.acos(1 / Math.sqrt(dx * dx + dz * dz + 1)) * 180) / Math.PI;
    const height = this.heightAtGrid(gx, gz);
    const s = this.curvStep();
    const avg = (this.heightAtGrid(gx + s, gz) + this.heightAtGrid(gx - s, gz) + this.heightAtGrid(gx, gz + s) + this.heightAtGrid(gx, gz - s)) / 4;
    return { slope, height, curv: (height - avg) / (s * q), noise: autoNoise(gx * q, gz * q) };
  }

  /** Layer-Gewichte (Summe 1, Reihenfolge wie layers) an einer Gitterkoordinate */
  layerWeights(gx: number, gz: number): number[] {
    const L = this.layers;
    const n = L.length;
    const w = new Array<number>(n).fill(0);
    if (!n) return w;
    const inp = this.autoInputs(gx, gz);
    let rem = 1;
    for (let i = n - 1; i >= 1; i--) {
      const c = autoCoverage(L[i].auto, inp.slope, inp.height, inp.curv, inp.noise);
      w[i] = c * rem;
      rem *= 1 - c;
    }
    w[0] = rem;
    const sp = this.splat;
    if (sp) {
      const div = this.splatDiv;
      const sx = Math.min(this.SW - 1, Math.max(0, Math.round(gx / div)));
      const sz = Math.min(this.SH - 1, Math.max(0, Math.round(gz / div)));
      let total = 0;
      const p = L.map((l) => {
        const v = sp[this.splatIndex(l.ch, sx, sz)] / 255;
        total += v;
        return v;
      });
      const keep = 1 - Math.min(1, total);
      for (let i = 0; i < n; i++) w[i] = w[i] * keep + p[i];
    }
    return w;
  }

  /** Oberfläche des stärksten Layers an lokaler Position (m) */
  surfaceAt(x: number, z: number): SurfaceId {
    const w = this.layerWeights(this.toGridX(x), this.toGridZ(z));
    let best = 0;
    for (let i = 1; i < w.length; i++) if (w[i] > w[best]) best = i;
    return this.layers[best]?.surface ?? 'erde';
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Nach Änderungen an heights/holes/splat/grassMask aufrufen (Rechteck in Gitterpunkten, Loch-Zellen bzw. Splat-Texeln) */
  changed(r: Rect, kind: 'height' | 'holes' | 'splat' | 'grass' = 'height'): void {
    const c =
      kind === 'height' ? this.clip(r) : kind === 'holes' ? this.clip(r, this.HW, this.HH) : kind === 'grass' ? this.clip(r, this.SW, this.SH) : this.clip(r, this.SW, this.SH * 2);
    if (!c) return;
    this.revision++;
    if (kind === 'height') {
      if (this.base) this.recompose(c);
      this.updateBounds(c);
    }
    else if (kind === 'holes') this.updateHoleCounts(c);
    for (const fn of this.listeners) fn(c, kind);
  }

  clip(r: Rect, w = this.VW, h = this.VH): Rect | null {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(w, Math.ceil(r.x + r.w));
    const y1 = Math.min(h, Math.ceil(r.y + r.h));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  private updateBounds(r: Rect): void {
    const lv0 = this.minMax[0];
    // Gitterpunkte am Blockrand gehören zu beiden Blöcken
    const bx0 = Math.max(0, Math.floor((r.x - 1) / BLOCK));
    const by0 = Math.max(0, Math.floor((r.y - 1) / BLOCK));
    const bx1 = Math.min(lv0.w - 1, Math.floor((r.x + r.w - 1) / BLOCK));
    const by1 = Math.min(lv0.h - 1, Math.floor((r.y + r.h - 1) / BLOCK));
    const hs = this.heights;
    const VW = this.VW;
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        let mn = Infinity;
        let mx = -Infinity;
        for (let z = by * BLOCK; z <= (by + 1) * BLOCK; z++) {
          const row = z * VW;
          for (let x = bx * BLOCK; x <= (bx + 1) * BLOCK; x++) {
            const v = hs[row + x];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }
        lv0.min[by * lv0.w + bx] = mn;
        lv0.max[by * lv0.w + bx] = mx;
      }
    }
    // Pyramide nachziehen
    let x0 = bx0;
    let y0 = by0;
    let x1 = bx1;
    let y1 = by1;
    for (let l = 1; l < this.minMax.length; l++) {
      const src = this.minMax[l - 1];
      const dst = this.minMax[l];
      x0 >>= 1;
      y0 >>= 1;
      x1 >>= 1;
      y1 >>= 1;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          let mn = Infinity;
          let mx = -Infinity;
          for (let dy = 0; dy < 2; dy++) {
            const sy = y * 2 + dy;
            if (sy >= src.h) continue;
            for (let dx = 0; dx < 2; dx++) {
              const sx = x * 2 + dx;
              if (sx >= src.w) continue;
              const i = sy * src.w + sx;
              if (src.min[i] < mn) mn = src.min[i];
              if (src.max[i] > mx) mx = src.max[i];
            }
          }
          dst.min[y * dst.w + x] = mn;
          dst.max[y * dst.w + x] = mx;
        }
      }
    }
  }

  private updateHoleCounts(r: Rect): void {
    const C = COMPONENT_QUADS * this.holeSub;
    const HW = this.HW;
    const cx0 = Math.floor(r.x / C);
    const cy0 = Math.floor(r.y / C);
    const cx1 = Math.floor((r.x + r.w - 1) / C);
    const cy1 = Math.floor((r.y + r.h - 1) / C);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        let n = 0;
        for (let z = cy * C; z < (cy + 1) * C; z++) {
          const row = z * HW;
          for (let x = cx * C; x < (cx + 1) * C; x++) n += this.holes[row + x];
        }
        this.compHoles[cy * this.compX + cx] = n;
      }
    }
  }

  /** Min/Max-Höhe eines Rechtecks in Blöcken auf Pyramidenstufe `level` */
  rangeAt(level: number, bx: number, by: number): [number, number] | null {
    const lv = this.minMax[Math.min(level, this.minMax.length - 1)];
    if (bx < 0 || by < 0 || bx >= lv.w || by >= lv.h) return null;
    return [lv.min[by * lv.w + bx], lv.max[by * lv.w + bx]];
  }

  get minHeight(): number {
    return this.minMax[this.minMax.length - 1].min[0];
  }
  get maxHeight(): number {
    return this.minMax[this.minMax.length - 1].max[0];
  }

  // ---------- Koordinaten ----------

  /** lokale Position (Meter, Ursprung Mitte) → Gitterkoordinate */
  toGridX(x: number): number {
    return x / this.quadSize + this.W / 2;
  }
  toGridZ(z: number): number {
    return z / this.quadSize + this.H / 2;
  }
  fromGridX(gx: number): number {
    return (gx - this.W / 2) * this.quadSize;
  }
  fromGridZ(gz: number): number {
    return (gz - this.H / 2) * this.quadSize;
  }

  h(ix: number, iz: number): number {
    ix = ix < 0 ? 0 : ix > this.W ? this.W : ix;
    iz = iz < 0 ? 0 : iz > this.H ? this.H : iz;
    return this.heights[iz * this.VW + ix];
  }

  /** Loch an einer Gitterkoordinate (1 = ein Quad); außerhalb = Loch */
  holeAtGrid(gx: number, gz: number): boolean {
    if (!(gx >= 0 && gz >= 0 && gx <= this.W && gz <= this.H)) return true;
    const s = this.holeSub;
    const cx = Math.min(this.HW - 1, Math.floor(gx * s));
    const cz = Math.min(this.HH - 1, Math.floor(gz * s));
    return this.holes[cz * this.HW + cx] !== 0;
  }

  /** 0 = Quad ohne Loch, 1 = teilweise, 2 = ganz Loch */
  quadHoleState(qx: number, qz: number): 0 | 1 | 2 {
    const s = this.holeSub;
    const HW = this.HW;
    let n = 0;
    for (let y = 0; y < s; y++) {
      const row = (qz * s + y) * HW + qx * s;
      for (let x = 0; x < s; x++) n += this.holes[row + x];
    }
    return n === 0 ? 0 : n === s * s ? 2 : 1;
  }

  /** Höhe an einer Gitterkoordinate (gleiche Dreiecksteilung wie Render/Kollision); `src` = anderes Höhenraster (base) */
  heightAtGrid(gx: number, gz: number, src: Float32Array = this.heights): number {
    gx = Math.min(this.W, Math.max(0, gx));
    gz = Math.min(this.H, Math.max(0, gz));
    const ix = Math.min(this.W - 1, Math.floor(gx));
    const iz = Math.min(this.H - 1, Math.floor(gz));
    const fx = gx - ix;
    const fz = gz - iz;
    const i = iz * this.VW + ix;
    const h00 = src[i];
    const h10 = src[i + 1];
    const h01 = src[i + this.VW];
    const h11 = src[i + this.VW + 1];
    // Bilinear (Render-Shader interpoliert ebenfalls bilinear)
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  /** Höhe an lokaler Position (Meter); null außerhalb oder über einem Loch */
  heightAt(x: number, z: number): number | null {
    const gx = this.toGridX(x);
    const gz = this.toGridZ(z);
    if (gx < 0 || gz < 0 || gx > this.W || gz > this.H) return null;
    if (this.holeAtGrid(gx, gz)) return null;
    return this.heightAtGrid(gx, gz);
  }

  /** Normale an einem Gitterpunkt (zentrale Differenzen) */
  normalAt(ix: number, iz: number, out = new THREE.Vector3()): THREE.Vector3 {
    const q = this.quadSize;
    const dx = (this.h(ix + 1, iz) - this.h(ix - 1, iz)) / (2 * q);
    const dz = (this.h(ix, iz + 1) - this.h(ix, iz - 1)) / (2 * q);
    return out.set(-dx, 1, -dz).normalize();
  }

  // ---------- Raycast ----------

  /**
   * Strahl (lokale Koordinaten) gegen das Höhenfeld; liefert Abstand (in Einheiten von dir) + Normale.
   * Grobe Suche über die Min/Max-Blöcke, dann Quads entlang des Strahls (2D-DDA), je Quad zwei Dreiecke.
   * `throughHoles`: Löcher zählen als Fläche (Editor: Löcher wieder füllen).
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist = Infinity, throughHoles = false): { t: number; normal: THREE.Vector3 } | null {
    this._solid = throughHoles;
    const q = this.quadSize;
    // In Gitterraum (x, z in Quads, y in Metern)
    const ox = origin.x / q + this.W / 2;
    const oz = origin.z / q + this.H / 2;
    const dx = dir.x / q;
    const dz = dir.z / q;
    const oy = origin.y;
    const dy = dir.y;
    // Strahl auf die Landscape-Hülle beschneiden
    let t0 = 0;
    let t1 = maxDist;
    const slab = (o: number, d: number, lo: number, hi: number): boolean => {
      if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
      let a = (lo - o) / d;
      let b = (hi - o) / d;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      return t0 <= t1;
    };
    if (!slab(ox, dx, 0, this.W) || !slab(oz, dz, 0, this.H) || !slab(oy, dy, this.minHeight - 0.01, this.maxHeight + 0.01)) return null;

    // Block-DDA (BLOCK×BLOCK Quads)
    const lv = this.minMax[0];
    const B = BLOCK;
    let t = t0;
    const eps = 1e-7;
    let bx = Math.min(lv.w - 1, Math.max(0, Math.floor((ox + dx * (t + eps)) / B)));
    let bz = Math.min(lv.h - 1, Math.max(0, Math.floor((oz + dz * (t + eps)) / B)));
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dx) > 1e-12 ? B / Math.abs(dx) : Infinity;
    const tDeltaZ = Math.abs(dz) > 1e-12 ? B / Math.abs(dz) : Infinity;
    let tMaxX = Math.abs(dx) > 1e-12 ? ((dx > 0 ? (bx + 1) * B : bx * B) - ox) / dx : Infinity;
    let tMaxZ = Math.abs(dz) > 1e-12 ? ((dz > 0 ? (bz + 1) * B : bz * B) - oz) / dz : Infinity;
    while (t <= t1 && bx >= 0 && bz >= 0 && bx < lv.w && bz < lv.h) {
      const tExit = Math.min(tMaxX, tMaxZ, t1);
      const yA = oy + dy * t;
      const yB = oy + dy * tExit;
      const i = bz * lv.w + bx;
      if (Math.min(yA, yB) <= lv.max[i] + 1e-4 && Math.max(yA, yB) >= lv.min[i] - 1e-4) {
        const hit = this.raycastQuads(ox, oz, oy, dx, dz, dy, t, tExit);
        if (hit) return hit;
      }
      if (tMaxX < tMaxZ) {
        bx += stepX;
        t = tMaxX;
        tMaxX += tDeltaX;
      } else {
        bz += stepZ;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
      }
    }
    return null;
  }

  private raycastQuads(ox: number, oz: number, oy: number, dx: number, dz: number, dy: number, tStart: number, tEnd: number): { t: number; normal: THREE.Vector3 } | null {
    const eps = 1e-7;
    let qx = Math.floor(ox + dx * (tStart + eps));
    let qz = Math.floor(oz + dz * (tStart + eps));
    qx = Math.min(this.W - 1, Math.max(0, qx));
    qz = Math.min(this.H - 1, Math.max(0, qz));
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dx) > 1e-12 ? 1 / Math.abs(dx) : Infinity;
    const tDeltaZ = Math.abs(dz) > 1e-12 ? 1 / Math.abs(dz) : Infinity;
    let tMaxX = Math.abs(dx) > 1e-12 ? ((dx > 0 ? qx + 1 : qx) - ox) / dx : Infinity;
    let tMaxZ = Math.abs(dz) > 1e-12 ? ((dz > 0 ? qz + 1 : qz) - oz) / dz : Infinity;
    let t = tStart;
    let guard = 0;
    while (t <= tEnd + 1e-6 && guard++ < 4096) {
      if (qx >= 0 && qz >= 0 && qx < this.W && qz < this.H && (this._solid || (this.holeSub === 1 ? !this.holes[qz * this.W + qx] : this.quadHoleState(qx, qz) !== 2))) {
        const hit = this.rayQuad(qx, qz, ox, oz, oy, dx, dz, dy);
        if (hit) return hit;
      }
      if (tMaxX < tMaxZ) {
        qx += stepX;
        t = tMaxX;
        tMaxX += tDeltaX;
      } else {
        qz += stepZ;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
      }
    }
    return null;
  }

  /** laufender raycast ignoriert Löcher */
  private _solid = false;
  private _a = new THREE.Vector3();
  private _b = new THREE.Vector3();
  private _c = new THREE.Vector3();
  private _d = new THREE.Vector3();
  private _ray = new THREE.Ray();
  private _hit = new THREE.Vector3();

  /** Zwei Dreiecke eines Quads (Diagonale wie im Render-Gitter: (0,0)–(1,1)) */
  private rayQuad(qx: number, qz: number, ox: number, oz: number, oy: number, dx: number, dz: number, dy: number): { t: number; normal: THREE.Vector3 } | null {
    const q = this.quadSize;
    // in Meter-Raum rechnen, damit Normalen stimmen
    const a = this._a.set(qx * q, this.h(qx, qz), qz * q);
    const b = this._b.set((qx + 1) * q, this.h(qx + 1, qz), qz * q);
    const c = this._c.set(qx * q, this.h(qx, qz + 1), (qz + 1) * q);
    const d = this._d.set((qx + 1) * q, this.h(qx + 1, qz + 1), (qz + 1) * q);
    const ray = this._ray;
    ray.origin.set(ox * q, oy, oz * q);
    ray.direction.set(dx * q, dy, dz * q);
    const len = ray.direction.length();
    ray.direction.divideScalar(len);
    let best: THREE.Vector3 | null = null;
    let normal: THREE.Vector3 | null = null;
    let bestT = Infinity;
    for (const [p0, p1, p2] of [
      [a, c, d],
      [a, d, b],
    ] as const) {
      const hit = ray.intersectTriangle(p0, p1, p2, false, this._hit);
      if (!hit) continue;
      // feine Löcher: Treffer in einer Loch-Zelle zählt nicht
      if (!this._solid && this.holeSub > 1 && this.holeAtGrid(hit.x / q, hit.z / q)) continue;
      const tt = hit.distanceTo(ray.origin);
      if (tt < bestT) {
        bestT = tt;
        best = hit;
        normal = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0)).normalize();
        if (normal.y < 0) normal.negate();
      }
    }
    if (!best || !normal) return null;
    return { t: bestT / len, normal };
  }
}

// ---------- Speichern (Blob) ----------

const MAGIC = 0x4c444843; // "CHDL"

/**
 * Höhen als Blob: Kopf (Magic, Version, W, H, min, max) + 16-bit-Werte, auf den tatsächlichen Wertebereich
 * quantisiert (bei 100 m Höhenunterschied ≈ 1.5 mm Auflösung), danach deflate.
 */
export function encodeHeights(d: LandscapeData, src: Float32Array = d.heights): Uint8Array {
  const n = src.length;
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!(mx > mn)) mx = mn + 1;
  const scale = 65535 / (mx - mn);
  const q = new Uint16Array(n);
  // Delta zur linken Nachbarhöhe komprimiert deutlich besser (glattes Gelände)
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.round((src[i] - mn) * scale);
    q[i] = (v - prev) & 0xffff;
    prev = v;
  }
  const body = deflateSync(new Uint8Array(q.buffer), { level: 6 });
  const out = new Uint8Array(24 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, d.W, true);
  dv.setUint32(12, d.H, true);
  dv.setFloat32(16, mn, true);
  dv.setFloat32(20, mx, true);
  out.set(body, 24);
  return out;
}

export function decodeHeights(bytes: Uint8Array, W: number, H: number): Float32Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Keine Landscape-Höhendaten');
  if (dv.getUint32(8, true) !== W || dv.getUint32(12, true) !== H) throw new Error(`Höhendaten passen nicht zur Landscape-Größe (${dv.getUint32(8, true)}×${dv.getUint32(12, true)} statt ${W}×${H})`);
  const mn = dv.getFloat32(16, true);
  const mx = dv.getFloat32(20, true);
  const raw = inflateSync(bytes.subarray(24));
  const q = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const n = (W + 1) * (H + 1);
  if (q.length !== n) throw new Error('Höhendaten beschädigt');
  const out = new Float32Array(n);
  const inv = (mx - mn) / 65535;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev = (prev + q[i]) & 0xffff;
    out[i] = mn + prev * inv;
  }
  return out;
}

export function encodeHoles(d: LandscapeData): Uint8Array | null {
  let any = false;
  for (let i = 0; i < d.holes.length; i++) {
    if (d.holes[i]) {
      any = true;
      break;
    }
  }
  return any ? deflateSync(d.holes, { level: 6 }) : null;
}

/** Lochdaten lesen; die Loch-Auflösung ergibt sich aus der Länge (ältere Maps: eine Zelle je Quad) */
export function decodeHoles(bytes: Uint8Array, W: number, H: number): { holes: Uint8Array; sub: number } {
  const raw = inflateSync(bytes);
  for (const sub of HOLE_SUBS) if (raw.length === W * sub * H * sub) return { holes: raw, sub };
  throw new Error('Lochdaten passen nicht zur Landscape-Größe');
}

const SPLAT_MAGIC = 0x544c5053; // "SPLT"

/** Splatmap als Blob (Kopf: Magic, SW, SH; danach deflate); null = nichts gemalt */
export function encodeSplat(d: LandscapeData): Uint8Array | null {
  const s = d.splat;
  if (!s) return null;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i]) {
      any = true;
      break;
    }
  }
  if (!any) return null;
  const body = deflateSync(s, { level: 6 });
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SPLAT_MAGIC, true);
  dv.setUint32(4, d.SW, true);
  dv.setUint32(8, d.SH, true);
  out.set(body, 12);
  return out;
}

export function decodeSplat(bytes: Uint8Array, SW: number, SH: number): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== SPLAT_MAGIC) throw new Error('Keine Splatmap-Daten');
  if (dv.getUint32(4, true) !== SW || dv.getUint32(8, true) !== SH) throw new Error('Splatmap passt nicht zur Landscape-Größe');
  const raw = inflateSync(bytes.subarray(12));
  if (raw.length !== SW * SH * 8) throw new Error('Splatmap beschädigt');
  return raw;
}

const GRASS_MAGIC = 0x4b534d47; // "GMSK"

/** Gras-Maske als Blob (Kopf: Magic, SW, SH; danach deflate); null = nichts radiert */
export function encodeGrassMask(d: LandscapeData): Uint8Array | null {
  const m = d.grassMask;
  if (!m || !m.some((v) => v !== 0)) return null;
  const body = deflateSync(m, { level: 6 });
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GRASS_MAGIC, true);
  dv.setUint32(4, d.SW, true);
  dv.setUint32(8, d.SH, true);
  out.set(body, 12);
  return out;
}

export function decodeGrassMask(bytes: Uint8Array, SW: number, SH: number): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GRASS_MAGIC) throw new Error('Keine Gras-Maske');
  if (dv.getUint32(4, true) !== SW || dv.getUint32(8, true) !== SH) throw new Error('Gras-Maske passt nicht zur Landscape-Größe');
  const raw = inflateSync(bytes.subarray(12));
  if (raw.length !== SW * SH) throw new Error('Gras-Maske beschädigt');
  return raw;
}

/**
 * Loch-Raster auf eine andere Unterteilung umrechnen (w/h = Zellen der Quelle).
 * Feiner: jede Zelle wird vervielfacht. Gröber: Loch, wenn mindestens die Hälfte der Teilzellen Loch ist.
 */
export function resampleHoles(src: Uint8Array, w: number, h: number, from: number, to: number): Uint8Array {
  if (from === to) return src.slice();
  const nw = (w / from) * to;
  const nh = (h / from) * to;
  const out = new Uint8Array(nw * nh);
  if (to > from) {
    const f = to / from;
    for (let y = 0; y < nh; y++) {
      const srow = Math.floor(y / f) * w;
      const drow = y * nw;
      for (let x = 0; x < nw; x++) out[drow + x] = src[srow + Math.floor(x / f)];
    }
  } else {
    const f = from / to;
    const half = (f * f) / 2;
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let n = 0;
        for (let dy = 0; dy < f; dy++) {
          const row = (y * f + dy) * w + x * f;
          for (let dx = 0; dx < f; dx++) n += src[row + dx];
        }
        out[y * nw + x] = n >= half ? 1 : 0;
      }
    }
  }
  return out;
}
