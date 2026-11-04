import * as THREE from 'three';
import { asVolume, FOG_ADDITIVE, FOG_PREMUL, PREMUL_BLEND, sharedUniforms, VOLUME_HEAD, volumeFX } from './volumetrics';

// Partikeleffekte: Feuer (mit Glut/Funken, Licht, optionalem Rauch), Rauch und Funkenregen.
// CPU-Simulation, gezeichnet als instanzierte Billboards in Weltkoordinaten (auf VOLUME_LAYER).
// Interaktiv: Wind, Spieler und Schussbahnen verdrängen Partikel; Schüsse durch Feuer erzeugen
// Funkenschauer, Regen dämpft Flammen.

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// ---------- Billboard-Partikelpuffer ----------

type Mode = 'fire' | 'smoke' | 'spark';

/** Instanzierte Quads: aPos (xyz, Größe), aData (Alter 0..1, Rotation, Seed, Helligkeit), aVel (xyz, Streckung) */
class ParticleBuffer {
  readonly mesh: THREE.Mesh;
  readonly pos: Float32Array;
  readonly data: Float32Array;
  readonly vel: Float32Array;
  readonly uniforms: Record<string, THREE.IUniform>;
  private geo: THREE.InstancedBufferGeometry;
  private aPos: THREE.InstancedBufferAttribute;
  private aData: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;

