import * as THREE from 'three';
import type { Collider } from './collision.ts';
import { boxesInRegion, particleWorld, type BoxShape } from './particleCollision.ts';
import { LightVisibility } from './lightOcclusion.ts';

// Volumetrische Effekte für Maps: Nebelvolumen (Raymarching in einer Box), Lichtkegel für Spotlights
// und schwebende Staubpartikel. Feuer, Rauch und Funken liegen in particles.ts.
//
// Alle Volumen-Objekte liegen auf VOLUME_LAYER und werden vom VolumePass (rendering/volumePass.ts)
// nach der opaken Szene gezeichnet. Dadurch kennen sie die Szenentiefe: Nebel endet sauber an Wänden,
// Partikel blenden weich am Boden aus. Gemeinsame Uniforms (volumeFX) liefern pro Frame:
//   - Beleuchtung: Taschenlampe (mit Schattenkarte → Schatten im Lichtkegel) + bis zu 4 Lichter
//   - Interaktion: "Störer" (Spieler-Kapsel, Schussbahnen) drücken Nebel und Partikel weg
//   - Physik: Welt-Collider + Spielerkörper für CPU-Partikel (siehe particleCollision.ts)
//   - Wind (vom Wetter), Umgebungslicht, Qualität

export const VOLUME_LAYER = 3;
const MAX_DISTURB = 8;
const MAX_LIGHTS = 4;

// ---------- 3D-Rauschtextur (kachelbar, Perlin-Worley) ----------

let noiseTex: THREE.Data3DTexture | null = null;

/** 64³ kachelbare Rauschtextur: R = weiche Wolken (fbm × invertiertes Worley) */
export function noiseTexture3D(): THREE.Data3DTexture {
  if (noiseTex) return noiseTex;
  const N = 64;
  const data = new Uint8Array(N * N * N);
  const hash = (x: number, y: number, z: number, s: number) => {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 144665) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const valueNoise = (x: number, y: number, z: number, period: number, seed: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = smooth(x - xi), fy = smooth(y - yi), fz = smooth(z - zi);
    const m = (v: number) => ((v % period) + period) % period;
    const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1), z0 = m(zi), z1 = m(zi + 1);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(hash(x0, y0, z0, seed), hash(x1, y0, z0, seed), fx), l(hash(x0, y1, z0, seed), hash(x1, y1, z0, seed), fx), fy),
      l(l(hash(x0, y0, z1, seed), hash(x1, y0, z1, seed), fx), l(hash(x0, y1, z1, seed), hash(x1, y1, z1, seed), fx), fy),
      fz,
    );
  };
  // Worley: Merkmalspunkte je Zelle, kachelbar
  const CELLS = 5;
  const worley = (x: number, y: number, z: number) => {
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const ix = cx + dx, iy = cy + dy, iz = cz + dz;
          const wx = ((ix % CELLS) + CELLS) % CELLS, wy = ((iy % CELLS) + CELLS) % CELLS, wz = ((iz % CELLS) + CELLS) % CELLS;
          const px = ix + hash(wx, wy, wz, 11) - x;
          const py = iy + hash(wx, wy, wz, 23) - y;
          const pz = iz + hash(wx, wy, wz, 37) - z;
          const d = px * px + py * py + pz * pz;
          if (d < best) best = d;
        }
    return Math.sqrt(best);
  };
  let i = 0;
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const u = x / N, v = y / N, w = z / N;
        let f = 0, amp = 0.55, total = 0;
        for (let o = 0; o < 4; o++) {
          const per = 4 << o;
          f += valueNoise(u * per, v * per, w * per, per, o) * amp;
          total += amp;
          amp *= 0.5;
        }
        f /= total;
        const wl = 1 - Math.min(1, worley(u * CELLS, v * CELLS, w * CELLS) * 1.1);
        let n = f * 0.65 + wl * 0.45 - 0.08;
        n = Math.min(1, Math.max(0, (n - 0.2) * 1.6));
        data[i++] = Math.round(n * 255);
      }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  noiseTex = tex;
  return tex;
}

// ---------- Gemeinsamer Zustand ----------

interface Disturber {
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
  strength: number;
  /** Schüsse: wachsen und verblassen */
  age?: number;
  life?: number;
  r0?: number;
  r1?: number;
}

type FxLight = THREE.PointLight | THREE.SpotLight;
type ShotListener = (from: THREE.Vector3, to: THREE.Vector3) => void;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _col = new THREE.Color();

