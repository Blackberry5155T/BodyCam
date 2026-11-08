import * as THREE from 'three';
import { WATER_LAYER, waterShared } from './material.ts';
import type { WaterSplash } from './registry.ts';

// Spritzer: Tropfen-Partikel (Ringpuffer, CPU-Bewegung mit Schwerkraft), gezeichnet vom WaterPass nach dem Wasser.

const MAX = 768;
const G = 9.81;

const vertexShader = /* glsl */ `
attribute float aLife;
attribute float aSize;
varying float vLife;
uniform float uScale;
void main() {
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aLife > 0.0 ? aSize * uScale / max(-mv.z, 0.1) : 0.0;
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uSunColor, uAmbient;
varying float vLife;
void main() {
  if (vLife <= 0.0) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  if (r > 1.0) discard;
  float a = (1.0 - r) * clamp(vLife * 3.0, 0.0, 1.0) * 0.8;
  vec3 c = (uAmbient * 1.3 + uSunColor * 0.5) * (0.85 + 0.15 * (1.0 - r));
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}
`;

export class WaterSplashes {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private floor = new Float32Array(MAX);
  private head = 0;
  private alive = 0;

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uSunColor: waterShared.uSunColor, uAmbient: waterShared.uAmbient },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.layers.set(WATER_LAYER);
    this.points.renderOrder = 10;
    this.points.userData.noPick = true;
    this.points.userData.noShot = true;
    this.points.userData.noWeather = true;
  }

  /** Bildschirmhöhe in Pixeln → Punktgröße */
  setViewport(heightPx: number, fovDeg: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  spawn(s: WaterSplash): void {
    const n = Math.min(80, Math.round(6 + s.strength * 22));
    const up = 1.2 + s.strength * 1.6;
    for (let k = 0; k < n; k++) {
      const i = this.head;
      this.head = (this.head + 1) % MAX;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      const sp = (0.4 + r * 1.4) * (0.6 + s.strength * 0.5);
      this.pos[i * 3] = s.pos.x + Math.cos(a) * 0.05;
      this.pos[i * 3 + 1] = s.pos.y + 0.02;
      this.pos[i * 3 + 2] = s.pos.z + Math.sin(a) * 0.05;
      let vx = Math.cos(a) * sp;
      let vy = up * (0.45 + Math.random() * 0.75) * (1 - r * 0.4);
      let vz = Math.sin(a) * sp;
      if (s.vel) {
        vx += s.vel.x * 0.15;
        vy += Math.abs(s.vel.y) * 0.05;
        vz += s.vel.z * 0.15;
      }
      this.vel[i * 3] = vx;
      this.vel[i * 3 + 1] = vy;
      this.vel[i * 3 + 2] = vz;
      this.life[i] = 0.5 + Math.random() * 0.7;
      this.size[i] = 0.012 + Math.random() * 0.03 * (0.6 + s.strength * 0.4);
      this.floor[i] = s.pos.y - 0.05;
    }
    this.alive = MAX;
  }

  update(dt: number): void {
    if (!this.alive) return;
    let any = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      this.vel[j + 1] -= G * dt;
      this.vel[j] *= 1 - 0.8 * dt;
      this.vel[j + 2] *= 1 - 0.8 * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.pos[j + 1] < this.floor[i]) this.life[i] = 0;
      if (this.life[i] > 0) any++;
      else this.life[i] = 0;
    }
    this.alive = any;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aLife.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
