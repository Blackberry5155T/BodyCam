import * as THREE from 'three';

// Bodycam-Linsen-/Sensor-Look als finaler Post-Pass (läuft nach Tonemapping, also im sRGB-Raum):
// Fischaugen-Verzerrung, chromatische Aberration, Entsättigung, Vignette, Sensorrauschen,
// feine Zeilenstruktur und Signal-Glitch bei Schüssen/Treffern.
export const BodycamShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDistortion: { value: 0.24 },
    uAberration: { value: 0.007 },
    uGrain: { value: 0.075 },
    uVignette: { value: 0.8 },
    uGlitch: { value: 0 },
    uExposure: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uDistortion;
    uniform float uAberration;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uGlitch;
    uniform float uExposure;
    varying vec2 vUv;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Tonnenverzerrung, normiert so dass die horizontalen Ränder exakt passen;
    // die Ecken fallen dadurch leicht ins Schwarze (runde Linsenkante)
    vec2 lens(vec2 uv, float k) {
      float aspect = uResolution.x / uResolution.y;
      vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
      float r2 = dot(c, c);
      float edge = 0.25 * aspect * aspect;
      c *= (1.0 + k * r2) / (1.0 + k * edge);
      return c / vec2(aspect, 1.0) + 0.5;
    }

    void main() {
      vec2 uv = vUv;

      // Signal-Glitch: einzelne Zeilenblöcke horizontal versetzt
      if (uGlitch > 0.001) {
        float row = floor(uv.y * 56.0);
        float n = hash(vec2(row, floor(uTime * 45.0)));
        uv.x += (n - 0.5) * 0.05 * uGlitch * step(0.78, n);
      }

      vec2 base = lens(uv, uDistortion);
      vec2 d = base - 0.5;
      float ab = uAberration * (1.0 + uGlitch * 4.0);
      vec3 col;
      col.r = texture2D(tDiffuse, 0.5 + d * (1.0 + ab)).r;
      col.g = texture2D(tDiffuse, base).g;
      col.b = texture2D(tDiffuse, 0.5 + d * (1.0 - ab)).b;

      vec2 edgeDist = min(base, 1.0 - base);
      float mask = smoothstep(0.0, 0.006, min(edgeDist.x, edgeDist.y));

      col *= uExposure;

      // Farbgebung: entsättigt, leicht kühl-grünlich, angehobene Schwärzen (billiger Sensor)
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(lum), col, 0.75);
      col = (col - 0.5) * 1.07 + 0.5;
      col *= vec3(0.96, 1.02, 1.0);
      col = max(col, 0.0) * 0.97 + 0.018;

      // Vignette
      float aspect = uResolution.x / uResolution.y;
      vec2 vc = (vUv - 0.5) * vec2(aspect, 1.0);
      float vig = smoothstep(1.1, 0.3, length(vc));
      col *= mix(1.0, vig, uVignette);

      // Sensorrauschen, stärker in dunklen Bereichen
      float g = hash(vUv * uResolution + fract(uTime * 7.13) * 1000.0) - 0.5;
      float gc = hash(vUv * uResolution * 0.5 + fract(uTime * 3.7) * 500.0) - 0.5;
      col += (g + vec3(gc, -gc, gc) * 0.3) * uGrain * (1.25 - lum) * (1.0 + uGlitch);

      // Feine Zeilenstruktur
      col *= 0.988 + 0.012 * sin(vUv.y * uResolution.y * 0.8 + uTime * 4.0);

      gl_FragColor = vec4(col * mask, 1.0);
    }
  `,
};
