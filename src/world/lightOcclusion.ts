import * as THREE from 'three';
import { boxesInRegion, ColliderWatch, segmentBlocked, type BoxShape } from './particleCollision.ts';

// Verdeckung der Effektlichter (Lampen, Feuer, Spotlichter) für Volumen-Effekte.
// Die Volumen-Shader beleuchten mit bis zu 4 Lichtern ("Slots", siehe VolumeFX), kennen aber keine Wände –
// ohne das hier würde ein Nebel im Nachbarraum vom Feuer nebenan durch die Wand aufgehellt.
// Für eine feste Menge Weltpunkte (Nebel: Gitter, Rauch/Staub: wenige Stichproben) wird je Licht auf der CPU
// geprüft, ob die Strecke Licht → Punkt von einem Map-Collider verdeckt wird. Ergebnisse werden je Licht
// gecacht (Slot-Wechsel kostet nichts) und in Portionen über mehrere Frames berechnet.

export const LIGHT_SLOTS = 4;
type SlotLights = readonly (THREE.Object3D | null)[];

interface Entry {
  vis: Uint8Array;
  done: number;
  x: number;
  y: number;
  z: number;
  boxes: BoxShape[];
  seen: number;
}

const _lp = new THREE.Vector3();

export class LightVisibility {
  /** je Punkt 4 Bytes (RGBA = Slot 0..3): 255 = Licht erreicht den Punkt, 0 = verdeckt */
  readonly out: Uint8Array;
  readonly points: Float32Array;
  private entries = new Map<THREE.Object3D, Entry>();
  private watch = new ColliderWatch();
  private watchT = Infinity;
  private slots: (THREE.Object3D | null)[] = new Array(LIGHT_SLOTS).fill(null);
  private frame = 0;
  private b = [0, 0, 0, 0, 0, 0];

  constructor(readonly count: number) {
    this.points = new Float32Array(count * 3);
    this.out = new Uint8Array(count * 4).fill(255);
  }

  /** Punkte wurden geändert (this.points beschrieben) → alles neu rechnen */
  pointsChanged(): void {
    const p = this.points;
    const b = this.b;
    b[0] = b[1] = b[2] = Infinity;
    b[3] = b[4] = b[5] = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      b[0] = Math.min(b[0], p[i]);
      b[1] = Math.min(b[1], p[i + 1]);
      b[2] = Math.min(b[2], p[i + 2]);
      b[3] = Math.max(b[3], p[i]);
      b[4] = Math.max(b[4], p[i + 1]);
      b[5] = Math.max(b[5], p[i + 2]);
    }
    this.entries.clear();
  }

  /** Pro Frame: Slots übernehmen und ein Stück weiterrechnen. budget ≈ Strecken-Box-Tests je Licht.
   *  true = out hat sich geändert (Textur/Uniform aktualisieren). */
  update(dt: number, slots: SlotLights, budget: number): boolean {
    this.frame++;
    this.watchT += dt;
    if (this.watchT > 0.5) {
      this.watchT = 0;
      if (this.watch.changed()) this.entries.clear();
    }
    const n = this.count;
    let changed = false;
    for (let k = 0; k < LIGHT_SLOTS; k++) {
      const l = slots[k] ?? null;
      if (l !== this.slots[k]) {
        this.slots[k] = l;
        changed = true;
      }
      if (!l) continue;
      l.getWorldPosition(_lp);
      let e = this.entries.get(l);
      if (e && Math.abs(e.x - _lp.x) + Math.abs(e.y - _lp.y) + Math.abs(e.z - _lp.z) > 0.01) e = undefined;
      if (!e) {
        const b = this.b;
        e = {
          vis: new Uint8Array(n).fill(255),
          done: 0,
          x: _lp.x,
          y: _lp.y,
          z: _lp.z,
          // Boxen um Licht + Punkte; Boxen, in denen das Licht selbst steckt (Lampengehäuse, Tonne), zählen nicht
          boxes: boxesInRegion(Math.min(b[0], _lp.x), Math.min(b[1], _lp.y), Math.min(b[2], _lp.z), Math.max(b[3], _lp.x), Math.max(b[4], _lp.y), Math.max(b[5], _lp.z), _lp),
          seen: 0,
        };
        this.entries.set(l, e);
        changed = true;
      }
      e.seen = this.frame;
      if (e.done >= n) continue;
      if (e.boxes.length === 0) {
        e.done = n;
        continue;
      }
      const end = Math.min(n, e.done + Math.max(8, Math.floor(budget / e.boxes.length)));
      const p = this.points;
      for (let i = e.done; i < end; i++) {
        e.vis[i] = segmentBlocked(e.x, e.y, e.z, p[i * 3], p[i * 3 + 1], p[i * 3 + 2], e.boxes) ? 0 : 255;
      }
      e.done = end;
      changed = true;
    }
    if (changed) this.pack();
    // alte Lichter vergessen
    if (this.entries.size > 8) {
      for (const [l, e] of this.entries) if (e.seen < this.frame - 120) this.entries.delete(l);
    }
    return changed;
  }

  /** mittlere Sichtbarkeit je Slot (für grobe Effekte: Rauch, Staub) */
  average(target: THREE.Vector4): THREE.Vector4 {
    const s = [0, 0, 0, 0];
    const o = this.out;
    for (let i = 0; i < o.length; i += 4) {
      s[0] += o[i];
      s[1] += o[i + 1];
      s[2] += o[i + 2];
      s[3] += o[i + 3];
    }
    const f = 1 / (255 * Math.max(1, this.count));
    return target.set(s[0] * f, s[1] * f, s[2] * f, s[3] * f);
  }

  private pack(): void {
    const o = this.out;
    const n = this.count;
    for (let k = 0; k < LIGHT_SLOTS; k++) {
      const l = this.slots[k];
      const v = l ? this.entries.get(l)?.vis : undefined;
      if (v) for (let i = 0; i < n; i++) o[i * 4 + k] = v[i];
      else for (let i = 0; i < n; i++) o[i * 4 + k] = 255;
    }
  }
}