  constructor(
    readonly capacity: number,
    mode: Mode,
    extra: Record<string, THREE.IUniform> = {},
  ) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new Float32Array(capacity * 4);
    this.data = new Float32Array(capacity * 4);
    this.vel = new Float32Array(capacity * 4);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 4).setUsage(THREE.DynamicDrawUsage);
    this.aData = new THREE.InstancedBufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(this.vel, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aData', this.aData);
    geo.setAttribute('aVel', this.aVel);
    geo.instanceCount = 0;
    this.geo = geo;
    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...sharedUniforms(),
      ...extra,
    };
    const blend = mode === 'smoke' ? PREMUL_BLEND : { blending: THREE.AdditiveBlending };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      ...blend,
      vertexShader: VERT,
      fragmentShader: mode === 'fire' ? FIRE_FRAG : mode === 'smoke' ? SMOKE_FRAG : SPARK_FRAG,
      defines: mode === 'spark' ? { STRETCH: 1 } : mode === 'fire' ? { STRETCH: 1, FIRE: 1 } : {},
    });
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = mode === 'smoke' ? 14 : 15;
    asVolume(this.mesh);
  }

  set count(n: number) {
    this.geo.instanceCount = n;
    this.aPos.needsUpdate = this.aData.needsUpdate = this.aVel.needsUpdate = n > 0;
    // nur den benutzten Bereich hochladen
    for (const a of [this.aPos, this.aData, this.aVel]) {
      a.clearUpdateRanges();
      if (n > 0) a.addUpdateRange(0, n * 4);
    }
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const VERT = /* glsl */ `
  attribute vec4 aPos;
  attribute vec4 aData;
  attribute vec4 aVel;
  varying vec2 vUv;
  varying vec4 vData;
  varying vec3 vWorldP;
  varying float vViewZ;
  varying vec3 vRight;
  varying vec3 vUp;
  #include <fog_pars_vertex>
  void main() {
    vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float size = aPos.w;
    float rot = aData.y;
    float c = cos(rot), s = sin(rot);
    vec3 R = camR * c + camU * s;
    vec3 U = -camR * s + camU * c;
    vec2 q = position.xy;
    vec3 wp;
    #ifdef STRETCH
      // entlang der (projizierten) Geschwindigkeit strecken: Funken als Striche, Flammen nach oben gezogen
      vec3 v = aVel.xyz;
      vec3 vs = v - dot(v, normalize(cameraPosition - aPos.xyz)) * normalize(cameraPosition - aPos.xyz);
      float sp = length(vs);
      if (aVel.w > 0.0 && sp > 1e-3) {
        U = vs / sp;
        R = normalize(cross(U, normalize(cameraPosition - aPos.xyz)));
        float stretch = 1.0 + sp * aVel.w;
        wp = aPos.xyz + R * q.x * size + U * (q.y * size * stretch + size * (stretch - 1.0) * -0.5);
      } else {
        wp = aPos.xyz + R * q.x * size + U * q.y * size;
      }
    #else
      wp = aPos.xyz + R * q.x * size + U * q.y * size;
    #endif
    vUv = q * 0.5 + 0.5;
    vData = aData;
    vWorldP = wp;
    vRight = R;
    vUp = U;
    vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
    vViewZ = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG_HEAD = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vData;
  varying vec3 vWorldP;
  varying float vViewZ;
  varying vec3 vRight;
  varying vec3 vUp;
  #include <fog_pars_fragment>
  ${VOLUME_HEAD}
`;

/** Schwarzkörper-artiger Farbverlauf: weißgelb (heiß) → orange → tiefrot → dunkel. HDR, damit Bloom greift. */
const FIRE_FRAG = /* glsl */ `
  uniform vec3 uTint;
  uniform float uHeat;
  ${FRAG_HEAD}
  vec3 fireRamp(float h) {
    vec3 c = mix(vec3(0.25, 0.02, 0.0), vec3(1.0, 0.18, 0.02), smoothstep(0.0, 0.35, h));
    c = mix(c, vec3(1.0, 0.55, 0.12), smoothstep(0.3, 0.65, h));
    c = mix(c, vec3(1.0, 0.9, 0.65), smoothstep(0.65, 1.0, h));
    return c;
  }
  void main() {
    float age = vData.x;
    float seed = vData.z;
    vec2 c = vUv * 2.0 - 1.0;
    // Flammenform: unten breit, oben spitz, vom Rauschen ausgefranst
    float taper = mix(1.0, 0.55, clamp(c.y * 0.5 + 0.5, 0.0, 1.0));
    float r = length(vec2(c.x / taper, c.y));
    vec3 np = vec3(vUv * vec2(1.2, 0.8), seed * 13.0) + vec3(0.0, -vTime * 1.3, vTime * 0.2);
    float n = vNoise3(np * 0.5) * 0.6 + vNoise3(np * 1.3 + 0.5) * 0.4;
    float shape = 1.0 - smoothstep(0.25, 1.0, r + (n - 0.5) * 0.9 * (0.4 + age));
    // Funken/Glut (Helligkeit > 1.5) sind kompakte Punkte
    float isEmber = step(1.5, vData.w);
    float ember = exp(-dot(c, c) * 5.0);
    shape = mix(shape, ember, isEmber);
    if (shape <= 0.002) discard;
    float heat = clamp((1.0 - age) * 1.15 - (1.0 - shape) * 0.45 + 0.08, 0.0, 1.0) * uHeat;
    heat = mix(heat, 0.75 + 0.25 * (1.0 - age), isEmber);
    vec3 col = fireRamp(heat) * uTint;
    float bright = mix(vData.w, (vData.w - 1.5) * 3.0, isEmber);
    // Kern deutlich über 1.0 → Bloom
    col *= (0.35 + heat * heat * 3.2) * bright;
    float fade = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.65, 1.0, age));
    fade *= vSoftFade(vViewZ, 0.25);
    gl_FragColor = vec4(col * shape * fade, 1.0);
    ${FOG_ADDITIVE}
  }
`;

const SMOKE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uSelfLight;
  uniform vec3 uGlowColor;
  ${FRAG_HEAD}
  void main() {
    float age = vData.x;
    float seed = vData.z;
    vec2 c = vUv * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    // Wolkiges Rauschen, mit dem Alter aufgelöst
    vec3 np = vec3(c * 0.55 + seed * 7.0, seed * 3.0 + vTime * 0.05);
    float n = vNoise3(np * 0.6) * 0.65 + vNoise3(np * 1.7 + 0.3) * 0.35;
    float body = smoothstep(1.0, 0.15, r2 + (0.55 - n) * (0.8 + age * 0.6));
    float a = body * uOpacity * vData.w;
    a *= smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.55, 1.0, age));
    a *= vSoftFade(vViewZ, 0.6);
    // Disturb: Spieler/Schüsse verdünnen den Rauch zusätzlich (Partikel werden auf der CPU weggeschoben)
    a *= 1.0 - 0.6 * vDisturb(vWorldP);
    if (a < 0.003) discard;
    // Kugelnormale für weiches Licht
    vec3 viewDir = normalize(cameraPosition - vWorldP);
    vec3 nrm = normalize(vRight * c.x + vUp * c.y + viewDir * sqrt(max(0.0, 1.0 - r2)));
    vec3 lit = vAmbient * (0.55 + 0.45 * nrm.y);
    // Lichter: Vorwärtsstreuung, zusätzlich etwas Lambert über die Kugelnormale
    vec3 rd = -viewDir;
    lit += vLightAt(vWorldP, rd, 0.35, true) * 0.12;
    vec3 col = uColor * lit;
    // Glut von unten (Feuer) – nimmt mit dem Alter ab
    col += uGlowColor * uSelfLight * pow(1.0 - age, 3.0) * (0.5 + 0.5 * n);
    gl_FragColor = vec4(col * a, a);
    ${FOG_PREMUL}
  }
`;

const SPARK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  ${FRAG_HEAD}
  void main() {
    float age = vData.x;
    vec2 c = vUv * 2.0 - 1.0;
    float g = exp(-c.x * c.x * 6.0) * smoothstep(1.0, 0.2, abs(c.y));
    if (g < 0.01) discard;
    // abkühlen: weiß → orange → rot
    vec3 hot = mix(uColor, vec3(1.0, 0.95, 0.8), 0.6);
    vec3 col = mix(hot, uColor * vec3(1.0, 0.35, 0.15), smoothstep(0.2, 1.0, age));
    col *= vData.w * (1.0 - age * age) * 6.0;
    gl_FragColor = vec4(col * g, 1.0);
    ${FOG_ADDITIVE}
  }
`;

// ---------- gemeinsame Hilfen ----------

