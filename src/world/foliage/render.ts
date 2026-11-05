import * as THREE from 'three';
import type { Collider, CylinderCollider } from '../collision.ts';
import { CELL, cellKey, cellOf, cellX, cellZ, STRIDE, type FoliageCell, type FoliageData } from './data.ts';
import { bakeImpostor, disposeMeshSet, IMPOSTOR_FRAMES, modelMeshSet, procMeshSet, type FoliageMeshSet, type ImpostorAtlas } from './meshes.ts';
import { thinnable, type FoliageType } from './types.ts';

// Foliage zeichnen: je Typ ein InstancedMesh pro LOD-Stufe + eins für Impostoren (Billboards aus dem Atlas).
// Die Instanz-Puffer werden neu gefüllt, wenn sich die Kamera ein Stück bewegt hat (nah: 2 m, Impostoren: 12 m)
// oder sich die Daten ändern — dabei wird je Instanz nach Abstand die LOD-Stufe gewählt.
// Wind biegt die Meshes im Vertex-Shader (auch im Schatten). Treffer (Kugeln, Editor) laufen über einen
// eigenen Strahltest gegen senkrechte Zylinder je Instanz, nicht über die Dreiecke.

// ---------- globale Einstellungen ----------

export const foliageQuality = {
  /** Anteil der Deko-Instanzen (Gras, Büsche ohne Sicht/Kollision) */
  density: 1,
  /** Faktor auf Sicht- und LOD-Weiten */
  distance: 1,
};

const WIND = { value: new THREE.Vector3() };
const TIME = { value: 0 };
let glRenderer: THREE.WebGLRenderer | null = null;
let bakesLeft = 0;

const live = new Set<FoliageRenderer>();

/** Renderer für das Impostor-Backen (Spiel und Editor setzen ihn beim Start) */
export function setFoliageRenderer(r: THREE.WebGLRenderer): void {
  glRenderer = r;
}

export function setFoliageQuality(q: Partial<typeof foliageQuality>): void {
  Object.assign(foliageQuality, q);
  for (const r of live) r.invalidate();
}

/** jeden Frame: Wind/Zeit setzen und Instanz-Puffer bei Bedarf neu füllen */
export function updateFoliage(camera: THREE.Camera, dt: number, wind: THREE.Vector3): void {
  WIND.value.copy(wind);
  TIME.value += dt;
  bakesLeft = 1;
  for (const r of live) r.update(camera);
}

export function liveFoliage(): Iterable<FoliageRenderer> {
  return live;
}

// ---------- Shader ----------

const WIND_HEAD = /* glsl */ `
uniform vec3 uFolWind;
uniform float uFolTime;
uniform float uFolBend;
uniform float uFolH;
`;

const WIND_BODY = /* glsl */ `
#include <begin_vertex>
#ifdef USE_INSTANCING
{
  float fs2 = max(dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz), 1e-6);
  float ft = clamp(position.y / uFolH, 0.0, 1.5);
  vec2 fp = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xz;
  float ph = dot(fp, vec2(0.071, 0.053));
  float gust = 0.62 + 0.38 * sin(uFolTime * 1.1 + ph) * sin(uFolTime * 0.37 + ph * 1.7);
  float flutter = 0.1 * sin(uFolTime * 5.3 + ph * 3.0 + dot(position, vec3(2.1, 1.3, 1.7)));
  vec3 fdisp = uFolWind * (uFolBend * ft * ft * (gust + flutter));
  fdisp.y = -length(fdisp.xz) * 0.3 * ft;
  transformed += transpose(mat3(instanceMatrix)) * fdisp / fs2;
}
#endif
`;

interface WindUniforms {
  uFolWind: typeof WIND;
  uFolTime: typeof TIME;
  uFolBend: { value: number };
  uFolH: { value: number };
}

