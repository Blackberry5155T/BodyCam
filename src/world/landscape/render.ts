import * as THREE from 'three';
import { BLOCK, type LandscapeData, type Rect } from './data.ts';

// CDLOD-Rendering (Continuous Distance-Dependent Level of Detail, Strugar 2009):
// Ein einziges 32×32-Gitter wird pro Quadtree-Knoten instanziert; der Vertex-Shader liest die Höhe aus einer
// Float-Textur und blendet Vertices zur Grenze der nächsten LOD-Stufe hin stufenlos auf das gröbere Raster
// (keine Risse, kein Ploppen). Normalen kommen aus einer eigenen Textur (pro Pixel), Löcher werden verworfen.

/** Quads pro Gitterkante eines Knotens (= BLOCK, damit Min/Max-Blöcke genau passen) */
const G = BLOCK;
const MAX_LEVELS = 16;

export interface LandscapeLook {
  grass: string;
  rock: string;
  /** Hangneigung (Grad), ab der Fels erscheint */
  slope: number;
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
uniform float uQuad;
varying vec2 vGrid;

vec3 lsNormal() {
  vec2 e = texture2D(uNormal, (vGrid + 0.5) / (uGridSize + 1.0)).rg * 2.0 - 1.0;
  return normalize(vec3(e.x, sqrt(max(0.0, 1.0 - dot(e, e))), e.y));
}
void lsClip() {
  ivec2 q = ivec2(clamp(floor(vGrid), vec2(0.0), uGridSize - 1.0));
  if (texelFetch(uHoles, q, 0).r > 0.001) discard;
}
`;

const COLOR_FRAG = /* glsl */ `
uniform vec3 uGrass;
uniform vec3 uRock;
uniform float uSlope;

float lsHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lsNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lsHash(i), lsHash(i + vec2(1, 0)), f.x), mix(lsHash(i + vec2(0, 1)), lsHash(i + vec2(1, 1)), f.x), f.y);
}
`;

const OVERLAY_FRAG = /* glsl */ `
uniform vec4 uBrush;
uniform vec3 uBrushColor;
uniform vec4 uRegion;
uniform vec4 uRampAB;
uniform float uRampW;
uniform vec4 uOverlayOn; // brush, region, ramp, grid

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

export class LandscapeRenderer {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  readonly heightTex: THREE.DataTexture;
  readonly normalTex: THREE.DataTexture;
  readonly holesTex: THREE.DataTexture;
  private normals: Uint8Array;
  private nodeAttr: THREE.InstancedBufferAttribute;
  private capacity = 0;
  private uniforms: Record<string, THREE.IUniform>;
  private levels: number;
  private ranges: number[] = [];
  private frustum = new THREE.Frustum();
  private offData: () => void;
  /** Sichtweite-Faktor (Grafik-Einstellung "Terrain-Detail") */
  static detail = 2.5;
  /** Anzahl gezeichneter Knoten im letzten Frame (Statistik) */
  drawn = 0;

  constructor(
    readonly data: LandscapeData,
    look: LandscapeLook,
  ) {
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
    this.holesTex = new THREE.DataTexture(d.holes, d.W, d.H, THREE.RedFormat, THREE.UnsignedByteType);
    this.holesTex.minFilter = this.holesTex.magFilter = THREE.NearestFilter;
    this.holesTex.unpackAlignment = 1;
    this.holesTex.needsUpdate = true;

    // Quadtree über eine Zweierpotenz an Knoten
    const nodes = Math.max(d.W, d.H) / G;
    this.levels = Math.max(1, Math.ceil(Math.log2(nodes)) + 1);

    this.uniforms = {
      uHeight: { value: this.heightTex },
      uNormal: { value: this.normalTex },
      uHoles: { value: this.holesTex },
      uGridSize: { value: new THREE.Vector2(d.W, d.H) },
      uQuad: { value: d.quadSize },
      uCamLocal: { value: new THREE.Vector3() },
      uMorphStart: { value: new Array<number>(MAX_LEVELS).fill(1e9) },
      uMorphEnd: { value: new Array<number>(MAX_LEVELS).fill(2e9) },
      uGrass: { value: new THREE.Color() },
      uRock: { value: new THREE.Color() },
      uSlope: { value: 35 },
      uBrush: { value: new THREE.Vector4() },
      uBrushColor: { value: new THREE.Color() },
      uRegion: { value: new THREE.Vector4() },
      uRampAB: { value: new THREE.Vector4() },
      uRampW: { value: 1 },
      uOverlayOn: { value: new THREE.Vector4(0, 0, 0, 0) }, // Achtung: Vector4() hat w = 1
    };
    this.setLook(look);
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
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${COMMON_VERT}`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', MORPH_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${COMMON_FRAG}\n${COLOR_FRAG}\n${OVERLAY_FRAG}`)
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
  lsClip();
  vec3 lsN = lsNormal();
  {
    float ang = degrees(acos(clamp(lsN.y, 0.0, 1.0)));
    float rockK = smoothstep(uSlope - 4.0, uSlope + 4.0, ang);
    vec2 wp = vGrid * uQuad;
    float macro = lsNoise(wp / 37.0) * 0.6 + lsNoise(wp / 9.0) * 0.4;
    vec3 grass = uGrass * (0.8 + 0.4 * macro);
    vec3 rock = uRock * (0.85 + 0.3 * lsNoise(wp / 4.0));
    diffuseColor.rgb *= mix(grass, rock, rockK);
  }`,
        )
        .replace('#include <normal_fragment_begin>', /* glsl */ `float faceDirection = 1.0;\nvec3 normal = normalize(mat3(viewMatrix) * lsN);\nvec3 nonPerturbedNormal = normal;
/*NORMAL_BEGIN*/`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${OVERLAY_APPLY}`);
    };
    mat.customProgramCacheKey = () => 'landscape-cdlod';

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
  }

  /** In die LOD-Auswahl aufnehmen (Objekt ist in der Szene) */
  attach(): void {
    live.add(this);
  }

  detach(): void {
    live.delete(this);
  }

  setLook(look: LandscapeLook): void {
    (this.uniforms.uGrass.value as THREE.Color).set(look.grass);
    (this.uniforms.uRock.value as THREE.Color).set(look.rock);
    this.uniforms.uSlope.value = look.slope;
  }

  setOverlay(o: LandscapeOverlay): void {
    const on = this.uniforms.uOverlayOn.value as THREE.Vector4;
    on.set(o.brush ? 1 : 0, o.region ? 1 : 0, o.ramp ? 1 : 0, o.grid ? 1 : 0);
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

  private onDataChange(r: Rect, kind: 'height' | 'holes'): void {
    const d = this.data;
    if (kind === 'holes') {
      uploadRows(this.holesTex, d.W, r);
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

  private _inv = new THREE.Matrix4();
  private _o = new THREE.Vector3();
  private _d = new THREE.Vector3();

  private raycast(raycaster: THREE.Raycaster, hits: THREE.Intersection[]): void {
    const mesh = this.mesh;
    this._inv.copy(mesh.matrixWorld).invert();
    this._o.copy(raycaster.ray.origin).applyMatrix4(this._inv);
    this._d.copy(raycaster.ray.direction).transformDirection(this._inv);
    const hit = this.data.raycast(this._o, this._d, raycaster.far);
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
    live.delete(this);
    this.offData();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.customDepthMaterial?.dispose();
    this.heightTex.dispose();
    this.normalTex.dispose();
    this.holesTex.dispose();
  }
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
