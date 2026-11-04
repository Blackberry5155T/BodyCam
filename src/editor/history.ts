import { deflateSync, inflateSync } from 'fflate';

// Undo für große Binär-Daten (Heightmaps, Splatmaps, Foliage-Zellen …).
// Statt die ganze Map als JSON zu speichern, merkt sich ein Pinselstrich nur die betroffenen Kacheln
// vorher/nachher — komprimiert, weil sich bei einem Strich meist wenig ändert.

/** Ein Undo-Schritt, der Daten außerhalb des Map-JSON ändert */
export interface DataEdit {
  /** Anzeige, z. B. „Landscape: Anheben“ */
  readonly label: string;
  /** belegter Speicher (für das Historien-Budget) */
  readonly bytes: number;
  undo(): void;
  redo(): void;
}

type Grid = Float32Array | Uint16Array | Uint8Array;

/** Rechteck in Samples (x/y inklusive, w/h > 0) */
export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const TILE = 64;

/**
 * Zeichnet Änderungen an einem 2D-Raster (Breite × Höhe × Kanäle) kachelweise auf.
 * Ablauf: `touch(rect)` VOR jeder Änderung → Raster ändern → `finish()` liefert den Undo-Schritt.
 */
export class GridRecorder {
  private before = new Map<number, Uint8Array>();
  private readonly tilesX: number;
  private readonly source: Grid | (() => Grid);

  constructor(
    /** Raster oder Funktion, die das aktuelle Raster liefert (falls es ersetzt werden kann, z. B. bei Auflösungswechsel) */
    data: Grid | (() => Grid),
    private readonly width: number,
    private readonly height: number,
    private readonly channels = 1,
    /** Nach Undo/Redo: geänderten Bereich neu hochladen (Textur, Kollision …) */
    private readonly onChange: (rect: GridRect) => void = () => {},
  ) {
    this.source = data;
    this.tilesX = Math.ceil(width / TILE);
  }

  private get data(): Grid {
    return typeof this.source === 'function' ? this.source() : this.source;
  }

  /** Bereich wird gleich geändert → betroffene Kacheln einmalig sichern */
  touch(rect: GridRect): void {
    const x0 = Math.max(0, Math.floor(rect.x / TILE));
    const y0 = Math.max(0, Math.floor(rect.y / TILE));
    const x1 = Math.min(this.tilesX - 1, Math.floor((rect.x + rect.w - 1) / TILE));
    const y1 = Math.min(Math.ceil(this.height / TILE) - 1, Math.floor((rect.y + rect.h - 1) / TILE));
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const key = ty * this.tilesX + tx;
        if (!this.before.has(key)) this.before.set(key, this.readTile(tx, ty));
      }
  }

  get empty(): boolean {
    return this.before.size === 0;
  }

  /** Strich abschließen: Kacheln nachher lesen, unveränderte verwerfen, alles komprimieren */
  finish(label: string): DataEdit | null {
    const tiles: { tx: number; ty: number; before: Uint8Array; after: Uint8Array }[] = [];
    let bytes = 0;
    for (const [key, raw] of this.before) {
      const tx = key % this.tilesX;
      const ty = Math.floor(key / this.tilesX);
      const now = this.readTile(tx, ty);
      if (equalBytes(raw, now)) continue;
      const before = deflateSync(raw, { level: 1 });
      const after = deflateSync(now, { level: 1 });
      bytes += before.byteLength + after.byteLength + 32;
      tiles.push({ tx, ty, before, after });
    }
    this.before.clear();
    if (!tiles.length) return null;
    const apply = (which: 'before' | 'after') => {
      const rect = { x: Infinity, y: Infinity, w: 0, h: 0 };
      let x1 = 0;
      let y1 = 0;
      for (const t of tiles) {
        const r = this.writeTile(t.tx, t.ty, inflateSync(t[which]));
        rect.x = Math.min(rect.x, r.x);
        rect.y = Math.min(rect.y, r.y);
        x1 = Math.max(x1, r.x + r.w);
        y1 = Math.max(y1, r.y + r.h);
      }
      rect.w = x1 - rect.x;
      rect.h = y1 - rect.y;
      this.onChange(rect);
    };
    return { label, bytes, undo: () => apply('before'), redo: () => apply('after') };
  }

  private tileRect(tx: number, ty: number): GridRect {
    const x = tx * TILE;
    const y = ty * TILE;
    return { x, y, w: Math.min(TILE, this.width - x), h: Math.min(TILE, this.height - y) };
  }

  /** Kachel als Bytes (Zeilen hintereinander) */
  private readTile(tx: number, ty: number): Uint8Array {
    const r = this.tileRect(tx, ty);
    const row = r.w * this.channels;
    const out = new (this.data.constructor as new (n: number) => Grid)(row * r.h);
    for (let y = 0; y < r.h; y++) {
      const start = ((r.y + y) * this.width + r.x) * this.channels;
      out.set(this.data.subarray(start, start + row), y * row);
    }
    return new Uint8Array(out.buffer);
  }

  private writeTile(tx: number, ty: number, bytes: Uint8Array): GridRect {
    const r = this.tileRect(tx, ty);
    const row = r.w * this.channels;
    const Ctor = this.data.constructor as new (b: ArrayBuffer) => Grid;
    // inflateSync liefert einen eigenen, passend großen Puffer → als typisiertes Array ansehen
    const src = new Ctor(bytes.slice().buffer);
    for (let y = 0; y < r.h; y++) this.data.set(src.subarray(y * row, (y + 1) * row), ((r.y + y) * this.width + r.x) * this.channels);
    return r;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
