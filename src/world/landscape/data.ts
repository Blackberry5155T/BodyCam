import * as THREE from 'three';
import { deflateSync, inflateSync } from 'fflate';

// Höhendaten einer Landscape (wie in UE5: Raster aus Komponenten à 128 × 128 Quads).
// Koordinaten: lokales Raster, Ursprung = Mitte der Landscape (Objektposition), x nach +X, z nach +Z.
// Gitterpunkt (ix, iz) liegt bei ((ix - W/2) · q, h, (iz - H/2) · q).
// heights: (W+1)·(H+1) Werte, zeilenweise (iz · (W+1) + ix), Meter relativ zur Objekthöhe.
// holes: W·H Quads, 1 = Loch (kein Rendering, keine Kollision).

export const COMPONENT_QUADS = 128;
/** Kantenlänge eines Min/Max-Blocks (= kleinster CDLOD-Knoten) in Quads */
export const BLOCK = 32;
export const MAX_QUADS = 8192;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ChangeKind = 'height' | 'holes';
export type ChangeListener = (r: Rect, kind: ChangeKind) => void;

export class LandscapeData {
  readonly W: number;
  readonly H: number;
  readonly VW: number;
  readonly VH: number;
  readonly heights: Float32Array;
  readonly holes: Uint8Array;
  /** Min/Max je BLOCK×BLOCK-Quads, Pyramide: Stufe 0 = Blöcke, jede weitere Stufe halbiert */
  readonly minMax: { w: number; h: number; min: Float32Array; max: Float32Array }[] = [];
  /** Anzahl Löcher je Komponente (für Kollision: Heightfield oder Trimesh) */
  readonly compHoles: Uint32Array;
  readonly compX: number;
  readonly compZ: number;
  private listeners = new Set<ChangeListener>();
  /** Erhöht sich bei jeder Änderung (für "muss gespeichert werden") */
  revision = 0;

  constructor(
    compX: number,
    compZ: number,
    public quadSize: number,
    heights?: Float32Array,
    holes?: Uint8Array,
  ) {
    this.compX = compX;
    this.compZ = compZ;
    this.W = compX * COMPONENT_QUADS;
    this.H = compZ * COMPONENT_QUADS;
    this.VW = this.W + 1;
    this.VH = this.H + 1;
    this.heights = heights ?? new Float32Array(this.VW * this.VH);
    this.holes = holes ?? new Uint8Array(this.W * this.H);
    this.compHoles = new Uint32Array(compX * compZ);
    let bw = this.W / BLOCK;
    let bh = this.H / BLOCK;
    for (;;) {
      this.minMax.push({ w: bw, h: bh, min: new Float32Array(bw * bh), max: new Float32Array(bw * bh) });
      if (bw === 1 && bh === 1) break;
      bw = Math.ceil(bw / 2);
      bh = Math.ceil(bh / 2);
    }
    this.updateBounds({ x: 0, y: 0, w: this.VW, h: this.VH });
    this.updateHoleCounts({ x: 0, y: 0, w: this.W, h: this.H });
  }

  get sizeX(): number {
    return this.W * this.quadSize;
  }
  get sizeZ(): number {
    return this.H * this.quadSize;
  }

  clone(): LandscapeData {
    return new LandscapeData(this.compX, this.compZ, this.quadSize, this.heights.slice(), this.holes.slice());
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Nach Änderungen an heights/holes aufrufen (Rechteck in Gitterpunkten bzw. Quads) */
  changed(r: Rect, kind: ChangeKind = 'height'): void {
    const c = this.clip(r, kind === 'height' ? this.VW : this.W, kind === 'height' ? this.VH : this.H);
    if (!c) return;
    this.revision++;
    if (kind === 'height') this.updateBounds(c);
    else this.updateHoleCounts(c);
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
    const cx0 = Math.floor(r.x / COMPONENT_QUADS);
    const cy0 = Math.floor(r.y / COMPONENT_QUADS);
    const cx1 = Math.floor((r.x + r.w - 1) / COMPONENT_QUADS);
    const cy1 = Math.floor((r.y + r.h - 1) / COMPONENT_QUADS);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        let n = 0;
        for (let z = cy * COMPONENT_QUADS; z < (cy + 1) * COMPONENT_QUADS; z++) {
          const row = z * this.W;
          for (let x = cx * COMPONENT_QUADS; x < (cx + 1) * COMPONENT_QUADS; x++) n += this.holes[row + x];
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

  isHole(qx: number, qz: number): boolean {
    if (qx < 0 || qz < 0 || qx >= this.W || qz >= this.H) return true;
    return this.holes[qz * this.W + qx] !== 0;
  }

  /** Höhe an einer Gitterkoordinate (gleiche Dreiecksteilung wie Render/Kollision) */
  heightAtGrid(gx: number, gz: number): number {
    gx = Math.min(this.W, Math.max(0, gx));
    gz = Math.min(this.H, Math.max(0, gz));
    const ix = Math.min(this.W - 1, Math.floor(gx));
    const iz = Math.min(this.H - 1, Math.floor(gz));
    const fx = gx - ix;
    const fz = gz - iz;
    const h00 = this.h(ix, iz);
    const h10 = this.h(ix + 1, iz);
    const h01 = this.h(ix, iz + 1);
    const h11 = this.h(ix + 1, iz + 1);
    // Bilinear (Render-Shader interpoliert ebenfalls bilinear)
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  /** Höhe an lokaler Position (Meter); null außerhalb oder über einem Loch */
  heightAt(x: number, z: number): number | null {
    const gx = this.toGridX(x);
    const gz = this.toGridZ(z);
    if (gx < 0 || gz < 0 || gx > this.W || gz > this.H) return null;
    if (this.isHole(Math.min(this.W - 1, Math.floor(gx)), Math.min(this.H - 1, Math.floor(gz)))) return null;
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
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist = Infinity): { t: number; normal: THREE.Vector3 } | null {
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
      if (qx >= 0 && qz >= 0 && qx < this.W && qz < this.H && !this.holes[qz * this.W + qx]) {
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
export function encodeHeights(d: LandscapeData): Uint8Array {
  const n = d.heights.length;
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = d.heights[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!(mx > mn)) mx = mn + 1;
  const scale = 65535 / (mx - mn);
  const q = new Uint16Array(n);
  // Delta zur linken Nachbarhöhe komprimiert deutlich besser (glattes Gelände)
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.round((d.heights[i] - mn) * scale);
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

export function decodeHoles(bytes: Uint8Array, W: number, H: number): Uint8Array {
  const raw = inflateSync(bytes);
  if (raw.length !== W * H) throw new Error('Lochdaten passen nicht zur Landscape-Größe');
  return raw;
}
