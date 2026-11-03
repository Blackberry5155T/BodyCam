import * as THREE from 'three';

// Volumetrische Effekte für Maps: Nebelvolumen (Raymarching in einer Box), Lichtkegel für Spotlights
// und schwebende Staubpartikel. Alle transparent, ohne Tiefenschreiben, mit Szenen-Nebel verrechnet.

const NOISE_GLSL = /* glsl */ `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y);
  float b = mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y);
  return mix(a, b, f.z);
}
float fbm(vec3 p) {
  return vnoise(p) * 0.6 + vnoise(p * 2.03 + 7.1) * 0.3 + vnoise(p * 4.1 + 3.3) * 0.1;
}
`;

export interface FogVolumeParams {
  color: string;
  density: number; // Extinktion pro Meter
  brightness: number; // >1 = leuchtender Dunst (Bloom)
  noise: number; // 0..1 Anteil der Wolkenstruktur
  noiseScale: number; // Strukturgröße (1/m)
  edge: number; // weiche Kante (Anteil der Box)
  heightFalloff: number; // 0..1, unten dichter
  speed: number;
}

/** Box-Nebelvolumen (Einheitswürfel, Größe über die Objektskalierung) */
export function createFogVolume(p: FogVolumeParams): { mesh: THREE.Mesh; update(t: number): void } {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
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
    },
  ]);
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
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
      uniform mat4 uModel;
      uniform mat4 uInvModel;
      uniform vec3 uColor;
      uniform float uDensity, uBrightness, uNoise, uNoiseScale, uEdge, uHeight, uTime;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      void main() {
        vec3 ro = (uInvModel * vec4(cameraPosition, 1.0)).xyz;
        vec3 rp = (uInvModel * vec4(vWorld, 1.0)).xyz;
        vec3 rd = normalize(rp - ro);
        vec3 inv = 1.0 / rd;
        vec3 t0 = (-0.5 - ro) * inv;
        vec3 t1 = (0.5 - ro) * inv;
        vec3 tmin = min(t0, t1);
        vec3 tmax = max(t0, t1);
        float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
        float tf = min(min(tmax.x, tmax.y), tmax.z);
        if (tf <= tn) discard;
        vec3 wa = (uModel * vec4(ro + rd * tn, 1.0)).xyz;
        vec3 wb = (uModel * vec4(ro + rd * tf, 1.0)).xyz;
        float worldLen = length(wb - wa);
        const int STEPS = 14;
        float stepT = (tf - tn) / float(STEPS);
        float jitter = hash13(gl_FragCoord.xyy + uTime);
        float acc = 0.0;
        for (int i = 0; i < STEPS; i++) {
          vec3 p = ro + rd * (tn + stepT * (float(i) + jitter));
          vec3 e = 0.5 - abs(p);
          float edge = smoothstep(0.0, uEdge, min(min(e.x, e.y), e.z));
          float h = mix(1.0, 1.0 - smoothstep(-0.5, 0.5, p.y), uHeight);
          vec3 wp = (uModel * vec4(p, 1.0)).xyz;
          float n = mix(1.0, fbm(wp * uNoiseScale + vec3(uTime * 0.13, uTime * 0.04, uTime * 0.09)) * 1.6, uNoise);
          acc += edge * h * max(n, 0.0);
        }
        float density = acc / float(STEPS) * worldLen * uDensity;
        float alpha = 1.0 - exp(-density);
        gl_FragColor = vec4(uColor * uBrightness, alpha);
        #include <fog_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.renderOrder = 10;
  mesh.onBeforeRender = () => {
    uniforms.uModel.value.copy(mesh.matrixWorld);
    uniforms.uInvModel.value.copy(mesh.matrixWorld).invert();
  };
  return {
    mesh,
    update(t: number) {
      uniforms.uTime.value = t * p.speed;
    },
  };
}

export interface LightConeParams {
  color: string;
  length: number;
  angle: number; // halber Öffnungswinkel (rad)
  strength: number;
}

/** Sichtbarer Lichtkegel entlang lokaler -Y (Spitze im Ursprung), additiv */
export function createLightCone(p: LightConeParams): { mesh: THREE.Mesh; update(t: number): void } {
  const radius = Math.tan(Math.min(p.angle, 1.45)) * p.length;
  const geo = new THREE.CylinderGeometry(0.02, radius, p.length, 40, 12, true);
  geo.translate(0, -p.length / 2, 0);
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uColor: { value: new THREE.Color(p.color) },
      uStrength: { value: p.strength },
      uLength: { value: p.length },
      uTime: { value: 0 },
    },
  ]);
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: true,
    vertexShader: /* glsl */ `
      uniform float uLength;
      varying float vAlong;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vAlong = clamp(-position.y / uLength, 0.0, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength, uTime;
      varying float vAlong;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float facing = abs(dot(normalize(vNormalW), viewDir));
        float rim = pow(facing, 2.2);
        float fall = pow(1.0 - vAlong, 1.6) * smoothstep(0.0, 0.08, vAlong);
        float n = 0.75 + 0.5 * fbm(vWorld * 1.3 + vec3(0.0, -uTime * 0.25, uTime * 0.1));
        float a = uStrength * fall * rim * n * 0.5;
        vec3 col = uColor * a;
        #ifdef USE_FOG
          col *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
        #endif
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = 11;
  return {
    mesh,
    update(t: number) {
      uniforms.uTime.value = t;
    },
  };
}

let dotTexture: THREE.Texture | null = null;
function softDot(): THREE.Texture {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
}

export interface DustParams {
  count: number;
  size: number;
  color: string;
  opacity: number;
  speed: number;
}

/** Schwebende Staubpartikel im Einheitswürfel (Größe über die Objektskalierung) */
export function createDust(p: DustParams, seed = 1): { points: THREE.Points; update(dt: number, t: number): void } {
  const count = Math.max(1, Math.min(5000, Math.round(p.count)));
  let s = seed * 9301 + 49297;
  const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const base = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count * 3; i++) base[i] = rand() - 0.5;
  for (let i = 0; i < count; i++) phase[i] = rand() * 100;
  const pos = new Float32Array(base);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: p.color,
    size: p.size,
    map: softDot(),
    transparent: true,
    opacity: p.opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const wrap = (v: number) => ((((v + 0.5) % 1) + 1) % 1) - 0.5;
  return {
    points,
    update(_dt: number, t: number) {
      const k = t * p.speed;
      for (let i = 0; i < count; i++) {
        const ph = phase[i];
        pos[i * 3] = wrap(base[i * 3] + Math.sin(k * 0.21 + ph) * 0.03 + k * 0.004);
        pos[i * 3 + 1] = wrap(base[i * 3 + 1] + Math.sin(k * 0.17 + ph * 1.3) * 0.03 - k * 0.006);
        pos[i * 3 + 2] = wrap(base[i * 3 + 2] + Math.cos(k * 0.19 + ph * 0.7) * 0.03);
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}