/** Effekt-Steuerung (Editor/Skripte) */
export interface EffectControl {
  readonly on: boolean;
  setOn(on: boolean): void;
  /** Intensität 0..3 (1 = wie eingestellt) */
  intensity: number;
  setIntensity(v: number): void;
  /** einmaliger Ausbruch (Stichflamme, Rauchstoß, Funkenregen) */
  burst(strength?: number): void;
}

/** Spieler/Schüsse schieben Partikel weg; gibt zurück, ob ein Schuss durchging */
function pushByDisturbers(p: Float32Array, i4: number, v: Float32Array, dt: number, scale = 1): number {
  let hit = 0;
  volumeFX.forEachDisturber((d, isPlayer) => {
    const ax = d.a.x, ay = d.a.y, az = d.a.z;
    const bx = d.b.x - ax, by = d.b.y - ay, bz = d.b.z - az;
    const px = p[i4] - ax, py = p[i4 + 1] - ay, pz = p[i4 + 2] - az;
    const len2 = bx * bx + by * by + bz * bz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / len2)) : 0;
    const ox = px - bx * t, oy = py - by * t, oz = pz - bz * t;
    const dist = Math.sqrt(ox * ox + oy * oy + oz * oz) + 1e-4;
    const r = d.radius * 1.4 + 0.15;
    if (dist >= r) return;
    const f = (1 - dist / r) * d.strength * scale;
    const k = (isPlayer ? 6 + volumeFX.playerVel.length() * 3 : 14) * f * dt;
    v[i4] += (ox / dist) * k;
    v[i4 + 1] += (oy / dist) * k * 0.6;
    v[i4 + 2] += (oz / dist) * k;
    if (isPlayer) {
      // mitgezogen werden
      v[i4] += volumeFX.playerVel.x * f * dt * 1.5;
      v[i4 + 2] += volumeFX.playerVel.z * f * dt * 1.5;
    } else hit = Math.max(hit, f);
  });
  return hit;
}

/** Abstand Punkt ↔ Strecke */
function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  _v.subVectors(b, a);
  const l2 = _v.lengthSq();
  const t = l2 > 0 ? THREE.MathUtils.clamp(_w.subVectors(p, a).dot(_v) / l2, 0, 1) : 0;
  return _w.copy(a).addScaledVector(_v, t).distanceTo(p);
}

/** Welt-Skalierung (gemittelt) und Box-Halbachsen eines Effekt-Objekts */
function worldScale(o: THREE.Object3D): number {
  o.matrixWorld.decompose(_v, _q, _s);
  return (Math.abs(_s.x) + Math.abs(_s.y) + Math.abs(_s.z)) / 3;
}

// ---------- Rauch ----------

export interface SmokeParams {
  color: string;
  rate: number; // Partikel/s
  life: number; // s
  size: number; // Startgröße (m)
  grow: number; // Endgröße (m)
  rise: number; // Auftrieb (m/s)
  spread: number; // Emitterradius (m)
  opacity: number;
  turbulence: number;
  /** Glut von unten (für Feuer-Rauch) */
  glow?: number;
  glowColor?: string;
}

export interface Effect {
  object: THREE.Object3D;
  update(dt: number, t: number): void;
  control: EffectControl;
  dispose(): void;
}

class Smoke {
  readonly buf: ParticleBuffer;
  private n = 0;
  private acc = 0;
  private life: Float32Array;
  private age: Float32Array;
  private size0: Float32Array;
  private order: Uint16Array;
  private tmpPos: Float32Array;
  private tmpData: Float32Array;
  private tmpVel: Float32Array;
  private rand: () => number;
  rateMul = 1;
  constructor(public p: SmokeParams, seed = 1, capacity = 0) {
    const cap = capacity || Math.min(600, Math.ceil(p.rate * p.life * 1.3) + 8);
    this.buf = new ParticleBuffer(cap, 'smoke', {
      uColor: { value: new THREE.Color(p.color) },
      uOpacity: { value: p.opacity },
      uSelfLight: { value: p.glow ?? 0 },
      uGlowColor: { value: new THREE.Color(p.glowColor ?? '#ff6a1a') },
    });
    this.life = new Float32Array(cap);
    this.age = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.order = new Uint16Array(cap);
    this.tmpPos = new Float32Array(cap * 4);
    this.tmpData = new Float32Array(cap * 4);
    this.tmpVel = new Float32Array(cap * 4);
    this.rand = rng(seed);
  }

  setColor(c: string) {
    (this.buf.uniforms.uColor.value as THREE.Color).set(c);
  }

