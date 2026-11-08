// Flachwasser-Simulation (Wasserquelle): „Virtual Pipes“ nach Mei, Decaudin & Hu (2007).
// Ein Höhenfeld-Gitter: je Zelle Bodenhöhe b, Wassertiefe d und vier Abflüsse (links/rechts/oben/unten) in m³/s.
// Je Schritt: Quellen füllen Wasser ein → Abflüsse beschleunigen mit dem Gefälle der Wasseroberfläche (b + d)
// → Tiefe ändert sich um Zu- minus Abfluss → Geschwindigkeit aus dem mittleren Durchfluss. Das Wasser läuft so
// bergab, sammelt sich in Senken (Seen) und läuft über, Flussbetten leiten es weiter. Am Gebietsrand und in
// Zellen ohne Boden (Abgrund) fließt es ab. Reibung bremst flaches Wasser stärker, Versickerung lässt dünne
// Filme verschwinden. Reines TypeScript ohne three.js — läuft im Web Worker.

export const SIM_G = 9.81;
/** Ab dieser Tiefe gilt eine Zelle als nass (Darstellung, Abfragen) */
export const SIM_WET = 0.008;
const MAX_SPEED = 9;

export interface SimSource {
  /** Mitte in Zell-Koordinaten (Zellmitte = Index + 0.5) */
  x: number;
  z: number;
  /** Radius in Zellen */
  r: number;
  /** Zufluss in m³/s */
  rate: number;
}

export interface SimParams {
  /** Reibung 0..1 (Bodenrauheit) */
  friction: number;
  /** Versickerung/Verdunstung in m/s */
  loss: number;
}

export class ShallowWater {
  readonly n: number;
  readonly depth: Float32Array;
  readonly fl: Float32Array;
  readonly fr: Float32Array;
  readonly ft: Float32Array;
  readonly fb: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
  /** 1 = kein Boden (Wasser verschwindet) */
  readonly drain: Uint8Array;
  time = 0;
  params: SimParams = { friction: 0.3, loss: 0.0002 };
  private srcCells: Int32Array = new Int32Array(0);
  private srcShare: Float32Array = new Float32Array(0);

  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
  /** Bodenhöhe je Zelle (NaN = kein Boden) */
  readonly ground: Float32Array;