class VolumeFX {
  readonly uniforms = {
    vDepth: { value: null as THREE.Texture | null },
    vDepthOn: { value: 0 },
    vScreen: { value: new THREE.Vector2(1, 1) },
    vNear: { value: 0.05 },
    vFar: { value: 200 },
    vNoise: { value: null as THREE.Data3DTexture | null },
    vTime: { value: 0 },
    vWind: { value: new THREE.Vector3() },
    vAmbient: { value: new THREE.Color(0.25, 0.26, 0.28) },
    vSteps: { value: 24 },
    vDisA: { value: Array.from({ length: MAX_DISTURB }, () => new THREE.Vector4()) },
    vDisB: { value: Array.from({ length: MAX_DISTURB }, () => new THREE.Vector4()) },
    vLampPos: { value: new THREE.Vector3() },
    vLampDir: { value: new THREE.Vector3(0, 0, -1) },
    vLampColor: { value: new THREE.Color(0, 0, 0) },
    vLampCone: { value: new THREE.Vector3(0.9, 0.95, 30) },
    vLampShadow: { value: null as THREE.Texture | null },
    vLampShadowMat: { value: new THREE.Matrix4() },
    vLampShadowOn: { value: 0 },
    vLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
    vLightCol: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
    vLightSpot: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4(0, -1, 0, -2)) },
  };

  /** 0 = niedrig, 1 = mittel, 2 = hoch */
  quality = 2;
  /** Regenstärke 0..1 (dämpft Feuer) */
  rain = 0;
  readonly wind = new THREE.Vector3();
  private lamp: THREE.SpotLight | null = null;
  private lights = new Set<FxLight>();
  /** Lichter in den Shader-Slots (vLightPos[i] …) dieses Frames; null = leer. Für die Verdeckung (lightOcclusion.ts) */
  readonly slots: (FxLight | null)[] = new Array(MAX_LIGHTS).fill(null);
  private player: Disturber | null = null;
  readonly playerVel = new THREE.Vector3();
  /** Spielerkörper als festes Hindernis für Partikel (Kapsel a → b mit Radius) */
  readonly body = { on: false, a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.36 };
  private shots: Disturber[] = [];
  private shotListeners = new Set<ShotListener>();
  readonly camPosition = new THREE.Vector3();

  constructor() {
    this.uniforms.vNoise.value = null;
  }

  /** Lazy, damit die Rauschtextur erst bei Bedarf gebaut wird */
  ensureNoise(): void {
    if (!this.uniforms.vNoise.value) this.uniforms.vNoise.value = noiseTexture3D();
  }

  setQuality(q: number): void {
    this.quality = THREE.MathUtils.clamp(Math.round(q), 0, 2);
    this.uniforms.vSteps.value = [12, 24, 40][this.quality];
  }

  /** Partikel-Faktor je Qualität */
  get particleScale(): number {
    return [0.45, 0.75, 1][this.quality];
  }

  setLamp(lamp: THREE.SpotLight | null): void {
    this.lamp = lamp;
  }

  addLight(light: FxLight): () => void {
    this.lights.add(light);
    return () => this.lights.delete(light);
  }

  /** Spieler als Störer (Kapsel Füße → Kopf); null = keiner */
  setPlayer(feet: THREE.Vector3 | null, height = 1.8, velocity?: THREE.Vector3): void {
    if (!feet) {
      this.player = null;
      this.body.on = false;
      this.playerVel.set(0, 0, 0);
      return;
    }
    if (!this.player) this.player = { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.55, strength: 0.85 };
    this.player.a.copy(feet).y += 0.25;
    this.player.b.copy(feet).y += height - 0.15;
    const body = this.body;
    body.on = true;
    body.a.copy(feet).y += body.radius;
    body.b.copy(feet).y += Math.max(body.radius, height - body.radius);
    if (velocity) this.playerVel.copy(velocity);
  }

  /** Welt-Collider für Partikel-Kollision (Rauch staut sich an Decken, Funken prallen ab, …).
   *  Die Liste darf danach in place verändert werden (wird per Länge/Intervall nachgezogen). */
  setColliders(list: readonly Collider[] | null, groundPlane: boolean): void {
    particleWorld.colliders = list ?? [];
    particleWorld.groundPlane = groundPlane;
  }

  /** Schussbahn: reißt eine Schneise in Nebel und Rauch */
  addShot(from: THREE.Vector3, to: THREE.Vector3): void {
    this.shots.push({ a: from.clone(), b: to.clone(), radius: 0.08, strength: 1, age: 0, life: 1.6, r0: 0.08, r1: 0.55 });
    if (this.shots.length > 6) this.shots.shift();
    for (const fn of this.shotListeners) fn(from, to);
  }

  onShot(fn: ShotListener): () => void {
    this.shotListeners.add(fn);
    return () => this.shotListeners.delete(fn);
  }

  /** Aktive Störer (für CPU-Partikel) */
  forEachDisturber(fn: (d: { a: THREE.Vector3; b: THREE.Vector3; radius: number; strength: number }, isPlayer: boolean) => void): void {
    if (this.player) fn(this.player, true);
    for (const s of this.shots) fn(s, false);
  }

  /** Umgebungslicht für Rauch/Staub aus Himmels- und Sonnenlicht */
  setAmbient(hemi: THREE.HemisphereLight | null, sun?: THREE.Light | null): void {
    const c = this.uniforms.vAmbient.value;
    if (!hemi) {
      c.setRGB(0.25, 0.26, 0.28);
      return;
    }
    c.copy(hemi.color).lerp(hemi.groundColor, 0.5).multiplyScalar(hemi.intensity);
    if (sun && sun.visible) c.add(_col.copy(sun.color).multiplyScalar(sun.intensity * 0.15));
  }

  update(dt: number, t: number, camera: THREE.Camera): void {
    const u = this.uniforms;
    u.vTime.value = t;
    u.vWind.value.copy(this.wind);
    camera.getWorldPosition(this.camPosition);

    // Störer
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.age! += dt;
      const k = s.age! / s.life!;
      if (k >= 1) {
        this.shots.splice(i, 1);
        continue;
      }
      s.radius = THREE.MathUtils.lerp(s.r0!, s.r1!, 1 - (1 - k) * (1 - k));
      s.strength = (1 - k) * (1 - k);
    }
    let n = 0;
    this.forEachDisturber((d) => {
      if (n >= MAX_DISTURB) return;
      u.vDisA.value[n].set(d.a.x, d.a.y, d.a.z, d.radius);
      u.vDisB.value[n].set(d.b.x, d.b.y, d.b.z, d.strength);
      n++;
    });
    for (; n < MAX_DISTURB; n++) u.vDisB.value[n].w = 0;

    // Taschenlampe
    const lamp = this.lamp;
    if (lamp && lamp.visible && lamp.intensity > 0) {
      lamp.getWorldPosition(u.vLampPos.value);
      lamp.target.getWorldPosition(_a);
      u.vLampDir.value.copy(_a).sub(u.vLampPos.value).normalize();
      u.vLampColor.value.copy(lamp.color).multiplyScalar(lamp.intensity);
      u.vLampCone.value.set(Math.cos(lamp.angle), Math.cos(lamp.angle * (1 - lamp.penumbra)), lamp.distance || 30);
      const map = lamp.castShadow ? lamp.shadow.map : null;
      u.vLampShadow.value = map?.depthTexture ?? null;
      u.vLampShadowOn.value = map ? 1 : 0;
      if (map) u.vLampShadowMat.value.copy(lamp.shadow.matrix);
    } else {
      u.vLampColor.value.setRGB(0, 0, 0);
      u.vLampShadowOn.value = 0;
    }

    // Lichter: die hellsten (relativ zur Kamera) gewinnen
    const ranked: { l: FxLight; score: number }[] = [];
    for (const l of this.lights) {
      if (l.intensity <= 0.01 || !isVisible(l)) continue;
      l.getWorldPosition(_b);
      const d2 = _b.distanceToSquared(this.camPosition);
      const range = l.distance || 30;
      if (Math.sqrt(d2) > range + 25) continue;
      ranked.push({ l, score: l.intensity / (d2 + 4) });
    }
    ranked.sort((x, y) => y.score - x.score);
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const r = ranked[i];
      this.slots[i] = r ? r.l : null;
      const pos = u.vLightPos.value[i];
      const col = u.vLightCol.value[i];
      const spot = u.vLightSpot.value[i];
      if (!r) {
        col.set(0, 0, 0, 1);
        continue;
      }
      const l = r.l;
      l.getWorldPosition(_b);
      pos.set(_b.x, _b.y, _b.z, l.distance || 30);
      col.set(l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity, 1);
      if ((l as THREE.SpotLight).isSpotLight) {
        const s = l as THREE.SpotLight;
        s.target.getWorldPosition(_a);
        _a.sub(_b).normalize();
        spot.set(_a.x, _a.y, _a.z, Math.cos(s.angle));
        col.w = Math.cos(s.angle * (1 - s.penumbra));
      } else {
        spot.set(0, -1, 0, -2);
      }
    }
  }
}

