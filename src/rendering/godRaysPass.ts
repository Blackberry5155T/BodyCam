import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * God-Rays (Lichtstrahlen der Sonne) im Screen-Space:
 *  1. Maske (halbe Auflösung): nur Himmelspixel (Tiefe = Far-Plane) leuchten, gewichtet nach Nähe zur Sonne.
 *     Geometrie (Bäume, Gebäude, Spieler) bleibt schwarz und wirft so Schatten in die Strahlen.
 *  2. Radialer Blur von jedem Pixel Richtung Sonne (GPU Gems 3, Kap. 13), mit Jitter gegen Streifen.
 *  3. Additiv auf den HDR-Puffer, vor Bloom/Tonemapping.
 * Braucht die aufgelöste Tiefentextur des MSAA-Targets (wie VolumePass); ohne sie bleibt der Pass aus.
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const maskShader = {
  uniforms: {
    tDepth: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uReversed: { value: 1 },
    uProjInv: { value: new THREE.Matrix4() },
    uViewInv: { value: new THREE.Matrix4() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  },
  vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform float uReversed;
    uniform mat4 uProjInv;
    uniform mat4 uViewInv;
    uniform vec3 uSunDir;
    varying vec2 vUv;

    float skyAt(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      return uReversed > 0.5 ? step(d, 1e-7) : step(0.9999999, d);
    }

    void main() {
      // 4 Taps aus der vollen Auflösung → weiche Kanten in der halben Auflösung
      float sky = 0.25 * (
        skyAt(vUv + uTexel * vec2(-0.5, -0.5)) + skyAt(vUv + uTexel * vec2(0.5, -0.5)) +
        skyAt(vUv + uTexel * vec2(-0.5, 0.5)) + skyAt(vUv + uTexel * vec2(0.5, 0.5)));
      vec4 v = uProjInv * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
      vec3 dir = normalize((uViewInv * vec4(v.xyz / v.w, 0.0)).xyz);
      float c = max(dot(dir, uSunDir), 0.0);
      float glow = pow(c, 900.0) * 6.0 + pow(c, 60.0) * 0.8 + pow(c, 8.0) * 0.12;
      gl_FragColor = vec4(vec3(sky * glow), 1.0);
    }
  `,
};

const SAMPLES = 64;

const blurShader = {
  uniforms: {
    tMask: { value: null as THREE.Texture | null },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    uDensity: { value: 0.9 },
    uDecay: { value: 0.965 },
  },
  vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tMask;
    uniform vec2 uSunUv;
    uniform float uDensity;
    uniform float uDecay;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 delta = (vUv - uSunUv) * uDensity / float(${SAMPLES});
      vec2 uv = vUv - delta * hash(gl_FragCoord.xy);
      float illum = 1.0;
      vec3 sum = vec3(0.0);
      for (int i = 0; i < ${SAMPLES}; i++) {
        uv -= delta;
        vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
        sum += texture2D(tMask, uv).rgb * illum * inside.x * inside.y;
        illum *= uDecay;
      }
      gl_FragColor = vec4(sum / float(${SAMPLES}) * 4.0, 1.0);
    }
  `,
};

const compositeShader = {
  uniforms: {
    tRays: { value: null as THREE.Texture | null },
    uColor: { value: new THREE.Color() },
  },
  vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tRays;
    uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      gl_FragColor = vec4(texture2D(tRays, vUv).rgb * uColor, 1.0);
    }
  `,
};

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

export class GodRaysPass extends Pass {
  /** Gesamtstärke (Einstellung); 0 = aus */
  strength = 1;
  /** Bewölkung 0..1, dämpft die Strahlen */
  overcast = 0;
  /** zusätzlicher Faktor (z. B. unter Wasser 0) */
  fade = 1;

  private maskRT: THREE.WebGLRenderTarget;
  private raysRT: THREE.WebGLRenderTarget;
  private maskMat = new THREE.ShaderMaterial({ ...maskShader, uniforms: THREE.UniformsUtils.clone(maskShader.uniforms), depthTest: false, depthWrite: false });
  private blurMat = new THREE.ShaderMaterial({ ...blurShader, uniforms: THREE.UniformsUtils.clone(blurShader.uniforms), depthTest: false, depthWrite: false });
  private compMat = new THREE.ShaderMaterial({
    ...compositeShader,
    uniforms: THREE.UniformsUtils.clone(compositeShader.uniforms),
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });
  private quad = new FullScreenQuad();

  constructor(
    private camera: THREE.Camera,
    private sun: THREE.Light,
  ) {
    super();
    this.needsSwap = false;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.maskRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.raysRT = new THREE.WebGLRenderTarget(1, 1, opts);
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  setSun(sun: THREE.Light): void {
    this.sun = sun;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.maskRT.setSize(w, h);
    this.raysRT.setSize(w, h);
    this.maskMat.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const cam = this.camera as THREE.PerspectiveCamera;
    const sun = this.sun;
    const msrtt = renderer.extensions.has('WEBGL_multisampled_render_to_texture');
    const depthOk = !!readBuffer.depthTexture && readBuffer.samples > 0 && !msrtt;
    if (!depthOk || !cam.isPerspectiveCamera || !sun.visible || sun.intensity <= 0) return;

    // SunLight: Richtung = Position (scheint zum Ursprung)
    const sunDir = _v.copy(sun.position).normalize();
    // Sonne relativ zur Blickrichtung: hinter der Kamera / unter dem Horizont / weit außerhalb → ausblenden
    const facing = -_p.copy(sunDir).transformDirection(cam.matrixWorldInverse).z;
    const clear = 1 - this.overcast;
    let fade = this.strength * this.fade * THREE.MathUtils.smoothstep(facing, 0.0, 0.35);
    fade *= THREE.MathUtils.smoothstep(sunDir.y, -0.03, 0.08) * clear * clear;
    if (fade <= 0.001) return;
    _p.copy(cam.position).addScaledVector(sunDir, cam.far * 0.5).project(cam);
    const edge = Math.max(Math.abs(_p.x), Math.abs(_p.y));
    fade *= 1 - THREE.MathUtils.smoothstep(edge, 1.1, 2.4);
    if (fade <= 0.001) return;

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;

    // 1. Maske
    const mu = this.maskMat.uniforms;
    mu.tDepth.value = readBuffer.depthTexture;
    mu.uReversed.value = cam.reversedDepth ? 1 : 0;
    mu.uProjInv.value.copy(cam.projectionMatrixInverse);
    mu.uViewInv.value.copy(cam.matrixWorld);
    mu.uSunDir.value.copy(sunDir);
    this.quad.material = this.maskMat;
    renderer.setRenderTarget(this.maskRT);
    this.quad.render(renderer);

    // 2. Radialer Blur Richtung Sonne
    const bu = this.blurMat.uniforms;
    bu.tMask.value = this.maskRT.texture;
    bu.uSunUv.value.set(_p.x * 0.5 + 0.5, _p.y * 0.5 + 0.5);
    this.quad.material = this.blurMat;
    renderer.setRenderTarget(this.raysRT);
    this.quad.render(renderer);

    // 3. Additiv auf die Szene (HDR, linear)
    const cu = this.compMat.uniforms;
    cu.tRays.value = this.raysRT.texture;
    cu.uColor.value.copy(sun.color).multiplyScalar(Math.min(sun.intensity, 6) * 0.35 * fade);
    this.quad.material = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(renderer);

    renderer.autoClear = autoClear;
  }

  dispose(): void {
    this.maskRT.dispose();
    this.raysRT.dispose();
    this.maskMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}