function patchWind(m: THREE.Material, u: WindUniforms): void {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${WIND_HEAD}`).replace('#include <begin_vertex>', WIND_BODY);
  };
  m.customProgramCacheKey = () => 'foliage-wind';
}

function impostorMaterial(atlas: ImpostorAtlas): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: atlas.albedo.texture, alphaTest: 0.5, roughness: 0.92, metalness: 0 });
  const uImp = { value: new THREE.Vector4(atlas.halfW, atlas.yMin, atlas.yMax, IMPOSTOR_FRAMES) };
  const uImpNormal = { value: atlas.normal.texture };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uImp = uImp;
    shader.uniforms.uImpNormal = uImpNormal;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uImp;\nvarying vec3 vImpRight;\nvarying vec3 vImpToCam;')
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec3 impC = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
        float impS = length(instanceMatrix[0].xyz);
        float impYaw = atan(-instanceMatrix[0].z, instanceMatrix[0].x);
        vec2 tc = cameraPosition.xz - impC.xz;
        tc /= max(length(tc), 1e-4);
        vImpToCam = vec3(tc.x, 0.0, tc.y);
        vImpRight = vec3(tc.y, 0.0, -tc.x);
        float cy = cos(impYaw);
        float sy = sin(impYaw);
        vec2 lv = vec2(tc.x * cy - tc.y * sy, tc.x * sy + tc.y * cy);
        float fr = mod(floor(atan(lv.x, lv.y) / (6.2831853 / uImp.w) + 0.5) + uImp.w, uImp.w);
        vec3 impW = impC + vImpRight * (position.x * uImp.x * impS) + vec3(0.0, mix(uImp.y, uImp.z, position.y) * impS, 0.0);
        vec4 mvPosition = viewMatrix * vec4(impW, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vMapUv = vec2((fr + uv.x) / uImp.w, uv.y);
        `,
      )
      .replace('#include <worldpos_vertex>', 'vec4 worldPosition = vec4(impW, 1.0);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uImpNormal;\nvarying vec3 vImpRight;\nvarying vec3 vImpToCam;')
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        vec3 impN = texture2D(uImpNormal, vMapUv).xyz * 2.0 - 1.0;
        vec3 impNW = normalize(vImpRight * impN.x + vec3(0.0, impN.y, 0.0) + vImpToCam * impN.z);
        normal = normalize((viewMatrix * vec4(impNW, 0.0)).xyz);
        `,
      );
  };
  m.customProgramCacheKey = () => 'foliage-impostor';
  return m;
}

/** Billboard-Quad: x ∈ [-1, 1], y ∈ [0, 1] */
function impostorQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// ---------- Strahltest ----------

export interface FoliageHit {
  typeId: string;
  key: number;
  index: number;
  /** Abstand (Welt) */
  t: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

const noRaycast = () => {};

/** Strahl gegen senkrechten Zylinder (lokal); liefert t und Normale oder -1 */
function rayCylinder(o: THREE.Vector3, d: THREE.Vector3, cx: number, cz: number, y0: number, y1: number, r: number, nOut: THREE.Vector3): number {
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  const c = ox * ox + oz * oz - r * r;
  if (a < 1e-9 || c <= 0) return c <= 0 ? capHit(o, d, ox, oz, y1, r, nOut) : -1;
  const b = ox * d.x + oz * d.z;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t < 0) return -1;
  const y = o.y + d.y * t;
  if (y >= y0 && y <= y1) {
    nOut.set((ox + d.x * t) / r, 0, (oz + d.z * t) / r).normalize();
    return t;
  }
  return y > y1 ? capHit(o, d, ox, oz, y1, r, nOut) : -1;
}

/** Deckel oben (Strahl von oben) */
function capHit(o: THREE.Vector3, d: THREE.Vector3, ox: number, oz: number, y1: number, r: number, nOut: THREE.Vector3): number {
  if (d.y > -1e-6 || o.y <= y1) return -1;
  const t = (y1 - o.y) / d.y;
  const hx = ox + d.x * t;
  const hz = oz + d.z * t;
  if (hx * hx + hz * hz > r * r) return -1;
  nOut.set(0, 1, 0);
  return t;
}

// ---------- je Typ ----------

const NEAR_STEP = 2;
const FAR_STEP = 12;
const _cam = new THREE.Vector3();
const _root = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();

class Bucket {
  arr = new Float32Array(16 * 256);
  n = 0;
  push(src: Float32Array, i: number): void {
    if ((this.n + 1) * 16 > this.arr.length) {
      const b = new Float32Array(this.arr.length * 2);
      b.set(this.arr);
      this.arr = b;
    }
    const s = i * 16;
    const o = this.n * 16;
    const a = this.arr;
    for (let k = 0; k < 16; k++) a[o + k] = src[s + k];
    this.n++;
  }
}

function hashI(i: number, key: number): number {
  const x = Math.sin(i * 12.9898 + key * 0.0007813) * 43758.5453;
  return x - Math.floor(x);
}

class TypeRender {
  set: FoliageMeshSet | null = null;
  atlas: ImpostorAtlas | null = null;
  meshes: THREE.InstancedMesh[] = [];
  imp: THREE.InstancedMesh | null = null;
  readonly picker = new THREE.Object3D();
  private nearAt = new THREE.Vector3(Infinity, 0, 0);
  private farAt = new THREE.Vector3(Infinity, 0, 0);
  private nearDirty = true;
  private farDirty = true;
  private farTime = 0;
  private buckets = [new Bucket(), new Bucket(), new Bucket()];
  private farBucket = new Bucket();
  private uniforms: WindUniforms = { uFolWind: WIND, uFolTime: TIME, uFolBend: { value: 0 }, uFolH: { value: 1 } };
  private depthMats: THREE.Material[] = [];
  private disposed = false;
  readonly meshKey: string;

  constructor(
    public type: FoliageType,
    private readonly owner: FoliageRenderer,
  ) {
    this.meshKey = `${type.mesh}|${type.color}`;
    this.picker.name = `foliage:${type.name}`;
    this.applyType(type);
    if (type.mesh.startsWith('proc:')) this.init(procMeshSet(type.mesh, type.color));
    else
      void modelMeshSet(type.mesh).then((s) => {
        if (this.disposed) {
          if (s) disposeMeshSet(s);
          return;
        }
        if (!s) console.warn(`Foliage „${type.name}“: Modell ${type.mesh} nicht ladbar — Platzhalter`);
        this.init(s ?? procMeshSet('proc:busch', '#a03030'));
      });
  }

  /** Einstellungen ohne Mesh-Wechsel übernehmen */
  applyType(t: FoliageType): void {
    this.type = t;
    this.picker.userData.foliageSurface = t.surface;
    this.picker.userData.foliageType = t.id;
    // Gras/Büsche ohne Kollision: Kugeln fliegen durch
    this.picker.userData.noShot = t.collision === 'none';
    this.uniforms.uFolBend.value = t.wind / 10;
    for (const m of this.meshes) {
      m.castShadow = t.shadow;
      m.customDepthMaterial = t.wind > 0 ? this.depthMats[0] : undefined;
    }
    this.invalidate();
  }

  invalidate(): void {
    this.nearDirty = this.farDirty = true;
  }

  private init(set: FoliageMeshSet): void {
    this.set = set;
    this.uniforms.uFolH.value = Math.max(0.05, set.height);
    for (const lod of set.lods) for (const m of lod.materials) patchWind(m, this.uniforms);
    const src = set.lods[0].materials[0] as THREE.MeshStandardMaterial;
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: src.map ?? null, alphaTest: src.map ? Math.max(0.3, src.alphaTest || 0) : 0 });
    patchWind(depth, this.uniforms);
    this.depthMats = [depth];
    this.meshes = set.lods.map((l) => this.makeMesh(l.geometry, l.materials, 64));
    this.applyType(this.type);
  }

  private makeMesh(geo: THREE.BufferGeometry, mats: THREE.Material[], cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mats.length === 1 ? mats[0] : mats, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.castShadow = this.type.shadow;
    m.customDepthMaterial = this.type.wind > 0 ? this.depthMats[0] : undefined;
    m.raycast = noRaycast;
    m.userData.noOutline = true;
    m.userData.noShot = true;
    this.owner.group.add(m);
    return m;
  }

  /** Puffer auf Mindestgröße bringen (neues InstancedMesh, wenn zu klein) */
  private ensure(m: THREE.InstancedMesh, n: number): THREE.InstancedMesh {
    if (n <= m.instanceMatrix.count) return m;
    let cap = m.instanceMatrix.count;
    while (cap < n) cap *= 2;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const next = this.makeMesh(m.geometry, mats, cap);
    next.castShadow = m.castShadow;
    next.customDepthMaterial = m.customDepthMaterial;
    this.owner.group.remove(m);
    m.dispose();
    return next;
  }

  private upload(m: THREE.InstancedMesh, b: Bucket): THREE.InstancedMesh {
    m = this.ensure(m, b.n);
    if (b.n) {
      (m.instanceMatrix.array as Float32Array).set(b.arr.subarray(0, b.n * 16));
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, b.n * 16);
      m.instanceMatrix.needsUpdate = true;
    }
    m.count = b.n;
    return m;
  }

  /** Zellen im Umkreis (Kamera lokal) durchlaufen */
  private forCells(cam: THREE.Vector3, maxD: number, fn: (c: FoliageCell, key: number) => void): void {
    const cells = this.owner.data.cells.get(this.type.id);
    if (!cells || !cells.size) return;
    const x0 = cellOf(cam.x - maxD);
    const x1 = cellOf(cam.x + maxD);
    const z0 = cellOf(cam.z - maxD);
    const z1 = cellOf(cam.z + maxD);
    const visit = (key: number, c: FoliageCell) => {
      const cx = cellX(key);
      const cz = cellZ(key);
      // nächster Punkt der Zelle zur Kamera
      const nx = Math.max(cx * CELL, Math.min(cam.x, (cx + 1) * CELL)) - cam.x;
      const nz = Math.max(cz * CELL, Math.min(cam.z, (cz + 1) * CELL)) - cam.z;
      if (nx * nx + nz * nz <= maxD * maxD) fn(c, key);
    };
    if ((x1 - x0 + 1) * (z1 - z0 + 1) < cells.size) {
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const k = cellKey(x, z);
          const c = cells.get(k);
          if (c) visit(k, c);
        }
    } else for (const [k, c] of cells) visit(k, c);
  }

  update(cam: THREE.Vector3, now: number): void {
    const set = this.set;
    if (!set) return;
    const t = this.type;
    const q = foliageQuality;
    const cull = t.cull * q.distance;
    // Impostor backen (höchstens einer je Frame)
    if (t.impostor > 0 && !this.atlas && glRenderer && bakesLeft > 0) {
      bakesLeft--;
      this.atlas = bakeImpostor(glRenderer, set, new THREE.Color(t.color).multiplyScalar(0.5));
      this.imp = this.makeMesh(impostorQuad(), [impostorMaterial(this.atlas)], 256);
      this.imp.castShadow = false;
      this.imp.customDepthMaterial = undefined;
      this.farDirty = true;
    }
    const impD = this.atlas && t.impostor > 0 && t.impostor < cull ? t.impostor * q.distance : 0;
    const nearMax = impD || cull;
    const dens = thinnable(t) ? q.density : 1;
    const data = this.owner.data;

    if (this.nearDirty || cam.distanceToSquared(this.nearAt) > NEAR_STEP * NEAR_STEP) {
      this.nearDirty = false;
      this.nearAt.copy(cam);
      const l1 = t.lod1 * q.distance;
      const l2 = t.lod2 * q.distance;
      const lods = this.meshes.length;
      for (const b of this.buckets) b.n = 0;
      const near2 = nearMax * nearMax;
      const fade = thinnable(t);
      this.forCells(cam, nearMax, (c, key) => {
        const d = c.data;
        let mats: Float32Array | null = null;
        for (let i = 0, o = 0; i < c.n; i++, o += STRIDE) {
          const dx = d[o] - cam.x;
          const dy = d[o + 1] - cam.y;
          const dz = d[o + 2] - cam.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= near2) continue;
          if (fade || dens < 1) {
            // Deko dünnt zum Rand hin aus (statt hart abzuschneiden)
            const k = fade ? Math.min(1, (nearMax - Math.sqrt(d2)) / (nearMax * 0.3)) : 1;
            if (hashI(i, key) > dens * k) continue;
          }
          mats ??= data.matrices(c);
          const lod = d2 < l1 * l1 ? 0 : lods > 2 && d2 >= l2 * l2 ? 2 : 1;
          this.buckets[Math.min(lod, lods - 1)].push(mats, i);
        }
      });
      for (let l = 0; l < lods; l++) this.meshes[l] = this.upload(this.meshes[l], this.buckets[l]);
    }

    if (this.imp) {
      const far = this.farDirty && now - this.farTime > 0.3;
      if (far || cam.distanceToSquared(this.farAt) > FAR_STEP * FAR_STEP) {
        this.farDirty = false;
        this.farTime = now;
        this.farAt.copy(cam);
        const b = this.farBucket;
        b.n = 0;
        if (impD > 0) {
          // überlappt den Nah-Bereich um eine Schrittweite: keine Lücken zwischen den Aktualisierungen
          const from = Math.max(0, impD - FAR_STEP - 1);
          const from2 = from * from;
          const cull2 = cull * cull;
          this.forCells(cam, cull, (c, key) => {
            const d = c.data;
            let mats: Float32Array | null = null;
            for (let i = 0, o = 0; i < c.n; i++, o += STRIDE) {
              const dx = d[o] - cam.x;
              const dy = d[o + 1] - cam.y;
              const dz = d[o + 2] - cam.z;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < from2 || d2 >= cull2) continue;
              if (dens < 1 && hashI(i, key) > dens) continue;
              mats ??= data.matrices(c);
              b.push(mats, i);
            }
          });
        }
        this.imp = this.upload(this.imp, b);
      }
    }
  }

  /** Strahl (lokal, normiert) gegen alle Instanzen; mode „shot“ = Stamm/Körper, „select“ = ganze Hülle */
  raycast(o: THREE.Vector3, d: THREE.Vector3, far: number, mode: 'shot' | 'select', best: FoliageHit | null): FoliageHit | null {
    const set = this.set;
    const t = this.type;
    const cells = this.owner.data.cells.get(t.id);
    if (!set || !cells || !cells.size) return best;
    if (mode === 'shot' && t.collision === 'none') return best;
    const R = (mode === 'shot' && t.collision === 'trunk' ? set.trunk : set.radius) * t.scaleMax;
    const rk = mode === 'shot' ? (t.collision === 'trunk' ? set.trunk : set.radius * 0.8) : set.radius;
    const hk = mode === 'shot' && t.collision === 'trunk' ? 0.9 : 1;
    far = Math.min(far, best ? best.t : Infinity, 2000);
    // Zellen entlang des Strahls (Schritte von 16 m, aufgeweitet um den Radius)
    const keys = new Set<number>();
    const steps = Math.max(1, Math.ceil(far / 16));
    const len = Math.hypot(d.x, d.z) * far;
    const n = len < 1 ? 1 : steps;
    for (let s = 0; s <= n; s++) {
      const tt = (s / n) * far;
      const px = o.x + d.x * tt;
      const pz = o.z + d.z * tt;
      for (let z = cellOf(pz - R - 8); z <= cellOf(pz + R + 8); z++) for (let x = cellOf(px - R - 8); x <= cellOf(px + R + 8); x++) keys.add(cellKey(x, z));
    }
    for (const key of keys) {
      const c = cells.get(key);
      if (!c) continue;
      const a = c.data;
      for (let i = 0, p = 0; i < c.n; i++, p += STRIDE) {
        const s = a[p + 4];
        const hit = rayCylinder(o, d, a[p], a[p + 2], a[p + 1] - 0.3, a[p + 1] + set.height * s * hk, Math.max(0.05, rk * s), _n);
        if (hit < 0 || hit > far) continue;
        far = hit;
        best = { typeId: t.id, key, index: i, t: hit, point: o.clone().addScaledVector(d, hit), normal: _n.clone() };
      }
    }
    return best;
  }

  /** Collider einer Zelle (Welt): Stamm/Körper und Sicht-Blocker */
  cellColliders(c: FoliageCell, root: THREE.Vector3, out: Collider[]): void {
    const set = this.set;
    if (!set) return;
    const t = this.type;
    const a = c.data;
    for (let i = 0, p = 0; i < c.n; i++, p += STRIDE) {
      const s = a[p + 4];
      const x = a[p] + root.x;
      const y = a[p + 1] + root.y;
      const z = a[p + 2] + root.z;
      if (t.collision !== 'none') {
        const r = (t.collision === 'trunk' ? set.trunk : set.radius * 0.8) * s;
        out.push({ type: 'cylinder', center: new THREE.Vector2(x, z), radius: Math.max(0.05, r), minY: y - 0.5, maxY: y + set.height * s * (t.collision === 'trunk' ? 0.9 : 0.95) });
      }
      if (t.sight && t.collision !== 'full') {
        const sc: CylinderCollider = { type: 'cylinder', center: new THREE.Vector2(x, z), radius: set.radius * 0.75 * s, minY: y + set.crownBottom * s, maxY: y + set.height * s, sightOnly: true };
        out.push(sc);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const m of this.meshes) {
      this.owner.group.remove(m);
      m.dispose();
    }
    if (this.imp) {
      this.owner.group.remove(this.imp);
      this.imp.geometry.dispose();
      (this.imp.material as THREE.Material).dispose();
      this.imp.dispose();
    }
    this.atlas?.dispose();
    for (const m of this.depthMats) m.dispose();
    if (this.set) disposeMeshSet(this.set);
    this.owner.group.remove(this.picker);
  }
}

// ---------- je Foliage-Objekt ----------

export class FoliageRenderer {
  readonly group = new THREE.Group();
  private types = new Map<string, TypeRender>();
  private offData: () => void;
  private colliderCache = new Map<string, { rev: number; rx: number; ry: number; rz: number; list: Collider[] }>();
  private clock = 0;
  private editor = false;

  constructor(readonly data: FoliageData) {
    this.group.name = 'Foliage';
    this.group.userData.foliage = this;
    // Wetter-Shader (Nässe, Schnee) nicht auf tausende Instanzen anwenden
    this.group.userData.noWeather = true;
    this.syncTypes();
    this.offData = data.onChange((kind) => {
      if (kind === 'types') this.syncTypes();
      else this.invalidate();
    });
  }

  attach(): void {
    live.add(this);
  }

  detach(): void {
    live.delete(this);
  }

  invalidate(): void {
    for (const t of this.types.values()) t.invalidate();
  }

  private syncTypes(): void {
    const ids = new Set(this.data.types.map((t) => t.id));
    for (const [id, r] of this.types) {
      const t = this.data.type(id);
      if (!ids.has(id) || !t || r.meshKey !== `${t.mesh}|${t.color}`) {
        r.dispose();
        this.types.delete(id);
      }
    }
    for (const t of this.data.types) {
      const r = this.types.get(t.id);
      if (r) r.applyType(t);
      else {
        const nr = new TypeRender(t, this);
        this.types.set(t.id, nr);
        this.group.add(nr.picker);
        nr.picker.userData.noPick = this.editor;
        nr.picker.raycast = (rc, out) => this.raycastPicker(nr, rc, out);
      }
    }
  }

  /** Editor: Picker nicht anklickbar (Objekt-Auswahl) */
  setEditor(on: boolean): void {
    this.editor = on;
    for (const r of this.types.values()) r.picker.userData.noPick = on;
  }

  update(camera: THREE.Camera): void {
    if (!this.group.parent) return;
    this.clock = performance.now() / 1000;
    this.group.updateWorldMatrix(true, false);
    _root.setFromMatrixPosition(this.group.matrixWorld);
    _cam.setFromMatrixPosition(camera.matrixWorld).sub(_root);
    for (const r of this.types.values()) r.update(_cam, this.clock);
  }

  private raycastPicker(r: TypeRender, rc: THREE.Raycaster, out: THREE.Intersection[]): void {
    this.group.updateWorldMatrix(true, false);
    _root.setFromMatrixPosition(this.group.matrixWorld);
    _o.copy(rc.ray.origin).sub(_root);
    _d.copy(rc.ray.direction);
    const hit = r.raycast(_o, _d, rc.far, 'shot', null);
    if (!hit || hit.t < rc.near) return;
    out.push({
      distance: hit.t,
      point: hit.point.add(_root),
      object: r.picker,
      face: { a: 0, b: 0, c: 0, normal: hit.normal, materialIndex: 0 },
      faceIndex: 0,
      instanceId: hit.index,
    });
  }

  /** Editor: nächste Instanz entlang eines Welt-Strahls (alle oder bestimmte Typen) */
  pick(ray: THREE.Ray, far = 2000, only?: Set<string>): FoliageHit | null {
    this.group.updateWorldMatrix(true, false);
    _root.setFromMatrixPosition(this.group.matrixWorld);
    const o = ray.origin.clone().sub(_root);
    let best: FoliageHit | null = null;
    for (const r of this.types.values()) if (!only || only.has(r.type.id)) best = r.raycast(o, ray.direction, far, 'select', best);
    if (best) best.point.add(_root);
    return best;
  }

  /** Maße eines Typs (bei Skalierung 1), null solange das Modell lädt */
  bounds(typeId: string): { height: number; radius: number } | null {
    const s = this.types.get(typeId)?.set;
    return s ? { height: s.height, radius: s.radius } : null;
  }

  /** Collider aller Zellen im Umkreis (Welt) — Listen bleiben identisch, solange sich nichts ändert */
  colliders(center: THREE.Vector3, radius: number, out: Collider[]): void {
    this.group.updateWorldMatrix(true, false);
    _root.setFromMatrixPosition(this.group.matrixWorld);
    const lx = center.x - _root.x;
    const lz = center.z - _root.z;
    for (const r of this.types.values()) {
      const t = r.type;
      if (!r.set || (t.collision === 'none' && !t.sight)) continue;
      const cells = this.data.cells.get(t.id);
      if (!cells) continue;
      for (let z = cellOf(lz - radius); z <= cellOf(lz + radius); z++)
        for (let x = cellOf(lx - radius); x <= cellOf(lx + radius); x++) {
          const key = cellKey(x, z);
          const c = cells.get(key);
          if (!c) continue;
          const ck = `${t.id}|${key}`;
          let e = this.colliderCache.get(ck);
          if (!e || e.rev !== this.data.revision || e.rx !== _root.x || e.ry !== _root.y || e.rz !== _root.z) {
            const list: Collider[] = [];
            r.cellColliders(c, _root, list);
            e = { rev: this.data.revision, rx: _root.x, ry: _root.y, rz: _root.z, list };
            this.colliderCache.set(ck, e);
          }
          for (const col of e.list) out.push(col);
        }
    }
    if (this.colliderCache.size > 4096) this.colliderCache.clear();
  }

  dispose(): void {
    this.offData();
    live.delete(this);
    for (const r of this.types.values()) r.dispose();
    this.types.clear();
    this.colliderCache.clear();
  }
}

// ---------- Collider rund um den Spieler ----------

let activeColliders: Collider[] = [];
let activeKey = '';

/** Collider im Umkreis des Spielers in die Liste der Map einsortieren (vor physics.sync aufrufen) */
export function updateFoliageColliders(center: THREE.Vector3, list: Collider[], radius = 80): void {
  let key = `${cellOf(center.x / 0.5)}|${cellOf(center.z / 0.5)}`;
  for (const r of live) key += `|${r.data.revision}`;
  if (key === activeKey) return;
  activeKey = key;
  const next: Collider[] = [];
  for (const r of live) r.colliders(center, radius, next);
  if (activeColliders.length) {
    const old = new Set(activeColliders);
    let w = 0;
    for (let i = 0; i < list.length; i++) if (!old.has(list[i])) list[w++] = list[i];
    list.length = w;
  }
  for (const c of next) list.push(c);
  activeColliders = next;
}

/** Spielende/Map-Wechsel */
export function resetFoliageColliders(): void {
  activeColliders = [];
  activeKey = '';
}
