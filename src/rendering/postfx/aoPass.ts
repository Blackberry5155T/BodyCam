import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { DEPTH_GLSL, FULLSCREEN_VERTEX, depthUniforms, setDepthUniforms } from './depth.ts';

/**
 * Umgebungsverdeckung (Screen-Space Ambient Occlusion) nur aus der Szenentiefe:
 *  1. AO in halber Auflösung: Normale aus Tiefen-Nachbarn, Proben auf einer Spirale im Umkreis von
 *     „radius“ Metern; verdeckt, was über der Tangentialebene liegt (kosinusgewichtet, mit Reichweiten-Abfall).
 *  2. Tiefenbewusster Weichzeichner (horizontal + vertikal) – glättet das Rauschen, ohne über Kanten zu laufen.
 *  3. Multiplikativ auf den HDR-Puffer, direkt nach der opaken Szene (vor Wasser, Nebel, Rauch und Bloom –
 *     die liegen dann unverdunkelt darüber).
 * Ergebnis: Kontaktschatten in Ecken, unter Kisten, zwischen Gras und an Wandfugen – Objekte „stehen“ im Raum.
 * Braucht die aufgelöste Tiefentextur des MSAA-Targets; ohne sie bleibt der Pass aus.
 */

const MAX_SAMPLES = 16;