  emit(origin: THREE.Vector3, scale: number, count: number, extraVel = 0) {
    const { pos, data, vel } = this.buf;
    const r = this.rand;
    for (let k = 0; k < count && this.n < this.buf.capacity; k++) {
      const i = this.n++;
      const i4 = i * 4;
      const a = r() * Math.PI * 2;
      const rr = Math.sqrt(r()) * this.p.spread * scale;
      pos[i4] = origin.x + Math.cos(a) * rr;
      pos[i4 + 1] = origin.y + r() * 0.1 * scale;
      pos[i4 + 2] = origin.z + Math.sin(a) * rr;
      this.size0[i] = this.p.size * scale * (0.7 + r() * 0.6);
      pos[i4 + 3] = this.size0[i];
      vel[i4] = (r() - 0.5) * 0.3 * (1 + extraVel);
      vel[i4 + 1] = this.p.rise * scale * (0.6 + r() * 0.6) * (1 + extraVel * 0.5);
      vel[i4 + 2] = (r() - 0.5) * 0.3 * (1 + extraVel);
      vel[i4 + 3] = 0;
      data[i4] = 0;
      data[i4 + 1] = r() * Math.PI * 2;
      data[i4 + 2] = r();
      data[i4 + 3] = 0.75 + r() * 0.5;
      this.life[i] = this.p.life * (0.75 + r() * 0.5);
      this.age[i] = 0;
    }
  }

  update(dt: number, t: number, origin: THREE.Vector3, scale: number, emitting: boolean, camPos: THREE.Vector3) {
    const p = this.p;
    if (emitting) {
      this.acc += dt * p.rate * this.rateMul * volumeFX.particleScale;
      const k = Math.floor(this.acc);
      this.acc -= k;
      if (k > 0) this.emit(origin, scale, k);
    }
    const { pos, data, vel } = this.buf;
    const wind = volumeFX.wind;
    const drag = Math.exp(-dt * 0.6);
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const age = this.age[i] + dt;
      if (age >= this.life[i]) continue;
      const i4 = i * 4;
      const k = age / this.life[i];
      // Turbulenz (billig: Sinus-Felder)
      const px = pos[i4], py = pos[i4 + 1], pz = pos[i4 + 2];
      const tu = p.turbulence * scale;
      const ax = Math.sin(py * 1.7 + t * 0.9 + data[i4 + 2] * 6) * tu + wind.x * 0.8;
      const az = Math.cos(py * 1.3 + t * 0.7 + data[i4 + 2] * 4) * tu + wind.z * 0.8;
      vel[i4] = (vel[i4] + ax * dt) * drag;
      vel[i4 + 1] = (vel[i4 + 1] + (p.rise * scale * (1 - k) * 0.5 - vel[i4 + 1] * 0.3) * dt) * 1;
      vel[i4 + 2] = (vel[i4 + 2] + az * dt) * drag;
      pushByDisturbers(pos, i4, vel, dt);
      // kompakt: an Stelle j schreiben
      const j4 = j * 4;
      pos[j4] = px + vel[i4] * dt;
      pos[j4 + 1] = py + vel[i4 + 1] * dt;
      pos[j4 + 2] = pz + vel[i4 + 2] * dt;
      this.size0[j] = this.size0[i];
      pos[j4 + 3] = THREE.MathUtils.lerp(this.size0[i], p.grow * scale, 1 - (1 - k) * (1 - k));
      vel[j4] = vel[i4];
      vel[j4 + 1] = vel[i4 + 1];
      vel[j4 + 2] = vel[i4 + 2];
      vel[j4 + 3] = 0;
      data[j4] = k;
      data[j4 + 1] = data[i4 + 1] + dt * (data[i4 + 2] - 0.5) * 0.4;
      data[j4 + 2] = data[i4 + 2];
      data[j4 + 3] = data[i4 + 3];
      this.life[j] = this.life[i];
      this.age[j] = age;
      j++;
    }
    this.n = j;
    this.sort(camPos);
    this.buf.count = this.n;
  }

  /** hinten → vorne sortieren (Alpha-Blending) */
  private sort(cam: THREE.Vector3) {
    const n = this.n;
    if (n < 2) return;
    const { pos, data, vel } = this.buf;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const i4 = i * 4;
      const dx = pos[i4] - cam.x, dy = pos[i4 + 1] - cam.y, dz = pos[i4 + 2] - cam.z;
      d[i] = dx * dx + dy * dy + dz * dz;
      this.order[i] = i;
    }
    const ord = Array.from(this.order.subarray(0, n)).sort((a, b) => d[b] - d[a]);
    const tp = this.tmpPos, td = this.tmpData, tv = this.tmpVel;
    const life = new Float32Array(n), age = new Float32Array(n), s0 = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const i = ord[k];
      tp.set(pos.subarray(i * 4, i * 4 + 4), k * 4);
      td.set(data.subarray(i * 4, i * 4 + 4), k * 4);
      tv.set(vel.subarray(i * 4, i * 4 + 4), k * 4);
      life[k] = this.life[i];
      age[k] = this.age[i];
      s0[k] = this.size0[i];
    }
    pos.set(tp.subarray(0, n * 4));
    data.set(td.subarray(0, n * 4));
    vel.set(tv.subarray(0, n * 4));
    this.life.set(life);
    this.age.set(age);
    this.size0.set(s0);
  }

  clear() {
    this.n = 0;
    this.buf.count = 0;
  }
}