  constructor(nx: number, nz: number, cell: number, ground: Float32Array) {
    this.nx = nx;
    this.nz = nz;
    this.cell = cell;
    this.ground = ground;
    const n = (this.n = nx * nz);
    this.depth = new Float32Array(n);
    this.fl = new Float32Array(n);
    this.fr = new Float32Array(n);
    this.ft = new Float32Array(n);
    this.fb = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.drain = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!Number.isFinite(ground[i])) this.drain[i] = 1;
  }

  /** Quellen setzen: Zellen im Radius bekommen je einen Anteil (zur Mitte hin mehr) */
  setSources(list: readonly SimSource[]): void {
    const cells: number[] = [];
    const share: number[] = [];
    for (const s of list) {
      const r = Math.max(0.5, s.r);
      const x0 = Math.max(0, Math.floor(s.x - r));
      const x1 = Math.min(this.nx - 1, Math.ceil(s.x + r));
      const z0 = Math.max(0, Math.floor(s.z - r));
      const z1 = Math.min(this.nz - 1, Math.ceil(s.z + r));
      const start = cells.length;
      let sum = 0;
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x + 0.5 - s.x, z + 0.5 - s.z);
          if (d > r) continue;
          const i = z * this.nx + x;
          if (this.drain[i]) continue;
          const w = 1 - (d / r) * 0.7;
          cells.push(i);
          share.push(w);
          sum += w;
        }
      if (cells.length === start) {
        // Radius kleiner als eine Zelle: nächste Zelle
        const x = Math.min(this.nx - 1, Math.max(0, Math.floor(s.x)));
        const z = Math.min(this.nz - 1, Math.max(0, Math.floor(s.z)));
        const i = z * this.nx + x;
        if (this.drain[i]) continue;
        cells.push(i);
        share.push(1);
        sum = 1;
      }
      for (let k = start; k < share.length; k++) share[k] = (share[k] / sum) * s.rate;
    }
    this.srcCells = Int32Array.from(cells);
    this.srcShare = Float32Array.from(share);
  }

  /** größter stabiler Zeitschritt (CFL) */
  maxDt(): number {
    let dmax = 0.05;
    let vmax = 0;
    const { depth, vx, vz } = this;
    for (let i = 0; i < this.n; i++) {
      if (depth[i] > dmax) dmax = depth[i];
      const v = Math.abs(vx[i]) + Math.abs(vz[i]);
      if (v > vmax) vmax = v;
    }
    return Math.min(0.05, (this.cell * 0.5) / (Math.sqrt(SIM_G * dmax) + vmax));
  }

  /** `seconds` weiterrechnen (in stabilen Teilschritten) */
  advance(seconds: number): void {
    let left = seconds;
    let guard = 0;
    while (left > 1e-6 && guard++ < 100000) {
      const dt = Math.min(left, this.maxDt());
      this.step(dt);
      left -= dt;
    }
  }

  step(dt: number): void {
    const { nx, nz, cell, ground, depth, fl, fr, ft, fb, vx, vz, drain } = this;
    const A = cell * cell;
    const k = dt * cell * SIM_G;
    const fric = 0.004 + this.params.friction * 0.06;
    const fricV = this.params.friction * 0.15;

    // 1) Quellen
    const sc = this.srcCells;
    const ss = this.srcShare;
    for (let j = 0; j < sc.length; j++) depth[sc[j]] += (ss[j] * dt) / A;

    // 2) Abflüsse
    for (let z = 0; z < nz; z++) {
      const row = z * nx;
      for (let x = 0; x < nx; x++) {
        const i = row + x;
        if (drain[i]) continue;
        const d = depth[i];
        const b = ground[i];
        const H = b + d;
        // Nachbar fehlt (Rand) oder ohne Boden: Wasser fällt/fließt ab, als läge dort die eigene Bodenhöhe
        let n2 = i - 1;
        const hL = x > 0 && !drain[n2] ? ground[n2] + depth[n2] : b;
        n2 = i + 1;
        const hR = x < nx - 1 && !drain[n2] ? ground[n2] + depth[n2] : b;
        n2 = i - nx;
        const hT = z > 0 && !drain[n2] ? ground[n2] + depth[n2] : b;
        n2 = i + nx;
        const hB = z < nz - 1 && !drain[n2] ? ground[n2] + depth[n2] : b;
        // Reibung: flaches und schnelles Wasser wird stärker gebremst
        const sp = Math.abs(vx[i]) + Math.abs(vz[i]);
        const damp = 1 / (1 + (dt * (fric + fricV * sp)) / Math.max(d, 0.004));
        let l = Math.max(0, fl[i] * damp + k * (H - hL));
        let r = Math.max(0, fr[i] * damp + k * (H - hR));
        let t = Math.max(0, ft[i] * damp + k * (H - hT));
        let bo = Math.max(0, fb[i] * damp + k * (H - hB));
        const sum = (l + r + t + bo) * dt;
        const vol = d * A;
        if (sum > vol) {
          const s = sum > 0 ? vol / sum : 0;
          l *= s;
          r *= s;
          t *= s;
          bo *= s;
        }
        fl[i] = l;
        fr[i] = r;
        ft[i] = t;
        fb[i] = bo;
      }
    }

    // 3) Tiefe + Geschwindigkeit
    const loss = this.params.loss * dt;
    for (let z = 0; z < nz; z++) {
      const row = z * nx;
      for (let x = 0; x < nx; x++) {
        const i = row + x;
        if (drain[i]) {
          depth[i] = 0;
          vx[i] = 0;
          vz[i] = 0;
          continue;
        }
        const inL = x > 0 ? fr[i - 1] : 0;
        const inR = x < nx - 1 ? fl[i + 1] : 0;
        const inT = z > 0 ? fb[i - nx] : 0;
        const inB = z < nz - 1 ? ft[i + nx] : 0;
        const d0 = depth[i];
        let d1 = d0 + (dt * (inL + inR + inT + inB - fl[i] - fr[i] - ft[i] - fb[i])) / A;
        d1 = d1 > loss ? d1 - loss : 0;
        depth[i] = d1;
        const dm = (d0 + d1) * 0.5;
        if (dm > 1e-4) {
          // dünne Filme: Tiefe nach unten begrenzen, sonst entstehen riesige Scheingeschwindigkeiten
          const dv = cell * Math.max(dm, 0.02);
          const wx = (inL - fl[i] + fr[i] - inR) * 0.5;
          const wz = (inT - ft[i] + fb[i] - inB) * 0.5;
          let u = wx / dv;
          let v = wz / dv;
          const s = Math.hypot(u, v);
          if (s > MAX_SPEED) {
            u *= MAX_SPEED / s;
            v *= MAX_SPEED / s;
          }
          vx[i] = u;
          vz[i] = v;
        } else {
          vx[i] = 0;
          vz[i] = 0;
        }
      }
    }
    this.time += dt;
  }

  /** Wassermenge im Gebiet (m³) */
  volume(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.depth[i];
    return s * this.cell * this.cell;
  }

  /** nasse Zellen */
  wetCount(): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.depth[i] > SIM_WET) c++;
    return c;
  }
}

