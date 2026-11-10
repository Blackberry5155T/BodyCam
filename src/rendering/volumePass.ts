import * as THREE from 'three';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { VOLUME_HALF_LAYER, VOLUME_LAYER, anyVolumeVisible, volumeFX } from '../world/volumetrics';
import { DEPTH_GLSL, FULLSCREEN_VERTEX, depthUniforms, setDepthUniforms } from './postfx/depth.ts';

/**
 * Zeichnet alle Volumen-Objekte nach der opaken Szene in denselben Puffer. Die Szenentiefe wird aus der
 * aufgelösten Tiefentextur des (MSAA-)Render-Targets gelesen, während in den Multisample-Puffer gezeichnet
 * wird – daher keine Feedback-Schleife. Ohne MSAA wird ohne Tiefe gerendert (Fallback).
 *
 * Zwei Stufen:
 *  1. Raymarching-Volumen (Nebelvolumen, Lichtkegel – weich, aber teuer je Pixel) in HALBER Auflösung in ein
 *     eigenes Target; nur ein Viertel der Pixel wird durchmarschiert.
 *  2. Partikel (Staub, Rauch, Feuer, Funken – fein, billig) in voller Auflösung. Im selben Durchlauf legt ein
 *     bildschirmfüllendes Dreieck das Ergebnis aus 1. darunter: tiefenbewusst hochskaliert, damit Nebel an
 *     Kanten von Wänden und Objekten nicht ausfranst oder überläuft.
 * Hängt kein Volumen sichtbar in der Szene, entfällt der Pass komplett (auch die MSAA-Auflösung).
 */

const upsampleShader = {
  uniforms: {
    ...depthUniforms(),
    tVol: { value: null as THREE.Texture | null },
    uHalfSize: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    ${DEPTH_GLSL}
    uniform sampler2D tVol;
    uniform vec2 uHalfSize;
    varying vec2 vUv;
    void main() {
      float z0 = min(viewZ(vUv), 1e5);
      vec2 p = vUv * uHalfSize - 0.5;
      vec2 f = fract(p);
      vec2 t = 1.0 / uHalfSize;
      vec2 b = (floor(p) + 0.5) * t;
      float tol = 1.0 / max(z0 * 0.04, 0.03);
      vec4 acc = vec4(0.0);
      float wsum = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2(float(i & 1), float(i >> 1));
        vec2 uv = b + o * t;
        // bilineares Gewicht × Ähnlichkeit der Tiefe, mit der dieses Halb-Pixel gerechnet wurde
        float wb = mix(1.0 - f.x, f.x, o.x) * mix(1.0 - f.y, f.y, o.y);
        float dz = abs(min(viewZ(uv), 1e5) - z0) * tol;
        float w = (wb + 0.02) / (1.0 + dz * dz);
        acc += textureLod(tVol, uv, 0.0) * w;
        wsum += w;
      }
      gl_FragColor = acc / max(wsum, 1e-6);
    }
  `,
};

const _clear = new THREE.Color();

export class VolumePass extends Pass {
  private volRT = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  private upMat = new THREE.ShaderMaterial({
    ...upsampleShader,
    uniforms: THREE.UniformsUtils.clone(upsampleShader.uniforms),
    depthTest: false,
    depthWrite: false,
    transparent: true,
    // vormultipliziert über die Szene; Alpha des Ziels bleibt
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  /** bildschirmfüllendes Dreieck auf VOLUME_LAYER: wird mit den Partikeln gezeichnet (vor ihnen) */
  private upMesh: THREE.Mesh;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    super();
    this.needsSwap = false;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.upMesh = new THREE.Mesh(geo, this.upMat);
    this.upMesh.name = 'VolumeUpsample';
    this.upMesh.frustumCulled = false;
    this.upMesh.renderOrder = 9; // vor Staub (12), Rauch (14), Feuer/Funken (15)
    this.upMesh.layers.set(VOLUME_LAYER);
    this.upMesh.visible = false;
    this.upMesh.raycast = () => {};
    this.upMesh.userData.noPick = true;
    this.upMesh.userData.noShot = true;
    this.upMesh.userData.noWeather = true;
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const scene = this.scene;
    const camera = this.camera;
    if (scene.overrideMaterial) return;
    // nichts zu zeichnen → kein Szenen-Durchlauf und keine weitere Auflösung des MSAA-Puffers
    const marched = anyVolumeVisible(scene, true);
    const particles = anyVolumeVisible(scene, false);
    if (!marched && !particles) return;

    const u = volumeFX.uniforms;
    const msrtt = renderer.extensions.has('WEBGL_multisampled_render_to_texture');
    const depthOk = !!readBuffer.depthTexture && readBuffer.samples > 0 && !msrtt;
    u.vDepth.value = depthOk ? readBuffer.depthTexture : null;
    u.vDepthOn.value = depthOk ? 1 : 0;
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      u.vNear.value = cam.near;
      u.vFar.value = cam.far;
    }

    const mask = camera.layers.mask;
    const background = scene.background;
    const autoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;

    // 1. Raymarching-Volumen in halber Auflösung
    const uu = this.upMat.uniforms;
    const half = marched && depthOk && setDepthUniforms(uu as unknown as ReturnType<typeof depthUniforms>, renderer, readBuffer, camera);
    if (half) {
      const w = Math.max(1, Math.floor(readBuffer.width / 2));
      const h = Math.max(1, Math.floor(readBuffer.height / 2));
      if (this.volRT.width !== w || this.volRT.height !== h) this.volRT.setSize(w, h);
      u.vScreen.value.set(w, h);
      camera.layers.set(VOLUME_HALF_LAYER);
      const alpha = renderer.getClearAlpha();
      renderer.getClearColor(_clear);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.setRenderTarget(this.volRT);
      renderer.render(scene, camera);
      renderer.setClearColor(_clear, alpha);
      uu.tVol.value = this.volRT.texture;
      uu.uHalfSize.value.set(w, h);
      if (this.upMesh.parent !== scene) scene.add(this.upMesh);
    }
    this.upMesh.visible = !!half;

    // 2. Partikel in voller Auflösung (+ hochskalierte Volumen darunter); ohne Tiefe: alles direkt
    u.vScreen.value.set(readBuffer.width, readBuffer.height);
    camera.layers.set(VOLUME_LAYER);
    if (marched && !half) camera.layers.enable(VOLUME_HALF_LAYER);
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.render(scene, camera);

    this.upMesh.visible = false;
    uu.tDepth.value = null;
    camera.layers.mask = mask;
    scene.background = background;
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadowAuto;
  }

  dispose(): void {
    this.upMesh.removeFromParent();
    this.upMesh.geometry.dispose();
    this.upMat.dispose();
    this.volRT.dispose();
  }
}
