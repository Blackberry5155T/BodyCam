import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { DEPTH_GLSL, FULLSCREEN_VERTEX, depthUniforms, setDepthUniforms } from './depth.ts';

/**
 * Bewegungsunschärfe der Kamera (Verschlusszeit einer Bodycam): jedes Pixel wird über die Tiefe in die
 * Welt zurückgerechnet und mit der Kamera des letzten Frames erneut projiziert; entlang dieser Bildbewegung
 * wird verwischt. Schnelle Drehungen und Sprints ziehen Schlieren, im Stand bleibt das Bild scharf.
 * Der Nahbereich (Waffe, Arme – bewegen sich mit der Kamera) bleibt scharf und schmiert nicht in den Hintergrund.
 * Erster Pass der Nachbearbeitungs-Kette: liest Farbe + Tiefe des (MSAA-)Szenen-Targets und schreibt in die
 * MSAA-freie Kette – ist die Unschärfe aus (strength 0), kopiert er nur.
 */

const SAMPLES = 8;

const shader = {
  uniforms: {
    ...depthUniforms(),
    tDiffuse: { value: null as THREE.Texture | null },
    uReproj: { value: new THREE.Matrix4() },
    uScale: { value: 0.5 },
    uMax: { value: 0.035 },
    uTexel: { value: new THREE.Vector2() },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    ${DEPTH_GLSL}
    uniform sampler2D tDiffuse;
    uniform mat4 uReproj;
    uniform float uScale;
    uniform float uMax;
    uniform vec2 uTexel;
    varying vec2 vUv;

    // 0 im Nahbereich (Waffe/Arme), 1 für die Welt
    float worldMask(float z) { return smoothstep(0.7, 1.5, z); }

    void main() {
      vec4 base = textureLod(tDiffuse, vUv, 0.0);
      if (uScale <= 0.0) { gl_FragColor = base; return; }
      vec3 p = viewPos(vUv);
      float z = -p.z;
      // sehr ferne Punkte (Himmel) begrenzen: nur die Drehung zählt, die Zahlen bleiben klein
      if (z > 5000.0) p *= 5000.0 / z;
      vec4 pc = uReproj * vec4(p, 1.0);
      if (pc.w <= 1e-4) { gl_FragColor = base; return; }
      vec2 vel = (vUv - (pc.xy / pc.w * 0.5 + 0.5)) * uScale * worldMask(z);
      float len = length(vel);
      if (len < uTexel.y * 0.75) { gl_FragColor = base; return; }
      vel *= min(1.0, uMax / len);

      float j = ign(gl_FragCoord.xy) - 0.5;
      vec3 sum = base.rgb;
      float wsum = 1.0;
      for (int i = 0; i < ${SAMPLES}; i++) {
        float t = (float(i) + 0.5 + j) / float(${SAMPLES}) - 0.5;
        vec2 uv = clamp(vUv + vel * t, vec2(0.001), vec2(0.999));
        float w = worldMask(viewZ(uv));
        sum += textureLod(tDiffuse, uv, 0.0).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(sum / wsum, base.a);
    }
  `,
};

export class MotionBlurPass extends Pass {
  /** 0 = aus, 1 = volle Verschlusszeit (ein ganzer Frame bei 60 Hz) */
  strength = 0.5;

  private mat = new THREE.ShaderMaterial({ ...shader, uniforms: THREE.UniformsUtils.clone(shader.uniforms), depthTest: false, depthWrite: false });
  private quad = new FullScreenQuad(this.mat);
  private prevViewProj = new THREE.Matrix4();
  private viewProj = new THREE.Matrix4();
  private hasPrev = false;

  /** source: liefert das Szenen-Target (Farbe + Tiefentextur) dieses Frames */
  constructor(
    private camera: THREE.Camera,
    private source: () => THREE.WebGLRenderTarget,
  ) {
    super();
    this.needsSwap = true;
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    this.hasPrev = false;
  }

  setSize(width: number, height: number): void {
    this.mat.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, _readBuffer: THREE.WebGLRenderTarget, deltaTime: number): void {
    const u = this.mat.uniforms;
    const cam = this.camera;
    const src = this.source();
    const depthOk = this.strength > 0.01 && setDepthUniforms(u as unknown as ReturnType<typeof depthUniforms>, renderer, src, cam);
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    // View-Space dieses Frames → Clip-Space des letzten Frames
    u.uReproj.value.multiplyMatrices(this.prevViewProj, cam.matrixWorld);
    // Länge der Schliere unabhängig von der Bildrate (Verschlusszeit in Sekunden bleibt gleich)
    const dt = Math.max(deltaTime, 1 / 240);
    u.uScale.value = depthOk && this.hasPrev ? this.strength * THREE.MathUtils.clamp(1 / 60 / dt, 0.25, 1.5) : 0;
    u.tDiffuse.value = src.texture;
    this.prevViewProj.copy(this.viewProj);
    this.hasPrev = true;

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
    u.tDepth.value = null;
  }

  dispose(): void {
    this.mat.dispose();
    this.quad.dispose();
  }
}
