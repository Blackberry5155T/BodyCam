import * as THREE from 'three';
import type { Collider } from '../collision.ts';
import { COMPONENT_QUADS, type LandscapeData } from './data.ts';

// Kollision einer Landscape: ein Rapier-Heightfield je Komponente (128 × 128 Quads),
// Komponenten mit Löchern werden zu Dreiecksnetzen (Heightfields kennen keine Löcher). Bei feiner
// Loch-Auflösung bekommen teilweise gelochte Quads ein Teilnetz je Loch-Zelle (Höhe aus der Ebene des Quad-Dreiecks).
// Unveränderte Komponenten behalten ihr Collider-Objekt (PhysicsWorld.sync vergleicht nach Identität).

interface CompEntry {
  rev: number;
  key: string;
  collider: Collider;
}

export class LandscapeColliders {
  private comps: (CompEntry | null)[];
  private revs: Uint32Array;
  private off: () => void;

  constructor(private data: LandscapeData) {
    this.comps = new Array(data.compX * data.compZ).fill(null);
    this.revs = new Uint32Array(data.compX * data.compZ);
    this.off = data.onChange((r, kind) => {
      if (kind === 'splat' || kind === 'layers') return;
      if (kind === 'holeRes') {
        for (let i = 0; i < this.revs.length; i++) this.revs[i]++;
        return;
      }
      // Loch-Zellen → Quads
      if (kind === 'holes' && data.holeSub > 1) {
        const s = data.holeSub;
        const x1 = Math.ceil((r.x + r.w) / s);
        const y1 = Math.ceil((r.y + r.h) / s);
        r = { x: Math.floor(r.x / s), y: Math.floor(r.y / s), w: 0, h: 0 };
        r.w = x1 - r.x;
        r.h = y1 - r.y;
      }
      // Höhen: Gitterpunkte am Rand gehören zu zwei Komponenten
      const pad = kind === 'height' ? 1 : 0;
      const cx0 = Math.max(0, Math.floor((r.x - pad) / COMPONENT_QUADS));
      const cz0 = Math.max(0, Math.floor((r.y - pad) / COMPONENT_QUADS));
      const cx1 = Math.min(data.compX - 1, Math.floor((r.x + r.w - 1) / COMPONENT_QUADS));
      const cz1 = Math.min(data.compZ - 1, Math.floor((r.y + r.h - 1) / COMPONENT_QUADS));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) this.revs[cz * data.compX + cx]++;
    });
  }

  /** Collider aller Komponenten (Weltlage = origin, Landscape ist nicht gedreht/skaliert) */
  build(origin: THREE.Vector3): Collider[] {
    const d = this.data;
    const out: Collider[] = [];
    const key = `${origin.x},${origin.y},${origin.z}`;
    for (let cz = 0; cz < d.compZ; cz++) {
      for (let cx = 0; cx < d.compX; cx++) {
        const i = cz * d.compX + cx;
        let e = this.comps[i];
        if (!e || e.rev !== this.revs[i] || e.key !== key) {
          const collider = d.compHoles[i] >= (COMPONENT_QUADS * d.holeSub) ** 2 ? null : this.buildComponent(cx, cz, origin);
          e = collider ? { rev: this.revs[i], key, collider } : null;
          this.comps[i] = e;
        }
        if (e) out.push(e.collider);
      }
    }
    return out;
  }

  private buildComponent(cx: number, cz: number, origin: THREE.Vector3): Collider {
    const d = this.data;
    const N = COMPONENT_QUADS;
    const x0 = cx * N;
    const z0 = cz * N;
    const q = d.quadSize;
    let mn = Infinity;
    let mx = -Infinity;
    for (let z = z0; z <= z0 + N; z++) {
      for (let x = x0; x <= x0 + N; x++) {
        const v = d.heights[z * d.VW + x];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    if (d.compHoles[cz * d.compX + cx] === 0) {
      const heights = new Float32Array((N + 1) * (N + 1));
      for (let x = 0; x <= N; x++) {
        for (let z = 0; z <= N; z++) heights[x * (N + 1) + z] = d.heights[(z0 + z) * d.VW + x0 + x];
      }
      return {
        type: 'heightfield',
        center: new THREE.Vector3(origin.x + d.fromGridX(x0 + N / 2), origin.y, origin.z + d.fromGridZ(z0 + N / 2)),
        rows: N,
        cols: N,
        heights,
        sizeX: N * q,
        sizeZ: N * q,
        minY: origin.y + mn,
        maxY: origin.y + mx,
      };
    }
    // Mit Löchern: Netz nur aus den vorhandenen Quads bzw. Loch-Zellen
    const verts: number[] = [];
    for (let z = 0; z <= N; z++) {
      for (let x = 0; x <= N; x++) {
        verts.push(origin.x + d.fromGridX(x0 + x), origin.y + d.heights[(z0 + z) * d.VW + x0 + x], origin.z + d.fromGridZ(z0 + z));
      }
    }
    const idx: number[] = [];
    const s = d.holeSub;
    const HW = d.HW;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const state = s === 1 ? (d.holes[(z0 + z) * d.W + x0 + x] ? 2 : 0) : d.quadHoleState(x0 + x, z0 + z);
        if (state === 2) continue;
        if (state === 0) {
          const a = z * (N + 1) + x;
          const b = a + 1;
          const c = a + N + 1;
          const e = c + 1;
          idx.push(a, c, e, a, e, b);
          continue;
        }
        // teilweise gelocht: (s+1)² eigene Punkte, Dreiecke nur für offene Zellen
        const gx = x0 + x;
        const gz = z0 + z;
        const h00 = d.heights[gz * d.VW + gx];
        const h10 = d.heights[gz * d.VW + gx + 1];
        const h01 = d.heights[(gz + 1) * d.VW + gx];
        const h11 = d.heights[(gz + 1) * d.VW + gx + 1];
        const base = verts.length / 3;
        for (let sz = 0; sz <= s; sz++) {
          const fz = sz / s;
          for (let sx = 0; sx <= s; sx++) {
            const fx = sx / s;
            // gleiche Diagonale wie das Quad: (0,0)–(1,1)
            const hh = fz >= fx ? h00 + (h11 - h01) * fx + (h01 - h00) * fz : h00 + (h10 - h00) * fx + (h11 - h10) * fz;
            verts.push(origin.x + d.fromGridX(gx + fx), origin.y + hh, origin.z + d.fromGridZ(gz + fz));
          }
        }
        for (let sz = 0; sz < s; sz++) {
          const row = (gz * s + sz) * HW + gx * s;
          for (let sx = 0; sx < s; sx++) {
            if (d.holes[row + sx]) continue;
            const a = base + sz * (s + 1) + sx;
            const b = a + 1;
            const c = a + s + 1;
            const e = c + 1;
            idx.push(a, c, e, a, e, b);
          }
        }
      }
    }
    return { type: 'trimesh', vertices: new Float32Array(verts), indices: new Uint32Array(idx), minY: origin.y + mn, maxY: origin.y + mx };
  }

  dispose(): void {
    this.off();
  }
}
