import * as THREE from 'three';
import { RAPIER, WORLD_QUERY, type PhysicsWorld } from '../physics/physics.ts';
import { SCALE } from '../world/collision.ts';

// Navigationsraster für NPCs: wird einmal aus der Rapier-Welt abgetastet (Bodenhöhe per Strahl nach unten,
// Freiraum per Zylinder in Körpergröße). Wegsuche per A* (8 Nachbarn, keine Ecken schneiden), danach
// „String Pulling“ über Sichtlinien im Raster → wenige, gerade Wegpunkte.
// Eine Ebene (höchster begehbarer Boden unter der Referenzhöhe) — reicht für Arenen/Trainingslevel.

const MAX_STEP = 0.35; // Höhenunterschied zwischen Nachbarzellen, den der Character Controller noch steigt
const CLEAR_RADIUS = SCALE.playerRadius + 0.08;
const BODY_FROM = 0.4; // Freiraum-Prüfung ab dieser Höhe über dem Boden (Stufen darunter sind ok)
const BODY_TO = 1.75;
const MAX_CELLS = 160_000;

export interface NavBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export class NavGrid {
  readonly cell: number;
  readonly minX: number;
  readonly minZ: number;
  readonly w: number;
  readonly h: number;
  /** Bodenhöhe je Zelle, NaN = nicht begehbar */
  private ground: Float32Array;
  // Puffer für A*
  private gScore: Float32Array;
  private parent: Int32Array;
  private visit: Uint32Array;
  private closed: Uint32Array;
  private stamp = 0;
  private heap: number[] = [];
  private heapF: number[] = [];