function isVisible(o: THREE.Object3D): boolean {
  for (let c: THREE.Object3D | null = o; c; c = c.parent) if (!c.visible) return false;
  return true;
}

export const volumeFX = new VolumeFX();

/** Gemeinsame Uniforms per Referenz einhängen (nicht klonen!) */
export function sharedUniforms(): typeof volumeFX.uniforms {
  volumeFX.ensureNoise();
  return { ...volumeFX.uniforms };
}

/** Markiert ein Objekt (und Kinder) als Volumen: eigener Layer, nicht treff-/wählbar */
export function asVolume<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => {
    if ((c as THREE.Light).isLight) return;
    c.layers.set(VOLUME_LAYER);
    c.userData.noPick = true;
    c.userData.noShot = true;
  });
  return o;
}

// ---------- GLSL ----------

/** Nur die gemeinsamen Uniforms (auch im Vertex-Shader nutzbar) */
export const VOLUME_UNIFORMS = /* glsl */ `
uniform sampler2D vDepth;
uniform float vDepthOn;
uniform vec2 vScreen;
uniform float vNear, vFar;
uniform sampler3D vNoise;
uniform float vTime;
uniform vec3 vWind;
uniform vec3 vAmbient;
uniform int vSteps;
uniform vec4 vDisA[${MAX_DISTURB}];
uniform vec4 vDisB[${MAX_DISTURB}];
uniform vec3 vLampPos, vLampDir, vLampColor, vLampCone;
uniform sampler2DShadow vLampShadow;
uniform mat4 vLampShadowMat;
uniform float vLampShadowOn;
uniform vec4 vLightPos[${MAX_LIGHTS}];
uniform vec4 vLightCol[${MAX_LIGHTS}];
uniform vec4 vLightSpot[${MAX_LIGHTS}];
`;