export function createSmoke(p: SmokeParams, seed = 1): Effect {
  const object = new THREE.Group();
  const smoke = new Smoke(p, seed);
  // Partikel leben in Weltkoordinaten → nicht an die Transformation hängen
  const world = new THREE.Group();
  world.matrixAutoUpdate = false;
  world.add(smoke.buf.mesh);
  object.add(world);
  object.userData.worldSpace = world;
  const origin = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  let on = true;
  let burst = 0;
  const control: EffectControl = {
    get on() {
      return on;
    },
    setOn(v) {
      on = v;
    },
    intensity: 1,
    setIntensity(v) {
      this.intensity = Math.max(0, v);
    },
    burst(strength = 1) {
      burst += strength;
    },
  };
  return {
    object,
    control,
    update(dt, t) {
      // Welt-Gruppe neutralisiert die Elterntransformation
      object.updateWorldMatrix(true, false);
      world.matrix.copy(object.matrixWorld).invert();
      world.matrixWorldNeedsUpdate = true;
      object.getWorldPosition(origin);
      const sc = worldScale(object);
      camPos.copy(volumeFX.camPosition);
      smoke.rateMul = control.intensity;
      if (burst > 0) {
        smoke.emit(origin, sc, Math.round(12 * burst * volumeFX.particleScale), 2 * burst);
        burst = 0;
      }
      smoke.update(Math.min(dt, 0.05), t, origin, sc, on && object.visible, camPos);
    },
    dispose() {
      smoke.buf.dispose();
    },
  };
}

// ---------- Funken ----------

export interface SparkParams {
  color: string;
  rate: number; // Ausbrüche pro Sekunde (0 = nur per Skript/Schuss)
  count: number; // Funken pro Ausbruch
  speed: number;
  gravity: number;
  life: number;
  size: number;
  /** Funken springen am Boden der Box ab */
  bounce: number;
  /** Lichtblitz beim Ausbruch */
  flash: boolean;
}

class Sparks {
  readonly buf: ParticleBuffer;
  private n = 0;
  private life: Float32Array;
  private rand: () => number;
  constructor(public p: SparkParams, seed = 3, capacity = 400) {
    this.buf = new ParticleBuffer(capacity, 'spark', { uColor: { value: new THREE.Color(p.color) } });
    this.life = new Float32Array(capacity);
    this.rand = rng(seed);
  }

  setColor(c: string) {
    (this.buf.uniforms.uColor.value as THREE.Color).set(c);
  }

  /** Ausbruch an origin, bevorzugt in Richtung dir (Kegel), sonst nach oben/allseitig */
  emit(origin: THREE.Vector3, count: number, speed: number, dir?: THREE.Vector3, cone = 0.9) {
    const { pos, data, vel } = this.buf;
    const r = this.rand;
    for (let k = 0; k < count && this.n < this.buf.capacity; k++) {
      const i = this.n++;
      const i4 = i * 4;
      pos[i4] = origin.x;
      pos[i4 + 1] = origin.y;
      pos[i4 + 2] = origin.z;
      pos[i4 + 3] = this.p.size * (0.6 + r() * 0.8);
      // zufällige Richtung, um dir herum
      let x = r() * 2 - 1, y = r() * 2 - 1, z = r() * 2 - 1;
      const l = Math.hypot(x, y, z) || 1;
      x /= l;
      y /= l;
      z /= l;
      if (dir) {
        x = dir.x + x * cone;
        y = dir.y + y * cone;
        z = dir.z + z * cone;
      } else y = Math.abs(y) * 0.8 + 0.4;
      const s = speed * (0.4 + r() * 0.8);
      const ln = Math.hypot(x, y, z) || 1;
      vel[i4] = (x / ln) * s;
      vel[i4 + 1] = (y / ln) * s;
      vel[i4 + 2] = (z / ln) * s;
      vel[i4 + 3] = 0.045;
      data[i4] = 0;
      data[i4 + 1] = 0;
      data[i4 + 2] = r();
      data[i4 + 3] = 0.6 + r() * 0.8;
      this.life[i] = this.p.life * (0.5 + r() * 0.8);
    }
  }