  constructor(
    private physics: PhysicsWorld,
    bounds: NavBounds,
    private refY: number,
  ) {
    const area = (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ);
    this.cell = Math.max(0.5, Math.sqrt(area / MAX_CELLS));
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.w = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / this.cell));
    this.h = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / this.cell));
    const n = this.w * this.h;
    this.ground = new Float32Array(n);
    this.gScore = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.visit = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.build();
  }

  private build(): void {
    const world = this.physics.world;
    const top = this.refY + 2.6;
    const ray = new RAPIER.Ray({ x: 0, y: top, z: 0 }, { x: 0, y: -1, z: 0 });
    const half = (BODY_TO - BODY_FROM) / 2;
    const body = new RAPIER.Cylinder(half, CLEAR_RADIUS);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const pos = { x: 0, y: 0, z: 0 };
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const k = j * this.w + i;
        const x = this.minX + (i + 0.5) * this.cell;
        const z = this.minZ + (j + 0.5) * this.cell;
        ray.origin = { x, y: top, z };
        const hit = world.castRay(ray, 8, true, undefined, WORLD_QUERY);
        // kein Boden oder Strahl startet in einer Wand
        if (!hit || hit.timeOfImpact < 1e-3) {
          this.ground[k] = NaN;
          continue;
        }
        const gy = top - hit.timeOfImpact;
        pos.x = x;
        pos.y = gy + BODY_FROM + half;
        pos.z = z;
        this.ground[k] = world.intersectionWithShape(pos, rot, body, undefined, WORLD_QUERY) ? NaN : gy;
      }
    }
  }

  private idx(x: number, z: number): number {
    const i = Math.floor((x - this.minX) / this.cell);
    const j = Math.floor((z - this.minZ) / this.cell);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return j * this.w + i;
  }

  private cx(k: number): number {
    return this.minX + ((k % this.w) + 0.5) * this.cell;
  }

  private cz(k: number): number {
    return this.minZ + (Math.floor(k / this.w) + 0.5) * this.cell;
  }

  walkable(x: number, z: number): boolean {
    const k = this.idx(x, z);
    return k >= 0 && !Number.isNaN(this.ground[k]);
  }

  /** Bodenhöhe an einer Stelle (NaN = nicht begehbar) */
  groundAt(x: number, z: number): number {
    const k = this.idx(x, z);
    return k < 0 ? NaN : this.ground[k];
  }

  /** Nächste begehbare Zelle (Spiralsuche); null, wenn im Umkreis keine */
  nearest(x: number, z: number, maxR = 4, out = new THREE.Vector3()): THREE.Vector3 | null {
    const k0 = this.idx(x, z);
    if (k0 >= 0 && !Number.isNaN(this.ground[k0])) return out.set(x, this.ground[k0], z);
    const r = Math.ceil(maxR / this.cell);
    let best = -1;
    let bestD = Infinity;
    const i0 = Math.floor((x - this.minX) / this.cell);
    const j0 = Math.floor((z - this.minZ) / this.cell);
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
        const k = j * this.w + i;
        if (Number.isNaN(this.ground[k])) continue;
        const d = di * di + dj * dj;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
    }
    return best < 0 ? null : out.set(this.cx(best), this.ground[best], this.cz(best));
  }

  /** Zufällige begehbare Stelle im Umkreis */
  randomNear(x: number, z: number, radius: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    for (let n = 0; n < 12; n++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const p = this.nearest(x + Math.cos(a) * r, z + Math.sin(a) * r, 1.5, out);
      if (p) return p;
    }
    return null;
  }

  private connected(a: number, b: number): boolean {
    const ga = this.ground[a];
    const gb = this.ground[b];
    return !Number.isNaN(gb) && Math.abs(ga - gb) <= MAX_STEP;
  }

  /** Gerade Linie im Raster begehbar (ohne Stufen > MAX_STEP)? */
  lineClear(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / (this.cell * 0.35)));
    let prev = this.idx(ax, az);
    if (prev < 0 || Number.isNaN(this.ground[prev])) return false;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const k = this.idx(ax + dx * t, az + dz * t);
      if (k < 0) return false;
      if (k !== prev) {
        if (!this.connected(prev, k)) return false;
        prev = k;
      }
    }
    return true;
  }

  /** Weg von a nach b (Weltkoordinaten); Rückgabe ohne Startpunkt, letzter Punkt = Ziel. null = unerreichbar */
  findPath(from: THREE.Vector3, to: THREE.Vector3, maxExpand = 12000): THREE.Vector3[] | null {
    const s0 = this.nearest(from.x, from.z, 2, _a);
    const e0 = this.nearest(to.x, to.z, 3, _b);
    if (!s0 || !e0) return null;
    const start = this.idx(s0.x, s0.z);
    const goal = this.idx(e0.x, e0.z);
    if (start === goal) return [e0.clone()];

    const stamp = ++this.stamp;
    const w = this.w;
    const gx = goal % w;
    const gz = Math.floor(goal / w);
    const heur = (k: number) => {
      const dx = Math.abs((k % w) - gx);
      const dz = Math.abs(Math.floor(k / w) - gz);
      return (Math.max(dx, dz) + 0.4142 * Math.min(dx, dz)) * this.cell;
    };
    this.heap.length = 0;
    this.heapF.length = 0;
    this.gScore[start] = 0;
    this.parent[start] = -1;
    this.visit[start] = stamp;
    this.push(start, heur(start));
    let found = false;
    let expanded = 0;
    while (this.heap.length) {
      const cur = this.pop();
      if (this.closed[cur] === stamp) continue;
      this.closed[cur] = stamp;
      if (cur === goal) {
        found = true;
        break;
      }
      if (++expanded > maxExpand) break;
      const ci = cur % w;
      const cj = Math.floor(cur / w);
      for (let d = 0; d < 8; d++) {
        const ni = ci + DI[d];
        const nj = cj + DJ[d];
        if (ni < 0 || nj < 0 || ni >= w || nj >= this.h) continue;
        const nk = nj * w + ni;
        if (this.closed[nk] === stamp || !this.connected(cur, nk)) continue;
        // Diagonale nur, wenn beide Orthogonalen frei sind (keine Ecken schneiden)
        if (d >= 4 && (!this.connected(cur, cj * w + ni) || !this.connected(cur, nj * w + ci))) continue;
        const g = this.gScore[cur] + (d >= 4 ? 1.4142 : 1) * this.cell;
        if (this.visit[nk] === stamp && g >= this.gScore[nk]) continue;
        this.visit[nk] = stamp;
        this.gScore[nk] = g;
        this.parent[nk] = cur;
        this.push(nk, g + heur(nk));
      }
    }
    if (!found) return null;

    // Zellkette rückwärts → Punkte
    const cells: number[] = [];
    for (let k = goal; k !== -1; k = this.parent[k]) cells.push(k);
    cells.reverse();
    // String Pulling: von jedem Ankerpunkt so weit wie möglich geradeaus
    const out: THREE.Vector3[] = [];
    let ax = from.x;
    let az = from.z;
    let i = 0;
    while (i < cells.length - 1) {
      let j = cells.length - 1;
      while (j > i + 1 && !this.lineClear(ax, az, this.cx(cells[j]), this.cz(cells[j]))) j--;
      const k = cells[j];
      ax = this.cx(k);
      az = this.cz(k);
      out.push(new THREE.Vector3(ax, this.ground[k], az));
      i = j;
    }
    // Letzter Punkt: das tatsächliche Ziel (falls begehbar), nicht die Zellmitte
    if (out.length && this.walkable(to.x, to.z)) out[out.length - 1].set(to.x, this.groundAt(to.x, to.z), to.z);
    return out;
  }

  // --- Binärer Min-Heap (Zellindex, f-Wert) ---
  private push(k: number, f: number): void {
    const h = this.heap;
    const hf = this.heapF;
    let i = h.length;
    h.push(k);
    hf.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      h[i] = h[p];
      hf[i] = hf[p];
      i = p;
    }
    h[i] = k;
    hf[i] = f;
  }

  private pop(): number {
    const h = this.heap;
    const hf = this.heapF;
    const top = h[0];
    const lastK = h.pop()!;
    const lastF = hf.pop()!;
    const n = h.length;
    if (n === 0) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && hf[r] < hf[l] ? r : l;
      if (hf[c] >= lastF) break;
      h[i] = h[c];
      hf[i] = hf[c];
      i = c;
    }
    h[i] = lastK;
    hf[i] = lastF;
    return top;
  }
}

// Nachbarn: erst orthogonal (0–3), dann diagonal (4–7)
const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
