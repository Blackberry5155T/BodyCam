import * as THREE from 'three';
import { BLOCK, type ChangeKind, type LandscapeData, type Rect } from './data.ts';
import { MAX_LAYERS } from './layers.ts';
import { loadTextureSet, onTexturesInvalidated, type TexSetData } from './textures.ts';
import { surfaceDef, type SurfaceId } from '../surfaces.ts';

// CDLOD-Rendering (Continuous Distance-Dependent Level of Detail, Strugar 2009):
// Ein einziges 32×32-Gitter wird pro Quadtree-Knoten instanziert; der Vertex-Shader liest die Höhe aus einer
// Float-Textur und blendet Vertices zur Grenze der nächsten LOD-Stufe hin stufenlos auf das gröbere Raster
// (keine Risse, kein Ploppen). Normalen kommen aus einer eigenen Textur (pro Pixel), Löcher werden verworfen.

/** Quads pro Gitterkante eines Knotens (= BLOCK, damit Min/Max-Blöcke genau passen) */
const G = BLOCK;
const MAX_LEVELS = 16;

/** Texturgröße und Anzahl gleichzeitig gemischter Layer je Pixel, gekoppelt an "Terrain-Detail" */
function quality(detail: number): { size: number; k: number } {
  if (detail < 1.75) return { size: 512, k: 2 };
  if (detail < 2.25) return { size: 1024, k: 2 };
  return { size: 1024, k: 3 };
}

function makeArray(size: number, ch: number, fill: number[], srgb: boolean): THREE.DataArrayTexture {
  const n = size * size * MAX_LAYERS;
  const data = new Uint8Array(n * ch);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) data[i * ch + c] = fill[c];
  const t = new THREE.DataArrayTexture(data, size, size, MAX_LAYERS);
  t.format = ch === 2 ? THREE.RGFormat : THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** Editor-Overlays, im Terrain-Shader gezeichnet (folgen exakt der Oberfläche) */
export interface LandscapeOverlay {
  /** Pinsel: Mitte (lokal, m), Radius (m), Anteil des Abfalls (0..1) */
  brush: { x: number; z: number; radius: number; falloff: number; color: THREE.Color } | null;
  /** Rechteck (lokal, m): Region-Auswahl */
  region: { x0: number; z0: number; x1: number; z1: number } | null;
  /** Rampe: Linie a→b mit Breite */
  ramp: { ax: number; az: number; bx: number; bz: number; width: number } | null;
  /** Komponenten-Raster anzeigen */
  grid: boolean;
  /** Loch-Zellen unter dem Pinsel schraffiert zeigen (Füllen) */
  holeGhost?: boolean;
}

let sharedGrid: THREE.BufferGeometry | null = null;

