import * as THREE from 'three';
import type { WaterImpulse } from './registry.ts';

// GPU-Wellenringe: Höhenfeld 512² über 64 m × 64 m um die Kamera (Ping-Pong, R = Höhe, G = vorherige Höhe).
// Wellengleichung mit fester Schrittweite (60 Hz, höchstens 3 Schritte pro Frame). Wandert die Kamera, rückt
// das Feld in ganzen Texeln nach (beim Lesen verschoben), damit Ringe an ihrer Welt-Position bleiben.

export const RIPPLE_RES = 512;
export const RIPPLE_SIZE = 64;
const MAX_IMP = 16;
const STEP = 1 / 60;

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D tPrev;
uniform vec2 uShift;
uniform vec2 uCenter;
uniform float uSize;
uniform vec4 uImp[${MAX_IMP}];
uniform int uImpN;
varying vec2 vUv;
float h(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return texture2D(tPrev, uv).r;
}
void main() {
  vec2 e = vec2(1.0 / ${RIPPLE_RES}.0);
  vec2 uv = vUv + uShift;
  vec4 c = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture2D(tPrev, uv);
  float avg = (h(uv + vec2(e.x, 0.0)) + h(uv - vec2(e.x, 0.0)) + h(uv + vec2(0.0, e.y)) + h(uv - vec2(0.0, e.y))) * 0.25;
  float n = c.r + (c.r - c.g) * 0.982 + (avg - c.r) * 1.2;
  n *= 0.997;
  vec2 wp = uCenter + (vUv - 0.5) * uSize;
  for (int i = 0; i < ${MAX_IMP}; i++) {
    if (i >= uImpN) break;
    vec4 I = uImp[i];
    float d = length(wp - I.xy);
    float k = 1.0 - smoothstep(0.0, I.z, d);
    n += I.w * k * k;
  }
  // Ränder ausblenden (keine Reflexion am Feldrand)
  vec2 edge = min(vUv, 1.0 - vUv);
  n *= smoothstep(0.0, 0.03, min(edge.x, edge.y));
  gl_FragColor = vec4(clamp(n, -2.0, 2.0), c.r, 0.0, 1.0);
}
`;

export class RippleSim {
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private idx = 0;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private acc = 0;
  private pending: WaterImpulse[] = [];
  private center = new THREE.Vector2(Infinity, Infinity);
  private cleared = false;
  /** xy = Mitte, z = Größe, w = aktiv (für das Wasser-Material) */
  readonly area = new THREE.Vector4(0, 0, RIPPLE_SIZE, 0);

  constructor(private renderer: THREE.WebGLRenderer) {
    const opts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false };
    this.targets = [new THREE.WebGLRenderTarget(RIPPLE_RES, RIPPLE_RES, opts), new THREE.WebGLRenderTarget(RIPPLE_RES, RIPPLE_RES, opts)];
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tPrev: { value: null },
        uShift: { value: new THREE.Vector2() },
        uCenter: { value: new THREE.Vector2() },
        uSize: { value: RIPPLE_SIZE },
        uImp: { value: Array.from({ length: MAX_IMP }, () => new THREE.Vector4()) },
        uImpN: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  get texture(): THREE.Texture {
    return this.targets[this.idx].texture;
  }

  add(list: WaterImpulse[]): void {
    for (const i of list) {
      if (this.pending.length >= 48) this.pending.shift();
      this.pending.push(i);
    }
  }

  /** Simulation weiterrechnen; `active` = Wasser in der Nähe der Kamera */
  update(dt: number, camX: number, camZ: number, active: boolean): void {
    this.area.w = active ? 1 : 0;
    if (!active) {
      this.pending.length = 0;
      this.acc = 0;
      return;
    }
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.autoClear = false;
    if (!this.cleared) {
      const cc = r.getClearColor(new THREE.Color());
      const ca = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      for (const t of this.targets) {
        r.setRenderTarget(t);
        r.clear(true, false, false);
      }
      r.setClearColor(cc, ca);
      this.cleared = true;
    }
    this.acc = Math.min(this.acc + dt, STEP * 3);
    const u = this.mat.uniforms;
    const texel = RIPPLE_SIZE / RIPPLE_RES;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      // Feld auf ganze Texel an die Kamera rücken
      const nx = Math.round(camX / texel) * texel;
      const nz = Math.round(camZ / texel) * texel;
      if (!Number.isFinite(this.center.x) || Math.abs(nx - this.center.x) > RIPPLE_SIZE || Math.abs(nz - this.center.y) > RIPPLE_SIZE) {
        u.uShift.value.set(10, 10); // alles außerhalb → leer
      } else u.uShift.value.set((nx - this.center.x) / RIPPLE_SIZE, (nz - this.center.y) / RIPPLE_SIZE);
      this.center.set(nx, nz);
      u.uCenter.value.copy(this.center);
      const n = Math.min(MAX_IMP, this.pending.length);
      for (let i = 0; i < n; i++) {
        const p = this.pending[i];
        u.uImp.value[i].set(p.x, p.z, Math.max(texel * 1.5, p.radius), p.strength);
      }
      this.pending.splice(0, n);
      u.uImpN.value = n;
      u.tPrev.value = this.targets[this.idx].texture;
      this.idx = 1 - this.idx;
      r.setRenderTarget(this.targets[this.idx]);
      r.render(this.scene, this.cam);
    }
    this.area.set(this.center.x, this.center.y, RIPPLE_SIZE, 1);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    r.xr.enabled = prevXr;
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.mat.dispose();
  }
}