/** Uniforms + Fragment-Hilfsfunktionen */
export const VOLUME_GLSL = /* glsl */ `
${VOLUME_UNIFORMS}
const float PI_V = 3.14159265;

float vHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
/** Interleaved Gradient Noise: gleichmäßiges Dithering gegen Banding */
float vIGN(vec2 px) {
  return fract(52.9829189 * fract(dot(px + vec2(5.588238, 5.588238) * mod(vTime * 60.0, 64.0), vec2(0.06711056, 0.00583715))));
}
float vNoise3(vec3 p) { return texture(vNoise, p).r; }
/** zweistufiges Wolkenrauschen (grob + Detail) */
float vCloud(vec3 p) {
  return vNoise3(p * 0.25) * 0.7 + vNoise3(p * 0.73 + 0.37) * 0.3;
}

/** lineare Szenentiefe (Kameraachse) am aktuellen Pixel, 1e6 ohne Tiefe */
float vSceneLinear() {
  if (vDepthOn < 0.5) return 1e6;
  float d = texture2D(vDepth, gl_FragCoord.xy / vScreen).x;
#ifdef USE_REVERSED_DEPTH_BUFFER
  // Reversed-Z: Near = 1, Far/Himmel = 0
  if (d <= 1e-7) return 1e6;
  return vNear * vFar / (vNear + d * (vFar - vNear));
#else
  if (d >= 0.99999) return 1e6;
  return vNear * vFar / (vFar - d * (vFar - vNear));
#endif
}
vec3 vCamForward() { return -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]); }
/** Distanz von der Kamera bis zur Szene entlang der (Welt-)Blickrichtung rd */
float vSceneDistance(vec3 rd) {
  return vSceneLinear() / max(dot(rd, vCamForward()), 1e-3);
}

/** 0..1: wie stark Spieler/Schüsse das Medium an p verdrängen */
float vDisturb(vec3 p) {
  float k = 0.0;
  for (int i = 0; i < ${MAX_DISTURB}; i++) {
    vec4 B = vDisB[i];
    if (B.w <= 0.0) continue;
    vec4 A = vDisA[i];
    vec3 ab = B.xyz - A.xyz;
    float t = clamp(dot(p - A.xyz, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
    float d = length(p - A.xyz - ab * t);
    k = max(k, B.w * (1.0 - smoothstep(A.w * 0.35, A.w, d)));
  }
  return k;
}

float vPhase(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-3), 1.5);
}

/** Schattenkarte eines Spotlichts an p abfragen (1 = beleuchtet) */
float vShadowAt(sampler2DShadow map, mat4 m, vec3 p) {
  vec4 sc = m * vec4(p, 1.0);
  sc.xyz /= sc.w;
  if (sc.w <= 0.0 || sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z < 0.0 || sc.z > 1.0) return 1.0;
  // Hardware-Vergleich gegen die Tiefentextur der Schattenkarte (compareFunction setzt three)
#ifdef USE_REVERSED_DEPTH_BUFFER
  return texture(map, vec3(sc.xy, sc.z + 0.002));
#else
  return texture(map, vec3(sc.xy, sc.z - 0.002));
#endif
}

float vLampShadowAt(vec3 p) {
  if (vLampShadowOn < 0.5) return 1.0;
  return vShadowAt(vLampShadow, vLampShadowMat, p);
}

/** Einfallendes Licht an p (Blickrichtung rd), g = Vorwärtsstreuung;
 *  vis[i] = Sichtbarkeit von Effektlicht i an p (0 = hinter einer Wand, siehe lightOcclusion.ts) */
vec3 vLightAtVis(vec3 p, vec3 rd, float g, bool lampShadow, vec4 vis) {
  vec3 L = vec3(0.0);
  vec3 tl = vLampPos - p;
  float dl = length(tl);
  if (dot(vLampColor, vLampColor) > 0.0 && dl < vLampCone.z) {
    vec3 l = tl / max(dl, 1e-4);
    float spot = smoothstep(vLampCone.x, vLampCone.y, dot(-l, vLampDir));
    if (spot > 0.0) {
      float win = 1.0 - pow(dl / vLampCone.z, 4.0);
      float att = spot * win * win / (dl * dl + 0.25);
      if (lampShadow) att *= vLampShadowAt(p);
      L += vLampColor * att * vPhase(dot(rd, -l), g);
    }
  }
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    vec4 c = vLightCol[i];
    if (c.r + c.g + c.b <= 0.0) continue;
    vec4 lp = vLightPos[i];
    vec3 tv = lp.xyz - p;
    float d = length(tv);
    if (d > lp.w) continue;
    vec3 l = tv / max(d, 1e-4);
    vec4 s = vLightSpot[i];
    float spot = s.w < -1.5 ? 1.0 : smoothstep(s.w, c.w, dot(-l, s.xyz));
    float win = 1.0 - pow(d / lp.w, 4.0);
    L += c.rgb * spot * win * win / (d * d + 0.25) * vPhase(dot(rd, -l), g * 0.6) * vis[i];
  }
  return L;
}
vec3 vLightAt(vec3 p, vec3 rd, float g, bool lampShadow) {
  return vLightAtVis(p, rd, g, lampShadow, vec4(1.0));
}

/** weiches Ausblenden an Geometrie (Soft Particles), viewDepth = lineare Tiefe des Fragments */
float vSoftFade(float viewDepth, float range) {
  return clamp((vSceneLinear() - viewDepth) / range, 0.0, 1.0);
}
`;

/** Shader-Kopf für Volumen-Materialien: packing (Schattenkarte) + gemeinsame Uniforms */
export const VOLUME_HEAD = /* glsl */ `
#include <packing>
${VOLUME_GLSL}
`;

/** Szenen-Nebel auf vormultiplizierte Farbe (rgb, alpha) anwenden */
export const FOG_PREMUL = /* glsl */ `
#ifdef USE_FOG
  float fogF = smoothstep(fogNear, fogFar, vFogDepth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor * gl_FragColor.a, fogF);
#endif
`;

/** Additiv: im Nebel verschwinden */
export const FOG_ADDITIVE = /* glsl */ `
#ifdef USE_FOG
  gl_FragColor.rgb *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
#endif
`;

const PREMUL_BLEND = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
} as const;
export { PREMUL_BLEND };

// ---------- Nebelvolumen ----------

export interface FogVolumeParams {
  color: string;
  density: number; // Extinktion pro Meter
  brightness: number; // Eigenleuchten (>1 = leuchtender Dunst, Bloom)
  noise: number; // 0..1 Anteil der Wolkenstruktur
  noiseScale: number; // Strukturgröße (1/m)
  edge: number; // weiche Kante (Anteil der Box)
  heightFalloff: number; // 0..1, unten dichter
  speed: number;
  /** wie stark Lichter (Taschenlampe, Lampen, Feuer) den Nebel aufhellen */
  lightResponse?: number;
  /** Vorwärtsstreuung 0..0.9 (hoch = Lichtkegel heller, wenn man hineinleuchtet) */
  anisotropy?: number;
  /** Spieler und Schüsse verdrängen den Nebel */
  interactive?: boolean;
}

const _gp = new THREE.Vector3();
const _gq = new THREE.Quaternion();
const _gs = new THREE.Vector3();

/** Sichtbarkeit der Effektlichter in einem Einheitswürfel-Volumen (Nebel, Staub) als RGBA-3D-Textur
 *  (Kanal i = Licht-Slot i). Wird neu aufgebaut, wenn das Objekt bewegt/skaliert wird. */
class VisGrid {
  private vis: LightVisibility | null = null;
  private tex: THREE.Data3DTexture | null = null;
  private dims = [0, 0, 0];
  private lastMatrix = new THREE.Matrix4();

  constructor(
    private obj: THREE.Object3D,
    private texUniform: { value: THREE.Data3DTexture | null },
    private onUniform: { value: number },
    private cell = 0.35,
    private maxCells = 12000,
  ) {}

  update(dt: number): void {
    if (!isVisible(this.obj)) return;
    this.obj.updateWorldMatrix(true, false);
    if (!this.vis || !this.lastMatrix.equals(this.obj.matrixWorld)) this.rebuild();
    if (this.vis!.update(dt, volumeFX.slots, 20000)) this.tex!.needsUpdate = true;
  }