  update(dt: number, floorY: number) {
    const { pos, data, vel } = this.buf;
    const g = this.p.gravity;
    const wind = volumeFX.wind;
    const drag = Math.exp(-dt * 0.8);
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const i4 = i * 4;
      const age = data[i4] + dt / this.life[i];
      if (age >= 1) continue;
      vel[i4] = (vel[i4] + wind.x * 0.3 * dt) * drag;
      vel[i4 + 1] = (vel[i4 + 1] - g * dt) * drag;
      vel[i4 + 2] = (vel[i4 + 2] + wind.z * 0.3 * dt) * drag;
      const x = pos[i4] + vel[i4] * dt;
      let y = pos[i4 + 1] + vel[i4 + 1] * dt;
      const z = pos[i4 + 2] + vel[i4 + 2] * dt;
      if (y < floorY && vel[i4 + 1] < 0) {
        y = floorY;
        if (this.p.bounce > 0 && Math.abs(vel[i4 + 1]) > 0.6) {
          vel[i4 + 1] *= -this.p.bounce;
          vel[i4] *= 0.6;
          vel[i4 + 2] *= 0.6;
        } else {
          vel[i4 + 1] = 0;
          vel[i4] *= 0.85;
          vel[i4 + 2] *= 0.85;
        }
      }
      const j4 = j * 4;
      pos[j4] = x;
      pos[j4 + 1] = y;
      pos[j4 + 2] = z;
      pos[j4 + 3] = pos[i4 + 3];
      vel[j4] = vel[i4];
      vel[j4 + 1] = vel[i4 + 1];
      vel[j4 + 2] = vel[i4 + 2];
      vel[j4 + 3] = vel[i4 + 3];
      data[j4] = age;
      data[j4 + 1] = 0;
      data[j4 + 2] = data[i4 + 2];
      data[j4 + 3] = data[i4 + 3];
      this.life[j] = this.life[i];
      j++;
    }
    this.n = j;
    this.buf.count = j;
  }

  get alive() {
    return this.n;
  }
}

/** Flackerndes Licht, das bei FX registriert ist (beleuchtet Nebel/Rauch) */
function fxLight(color: string, distance: number) {
  const light = new THREE.PointLight(color, 0, distance, 2);
  light.castShadow = false;
  const unregister = volumeFX.addLight(light);
  return { light, unregister };
}

export function createSparks(p: SparkParams, seed = 3): Effect {
  const object = new THREE.Group();
  const sparks = new Sparks(p, seed, Math.min(1200, Math.max(64, Math.ceil(p.count * Math.max(1, p.rate) * p.life * 2) + 32)));
  const world = new THREE.Group();
  world.matrixAutoUpdate = false;
  world.add(sparks.buf.mesh);
  object.add(world);
  const { light, unregister } = fxLight(p.color, 6);
  object.add(light);
  const origin = new THREE.Vector3();
  const down = new THREE.Vector3();
  let on = true;
  let acc = 0;
  let flash = 0;
  let pending = 0;
  const control: EffectControl = {
    get on() {
      return on;
    },
    setOn(v) {
      on = v;
    },
    intensity: 1,
    setIntensity(v) {
      this.intensity = Math.max(0, v);
    },
    burst(strength = 1) {
      pending += strength;
    },
  };
  return {
    object,
    control,
    update(dt, _t) {
      dt = Math.min(dt, 0.05);
      object.updateWorldMatrix(true, false);
      world.matrix.copy(object.matrixWorld).invert();
      world.matrixWorldNeedsUpdate = true;
      object.getWorldPosition(origin);
      const sc = worldScale(object);
      // Boden = Unterkante der Effekt-Box (Einheitswürfel, Ursprung oben)
      down.set(0, -1, 0).applyMatrix4(object.matrixWorld);
      const floorY = Math.min(down.y, origin.y - 0.05);
      const count = Math.max(1, Math.round(p.count * volumeFX.particleScale));
      if (on && object.visible && p.rate > 0) {
        acc += dt * p.rate * control.intensity;
        while (acc >= 1) {
          acc -= 1;
          pending += 1;
        }
      }
      while (pending > 0) {
        const k = Math.min(1, pending);
        pending -= k;
        sparks.emit(origin, Math.round(count * k * Math.max(0.3, control.intensity)), p.speed * Math.max(0.5, sc));
        if (p.flash) flash = Math.max(flash, k);
      }
      sparks.update(dt, floorY);
      flash = Math.max(0, flash - dt * 9);
      light.intensity = flash * 18 * control.intensity;
      light.visible = light.intensity > 0.01;
    },
    dispose() {
      unregister();
      sparks.buf.dispose();
      light.dispose();
    },
  };
}

// ---------- Feuer ----------

export interface FireParams {
  color: string; // Farbton (Multiplikator auf den Glut-Verlauf)
  size: number; // Flammenhöhe (m)
  radius: number; // Grundfläche (m)
  rate: number; // Flammenpartikel/s
  embers: number; // Glut-Funken/s
  smoke: number; // 0 = kein Rauch, 1 = normal, 2 = dicht
  smokeColor: string;
  light: number; // Lichtstärke (0 = aus)
  lightColor: string;
  flicker: number; // 0..1
  /** Schaden/Spielmechanik ist nicht Teil davon – rein visuell */
}