// ---------- Zustand speichern/laden ----------

export interface SimHeader {
  nx: number;
  nz: number;
  cell: number;
  minX: number;
  minZ: number;
  time: number;
}

const MAGIC = 0x57534d31; // "WSM1"

/** Gitter + Zustand als Bytes (Boden, Tiefe, 4 Abflüsse, Geschwindigkeit) — wird mit fflate komprimiert */
export function encodeSim(s: ShallowWater, minX: number, minZ: number): Uint8Array {
  return encodeState({ nx: s.nx, nz: s.nz, cell: s.cell, minX, minZ, time: s.time }, s.ground, s.depth, s.vx, s.vz, [s.fl, s.fr, s.ft, s.fb]);
}

/** Zustand aus einzelnen Feldern (ohne Abflüsse: starten bei null) */
export function encodeState(h: SimHeader, ground: Float32Array, depth: Float32Array, vx: Float32Array, vz: Float32Array, flux?: Float32Array[]): Uint8Array {
  const n = h.nx * h.nz;
  const head = new Float64Array([MAGIC, h.nx, h.nz, h.cell, h.minX, h.minZ, h.time, 0]);
  const body = new Float32Array(n * 8);
  body.set(ground, 0);
  body.set(depth, n);
  if (flux) for (let k = 0; k < 4; k++) body.set(flux[k], n * (2 + k));
  body.set(vx, n * 6);
  body.set(vz, n * 7);
  const out = new Uint8Array(head.byteLength + body.byteLength);
  out.set(new Uint8Array(head.buffer), 0);
  out.set(new Uint8Array(body.buffer), head.byteLength);
  return out;
}

export function decodeHeader(bytes: Uint8Array): SimHeader | null {
  if (bytes.byteLength < 64) return null;
  const head = new Float64Array(bytes.slice(0, 64).buffer);
  if (head[0] !== MAGIC) return null;
  const nx = head[1];
  const nz = head[2];
  if (bytes.byteLength !== 64 + nx * nz * 8 * 4) return null;
  return { nx, nz, cell: head[3], minX: head[4], minZ: head[5], time: head[6] };
}

export function decodeSim(bytes: Uint8Array): { head: SimHeader; sim: ShallowWater } | null {
  const head = decodeHeader(bytes);
  if (!head) return null;
  const n = head.nx * head.nz;
  const body = new Float32Array(bytes.slice(64).buffer);
  const sim = new ShallowWater(head.nx, head.nz, head.cell, body.slice(0, n));
  sim.depth.set(body.subarray(n, n * 2));
  sim.fl.set(body.subarray(n * 2, n * 3));
  sim.fr.set(body.subarray(n * 3, n * 4));
  sim.ft.set(body.subarray(n * 4, n * 5));
  sim.fb.set(body.subarray(n * 5, n * 6));
  sim.vx.set(body.subarray(n * 6, n * 7));
  sim.vz.set(body.subarray(n * 7, n * 8));
  sim.time = head.time;
  return { head, sim };
}