  dispose(): void {
    this.tex?.dispose();
  }

  private rebuild(): void {
    const m = this.obj.matrixWorld;
    this.lastMatrix.copy(m);
    m.decompose(_gp, _gq, _gs);
    const want = [_gs.x, _gs.y, _gs.z].map((v) => THREE.MathUtils.clamp(Math.ceil(Math.abs(v) / this.cell), 2, 32));
    while (want[0] * want[1] * want[2] > this.maxCells) {
      const i = want.indexOf(Math.max(...want));
      want[i] = Math.max(2, Math.floor(want[i] * 0.8));
    }
    const [nx, ny, nz] = want;
    const d = this.dims;
    if (!this.vis || nx !== d[0] || ny !== d[1] || nz !== d[2]) {
      d[0] = nx;
      d[1] = ny;
      d[2] = nz;
      this.vis = new LightVisibility(nx * ny * nz);
      this.tex?.dispose();
      const tex = new THREE.Data3DTexture(this.vis.out, nx, ny, nz);
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.UnsignedByteType;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      this.tex = tex;
      this.texUniform.value = tex;
      this.onUniform.value = 1;
    }
    const pts = this.vis.points;
    let i = 0;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          _gp.set((x + 0.5) / nx - 0.5, (y + 0.5) / ny - 0.5, (z + 0.5) / nz - 0.5).applyMatrix4(m);
          pts[i++] = _gp.x;
          pts[i++] = _gp.y;
          pts[i++] = _gp.z;
        }
    this.vis.pointsChanged();
  }
}

