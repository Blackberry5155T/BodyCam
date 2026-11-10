import * as THREE from 'three';

// Gemeinsame Bausteine für Post-Passes, die die Szenentiefe lesen (AO, Bewegungsunschärfe).
// Die Tiefe kommt aus der aufgelösten Tiefentextur des MSAA-Targets (wie bei VolumePass/GodRaysPass).

export const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Uniforms: tDepth, uNear, uFar, uReversed, uInvProj (1/P00, 1/P11).
 *  viewZ(uv): lineare Tiefe entlang der Blickachse (m, 1e6 = Himmel); viewPos(uv): Position im View-Space. */
export const DEPTH_GLSL = /* glsl */ `
  uniform sampler2D tDepth;
  uniform float uNear;
  uniform float uFar;
  uniform float uReversed;
  uniform vec2 uInvProj;

  float viewZ(vec2 uv) {
    // textureLod: wird auch in Schleifen mit variabler Länge abgetastet (keine Ableitungen nötig)
    float d = textureLod(tDepth, uv, 0.0).x;
    if (uReversed > 0.5) {
      // Reversed-Z: Near = 1, Far/Himmel = 0
      if (d <= 1e-7) return 1e6;
      return uNear * uFar / (uNear + d * (uFar - uNear));
    }
    if (d >= 0.9999999) return 1e6;
    return uNear * uFar / (uFar - d * (uFar - uNear));
  }
  vec3 viewPos(vec2 uv) {
    float z = viewZ(uv);
    return vec3((uv * 2.0 - 1.0) * uInvProj * z, -z);
  }
  /** Interleaved Gradient Noise (Jimenez): gleichmäßiges Rauschen je Pixel */
  float ign(vec2 px) {
    return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
  }
`;

export function depthUniforms() {
  return {
    tDepth: { value: null as THREE.Texture | null },
    uNear: { value: 0.05 },
    uFar: { value: 2000 },
    uReversed: { value: 1 },
    uInvProj: { value: new THREE.Vector2(1, 1) },
  };
}

/** Tiefen-Uniforms aus Kamera und Target setzen; false, wenn keine lesbare Tiefe vorhanden ist */
export function setDepthUniforms(
  u: ReturnType<typeof depthUniforms>,
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  camera: THREE.Camera,
): boolean {
  const cam = camera as THREE.PerspectiveCamera;
  const msrtt = renderer.extensions.has('WEBGL_multisampled_render_to_texture');
  if (!target.depthTexture || target.samples <= 0 || msrtt || !cam.isPerspectiveCamera) return false;
  u.tDepth.value = target.depthTexture;
  u.uNear.value = cam.near;
  u.uFar.value = cam.far;
  u.uReversed.value = cam.reversedDepth ? 1 : 0;
  const e = cam.projectionMatrix.elements;
  u.uInvProj.value.set(1 / e[0], 1 / e[5]);
  return true;
}