const aoShader = {
  uniforms: {
    ...depthUniforms(),
    uTexel: { value: new THREE.Vector2() },
    uProj: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: 0.6 },
    uIntensity: { value: 4.6 },
    uFade: { value: 60 },
    uSamples: { value: 10 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    ${DEPTH_GLSL}
    uniform vec2 uTexel;
    uniform vec2 uProj;
    uniform float uRadius;
    uniform float uIntensity;
    uniform float uFade;
    uniform int uSamples;
    varying vec2 vUv;

    void main() {
      vec3 p = viewPos(vUv);
      float z = -p.z;
      if (z > uFade) { gl_FragColor = vec4(1.0); return; }

      // Normale aus den Nachbarn: je Achse die Seite mit dem kleineren Tiefensprung (bleibt an Kanten sauber)
      vec2 dx = vec2(uTexel.x, 0.0);
      vec2 dy = vec2(0.0, uTexel.y);
      vec3 pr = viewPos(vUv + dx), pl = viewPos(vUv - dx);
      vec3 pu = viewPos(vUv + dy), pd = viewPos(vUv - dy);
      vec3 ddx = abs(pr.z - p.z) < abs(p.z - pl.z) ? pr - p : p - pl;
      vec3 ddy = abs(pu.z - p.z) < abs(p.z - pd.z) ? pu - p : p - pd;
      vec3 n = normalize(cross(ddx, ddy));

      // Radius auf dem Bildschirm (uv); sehr nah an der Kamera begrenzt, in der Ferne zu klein → keine AO
      float rUv = min(uRadius * uProj.y * 0.5 / z, 0.1);
      if (rUv < uTexel.y * 1.5) { gl_FragColor = vec4(1.0); return; }
      vec2 rr = vec2(rUv * uProj.x / uProj.y, rUv);
      float rWorld = rUv * z * 2.0 / uProj.y;
      float inv2 = 1.0 / (rWorld * rWorld);
      float bias = 0.02 + 0.006 * z;

      float ang = ign(gl_FragCoord.xy) * 6.2831853;
      float n01 = ign(gl_FragCoord.yx + 17.0);
      float occ = 0.0;
      for (int i = 0; i < ${MAX_SAMPLES}; i++) {
        if (i >= uSamples) break;
        float t = (float(i) + n01) / float(uSamples);
        float a = ang + float(i) * 2.3999632;
        vec2 o = vec2(cos(a), sin(a)) * sqrt(t) * rr;
        vec3 v = viewPos(vUv + o) - p;
        float d2 = dot(v, v);
        float fall = max(0.0, 1.0 - d2 * inv2);
        occ += max(dot(n, v) - bias, 0.0) / (sqrt(d2) + 1e-4) * fall;
      }
      float ao = 1.0 - clamp(occ / float(uSamples) * uIntensity, 0.0, 1.0);
      ao = mix(ao, 1.0, smoothstep(uFade * 0.6, uFade, z));
      gl_FragColor = vec4(ao, ao, ao, 1.0);
    }
  `,
};

const blurShader = {
  uniforms: {
    ...depthUniforms(),
    tAO: { value: null as THREE.Texture | null },
    uDir: { value: new THREE.Vector2() },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    ${DEPTH_GLSL}
    uniform sampler2D tAO;
    uniform vec2 uDir;
    varying vec2 vUv;
    void main() {
      float z0 = viewZ(vUv);
      float sum = textureLod(tAO, vUv, 0.0).r;
      float wsum = 1.0;
      if (z0 < 1e5) {
        float tol = 1.0 / (0.04 * z0 + 0.03);
        for (int i = 1; i <= 3; i++) {
          vec2 o = uDir * float(i);
          float wg = 1.0 - float(i) * 0.22;
          float wa = wg * max(0.0, 1.0 - abs(viewZ(vUv + o) - z0) * tol);
          float wb = wg * max(0.0, 1.0 - abs(viewZ(vUv - o) - z0) * tol);
          sum += textureLod(tAO, vUv + o, 0.0).r * wa + textureLod(tAO, vUv - o, 0.0).r * wb;
          wsum += wa + wb;
        }
      }
      float ao = sum / wsum;
      gl_FragColor = vec4(ao, ao, ao, 1.0);
    }
  `,
};

const compositeShader = {
  uniforms: {
    tAO: { value: null as THREE.Texture | null },
    uStrength: { value: 1 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tAO;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      float ao = mix(1.0, texture2D(tAO, vUv).r, uStrength);
      gl_FragColor = vec4(ao, ao, ao, 1.0);
    }
  `,
};

export class AOPass extends Pass {
  /** Stärke 0..1 (Anteil der Verdunklung) */
  strength = 0.85;
  /** Reichweite der Verdeckung in Metern */
  radius = 0.7;
  /** AO verschwindet bis zu dieser Entfernung (m) – dahinter liegt ohnehin Nebel */
  fadeDistance = 60;

  private aoRT: THREE.WebGLRenderTarget;
  private blurRT: THREE.WebGLRenderTarget;
  private aoMat = new THREE.ShaderMaterial({ ...aoShader, uniforms: THREE.UniformsUtils.clone(aoShader.uniforms), depthTest: false, depthWrite: false });
  private blurMat = new THREE.ShaderMaterial({ ...blurShader, uniforms: THREE.UniformsUtils.clone(blurShader.uniforms), depthTest: false, depthWrite: false });
  private compMat = new THREE.ShaderMaterial({
    ...compositeShader,
    uniforms: THREE.UniformsUtils.clone(compositeShader.uniforms),
    depthTest: false,
    depthWrite: false,
    transparent: true,
    // Ziel × Quelle: verdunkelt, Alpha bleibt
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  private quad = new FullScreenQuad();

  constructor(private camera: THREE.Camera) {
    super();
    this.needsSwap = false;
    const opts = { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.blurRT = new THREE.WebGLRenderTarget(1, 1, opts);
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  /** 1 = sparsam (8 Proben), 2 = hoch (14 Proben) */
  setQuality(q: number): void {
    this.aoMat.uniforms.uSamples.value = q >= 2 ? 14 : 8;
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.aoRT.setSize(w, h);
    this.blurRT.setSize(w, h);
    this.aoMat.uniforms.uTexel.value.set(1 / width, 1 / height);
    this.blurMat.uniforms.uDir.value.set(1 / w, 1 / h);
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const au = this.aoMat.uniforms;
    if (this.strength <= 0 || !setDepthUniforms(au as unknown as ReturnType<typeof depthUniforms>, renderer, readBuffer, this.camera)) return;
    const bu = this.blurMat.uniforms;
    setDepthUniforms(bu as unknown as ReturnType<typeof depthUniforms>, renderer, readBuffer, this.camera);
    const e = (this.camera as THREE.PerspectiveCamera).projectionMatrix.elements;
    au.uProj.value.set(e[0], e[5]);
    au.uRadius.value = this.radius;
    au.uFade.value = this.fadeDistance;

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;

    // 1. AO (halbe Auflösung)
    this.quad.material = this.aoMat;
    renderer.setRenderTarget(this.aoRT);
    this.quad.render(renderer);

    // 2. Weichzeichner: horizontal → blurRT, vertikal → aoRT
    const texel = bu.uDir.value as THREE.Vector2;
    const tx = 1 / this.aoRT.width;
    const ty = 1 / this.aoRT.height;
    this.quad.material = this.blurMat;
    bu.tAO.value = this.aoRT.texture;
    texel.set(tx, 0);
    renderer.setRenderTarget(this.blurRT);
    this.quad.render(renderer);
    bu.tAO.value = this.blurRT.texture;
    texel.set(0, ty);
    renderer.setRenderTarget(this.aoRT);
    this.quad.render(renderer);

    // 3. auf die Szene multiplizieren
    const cu = this.compMat.uniforms;
    cu.tAO.value = this.aoRT.texture;
    cu.uStrength.value = Math.min(1, this.strength);
    this.quad.material = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(renderer);

    renderer.autoClear = autoClear;
    au.tDepth.value = null;
    bu.tDepth.value = null;
  }

  dispose(): void {
    this.aoRT.dispose();
    this.blurRT.dispose();
    this.aoMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}