/** Box-Nebelvolumen (Einheitswürfel, Größe über die Objektskalierung) */
export function createFogVolume(p: FogVolumeParams): { mesh: THREE.Mesh; update(t: number): void; dispose(): void } {
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    ...sharedUniforms(),
    uModel: { value: new THREE.Matrix4() },
    uInvModel: { value: new THREE.Matrix4() },
    uColor: { value: new THREE.Color(p.color) },
    uDensity: { value: p.density },
    uBrightness: { value: p.brightness },
    uNoise: { value: p.noise },
    uNoiseScale: { value: p.noiseScale },
    uEdge: { value: Math.max(0.001, p.edge) },
    uHeight: { value: p.heightFalloff },
    uTime: { value: 0 },
    uLightK: { value: p.lightResponse ?? 1 },
    uG: { value: p.anisotropy ?? 0.45 },
    uInteract: { value: p.interactive === false ? 0 : 1 },
    // Sichtbarkeit der 4 Effektlichter je Gitterzelle (RGBA), damit kein Licht durch Wände in den Nebel fällt
    uLightVis: { value: null as THREE.Data3DTexture | null },
    uLightVisOn: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    fog: true,
    ...PREMUL_BLEND,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform mat4 uModel;
      uniform mat4 uInvModel;
      uniform vec3 uColor;
      uniform float uDensity, uBrightness, uNoise, uNoiseScale, uEdge, uHeight, uTime, uLightK, uG, uInteract;
      uniform sampler3D uLightVis;
      uniform float uLightVisOn;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      ${VOLUME_HEAD}
      void main() {
        vec3 wrd = normalize(vWorld - cameraPosition);
        vec3 ro = (uInvModel * vec4(cameraPosition, 1.0)).xyz;
        vec3 rd = (uInvModel * vec4(wrd, 0.0)).xyz;
        float k = length(rd); // lokale Einheiten pro Weltmeter
        rd /= k;
        vec3 inv = 1.0 / rd;
        vec3 t0 = (-0.5 - ro) * inv;
        vec3 t1 = (0.5 - ro) * inv;
        vec3 tmin = min(t0, t1);
        vec3 tmax = max(t0, t1);
        float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
        float tf = min(min(tmax.x, tmax.y), tmax.z);
        // an der Szene (Wände, Boden, Objekte) abschneiden
        tf = min(tf, vSceneDistance(wrd) * k);
        if (tf <= tn) discard;

        int steps = vSteps;
        float stepL = (tf - tn) / float(steps);
        float stepW = stepL / k; // Schrittweite in Metern
        float jitter = vIGN(gl_FragCoord.xy);
        vec3 drift = vec3(0.13, 0.04, 0.09) * uTime - vWind * vTime * 0.35;
        vec3 selfLit = uColor * uBrightness;
        float T = 1.0;
        vec3 C = vec3(0.0);
        for (int i = 0; i < 48; i++) {
          if (i >= steps) break;
          vec3 p = ro + rd * (tn + stepL * (float(i) + jitter));
          vec3 e = 0.5 - abs(p);
          float edge = smoothstep(0.0, uEdge, min(min(e.x, e.y), e.z));
          float h = mix(1.0, 1.0 - smoothstep(-0.5, 0.5, p.y), uHeight);
          vec3 wp = (uModel * vec4(p, 1.0)).xyz;
          float n = mix(1.0, vCloud(wp * uNoiseScale + drift * uNoiseScale) * 1.7, uNoise);
          float dens = uDensity * edge * h * max(n, 0.0);
          if (uInteract > 0.5) dens *= 1.0 - vDisturb(wp);
          if (dens < 1e-4) continue;
          vec4 lv = uLightVisOn > 0.5 ? texture(uLightVis, p + 0.5) : vec4(1.0);
          vec3 Ls = selfLit + uColor * vLightAtVis(wp, wrd, uG, true, lv) * uLightK * 0.35;
          float a = exp(-dens * stepW);
          C += T * Ls * (1.0 - a);
          T *= a;
          if (T < 0.01) break;
        }
        gl_FragColor = vec4(C, 1.0 - T);
        ${FOG_PREMUL}
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.renderOrder = 10;
  mesh.frustumCulled = true;
  mesh.onBeforeRender = () => {
    uniforms.uModel.value.copy(mesh.matrixWorld);
    uniforms.uInvModel.value.copy(mesh.matrixWorld).invert();
  };
  asVolume(mesh);

  // Licht-Verdeckung: Gitter im Einheitswürfel, neu bei Verschieben/Skalieren
  const grid = new VisGrid(mesh, uniforms.uLightVis, uniforms.uLightVisOn);
  let lastT: number | null = null;

  return {
    mesh,
    update(t: number) {
      uniforms.uTime.value = t * p.speed;
      const dt = lastT === null ? 1 / 60 : THREE.MathUtils.clamp(t - lastT, 0, 0.1);
      lastT = t;
      grid.update(dt);
    },
    dispose() {
      grid.dispose();
    },
  };
}

// ---------- Lichtkegel (Spotlight) ----------

export interface LightConeParams {
  color: string;
  length: number;
  angle: number; // halber Öffnungswinkel (rad)
  penumbra: number;
  strength: number;
}

const MAX_OCC = 8;
const _apex = new THREE.Vector3();
const _axisW = new THREE.Vector3();
const _rel = new THREE.Vector3();

/** Raymarchter Lichtkegel entlang lokaler -Y (Spitze im Ursprung), additiv, mit Staub-Rauschen.
 *  Verdeckung: mit Schattenkarte des Spotlichts exakt (auch Modelle werfen Licht-Schatten in den Kegel),
 *  sonst über bis zu 8 nahe Collider-Boxen (Wände, Decken, Kisten) – der Kegel leuchtet nicht mehr durch Wände. */
export function createLightCone(p: LightConeParams): {
  mesh: THREE.Mesh;
  update(t: number): void;
  setIntensity(v: number): void;
  setColor(c: string): void;
  /** Spotlicht, dessen Schattenkarte (falls aktiv) die Verdeckung liefert */
  setLight(light: THREE.SpotLight | null): void;
} {
  const angle = Math.min(p.angle, 1.4);
  const radius = Math.tan(angle) * p.length * 1.05;
  const geo = new THREE.CylinderGeometry(0.03, radius, p.length, 32, 1, true);
  geo.translate(0, -p.length / 2, 0);
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    ...sharedUniforms(),
    uInvModel: { value: new THREE.Matrix4() },
    uModel: { value: new THREE.Matrix4() },
    uColor: { value: new THREE.Color(p.color) },
    uIntensity: { value: 0 },
    uStrength: { value: p.strength },
    uLength: { value: p.length },
    uRadius: { value: radius },
    uCone: { value: new THREE.Vector2(Math.cos(angle), Math.cos(angle * (1 - Math.max(0.05, p.penumbra)))) },
    uShadow: { value: null as THREE.Texture | null },
    uShadowMat: { value: new THREE.Matrix4() },
    uShadowOn: { value: 0 },
    uOccN: { value: 0 },
    uOccC: { value: Array.from({ length: MAX_OCC }, () => new THREE.Vector3()) },
    uOccH: { value: Array.from({ length: MAX_OCC }, () => new THREE.Vector3()) },
    uOccA: { value: Array.from({ length: MAX_OCC }, () => new THREE.Vector3()) },
    uOccR: { value: Array.from({ length: MAX_OCC }, () => new THREE.Matrix3()) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    fog: true,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform mat4 uInvModel, uModel;
      uniform vec3 uColor;
      uniform float uIntensity, uStrength, uLength, uRadius;
      uniform vec2 uCone;
      uniform sampler2DShadow uShadow;
      uniform mat4 uShadowMat;
      uniform float uShadowOn;
      uniform int uOccN;
      uniform vec3 uOccC[${MAX_OCC}];
      uniform vec3 uOccH[${MAX_OCC}];
      uniform vec3 uOccA[${MAX_OCC}];
      uniform mat3 uOccR[${MAX_OCC}];
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      ${VOLUME_HEAD}
      /** erreicht Licht von der Kegelspitze den Punkt wp? */
      float coneVisibility(vec3 wp) {
        if (uShadowOn > 0.5) return vShadowAt(uShadow, uShadowMat, wp);
        for (int i = 0; i < ${MAX_OCC}; i++) {
          if (i >= uOccN) break;
          // Strecke Spitze → wp im lokalen Raum der Box (Spitze dort vorberechnet), Slab-Test für t in [0, 1]
          vec3 a = uOccA[i];
          vec3 d = uOccR[i] * (wp - uOccC[i]) - a;
          vec3 inv = vec3(d.x < 0.0 ? -1.0 : 1.0, d.y < 0.0 ? -1.0 : 1.0, d.z < 0.0 ? -1.0 : 1.0) / max(abs(d), vec3(1e-5));
          vec3 h = uOccH[i];
          vec3 t0 = (-h - a) * inv;
          vec3 t1 = (h - a) * inv;
          vec3 tn = min(t0, t1);
          vec3 tf = max(t0, t1);
          float en = max(max(max(tn.x, tn.y), tn.z), 0.0);
          float ex = min(min(min(tf.x, tf.y), tf.z), 1.0);
          // nur echte Durchquerung zählt (Streifen an der Oberfläche, z. B. Lampe bündig an der Decke, nicht)
          if ((ex - en) * length(d) > 0.03) return 0.0;
        }
        return 1.0;
      }
      void main() {
        vec3 wrd = normalize(vWorld - cameraPosition);
        vec3 ro = (uInvModel * vec4(cameraPosition, 1.0)).xyz;
        vec3 rd = normalize((uInvModel * vec4(wrd, 0.0)).xyz);
        // Hüllquader des Kegels
        vec3 bmin = vec3(-uRadius, -uLength, -uRadius);
        vec3 bmax = vec3(uRadius, 0.0, uRadius);
        vec3 inv = 1.0 / rd;
        vec3 t0 = (bmin - ro) * inv;
        vec3 t1 = (bmax - ro) * inv;
        vec3 tmin = min(t0, t1);
        vec3 tmax = max(t0, t1);
        float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
        float tf = min(min(tmax.x, tmax.y), tmax.z);
        tf = min(tf, distance(vWorld, cameraPosition) + 0.01);
        tf = min(tf, vSceneDistance(wrd));
        if (tf <= tn || uIntensity <= 0.0) discard;
        int steps = max(8, vSteps / 2 + 4);
        float stepL = (tf - tn) / float(steps);
        float jitter = vIGN(gl_FragCoord.xy);
        vec3 axisW = normalize(mat3(uModel) * vec3(0.0, -1.0, 0.0));
        vec3 drift = vec3(0.0, -0.05, 0.03) * vTime - vWind * vTime * 0.3;
        float acc = 0.0;
        for (int i = 0; i < 32; i++) {
          if (i >= steps) break;
          float t = tn + stepL * (float(i) + jitter);
          vec3 p = ro + rd * t;
          float d = length(p);
          float along = -p.y;
          if (along <= 0.0 || d < 1e-3) continue;
          float spot = smoothstep(uCone.x, uCone.y, along / d);
          if (spot <= 0.0) continue;
          float win = clamp(1.0 - pow(d / uLength, 4.0), 0.0, 1.0);
          vec3 wp = cameraPosition + wrd * t;
          float vis = coneVisibility(wp);
          if (vis <= 0.0) continue;
          float dust = 0.45 + 0.9 * vCloud(wp * 1.4 + drift);
          dust *= 1.0 - 0.7 * vDisturb(wp);
          acc += spot * win * win / (d * d + 0.3) * dust * vis;
        }
        float ph = vPhase(dot(wrd, axisW), 0.4);
        vec3 col = uColor * uIntensity * uStrength * acc * stepL * ph * 0.02;
        gl_FragColor = vec4(col, 1.0);
        ${FOG_ADDITIVE}
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = 11;
  let light: THREE.SpotLight | null = null;
  mesh.onBeforeRender = (renderer) => {
    uniforms.uModel.value.copy(mesh.matrixWorld);
    uniforms.uInvModel.value.copy(mesh.matrixWorld).invert();
    // Schattenkarte nur, wenn sie in diesem Frame gerendert wird und eine Vergleichstextur ist (PCF);
    // sonst (Schatten aus, VSM, …) die Collider-Boxen
    const map = light && light.castShadow && renderer.shadowMap.enabled ? light.shadow.map : null;
    const depth = map?.depthTexture && map.depthTexture.compareFunction !== null ? map.depthTexture : null;
    uniforms.uShadow.value = depth;
    uniforms.uShadowOn.value = depth ? 1 : 0;
    if (depth) uniforms.uShadowMat.value.copy(light!.shadow.matrix);
  };
  asVolume(mesh);

  // Verdecker aus den Map-Collidern: periodisch bzw. sofort, wenn sich Lage oder Collider-Liste ändern
  const lastMatrix = new THREE.Matrix4();
  let lastT = -Infinity;
  let lastList: readonly unknown[] | null = null;
  let lastLen = -1;
  function refreshOccluders(t: number) {
    mesh.updateWorldMatrix(true, false);
    const list = particleWorld.colliders;
    const moved = !lastMatrix.equals(mesh.matrixWorld);
    if (!moved && t - lastT < 0.5 && list === lastList && list.length === lastLen) return;
    lastT = t;
    lastList = list;
    lastLen = list.length;
    lastMatrix.copy(mesh.matrixWorld);
    _apex.setFromMatrixPosition(mesh.matrixWorld);
    _axisW.set(0, -1, 0).transformDirection(mesh.matrixWorld);
    // Hülle des Kegels: Spitze + Enddeckel (Kreis mit Radius r um das Ende)
    const L = p.length;
    const ex = _apex.x + _axisW.x * L, ey = _apex.y + _axisW.y * L, ez = _apex.z + _axisW.z * L;
    const rx = radius * Math.sqrt(Math.max(0, 1 - _axisW.x * _axisW.x));
    const ry = radius * Math.sqrt(Math.max(0, 1 - _axisW.y * _axisW.y));
    const rz = radius * Math.sqrt(Math.max(0, 1 - _axisW.z * _axisW.z));
    const boxes = boxesInRegion(
      Math.min(_apex.x, ex - rx),
      Math.min(_apex.y, ey - ry),
      Math.min(_apex.z, ez - rz),
      Math.max(_apex.x, ex + rx),
      Math.max(_apex.y, ey + ry),
      Math.max(_apex.z, ez + rz),
      _apex,
    );
    // Boxen ganz hinter der Spitze (z. B. die Decke, an der die Lampe hängt) können nichts verdecken;
    // übrige nach Abstand zur Spitze – die nächsten werfen die größten Schatten
    const ranked: { s: BoxShape; d: number }[] = [];
    for (const s of boxes) {
      _rel.set(s.cx - _apex.x, s.cy - _apex.y, s.cz - _apex.z);
      // Ausdehnung der Box entlang der Kegelachse
      const m = s.m;
      const ext = m
        ? Math.abs(m[0] * _axisW.x + m[1] * _axisW.y + m[2] * _axisW.z) * s.hx +
          Math.abs(m[3] * _axisW.x + m[4] * _axisW.y + m[5] * _axisW.z) * s.hy +
          Math.abs(m[6] * _axisW.x + m[7] * _axisW.y + m[8] * _axisW.z) * s.hz
        : Math.abs(_axisW.x) * s.hx + Math.abs(_axisW.y) * s.hy + Math.abs(_axisW.z) * s.hz;
      if (_rel.dot(_axisW) + ext <= 0.02) continue;
      ranked.push({ s, d: Math.max(0, _rel.length() - Math.hypot(s.hx, s.hy, s.hz)) });
    }
    ranked.sort((a, b) => a.d - b.d);
    const n = Math.min(MAX_OCC, ranked.length);
    for (let i = 0; i < n; i++) {
      const s = ranked[i].s;
      const R = uniforms.uOccR.value[i];
      // Welt → lokal = Rᵀ; Matrix3.set nimmt Zeilen, die Spalten von m (lokale Achsen) werden so zu Zeilen
      if (s.m) {
        const m = s.m;
        R.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
      } else R.identity();
      uniforms.uOccC.value[i].set(s.cx, s.cy, s.cz);
      uniforms.uOccH.value[i].set(s.hx, s.hy, s.hz);
      uniforms.uOccA.value[i].set(_apex.x - s.cx, _apex.y - s.cy, _apex.z - s.cz).applyMatrix3(R);
    }
    uniforms.uOccN.value = n;
  }

  return {
    mesh,
    update(t: number) {
      refreshOccluders(t);
    },
    setIntensity: (v) => (uniforms.uIntensity.value = v),
    setColor: (c) => uniforms.uColor.value.set(c),
    setLight: (l) => (light = l),
  };
}

// ---------- Staub ----------

export interface DustParams {
  count: number;
  size: number;
  color: string;
  opacity: number;
  speed: number;
}

/** Schwebende Staubpartikel im Einheitswürfel (Größe über die Objektskalierung).
 *  Animation komplett im Vertex-Shader; glitzern im Licht der Taschenlampe, weichen dem Spieler aus. */
export function createDust(p: DustParams, seed = 1): { points: THREE.Points; update(dt: number, t: number): void; dispose(): void } {
  const count = Math.max(1, Math.min(8000, Math.round(p.count)));
  let s = seed * 9301 + 49297;
  const rand = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const base = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count * 3; i++) base[i] = rand() - 0.5;
  for (let i = 0; i < count; i++) phase[i] = rand() * 100;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.9);
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    ...sharedUniforms(),
    uColor: { value: new THREE.Color(p.color) },
    uSize: { value: p.size },
    uOpacity: { value: p.opacity },
    uT: { value: 0 },
    uWindLocal: { value: new THREE.Vector3() },
    uLightVis: { value: null as THREE.Data3DTexture | null },
    uLightVisOn: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    vertexShader: /* glsl */ `
      attribute float aPhase;
      uniform float uSize, uT;
      uniform vec3 uWindLocal;
      varying float vPhaseV;
      varying vec3 vWorldP;
      varying vec3 vLocalP;
      varying float vViewZ;
      #include <fog_pars_vertex>
      ${VOLUME_UNIFORMS}
      vec3 wrap(vec3 v) { return fract(v + 0.5) - 0.5; }
      void main() {
        float ph = aPhase;
        vec3 lp = position + vec3(
          sin(uT * 0.21 + ph) * 0.03 + uT * 0.004,
          sin(uT * 0.17 + ph * 1.3) * 0.03 - uT * 0.006,
          cos(uT * 0.19 + ph * 0.7) * 0.03) + uWindLocal * vTime;
        lp = wrap(lp);
        // an den Rändern ausblenden statt hart umspringen
        vec3 e = 0.5 - abs(lp);
        float edge = smoothstep(0.0, 0.06, min(min(e.x, e.y), e.z));
        vec4 wp = modelMatrix * vec4(lp, 1.0);
        // Spieler/Schüsse schieben die Partikel weg
        for (int i = 0; i < 8; i++) {
          vec4 B = vDisB[i];
          if (B.w <= 0.0) continue;
          vec4 A = vDisA[i];
          vec3 ab = B.xyz - A.xyz;
          float t = clamp(dot(wp.xyz - A.xyz, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
          vec3 off = wp.xyz - A.xyz - ab * t;
          float d = length(off);
          float r = A.w * 1.3;
          if (d < r) wp.xyz += normalize(off + vec3(1e-4)) * (r - d) * B.w;
        }
        vWorldP = wp.xyz;
        vLocalP = lp;
        vPhaseV = ph;
        vec4 mvPosition = viewMatrix * wp;
        vViewZ = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = edge * uSize * vScreen.y * 0.5 * projectionMatrix[1][1] / max(-mvPosition.z, 0.05);
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform sampler3D uLightVis;
      uniform float uLightVisOn;
      varying float vPhaseV;
      varying vec3 vWorldP;
      varying vec3 vLocalP;
      varying float vViewZ;
      #include <fog_pars_fragment>
      ${VOLUME_HEAD}
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(c, c);
        if (r2 > 1.0) discard;
        float shape = exp(-r2 * 3.5);
        vec3 rd = normalize(vWorldP - cameraPosition);
        vec4 lv = uLightVisOn > 0.5 ? texture(uLightVis, vLocalP + 0.5) : vec4(1.0);
        vec3 lit = vLightAtVis(vWorldP, rd, 0.55, false, lv);
        // Glitzern: einzelne Körner blitzen im Lichtkegel auf
        float glint = 0.6 + 2.4 * pow(max(0.0, sin(vTime * 2.3 + vPhaseV * 7.0)), 12.0);
        vec3 col = uColor * (0.08 + vAmbient * 0.25 + lit * glint * 0.06);
        float fade = vSoftFade(vViewZ, 0.15);
        gl_FragColor = vec4(col * shape * uOpacity * fade, 1.0);
        ${FOG_ADDITIVE}
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.renderOrder = 12;
  asVolume(points);
  const inv = new THREE.Matrix3();
  // gröber als beim Nebel: Körner sind klein, es zählt nur, auf welcher Seite der Wand sie liegen
  const grid = new VisGrid(points, uniforms.uLightVis, uniforms.uLightVisOn, 0.5, 6000);
  return {
    points,
    dispose: () => grid.dispose(),
    update(dt: number, t: number) {
      uniforms.uT.value = t * p.speed;
      grid.update(Math.min(dt, 0.1));
      // Wind in lokale Einheiten (Würfel) umrechnen
      points.updateWorldMatrix(true, false);
      inv.setFromMatrix4(points.matrixWorld).invert();
      uniforms.uWindLocal.value.copy(volumeFX.wind).multiplyScalar(0.15).applyMatrix3(inv);
    },
  };
}
