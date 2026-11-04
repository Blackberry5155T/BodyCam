import * as THREE from 'three';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { VOLUME_LAYER, volumeFX } from '../world/volumetrics';

/**
 * Zeichnet alle Volumen-Objekte (Nebel, Lichtkegel, Staub, Feuer, Rauch, Funken) direkt nach der
 * opaken Szene in denselben Puffer. Die Szenentiefe wird aus der aufgelösten Tiefentextur des
 * (MSAA-)Render-Targets gelesen, während in den Multisample-Puffer gezeichnet wird – daher keine
 * Feedback-Schleife. Ohne MSAA wird ohne Tiefe gerendert (Fallback).
 */
export class VolumePass extends Pass {
  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    super();
    this.needsSwap = false;
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const scene = this.scene;
    const camera = this.camera;
    if (scene.overrideMaterial) return;
    const u = volumeFX.uniforms;
    const msrtt = renderer.extensions.has('WEBGL_multisampled_render_to_texture');
    const depthOk = !!readBuffer.depthTexture && readBuffer.samples > 0 && !msrtt;
    u.vDepth.value = depthOk ? readBuffer.depthTexture : null;
    u.vDepthOn.value = depthOk ? 1 : 0;
    u.vScreen.value.set(readBuffer.width, readBuffer.height);
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      u.vNear.value = cam.near;
      u.vFar.value = cam.far;
    }

    const mask = camera.layers.mask;
    const background = scene.background;
    const autoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    camera.layers.set(VOLUME_LAYER);
    scene.background = null;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;

    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.render(scene, camera);

    camera.layers.mask = mask;
    scene.background = background;
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadowAuto;
  }
}