export function createFire(p: FireParams, seed = 7): Effect {
  const object = new THREE.Group();
  const world = new THREE.Group();
  world.matrixAutoUpdate = false;
  object.add(world);
  const flameCap = Math.min(700, Math.ceil(p.rate * 1.4 * 1.2) + 16);
  const flames = new ParticleBuffer(flameCap, 'fire', {
    uTint: { value: new THREE.Color(p.color) },
    uHeat: { value: 1 },
  });
  world.add(flames.mesh);
  const flameLife = new Float32Array(flameCap);
  const flameAge = new Float32Array(flameCap);
  const flameSize = new Float32Array(flameCap);
  const flameOff = new Float32Array(flameCap * 2);
  let nFlames = 0;
  const sparks = new Sparks(
    { color: '#ff8a2a', rate: 0, count: 0, speed: 3, gravity: -0.4, life: 1.6, size: 0.022, bounce: 0, flash: false },
    seed + 1,
    260,
  );
  world.add(sparks.buf.mesh);
  const hitSparks = new Sparks(
    { color: '#ffb050', rate: 0, count: 0, speed: 6, gravity: 7, life: 0.9, size: 0.03, bounce: 0.35, flash: false },
    seed + 2,
    200,
  );
  world.add(hitSparks.buf.mesh);
  const smoke =
    p.smoke > 0
      ? new Smoke(
          {
            color: p.smokeColor,
            rate: 5 * p.smoke,
            life: 4.5 + p.smoke,
            size: 0.35 * p.radius * 2,
            grow: 1.4 * p.size + 0.6,
            rise: 0.9,
            spread: p.radius * 0.6,
            opacity: 0.45 + 0.2 * Math.min(1, p.smoke - 1),
            turbulence: 0.6,
            glow: 0.35,
            glowColor: '#ff5a10',
          },
          seed + 3,
        )
      : null;
  if (smoke) world.add(smoke.buf.mesh);
  const { light, unregister } = fxLight(p.lightColor, 6 + p.size * 6);
  light.castShadow = false;
  object.add(light);
  const rand = rng(seed);

  const origin = new THREE.Vector3();
  const smokeOrigin = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  let on = true;
  let level = 1; // 0..1 Anzündkurve (sanftes Ein/Aus)
  let acc = 0;
  let emberAcc = 0;
  let flare = 0;
  let pendingBurst = 0;

  const control: EffectControl = {
    get on() {
      return on;
    },
    setOn(v) {
      on = v;
    },
    intensity: 1,
    setIntensity(v) {
      this.intensity = Math.max(0, v);
    },
    burst(strength = 1) {
      pendingBurst += strength;
    },
  };

  // Schüsse durch die Flammen: Funkenschauer und kurzes Aufflackern
  const offShot = volumeFX.onShot((from, to) => {
    if (!on || level < 0.1) return;
    tmpA.copy(origin).y += p.size * worldScale(object) * 0.35;
    const reach = (p.radius + p.size * 0.4) * worldScale(object);
    if (segDist(tmpA, from, to) > reach) return;
    const dir = new THREE.Vector3().subVectors(to, from).normalize();
    hitSparks.emit(tmpA, Math.round(26 * volumeFX.particleScale) + 6, 5, dir, 1.1);
    flare = Math.min(1.5, flare + 0.9);
  });

  function emitFlame(sc: number, strength: number) {
    if (nFlames >= flameCap) return;
    const i = nFlames++;
    const i4 = i * 4;
    const a = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand()) * p.radius * sc;
    flameOff[i * 2] = Math.cos(a) * rr;
    flameOff[i * 2 + 1] = Math.sin(a) * rr;
    const { pos, vel, data } = flames;
    pos[i4] = origin.x + flameOff[i * 2];
    pos[i4 + 1] = origin.y + rand() * 0.05 * sc;
    pos[i4 + 2] = origin.z + flameOff[i * 2 + 1];
    // innen größer, außen kleiner
    const centre = 1 - rr / (p.radius * sc + 1e-4);
    flameSize[i] = (0.18 + 0.22 * centre + rand() * 0.12) * Math.sqrt(p.size) * sc * (0.7 + 0.3 * strength);
    pos[i4 + 3] = flameSize[i];
    vel[i4] = (rand() - 0.5) * 0.2;
    vel[i4 + 1] = (1.2 + rand() * 0.9) * Math.sqrt(p.size) * sc * (0.75 + 0.25 * strength);
    vel[i4 + 2] = (rand() - 0.5) * 0.2;
    vel[i4 + 3] = 0.12;
    data[i4] = 0;
    data[i4 + 1] = (rand() - 0.5) * 0.3;
    data[i4 + 2] = rand();
    data[i4 + 3] = 0.8 + rand() * 0.4;
    flameLife[i] = (0.55 + rand() * 0.45) * Math.sqrt(p.size) * (0.8 + 0.2 * strength);
    flameAge[i] = 0;
  }

  function updateFlames(dt: number, t: number, sc: number) {
    const { pos, vel, data } = flames;
    const wind = volumeFX.wind;
    let j = 0;
    for (let i = 0; i < nFlames; i++) {
      const age = flameAge[i] + dt;
      if (age >= flameLife[i]) continue;
      const k = age / flameLife[i];
      const i4 = i * 4;
      // zur Achse ziehen (Flamme läuft spitz zu), Auftrieb, Turbulenz, Wind
      const dx = pos[i4] - origin.x, dz = pos[i4 + 2] - origin.z;
      const sw = Math.sin(t * 7 + data[i4 + 2] * 30 + pos[i4 + 1] * 4) * 0.9 * p.flicker;
      vel[i4] += (-dx * 2.4 + sw + wind.x * 1.2) * dt;
      vel[i4 + 2] += (-dz * 2.4 + Math.cos(t * 6 + data[i4 + 2] * 21) * 0.9 * p.flicker + wind.z * 1.2) * dt;
      vel[i4 + 1] += 1.8 * sc * dt;
      pushByDisturbers(pos, i4, vel, dt, 0.6);
      const j4 = j * 4;
      pos[j4] = pos[i4] + vel[i4] * dt;
      pos[j4 + 1] = pos[i4 + 1] + vel[i4 + 1] * dt;
      pos[j4 + 2] = pos[i4 + 2] + vel[i4 + 2] * dt;
      // erst wachsen, dann schrumpfen
      pos[j4 + 3] = flameSize[i] * (0.6 + 0.9 * Math.sin(Math.min(1, k * 1.4) * Math.PI * 0.5)) * (1 - k * 0.55);
      vel[j4] = vel[i4];
      vel[j4 + 1] = vel[i4 + 1];
      vel[j4 + 2] = vel[i4 + 2];
      vel[j4 + 3] = vel[i4 + 3];
      data[j4] = k;
      data[j4 + 1] = data[i4 + 1];
      data[j4 + 2] = data[i4 + 2];
      data[j4 + 3] = data[i4 + 3];
      flameLife[j] = flameLife[i];
      flameAge[j] = age;
      flameSize[j] = flameSize[i];
      j++;
    }
    nFlames = j;
    flames.count = j;
  }

  return {
    object,
    control,
    update(dt, t) {
      dt = Math.min(dt, 0.05);
      object.updateWorldMatrix(true, false);
      world.matrix.copy(object.matrixWorld).invert();
      world.matrixWorldNeedsUpdate = true;
      object.getWorldPosition(origin);
      camPos.copy(volumeFX.camPosition);
      const sc = worldScale(object);
      const active = on && object.visible;
      // Regen dämpft das Feuer
      const rainDamp = 1 - volumeFX.rain * 0.45;
      const target = active ? control.intensity * rainDamp : 0;
      level += (target - level) * Math.min(1, dt * (target > level ? 1.5 : 2.5));
      const strength = level + flare * 0.6;
      flames.uniforms.uHeat.value = THREE.MathUtils.clamp(0.75 + 0.25 * strength, 0.5, 1.15);

      if (pendingBurst > 0) {
        flare = Math.min(2, flare + pendingBurst);
        sparks.emit(tmpA.copy(origin).setY(origin.y + 0.2 * sc), Math.round(30 * pendingBurst * volumeFX.particleScale), 3.5 * sc);
        if (smoke) smoke.emit(smokeOrigin.copy(origin).setY(origin.y + p.size * sc * 0.8), sc, Math.round(6 * pendingBurst), 1.5);
        pendingBurst = 0;
      }

      if (strength > 0.02) {
        acc += dt * p.rate * Math.min(1.6, strength) * volumeFX.particleScale;
        while (acc >= 1) {
          acc -= 1;
          emitFlame(sc, strength);
        }
        emberAcc += dt * p.embers * strength * volumeFX.particleScale;
        while (emberAcc >= 1) {
          emberAcc -= 1;
          tmpA.set(origin.x + (rand() - 0.5) * p.radius * sc, origin.y + p.size * sc * 0.3 * rand(), origin.z + (rand() - 0.5) * p.radius * sc);
          sparks.emit(tmpA, 1, (1 + rand() * 1.8) * Math.sqrt(sc), tmpB.set(volumeFX.wind.x * 0.2, 1, volumeFX.wind.z * 0.2).normalize(), 0.5);
        }
      }
      // Glut-Funken: nach oben treibend (negative Schwerkraft), mit Wind
      updateFlames(dt, t, sc);
      sparks.update(dt, -1e9);
      hitSparks.update(dt, origin.y);
      if (smoke) {
        smokeOrigin.copy(origin).setY(origin.y + p.size * sc * 0.75);
        smoke.rateMul = Math.min(1.5, strength) * (1 + volumeFX.rain * 1.5);
        smoke.update(dt, t, smokeOrigin, sc, strength > 0.05, camPos);
      }
      flare = Math.max(0, flare - dt * 1.8);

      // Licht: weiches Flackern aus mehreren Frequenzen
      const fl =
        1 -
        p.flicker *
          (0.22 * (0.5 + 0.5 * Math.sin(t * 11.3 + seed)) +
            0.14 * (0.5 + 0.5 * Math.sin(t * 23.7 + seed * 2)) +
            0.1 * (0.5 + 0.5 * Math.sin(t * 5.1)));
      light.position.set(Math.sin(t * 9) * 0.05 * p.flicker, p.size * 0.45, Math.cos(t * 7.3) * 0.05 * p.flicker);
      light.intensity = p.light * strength * fl;
      light.visible = light.intensity > 0.01;
    },
    dispose() {
      offShot();
      unregister();
      flames.dispose();
      sparks.buf.dispose();
      hitSparks.buf.dispose();
      smoke?.buf.dispose();
      light.dispose();
    },
  };
}