function gridGeometry(): THREE.BufferGeometry {
  if (sharedGrid) return sharedGrid;
  const pos = new Float32Array((G + 1) * (G + 1) * 3);
  let k = 0;
  for (let z = 0; z <= G; z++) {
    for (let x = 0; x <= G; x++) {
      pos[k++] = x;
      pos[k++] = 0;
      pos[k++] = z;
    }
  }
  const idx = new Uint16Array(G * G * 6);
  k = 0;
  for (let z = 0; z < G; z++) {
    for (let x = 0; x < G; x++) {
      const a = z * (G + 1) + x;
      const b = a + 1;
      const c = a + (G + 1);
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = d;
      idx[k++] = a;
      idx[k++] = d;
      idx[k++] = b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  sharedGrid = g;
  return g;
}

const COMMON_VERT = /* glsl */ `
uniform sampler2D uHeight;
uniform vec2 uGridSize;
uniform float uQuad;
uniform vec3 uCamLocal;
uniform float uMorphStart[${MAX_LEVELS}];
uniform float uMorphEnd[${MAX_LEVELS}];
attribute vec4 aNode;
varying vec2 vGrid;

float lsHeight(vec2 g) {
  g = clamp(g, vec2(0.0), uGridSize);
  vec2 i = min(floor(g), uGridSize - 1.0);
  vec2 f = g - i;
  ivec2 p = ivec2(i);
  float h00 = texelFetch(uHeight, p, 0).r;
  float h10 = texelFetch(uHeight, p + ivec2(1, 0), 0).r;
  float h01 = texelFetch(uHeight, p + ivec2(0, 1), 0).r;
  float h11 = texelFetch(uHeight, p + ivec2(1, 1), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
vec2 lsLocal(vec2 g) { return (g - uGridSize * 0.5) * uQuad; }
`;

const MORPH_VERT = /* glsl */ `
  float lsStep = aNode.z;
  vec2 lsG = aNode.xy + position.xz * lsStep;
  vec2 lsP = lsLocal(clamp(lsG, vec2(0.0), uGridSize));
  float lsH = lsHeight(lsG);
  float lsDist = distance(vec3(lsP.x, lsH, lsP.y), uCamLocal);
  int lsLevel = int(aNode.w + 0.5);
  float lsK = clamp((lsDist - uMorphStart[lsLevel]) / max(uMorphEnd[lsLevel] - uMorphStart[lsLevel], 1e-3), 0.0, 1.0);
  lsG -= fract(position.xz * 0.5) * 2.0 * lsStep * lsK;
  lsG = clamp(lsG, vec2(0.0), uGridSize);
  vGrid = lsG;
  vec2 lsXZ = lsLocal(lsG);
  vec3 transformed = vec3(lsXZ.x, lsHeight(lsG), lsXZ.y);
`;

const COMMON_FRAG = /* glsl */ `
uniform sampler2D uNormal;
uniform sampler2D uHoles;
uniform vec2 uGridSize;
uniform float uHoleSub;
uniform float uQuad;
varying vec2 vGrid;

vec3 lsNormal() {
  vec2 e = texture2D(uNormal, (vGrid + 0.5) / (uGridSize + 1.0)).rg * 2.0 - 1.0;
  return normalize(vec3(e.x, sqrt(max(0.0, 1.0 - dot(e, e))), e.y));
}
void lsClip() {
  // Loch-Zellen: uHoleSub × uHoleSub je Quad
  ivec2 q = ivec2(clamp(floor(vGrid * uHoleSub), vec2(0.0), uGridSize * uHoleSub - 1.0));
  if (texelFetch(uHoles, q, 0).r > 0.001) discard;
}
`;

// Landscape-Material: bis zu 8 Layer, Gewichte = gemalte Splatmap + Auto-Regeln (Neigung, Höhe, Krümmung, Rauschen).
// Je Pixel werden nur die LS_K stärksten Layer abgetastet und über ihre Texturhöhe gemischt (Höhen-Blending).
// Draufsicht: Hex-Tiling (Mikkelsen 2022) gegen sichtbare Kachelung, in der Ferne ein zweiter, gröberer Abgriff;
// steile Flächen: Triplanar-Projektion mit Whiteout-Normalen (Golus). Gleiche Auto-Formeln wie layers.ts.
const LAYER_FRAG = /* glsl */ `
uniform sampler2D uHeight;
uniform sampler2D uSplat;
uniform vec4 uSplatInfo; // SW, SH, div, an
uniform sampler2DArray uAlb;
uniform sampler2DArray uNrm;
uniform sampler2DArray uArm;
uniform vec4 uLay[8];     // 1/Kachel, Ebene, Rauheit, Normalenstärke
uniform vec4 uLayTint[8]; // Farbton (linear), Splat-Kanal
uniform vec4 uAutoA[8];   // Neigung min/max, Höhe min/max
uniform vec4 uAutoB[8];   // an, Krümmung, weich, Rauschen
uniform vec4 uLaySurf[8]; // Porosität, Pfützen-Neigung
uniform int uLayerN;
uniform float uCurvStep;

float lsRough = 0.9;
float lsAO = 1.0;
vec3 lsDN = vec3(0.0, 1.0, 0.0);
float lsPor = 1.0;
float lsPudBias = 0.0;
float lsWt[8];

float lsHeightF(vec2 g) {
  g = clamp(g, vec2(0.0), uGridSize);
  vec2 i = min(floor(g), uGridSize - 1.0);
  vec2 f = g - i;
  ivec2 p = ivec2(i);
  float h00 = texelFetch(uHeight, p, 0).r;
  float h10 = texelFetch(uHeight, p + ivec2(1, 0), 0).r;
  float h01 = texelFetch(uHeight, p + ivec2(0, 1), 0).r;
  float h11 = texelFetch(uHeight, p + ivec2(1, 1), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

float lsHashU(ivec2 p) {
  uint h = uint(p.x) * 1597334677u ^ uint(p.y) * 3812015801u;
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return float(h) / 4294967296.0;
}
float lsVNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  ivec2 q = ivec2(i);
  return mix(mix(lsHashU(q), lsHashU(q + ivec2(1, 0)), f.x), mix(lsHashU(q + ivec2(0, 1)), lsHashU(q + ivec2(1, 1)), f.x), f.y);
}
float lsAutoNoise(vec2 p) {
  return lsVNoise(p / 7.0) * 0.65 + lsVNoise(p / 2.3 + vec2(17.0, 5.0)) * 0.35;
}

float lsAuto(int i, float slope, float hgt, float curv, float nz) {
  vec4 A = uAutoA[i];
  vec4 B = uAutoB[i];
  if (B.x < 0.5) return 0.0;
  float n = (nz - 0.5) * B.w;
  float s = slope + n * 30.0;
  float h = hgt + n * 25.0;
  float ss = 1.0 + B.z * 14.0;
  float hs = 0.5 + B.z * 20.0;
  float c = 1.0;
  if (A.x > 0.5) c *= smoothstep(A.x - ss, A.x + ss, s);
  if (A.y < 89.5) c *= 1.0 - smoothstep(A.y - ss, A.y + ss, s);
  if (A.z > -9999.0) c *= smoothstep(A.z - hs, A.z + hs, h);
  if (A.w < 9999.0) c *= 1.0 - smoothstep(A.w - hs, A.w + hs, h);
  if (B.y != 0.0) {
    float k = clamp(curv * 6.0, -1.0, 1.0) * sign(B.y) + n * 0.6;
    c *= 1.0 + (smoothstep(-0.15, 0.35, k) - 1.0) * abs(B.y);
  }
  return c;
}

mat2 lsRot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

vec3 lsTN(vec2 rg, float str) {
  vec3 t = vec3(rg * 2.0 - 1.0, 0.0);
  t.z = sqrt(max(0.0, 1.0 - dot(t.xy, t.xy)));
  t.xy *= str;
  return normalize(t);
}

// ein Abgriff (gedreht um R); Normale zurück in die Projektionsebene gedreht
void lsTap(float sl, vec2 st, vec2 gx, vec2 gy, mat2 R, float str, out vec3 alb, out vec3 arm, out vec3 tn) {
  vec3 c = vec3(R * st, sl);
  vec2 dx = R * gx;
  vec2 dy = R * gy;
  alb = textureGrad(uAlb, c, dx, dy).rgb;
  arm = textureGrad(uArm, c, dx, dy).rgb;
  tn = lsTN(textureGrad(uNrm, c, dx, dy).rg, str);
  tn.xy = transpose(R) * tn.xy;
}

// Hex-Tiling: drei zufällig gedrehte/verschobene Kacheln je Dreieck, gewichtet nach Nähe und Texturhöhe
void lsHex(float sl, vec2 st, vec2 gx, vec2 gy, float str, out vec3 alb, out vec3 arm, out vec3 tn) {
  vec2 hs = st * 1.6;
  vec2 sk = vec2(hs.x, -0.57735027 * hs.x + 1.15470054 * hs.y);
  vec2 bf = floor(sk);
  ivec2 base = ivec2(bf);
  vec3 t = vec3(sk - bf, 0.0);
  t.z = 1.0 - t.x - t.y;
  float s = step(0.0, -t.z);
  float s2 = 2.0 * s - 1.0;
  vec3 w = max(vec3(-t.z * s2, s - t.y * s2, s - t.x * s2), 0.0);
  int si = int(s);
  ivec2 v[3];
  v[0] = base + ivec2(si, si);
  v[1] = base + ivec2(si, 1 - si);
  v[2] = base + ivec2(1 - si, si);
  alb = vec3(0.0);
  arm = vec3(0.0);
  tn = vec3(0.0);
  float ws = 0.0;
  for (int j = 0; j < 3; j++) {
    mat2 R = lsRot(lsHashU(v[j]) * 6.2831853);
    vec2 off = vec2(lsHashU(v[j] + ivec2(113, 47)), lsHashU(v[j] + ivec2(29, 211)));
    vec3 a, m, n;
    lsTap(sl, st + transpose(R) * off, gx, gy, R, str, a, m, n);
    float W = pow(w[j], 7.0) * (0.15 + m.b);
    alb += a * W;
    arm += m * W;
    tn += n * W;
    ws += W;
  }
  ws = max(ws, 1e-6);
  alb /= ws;
  arm /= ws;
  tn = normalize(tn);
}

// Draufsicht: nah Hex-Tiling, fern zwei Abgriffe in verschiedenen Maßstäben (bricht große Wiederholungen)
void lsTop(float sl, vec2 st, vec2 gx, vec2 gy, float str, float farK, out vec3 alb, out vec3 arm, out vec3 tn) {
  alb = vec3(0.0);
  arm = vec3(0.0);
  tn = vec3(0.0, 0.0, 1.0);
  if (farK < 0.999) lsHex(sl, st, gx, gy, str, alb, arm, tn);
  if (farK > 0.001) {
    vec3 a1, m1, n1, a2, m2, n2;
    lsTap(sl, st, gx, gy, mat2(0.8, 0.6, -0.6, 0.8), str, a1, m1, n1);
    lsTap(sl, st * 0.23, gx * 0.23, gy * 0.23, mat2(-0.28, 0.96, -0.96, -0.28), str, a2, m2, n2);
    alb = mix(alb, (a1 + a2) * 0.5, farK);
    arm = mix(arm, (m1 + m2) * 0.5, farK);
    tn = normalize(mix(tn, normalize(n1 + n2), farK));
  }
}

// ein Layer, alle Projektionen; Ergebnis: Albedo, ARM, Weltnormale
void lsLayer(int i, vec3 p, vec3 dpx, vec3 dpy, vec3 bw, vec3 gN, float farK, out vec3 alb, out vec3 arm, out vec3 nW) {
  vec4 L = uLay[i];
  float sl = L.y;
  float it = L.x;
  float str = L.w;
  vec3 aX = vec3(0.0), mX = vec3(0.0), nX = vec3(0.0, 0.0, 1.0);
  vec3 aY = vec3(0.0), mY = vec3(0.0), nY = vec3(0.0, 0.0, 1.0);
  vec3 aZ = vec3(0.0), mZ = vec3(0.0), nZ = vec3(0.0, 0.0, 1.0);
  mat2 I = mat2(1.0);
  if (bw.y > 0.0) lsTop(sl, p.xz * it, dpx.xz * it, dpy.xz * it, str, farK, aY, mY, nY);
  if (bw.x > 0.0) lsTap(sl, p.zy * it, dpx.zy * it, dpy.zy * it, I, str, aX, mX, nX);
  if (bw.z > 0.0) lsTap(sl, p.xy * it, dpx.xy * it, dpy.xy * it, I, str, aZ, mZ, nZ);
  alb = aX * bw.x + aY * bw.y + aZ * bw.z;
  arm = mX * bw.x + mY * bw.y + mZ * bw.z;
  vec3 wx = vec3(nX.xy + gN.zy, abs(nX.z) * gN.x);
  vec3 wy = vec3(nY.xy + gN.xz, abs(nY.z) * gN.y);
  vec3 wz = vec3(nZ.xy + gN.xy, abs(nZ.z) * gN.z);
  nW = normalize(wx.zyx * bw.x + wy.xzy * bw.y + wz * bw.z);
}
`;

const LAYER_APPLY = /* glsl */ `
  {
    vec2 lp = (vGrid - uGridSize * 0.5) * uQuad;
    float hc = lsHeightF(vGrid);
    vec3 p = vec3(lp.x, hc, lp.y);
    vec3 dpx = dFdx(p);
    vec3 dpy = dFdy(p);
    vec2 wp = vGrid * uQuad;

    // Auto-Regeln: von oben nach unten, jeder Layer deckt einen Teil des Rests ab; Basis bekommt, was übrig bleibt
    float slope = degrees(acos(clamp(lsN.y, 0.0, 1.0)));
    float cs = uCurvStep;
    float avg = 0.25 * (lsHeightF(vGrid + vec2(cs, 0.0)) + lsHeightF(vGrid - vec2(cs, 0.0)) + lsHeightF(vGrid + vec2(0.0, cs)) + lsHeightF(vGrid - vec2(0.0, cs)));
    float curv = (hc - avg) / (cs * uQuad);
    float nz = lsAutoNoise(wp);
    float rem = 1.0;
    for (int i = 7; i >= 1; i--) {
      lsWt[i] = 0.0;
      if (i < uLayerN) {
        float c = lsAuto(i, slope, hc, curv, nz);
        lsWt[i] = c * rem;
        rem *= 1.0 - c;
      }
    }
    lsWt[0] = rem;
    // Gemaltes ersetzt die Auto-Verteilung anteilig
    if (uSplatInfo.w > 0.5) {
      vec2 suv = (vGrid / uSplatInfo.z + 0.5) / vec2(uSplatInfo.x, 2.0 * uSplatInfo.y);
      vec4 s0 = texture2D(uSplat, suv);
      vec4 s1 = texture2D(uSplat, suv + vec2(0.0, 0.5));
      float pw[8];
      float tot = 0.0;
      for (int i = 0; i < 8; i++) {
        pw[i] = 0.0;
        if (i < uLayerN) {
          int ch = int(uLayTint[i].w + 0.5);
          pw[i] = ch < 4 ? s0[ch] : s1[ch - 4];
          tot += pw[i];
        }
      }
      float keep = 1.0 - min(tot, 1.0);
      for (int i = 0; i < 8; i++) lsWt[i] = lsWt[i] * keep + pw[i];
    }

    // die LS_K stärksten Layer
    int ki[LS_K];
    float kw[LS_K];
    for (int k = 0; k < LS_K; k++) {
      int bi = 0;
      float bv = -1.0;
      for (int i = 0; i < 8; i++) {
        if (i < uLayerN && lsWt[i] > bv) {
          bv = lsWt[i];
          bi = i;
        }
      }
      ki[k] = bi;
      kw[k] = bv;
      lsWt[bi] = -2.0;
    }

    vec3 bw = pow(abs(lsN), vec3(8.0));
    bw /= dot(bw, vec3(1.0));
    bw = max(bw - 0.03, 0.0);
    bw /= dot(bw, vec3(1.0));
    float dist = length(vViewPosition);

    vec3 hA[LS_K];
    vec3 hM[LS_K];
    vec3 hN[LS_K];
    float hb[LS_K];
    float ma = -10.0;
    for (int k = 0; k < LS_K; k++) {
      hA[k] = vec3(0.5);
      hM[k] = vec3(0.9, 1.0, 0.5);
      hN[k] = lsN;
      hb[k] = -10.0;
      if (kw[k] > 0.004) {
        int i = ki[k];
        float farK = smoothstep(12.0, 45.0, dist * uLay[i].x);
        lsLayer(i, p, dpx, dpy, bw, lsN, farK, hA[k], hM[k], hN[k]);
        hb[k] = kw[k] + hM[k].b * 0.5;
        ma = max(ma, hb[k]);
      }
    }
    // Höhen-Blending: am Übergang setzt sich der Layer mit der höheren Texturhöhe durch (Steine aus dem Gras)
    ma -= 0.12;
    vec3 alb = vec3(0.0);
    vec3 arm = vec3(0.0);
    vec3 nn = vec3(0.0);
    float por = 0.0;
    float pud = 0.0;
    float bs = 0.0;
    for (int k = 0; k < LS_K; k++) {
      float b = max(hb[k] - ma, 0.0);
      int i = ki[k];
      alb += hA[k] * uLayTint[i].rgb * b;
      arm += vec3(hM[k].r * uLay[i].z, hM[k].g, hM[k].b) * b;
      nn += hN[k] * b;
      por += uLaySurf[i].x * b;
      pud += uLaySurf[i].y * b;
      bs += b;
    }
    bs = max(bs, 1e-5);
    alb /= bs;
    arm /= bs;
    // großflächige Helligkeits-Variation (aus 1 km Entfernung sichtbar, bricht Gleichförmigkeit)
    float macro = lsVNoise(wp / 61.0) * 0.55 + lsVNoise(wp / 13.0) * 0.45;
    alb *= 0.84 + 0.32 * macro;
    diffuseColor.rgb *= alb;
    lsRough = clamp(arm.r, 0.04, 1.0);
    lsAO = arm.g;
    lsDN = normalize(nn);
    lsPor = por / bs;
    // Pfützen: Senken der Textur und Mulden im Gelände zuerst, Kuppen kaum
    lsPudBias = (arm.b - 0.5) * 0.2 - (pud / bs) * 0.2 + clamp(curv * 3.0, -0.15, 0.15);
  }
`;

const OVERLAY_FRAG = /* glsl */ `
uniform vec4 uBrush;
uniform vec3 uBrushColor;
uniform vec4 uRegion;
uniform vec4 uRampAB;
uniform float uRampW;
uniform vec4 uOverlayOn; // brush, region, ramp, grid
uniform float uHoleGhost;
float lsGhost = 0.0;

// wie lsClip, aber Loch-Zellen unter dem Pinsel bleiben sichtbar (Vorschau beim Füllen)
void lsClipEd() {
  ivec2 q = ivec2(clamp(floor(vGrid * uHoleSub), vec2(0.0), uGridSize * uHoleSub - 1.0));
  if (texelFetch(uHoles, q, 0).r > 0.001) {
    vec2 lp = (vGrid - uGridSize * 0.5) * uQuad;
    if (uHoleGhost > 0.5 && uOverlayOn.x > 0.5 && length(lp - uBrush.xy) <= uBrush.z) lsGhost = 1.0;
    else discard;
  }
}

float lsLine(float d) {
  float w = fwidth(d) * 1.2;
  return 1.0 - smoothstep(0.0, w, abs(d));
}
`;

const OVERLAY_APPLY = /* glsl */ `
  {
    vec2 lp = (vGrid - uGridSize * 0.5) * uQuad;
    vec3 ov = vec3(0.0);
    float oa = 0.0;
    if (uOverlayOn.x > 0.5) {
      float d = length(lp - uBrush.xy);
      float outer = lsLine(d - uBrush.z);
      float inner = lsLine(d - uBrush.z * (1.0 - uBrush.w)) * 0.55;
      float fill = (1.0 - smoothstep(uBrush.z * (1.0 - uBrush.w), uBrush.z, d)) * step(d, uBrush.z) * 0.08;
      float a = max(max(outer, inner), fill);
      ov = mix(ov, uBrushColor, a);
      oa = max(oa, a);
    }
    if (uOverlayOn.y > 0.5) {
      vec2 mn = min(uRegion.xy, uRegion.zw);
      vec2 mx = max(uRegion.xy, uRegion.zw);
      float inside = step(mn.x, lp.x) * step(lp.x, mx.x) * step(mn.y, lp.y) * step(lp.y, mx.y);
      float edge = max(max(lsLine(lp.x - mn.x), lsLine(lp.x - mx.x)) * step(mn.y, lp.y) * step(lp.y, mx.y),
                       max(lsLine(lp.y - mn.y), lsLine(lp.y - mx.y)) * step(mn.x, lp.x) * step(lp.x, mx.x));
      float a = max(edge, inside * 0.12);
      ov = mix(ov, vec3(1.0, 0.75, 0.2), a);
      oa = max(oa, a);
    }
    if (uOverlayOn.z > 0.5) {
      vec2 ab = uRampAB.zw - uRampAB.xy;
      float len = max(length(ab), 1e-4);
      vec2 dir = ab / len;
      vec2 ap = lp - uRampAB.xy;
      float along = dot(ap, dir);
      float side = dot(ap, vec2(-dir.y, dir.x));
      float inSeg = step(0.0, along) * step(along, len);
      float a = max(max(lsLine(abs(side) - uRampW * 0.5), lsLine(side) * 0.6) * inSeg, 0.0);
      a = max(a, inSeg * step(abs(side), uRampW * 0.5) * 0.1);
      ov = mix(ov, vec3(0.3, 0.8, 1.0), a);
      oa = max(oa, a);
    }
    if (uOverlayOn.w > 0.5) {
      vec2 c = vGrid / 128.0;
      vec2 f = abs(fract(c - 0.5) - 0.5) / fwidth(c);
      float a = (1.0 - min(min(f.x, f.y), 1.0)) * 0.6;
      ov = mix(ov, vec3(0.2, 0.9, 0.4), a);
      oa = max(oa, a);
    }
    gl_FragColor.rgb = mix(gl_FragColor.rgb, ov * 1.5, oa);
    if (lsGhost > 0.5) {
      float s = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, uBrushColor, 0.45 + 0.3 * s);
    }
  }
`;

const _m = new THREE.Matrix4();
const _box = new THREE.Box3();
const _cam = new THREE.Vector3();

/** Alle lebenden Landscape-Renderer (für updateLandscapes) */
const live = new Set<LandscapeRenderer>();

/** Vor jedem Rendern mit der Hauptkamera aufrufen: LOD-Auswahl aller Landscapes */
export function updateLandscapes(camera: THREE.Camera): void {
  for (const r of live) r.update(camera);
}

/** alle Landscapes in der Szene (Layer-Gras) */
export function liveLandscapes(): Iterable<LandscapeRenderer> {
  return live;
}

const _sInv = new THREE.Matrix4();
const _sP = new THREE.Vector3();

/** Oberfläche des Landscapes unter einem Welt-Punkt (höchstens `maxDy` m darüber/darunter), sonst null */
export function surfaceAtWorld(p: THREE.Vector3, maxDy = 0.35): SurfaceId | null {
  for (const r of live) {
    if (!r.mesh.visible) continue;
    _sP.copy(p).applyMatrix4(_sInv.copy(r.mesh.matrixWorld).invert());
    const h = r.data.heightAt(_sP.x, _sP.z);
    if (h !== null && Math.abs(_sP.y - h) <= maxDy) return r.data.surfaceAt(_sP.x, _sP.z);
  }
  return null;
}

/** Oberfläche an einem Treffer (Raycast) auf einem Landscape-Mesh, sonst null */
export function landscapeSurfaceOf(o: THREE.Object3D, p: THREE.Vector3): SurfaceId | null {
  const r = o.userData.landscape as LandscapeRenderer | undefined;
  if (!r) return null;
  _sP.copy(p).applyMatrix4(_sInv.copy(r.mesh.matrixWorld).invert());
  return r.data.surfaceAt(_sP.x, _sP.z);
}

export class LandscapeRenderer {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  readonly heightTex: THREE.DataTexture;
  readonly normalTex: THREE.DataTexture;
  holesTex: THREE.DataTexture;
  private normals: Uint8Array;
  private nodeAttr: THREE.InstancedBufferAttribute;
  private capacity = 0;
  private uniforms: Record<string, THREE.IUniform>;
  private levels: number;
  private ranges: number[] = [];
  private frustum = new THREE.Frustum();
  private offData: () => void;
  private albTex!: THREE.DataArrayTexture;
  private nrmTex!: THREE.DataArrayTexture;
  private armTex!: THREE.DataArrayTexture;
  /** erster Komplett-Upload der Arrays erfolgt (danach Ebenen einzeln) */
  private arraysUploaded = false;
  private texSize = 0;
  private texK = 0;
  /** geladene Textur je Array-Ebene (Promise aus dem Textur-Cache; neues Promise = neu laden) */
  private slice: (Promise<TexSetData> | undefined)[] = [];
  private offTex: () => void;
  private splatTex: THREE.DataTexture;
  private disposed = false;
  /** Sichtweite-Faktor (Grafik-Einstellung "Terrain-Detail") */
  static detail = 2.5;
  /** Anzahl gezeichneter Knoten im letzten Frame (Statistik) */
  drawn = 0;

  constructor(readonly data: LandscapeData) {
    const d = data;
    this.heightTex = new THREE.DataTexture(d.heights, d.VW, d.VH, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.needsUpdate = true;
    this.normals = new Uint8Array(d.VW * d.VH * 2);
    this.computeNormals({ x: 0, y: 0, w: d.VW, h: d.VH });
    this.normalTex = new THREE.DataTexture(this.normals, d.VW, d.VH, THREE.RGFormat, THREE.UnsignedByteType);
    this.normalTex.minFilter = this.normalTex.magFilter = THREE.LinearFilter;
    this.normalTex.unpackAlignment = 1;
    this.normalTex.needsUpdate = true;
    this.holesTex = makeHolesTex(d);

    // Quadtree über eine Zweierpotenz an Knoten
    const nodes = Math.max(d.W, d.H) / G;
    this.levels = Math.max(1, Math.ceil(Math.log2(nodes)) + 1);

    this.uniforms = {
      uHeight: { value: this.heightTex },
      uNormal: { value: this.normalTex },
      uHoles: { value: this.holesTex },
      uGridSize: { value: new THREE.Vector2(d.W, d.H) },
      uHoleSub: { value: d.holeSub },
      uQuad: { value: d.quadSize },
      uCamLocal: { value: new THREE.Vector3() },
      uMorphStart: { value: new Array<number>(MAX_LEVELS).fill(1e9) },
      uMorphEnd: { value: new Array<number>(MAX_LEVELS).fill(2e9) },
      uSplat: { value: null },
      uSplatInfo: { value: new THREE.Vector4(1, 1, 1, 0) },
      uAlb: { value: null },
      uNrm: { value: null },
      uArm: { value: null },
      uLay: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4()) },
      uLayTint: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4()) },
      uAutoA: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4()) },
      uAutoB: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4()) },
      uLaySurf: { value: Array.from({ length: MAX_LAYERS }, () => new THREE.Vector4()) },
      uLayerN: { value: 0 },
      uCurvStep: { value: d.curvStep() },
      uBrush: { value: new THREE.Vector4() },
      uBrushColor: { value: new THREE.Color() },
      uRegion: { value: new THREE.Vector4() },
      uRampAB: { value: new THREE.Vector4() },
      uRampW: { value: 1 },
      uHoleGhost: { value: 0 },
      uOverlayOn: { value: new THREE.Vector4(0, 0, 0, 0) }, // Achtung: Vector4() hat w = 1
    };
    this.splatTex = this.makeSplatTex();
    const q0 = quality(LandscapeRenderer.detail);
    this.texK = q0.k;
    this.makeArrays(q0.size);
    this.updateLayerUniforms();
    this.computeRanges();

    const geo = new THREE.InstancedBufferGeometry();
    const grid = gridGeometry();
    geo.setAttribute('position', grid.getAttribute('position'));
    geo.setIndex(grid.getIndex());
    this.nodeAttr = new THREE.InstancedBufferAttribute(new Float32Array(0), 4);
    this.ensureCapacity(256);
    geo.instanceCount = 0;
    // Hülle für Box3.setFromObject (Fokus, Auswahlbox); Culling macht der Quadtree
    geo.boundingBox = new THREE.Box3();
    geo.boundingSphere = new THREE.Sphere();
    this.updateBoundingVolumes(geo);

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    // W_CUSTOM_NORMAL/W_TERRAIN: Wetter-Shader nutzt Geländenormale, Pfützen-Neigung und Porosität der Layer
    mat.defines = { LS_K: this.texK, W_CUSTOM_NORMAL: 'lsN', W_TERRAIN: '' };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${COMMON_VERT}`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', MORPH_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${COMMON_FRAG}\n${LAYER_FRAG}\n${OVERLAY_FRAG}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n  lsClipEd();\n  vec3 lsN = lsNormal();\n${LAYER_APPLY}`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = lsRough;')
        .replace('#include <normal_fragment_begin>', /* glsl */ `float faceDirection = 1.0;\nvec3 normal = normalize(mat3(viewMatrix) * lsDN);\nvec3 nonPerturbedNormal = normalize(mat3(viewMatrix) * lsN);
/*NORMAL_BEGIN*/`)
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n  reflectedLight.indirectDiffuse *= lsAO;\n  reflectedLight.indirectSpecular *= mix(1.0, lsAO, 0.6);')
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${OVERLAY_APPLY}`);
    };
    mat.customProgramCacheKey = () => 'landscape-cdlod-' + this.texK;

    // Schatten: gleiche Verschiebung, Löcher verwerfen
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${COMMON_VERT}`).replace('#include <begin_vertex>', MORPH_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${COMMON_FRAG}`)
        .replace('void main() {', 'void main() {\n  lsClip();');
    };
    depth.customProgramCacheKey = () => 'landscape-cdlod-depth';

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.customDepthMaterial = depth;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.raycast = (raycaster, hits) => this.raycast(raycaster, hits);
    this.mesh.userData.landscape = this;

    this.offData = d.onChange((r, kind) => this.onDataChange(r, kind));
    this.offTex = onTexturesInvalidated(() => this.loadTextures());
  }

  /** In die LOD-Auswahl aufnehmen (Objekt ist in der Szene) */
  attach(): void {
    live.add(this);
  }

  detach(): void {
    live.delete(this);
  }

  // ---------- Material-Layer ----------

  private makeSplatTex(): THREE.DataTexture {
    const d = this.data;
    const s = d.splat;
    const t = s ? new THREE.DataTexture(s, d.SW, d.SH * 2, THREE.RGBAFormat, THREE.UnsignedByteType) : new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    this.uniforms.uSplat.value = t;
    (this.uniforms.uSplatInfo.value as THREE.Vector4).set(d.SW, d.SH, d.splatDiv, s ? 1 : 0);
    return t;
  }

  private makeArrays(size: number): void {
    this.albTex?.dispose();
    this.nrmTex?.dispose();
    this.armTex?.dispose();
    this.texSize = size;
    this.arraysUploaded = false;
    this.slice = [];
    this.albTex = makeArray(size, 4, [128, 128, 128, 255], true);
    this.nrmTex = makeArray(size, 2, [128, 128], false);
    this.armTex = makeArray(size, 4, [220, 255, 128, 255], false);
    this.albTex.onUpdate = () => (this.arraysUploaded = true);
    this.uniforms.uAlb.value = this.albTex;
    this.uniforms.uNrm.value = this.nrmTex;
    this.uniforms.uArm.value = this.armTex;
    this.loadTextures();
  }

  /** fehlende/geänderte Layer-Texturen laden und in ihre Array-Ebene (= Splat-Kanal) schreiben */
  private loadTextures(): void {
    const size = this.texSize;
    for (const l of this.data.layers) {
      const p = loadTextureSet(l.texture, size);
      if (this.slice[l.ch] === p) continue;
      this.slice[l.ch] = p;
      const ch = l.ch;
      p.then((set) => {
        if (this.disposed || this.texSize !== size || this.slice[ch] !== p) return;
        this.writeSlice(ch, set);
      }).catch((e) => console.warn('Landscape-Textur', l.texture, e));
    }
  }

  private writeSlice(ch: number, set: TexSetData): void {
    const px = this.texSize * this.texSize;
    const put = (t: THREE.DataArrayTexture, src: Uint8Array, comps: number) => {
      (t.image.data as Uint8Array).set(src.subarray(0, px * comps), ch * px * comps);
      // vor dem ersten Upload würde addLayerUpdate nur diese Ebene hochladen → dann alles auf einmal
      if (this.arraysUploaded) t.addLayerUpdate(ch);
      t.needsUpdate = true;
    };
    put(this.albTex, set.albedo, 4);
    put(this.nrmTex, set.normal, 2);
    put(this.armTex, set.arm, 4);
  }

  private updateLayerUniforms(): void {
    const L = this.data.layers;
    const u = this.uniforms;
    const lay = u.uLay.value as THREE.Vector4[];
    const tint = u.uLayTint.value as THREE.Vector4[];
    const aa = u.uAutoA.value as THREE.Vector4[];
    const ab = u.uAutoB.value as THREE.Vector4[];
    const sf = u.uLaySurf.value as THREE.Vector4[];
    const c = new THREE.Color();
    for (let i = 0; i < MAX_LAYERS; i++) {
      const l = L[i];
      if (!l) {
        ab[i].set(0, 0, 0, 0);
        continue;
      }
      lay[i].set(1 / Math.max(0.05, l.tile), l.ch, l.rough, l.normal);
      c.set(l.tint);
      tint[i].set(c.r, c.g, c.b, l.ch);
      aa[i].set(l.auto.slopeMin, l.auto.slopeMax, l.auto.heightMin, l.auto.heightMax);
      ab[i].set(l.auto.on && i > 0 ? 1 : 0, l.auto.curv, l.auto.soft, l.auto.noise);
      const s = surfaceDef(l.surface);
      sf[i].set(s.porosity, s.puddle, 0, 0);
    }
    u.uLayerN.value = Math.min(L.length, MAX_LAYERS);
    u.uCurvStep.value = this.data.curvStep();
  }

  setOverlay(o: LandscapeOverlay): void {
    const on = this.uniforms.uOverlayOn.value as THREE.Vector4;
    on.set(o.brush ? 1 : 0, o.region ? 1 : 0, o.ramp ? 1 : 0, o.grid ? 1 : 0);
    this.uniforms.uHoleGhost.value = o.holeGhost && o.brush ? 1 : 0;
    if (o.brush) {
      (this.uniforms.uBrush.value as THREE.Vector4).set(o.brush.x, o.brush.z, o.brush.radius, o.brush.falloff);
      (this.uniforms.uBrushColor.value as THREE.Color).copy(o.brush.color);
    }
    if (o.region) (this.uniforms.uRegion.value as THREE.Vector4).set(o.region.x0, o.region.z0, o.region.x1, o.region.z1);
    if (o.ramp) {
      (this.uniforms.uRampAB.value as THREE.Vector4).set(o.ramp.ax, o.ramp.az, o.ramp.bx, o.ramp.bz);
      this.uniforms.uRampW.value = o.ramp.width;
    }
  }

  private computeRanges(): void {
    const q = this.data.quadSize;
    const detail = LandscapeRenderer.detail;
    const ms = this.uniforms.uMorphStart.value as number[];
    const me = this.uniforms.uMorphEnd.value as number[];
    this.ranges = [];
    for (let l = 0; l < this.levels; l++) {
      const range = G * q * 2 ** l * detail;
      this.ranges.push(range);
      me[l] = l === this.levels - 1 ? 1e9 : range;
      ms[l] = l === this.levels - 1 ? 1e9 - 1 : range * 0.72;
    }
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    let cap = Math.max(256, this.capacity);
    while (cap < n) cap *= 2;
    this.capacity = cap;
    this.nodeAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    if (this.mesh) {
      this.mesh.geometry.setAttribute('aNode', this.nodeAttr);
    }
  }

  private updateBoundingVolumes(geo = this.mesh.geometry): void {
    const d = this.data;
    const hx = d.sizeX / 2;
    const hz = d.sizeZ / 2;
    geo.boundingBox!.set(new THREE.Vector3(-hx, d.minHeight, -hz), new THREE.Vector3(hx, d.maxHeight, hz));
    geo.boundingBox!.getBoundingSphere(geo.boundingSphere!);
  }

  // ---------- LOD-Auswahl ----------

  private out: Float32Array = new Float32Array(0);
  private count = 0;
  private origin = new THREE.Vector3();

  update(camera: THREE.Camera): void {
    if (LandscapeRenderer.detail !== this.lastDetail) {
      this.lastDetail = LandscapeRenderer.detail;
      this.computeRanges();
      const q = quality(this.lastDetail);
      if (q.size !== this.texSize) this.makeArrays(q.size);
      if (q.k !== this.texK) {
        this.texK = q.k;
        this.mesh.material.defines!.LS_K = q.k;
        this.mesh.material.needsUpdate = true;
      }
    }
    const mesh = this.mesh;
    if (!this.nodeAttr.array.length || mesh.geometry.getAttribute('aNode') !== this.nodeAttr) mesh.geometry.setAttribute('aNode', this.nodeAttr);
    mesh.updateWorldMatrix(true, false);
    this.origin.setFromMatrixPosition(mesh.matrixWorld);
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld).sub(this.origin);
    (this.uniforms.uCamLocal.value as THREE.Vector3).copy(_cam);
    // Frustum im lokalen Raum (Landscape ist nur verschoben)
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(new THREE.Matrix4().makeTranslation(this.origin.x, this.origin.y, this.origin.z));
    this.frustum.setFromProjectionMatrix(_m, camera.coordinateSystem, camera.reversedDepth);
    this.out = this.nodeAttr.array as Float32Array;
    this.count = 0;
    this.select(0, 0, this.levels - 1);
    this.nodeAttr.needsUpdate = true;
    this.nodeAttr.clearUpdateRanges();
    this.nodeAttr.addUpdateRange(0, this.count * 4);
    mesh.geometry.instanceCount = this.count;
    this.drawn = this.count;
  }
  private lastDetail = LandscapeRenderer.detail;

  /** Knoten-Hülle (lokal, m); null = komplett außerhalb der Landscape */
  private nodeBox(x: number, z: number, level: number, out: THREE.Box3): THREE.Box3 | null {
    const d = this.data;
    const size = G * 2 ** level;
    if (x >= d.W || z >= d.H) return null;
    // Min/Max: Pyramidenstufe = level (Stufe 0 = BLOCK = G)
    const r = d.rangeAt(level, x / size, z / size);
    if (!r) return null;
    const q = d.quadSize;
    const x1 = Math.min(x + size, d.W);
    const z1 = Math.min(z + size, d.H);
    out.min.set((x - d.W / 2) * q, r[0], (z - d.H / 2) * q);
    out.max.set((x1 - d.W / 2) * q, r[1], (z1 - d.H / 2) * q);
    return out;
  }

  private select(x: number, z: number, level: number): boolean {
    const box = this.nodeBox(x, z, level, _box);
    if (!box) return true; // nichts zu zeichnen
    const dist = box.distanceToPoint(_cam);
    if (dist > this.ranges[level] && level < this.levels - 1) return false;
    // Nahe Knoten immer (Schatten hinter der Kamera), entfernte nur im Sichtfeld
    if (dist > this.ranges[0] * 1.5 && !this.frustum.intersectsBox(box)) return true;
    if (level === 0 || dist > this.ranges[level - 1]) {
      this.add(x, z, level);
      return true;
    }
    const half = (G * 2 ** level) / 2;
    for (let i = 0; i < 4; i++) {
      const cx = x + (i & 1) * half;
      const cz = z + (i >> 1) * half;
      if (!this.select(cx, cz, level - 1)) {
        // Kind liegt außerhalb seines Bereichs: auf eigener Fläche, voll in die Elternstufe geblendet
        const b = this.nodeBox(cx, cz, level - 1, _box);
        if (b) this.add(cx, cz, level - 1);
      }
    }
    return true;
  }

  private add(x: number, z: number, level: number): void {
    if (this.count >= this.capacity) {
      const old = this.out;
      this.ensureCapacity(this.count + 1);
      (this.nodeAttr.array as Float32Array).set(old.subarray(0, this.count * 4));
      this.out = this.nodeAttr.array as Float32Array;
      this.mesh.geometry.setAttribute('aNode', this.nodeAttr);
    }
    const o = this.count * 4;
    this.out[o] = x;
    this.out[o + 1] = z;
    this.out[o + 2] = 2 ** level;
    this.out[o + 3] = level;
    this.count++;
  }

  // ---------- Datenänderungen → Texturen ----------

  private onDataChange(r: Rect, kind: ChangeKind): void {
    const d = this.data;
    if (kind === 'holes') {
      uploadRows(this.holesTex, d.HW, r);
      return;
    }
    if (kind === 'holeRes') {
      // andere Rastergröße: Textur neu anlegen
      this.holesTex.dispose();
      this.holesTex = makeHolesTex(d);
      this.uniforms.uHoles.value = this.holesTex;
      this.uniforms.uHoleSub.value = d.holeSub;
      return;
    }
    if (kind === 'layers') {
      this.updateLayerUniforms();
      this.loadTextures();
      return;
    }
    if (kind === 'splat') {
      // Splatmap neu angelegt/ersetzt → neue Textur, sonst nur geänderte Zeilen
      if (!d.splat || this.splatTex.image.data !== d.splat) {
        this.splatTex.dispose();
        this.splatTex = this.makeSplatTex();
      } else uploadRows(this.splatTex, d.SW, r);
      return;
    }
    uploadRows(this.heightTex, d.VW, r);
    const nr = d.clip({ x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 })!;
    this.computeNormals(nr);
    uploadRows(this.normalTex, d.VW, nr);
    this.updateBoundingVolumes();
  }

  private computeNormals(r: Rect): void {
    const d = this.data;
    const n = new THREE.Vector3();
    const out = this.normals;
    for (let z = r.y; z < r.y + r.h; z++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        d.normalAt(x, z, n);
        const i = (z * d.VW + x) * 2;
        out[i] = Math.round((n.x * 0.5 + 0.5) * 255);
        out[i + 1] = Math.round((n.z * 0.5 + 0.5) * 255);
      }
    }
  }

  // ---------- Raycast (Picking, Schüsse) ----------

  /** Picking trifft auch Löcher (nur kurzzeitig vom Löcher-Werkzeug gesetzt) */
  pickThroughHoles = false;
  private _inv = new THREE.Matrix4();
  private _o = new THREE.Vector3();
  private _d = new THREE.Vector3();

  private raycast(raycaster: THREE.Raycaster, hits: THREE.Intersection[]): void {
    const mesh = this.mesh;
    this._inv.copy(mesh.matrixWorld).invert();
    this._o.copy(raycaster.ray.origin).applyMatrix4(this._inv);
    this._d.copy(raycaster.ray.direction).transformDirection(this._inv);
    const hit = this.data.raycast(this._o, this._d, raycaster.far, this.pickThroughHoles);
    if (!hit || hit.t < raycaster.near) return;
    const point = raycaster.ray.at(hit.t, new THREE.Vector3());
    hits.push({
      distance: hit.t,
      point,
      object: mesh,
      face: { a: 0, b: 0, c: 0, normal: hit.normal, materialIndex: 0 },
      faceIndex: 0,
    } as THREE.Intersection);
  }

  dispose(): void {
    this.disposed = true;
    live.delete(this);
    this.offData();
    this.offTex();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.customDepthMaterial?.dispose();
    this.heightTex.dispose();
    this.normalTex.dispose();
    this.holesTex.dispose();
    this.splatTex.dispose();
    this.albTex.dispose();
    this.nrmTex.dispose();
    this.armTex.dispose();
  }
}

function makeHolesTex(d: LandscapeData): THREE.DataTexture {
  const t = new THREE.DataTexture(d.holes, d.HW, d.HH, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** Nur geänderte Zeilen hochladen (three: Bereiche in "Komponenten" zu je 4, egal welches Format) */
function uploadRows(tex: THREE.DataTexture, width: number, r: Rect): void {
  if (r.w * r.h > width * 64) {
    // Großer Bereich: einmal ganz
    tex.clearUpdateRanges();
  } else {
    for (let y = r.y; y < r.y + r.h; y++) tex.addUpdateRange((y * width + r.x) * 4, r.w * 4);
  }
  tex.needsUpdate = true;
}
