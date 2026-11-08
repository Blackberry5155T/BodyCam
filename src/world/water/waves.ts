// Analytische Gerstner-Wellen: CPU und GPU rechnen mit denselben Parametern dieselbe Oberfläche.
// Eine Welle verschiebt jeden Punkt der Ruhefläche p kreisförmig: horizontal entlang der Laufrichtung,
// vertikal um amp·sin(Phase). Die Höhe an einem festen Welt-Punkt x findet man, indem man das p sucht,
// dessen verschobener Punkt über x liegt (wenige Fixpunkt-Schritte, siehe heightAt).

export const MAX_WAVES = 4;
const G = 9.81;

export interface Wave {
  dirX: number;
  dirZ: number;
  /** Wellenzahl 2π/λ */
  k: number;
  amp: number;
  /** Kreisfrequenz (Tiefwasser: √(g·k)) */
  omega: number;
  /** Steilheit 0..1 (horizontale Verschiebung) */
  q: number;
}

export interface WaveSet {
  waves: Wave[];
  /** größte Gesamthöhe (für Hüllen und Ausblenden) */
  maxAmp: number;
}

/**
 * Wellen aus den Objekt-Einstellungen: Höhe (Wellental bis Kamm, m), Länge der Hauptwelle (m), Richtung (Grad).
 * Vier Wellen mit abnehmender Länge und leicht gefächerter Richtung, damit kein starres Muster entsteht.
 */
export function makeWaves(height: number, length: number, dirDeg: number, choppy = 0.6): WaveSet {
  const waves: Wave[] = [];
  const h = Math.max(0, height);
  const L = Math.max(0.5, length);
  const base = (dirDeg * Math.PI) / 180;
  const spec = [
    { l: 1, a: 0.5, d: 0 },
    { l: 0.61, a: 0.27, d: 0.55 },
    { l: 0.37, a: 0.15, d: -0.7 },
    { l: 0.23, a: 0.08, d: 1.4 },
  ];
  let maxAmp = 0;
  for (const s of spec) {
    const lambda = L * s.l;
    const k = (2 * Math.PI) / lambda;
    const amp = (h / 2) * s.a * 1.9;
    const ang = base + s.d;
    // Steilheit begrenzen, damit sich keine Schleifen bilden (Q·k·A·n ≤ 1)
    const q = amp > 0 ? Math.min(choppy, 1 / (k * amp * MAX_WAVES)) : 0;
    waves.push({ dirX: Math.cos(ang), dirZ: Math.sin(ang), k, amp, omega: Math.sqrt(G * k), q });
    maxAmp += amp;
  }
  return { waves, maxAmp };
}

export const NO_WAVES: WaveSet = { waves: [], maxAmp: 0 };

/**
 * Verschiebung des Ruhepunkts (px, pz) zur Zeit t. `fade` (0..1) dämpft die Wellen (Ufer, Ferne).
 * Ergebnis in out: [dx, dy, dz].
 */
export function displace(set: WaveSet, px: number, pz: number, t: number, fade: number, out: Float64Array | number[]): void {
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (const w of set.waves) {
    const ph = w.k * (w.dirX * px + w.dirZ * pz) - w.omega * t;
    const c = Math.cos(ph);
    const s = Math.sin(ph);
    const a = w.amp * fade;
    dx += w.q * a * w.dirX * c;
    dz += w.q * a * w.dirZ * c;
    dy += a * s;
  }
  out[0] = dx;
  out[1] = dy;
  out[2] = dz;
}

const _d = new Float64Array(3);

/** Wellenhöhe (relativ zur Ruhefläche) an einem festen Welt-Punkt */
export function heightAt(set: WaveSet, x: number, z: number, t: number, fade = 1): number {
  if (!set.waves.length || fade <= 0) return 0;
  let px = x;
  let pz = z;
  for (let i = 0; i < 3; i++) {
    displace(set, px, pz, t, fade, _d);
    px = x - _d[0];
    pz = z - _d[2];
  }
  displace(set, px, pz, t, fade, _d);
  return _d[1];
}

/** Uniform-Werte: je Welle vec4(dirX, dirZ, k, amp) und vec4(omega, q, 0, 0) */
export function waveUniforms(set: WaveSet, a: THREE_Vec4[], b: THREE_Vec4[]): void {
  for (let i = 0; i < MAX_WAVES; i++) {
    const w = set.waves[i];
    if (w) {
      a[i].set(w.dirX, w.dirZ, w.k, w.amp);
      b[i].set(w.omega, w.q, 0, 0);
    } else {
      a[i].set(1, 0, 1, 0);
      b[i].set(0, 0, 0, 0);
    }
  }
}

interface THREE_Vec4 {
  set(x: number, y: number, z: number, w: number): unknown;
}

/** GLSL: dieselbe Verschiebung wie displace() (uWaveA/uWaveB, uWaterTime) */
export const WAVES_GLSL = /* glsl */ `
#define MAX_WAVES ${MAX_WAVES}
uniform vec4 uWaveA[MAX_WAVES];
uniform vec4 uWaveB[MAX_WAVES];
uniform float uWaterTime;

vec3 gerstner(vec2 p, float fade, out vec3 tangent, out vec3 binormal) {
  vec3 d = vec3(0.0);
  tangent = vec3(1.0, 0.0, 0.0);
  binormal = vec3(0.0, 0.0, 1.0);
  for (int i = 0; i < MAX_WAVES; i++) {
    vec4 a = uWaveA[i];
    vec4 b = uWaveB[i];
    float amp = a.w * fade;
    float ph = a.z * dot(a.xy, p) - b.x * uWaterTime;
    float c = cos(ph);
    float s = sin(ph);
    float qa = b.y * amp;
    d.x += qa * a.x * c;
    d.z += qa * a.y * c;
    d.y += amp * s;
    // Ableitungen für die Normale
    float wa = a.z * amp;
    tangent += vec3(-b.y * a.x * a.x * wa * s, a.x * wa * c, -b.y * a.x * a.y * wa * s);
    binormal += vec3(-b.y * a.x * a.y * wa * s, a.y * wa * c, -b.y * a.y * a.y * wa * s);
  }
  return d;
}
`;
