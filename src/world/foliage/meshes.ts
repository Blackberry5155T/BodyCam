import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadModel } from '../modelStore.ts';

// Meshes für Foliage-Typen: prozedurale Platzhalter (Vertex-Farben, LOD0/LOD1) oder importierte Modelle
// (LOD-Stufen über Knotennamen „LOD0“, „LOD1“, „LOD2“). Impostor: 8 Ansichten rund um das Objekt
// (Albedo + Normalen) in einen Atlas gebacken — dafür braucht es den Renderer, deshalb erst beim ersten Zeichnen.

export interface FoliageLod {
  geometry: THREE.BufferGeometry;
  /** ein Material oder eines je Geometrie-Gruppe */
  materials: THREE.Material[];
}

export interface FoliageMeshSet {
  lods: FoliageLod[];
  /** Maße bei Skalierung 1 (lokal): Höhe, Kronen-/Außenradius, Stammradius, Unterkante der Krone */
  height: number;
  radius: number;
  trunk: number;
  crownBottom: number;
  /** untere Kante (meist 0) — für Impostor */
  minY: number;
}

// ---------- prozedurale Platzhalter ----------

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Teil vorbereiten: nur Position/Normale/Farbe, indiziert */
function part(geo: THREE.BufferGeometry, color: (p: THREE.Vector3) => THREE.Color): THREE.BufferGeometry {
  geo.deleteAttribute('uv');
  geo.deleteAttribute('normal');
  let g = geo.index ? geo : mergeVertices(geo, 1e-4);
  if (!g.index) g = mergeVertices(g);
  g.computeVertexNormals();
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    color(p).toArray(col, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** verbeulte Kugel (Krone, Busch, Fels) */
function blob(r: number, detail: number, x: number, y: number, z: number, sy: number, rough: number, seed: number): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(r, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const g = mergeVertices(ico, 1e-4);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const n = hash3(p.x * 3.1 + seed, p.y * 2.7, p.z * 3.3) - 0.5;
    p.multiplyScalar(1 + n * rough * 2);
    pos.setXYZ(i, p.x + x, p.y * sy + y, p.z + z);
  }
  return g;
}

function shade(base: THREE.Color, vary: number, dark = 0) {
  const c = new THREE.Color();
  return (p: THREE.Vector3) => {
    const v = 1 - vary / 2 + hash3(p.x, p.y, p.z) * vary;
    return c.copy(base).multiplyScalar(v * (1 - dark));
  };
}

const BARK = new THREE.Color(0x4a3626);

function trunk(r0: number, r1: number, h: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, false);
  g.translate(0, h / 2, 0);
  return part(g, shade(BARK, 0.25));
}

function crownColor(leaf: THREE.Color, top: number) {
  const c = new THREE.Color();
  return (p: THREE.Vector3) => {
    // oben heller, innen/unten dunkler (grobe Verschattung), leichte Streuung
    const k = 0.62 + 0.45 * THREE.MathUtils.clamp(p.y / top, 0, 1) + (hash3(p.x, p.y, p.z) - 0.5) * 0.18;
    return c.copy(leaf).multiplyScalar(k);
  };
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function laubbaum(leaf: THREE.Color, lod: number): THREE.BufferGeometry {
  const top = 9.3;
  if (lod === 0) {
    const blobs: [number, number, number, number][] = [
      [0, 6.2, 0, 2.6],
      [1.3, 5.4, 0.6, 1.8],
      [-1.2, 5.6, -0.5, 1.9],
      [0.3, 7.4, -0.4, 1.9],
      [-0.6, 5.0, 1.2, 1.6],
    ];
    return merged([trunk(0.3, 0.16, 5.6, 7), ...blobs.map(([x, y, z, r], i) => part(blob(r, 1, x, y, z, 0.9, 0.22, i), crownColor(leaf, top)))]);
  }
  return merged([trunk(0.3, 0.18, 5, 5), part(blob(2.8, 0, 0, 6.3, 0, 1, 0.12, 1), crownColor(leaf, top)), part(blob(2.1, 0, 0.5, 5.2, 0.3, 0.9, 0.12, 2), crownColor(leaf, top))]);
}

function nadelbaum(leaf: THREE.Color, lod: number): THREE.BufferGeometry {
  const top = 13.5;
  const parts: THREE.BufferGeometry[] = [trunk(0.28, 0.1, 12, lod ? 5 : 6)];
  const tiers: [number, number, number][] = lod ? [[4.6, 2.4, 6.4], [9.6, 1.5, 6]] : [0, 1, 2, 3, 4].map((k) => [3.2 + k * 2.1, 2.4 * (1 - k * 0.17), 3.8]);
  for (const [y, r, h] of tiers) {
    const g = new THREE.ConeGeometry(r, h, lod ? 6 : 9, 1, false);
    g.translate(0, y, 0);
    parts.push(part(g, crownColor(leaf, top)));
  }
  return merged(parts);
}

function busch(leaf: THREE.Color, lod: number): THREE.BufferGeometry {
  const blobs: [number, number, number, number][] = lod
    ? [
        [0, 0.6, 0, 0.95],
        [0.3, 0.5, 0.2, 0.7],
      ]
    : [
        [0, 0.6, 0, 0.85],
        [0.5, 0.45, 0.3, 0.6],
        [-0.45, 0.5, -0.2, 0.65],
        [0.1, 0.95, -0.1, 0.55],
      ];
  return merged(blobs.map(([x, y, z, r], i) => part(blob(r, lod ? 0 : 1, x, y, z, 0.8, 0.2, i + 5), crownColor(leaf, 1.4))));
}

function fels(stone: THREE.Color, lod: number): THREE.BufferGeometry {
  const g = blob(1, lod ? 1 : 2, 0, 0.3, 0, 0.65, 0.28, 11);
  return merged([part(g, shade(stone, 0.3))]);
}

function gras(leaf: THREE.Color, lod: number): THREE.BufferGeometry {
  const blades = lod ? 5 : 9;
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + hash3(b, 1, 2) * 1.3;
    const off = 0.04 + hash3(b, 3, 4) * 0.12;
    const bx = Math.cos(a) * off;
    const bz = Math.sin(a) * off;
    const h = 0.42 + hash3(b, 5, 6) * 0.3;
    const lean = 0.08 + hash3(b, 7, 8) * 0.18;
    const w = 0.035;
    // Blatt quer zur Ausrichtung
    const fx = -Math.sin(a);
    const fz = Math.cos(a);
    const segs = lod ? 1 : 2;
    const base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / (segs + 1);
      const ww = w * (1 - t);
      const cx = bx + Math.cos(a) * lean * t * t;
      const cz = bz + Math.sin(a) * lean * t * t;
      pos.push(cx - fx * ww, h * t, cz - fz * ww, cx + fx * ww, h * t, cz + fz * ww);
      for (let k = 0; k < 2; k++) {
        nor.push(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3);
        c.copy(leaf).multiplyScalar(0.45 + 0.75 * t);
        col.push(c.r, c.g, c.b);
      }
    }
    pos.push(bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean);
    nor.push(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3);
    c.copy(leaf).multiplyScalar(1.25);
    col.push(c.r, c.g, c.b);
    for (let s = 0; s < segs; s++) {
      const i = base + s * 2;
      idx.push(i, i + 1, i + 3, i, i + 3, i + 2);
    }
    const last = base + segs * 2;
    idx.push(last, last + 1, last + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const n = new THREE.Float32BufferAttribute(nor, 3);
  for (let i = 0; i < n.count; i++) {
    const l = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
    n.setXYZ(i, n.getX(i) / l, n.getY(i) / l, n.getZ(i) / l);
  }
  g.setAttribute('normal', n);
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

const PROC: Record<string, { build: (c: THREE.Color, lod: number) => THREE.BufferGeometry; trunk: number; crownBottom: number; double: boolean }> = {
  'proc:laubbaum': { build: laubbaum, trunk: 0.3, crownBottom: 3.4, double: false },
  'proc:nadelbaum': { build: nadelbaum, trunk: 0.28, crownBottom: 1.3, double: false },
  'proc:busch': { build: busch, trunk: 0, crownBottom: 0, double: false },
  'proc:fels': { build: fels, trunk: 0, crownBottom: 0, double: false },
  'proc:gras': { build: gras, trunk: 0, crownBottom: 0, double: true },
};

function boundsOf(g: THREE.BufferGeometry): { height: number; radius: number; minY: number } {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  return { height: b.max.y, radius: Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.z), Math.abs(b.max.z), 0.05), minY: b.min.y };
}

export function procMeshSet(mesh: string, color: string): FoliageMeshSet {
  const def = PROC[mesh] ?? PROC['proc:laubbaum'];
  const c = new THREE.Color(color).convertSRGBToLinear();
  const lods = [0, 1].map((l) => {
    const geometry = def.build(c, l);
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, side: def.double ? THREE.DoubleSide : THREE.FrontSide });
    return { geometry, materials: [material] as THREE.Material[] };
  });
  const b = boundsOf(lods[0].geometry);
  return { lods, height: b.height, radius: b.radius, minY: b.minY, trunk: def.trunk || b.radius * 0.8, crownBottom: def.crownBottom };
}

// ---------- Modelle ----------

function lodIndex(o: THREE.Object3D, root: THREE.Object3D): number {
  for (let c: THREE.Object3D | null = o; c && c !== root; c = c.parent) {
    const m = /lod[_\s-]?(\d)/i.exec(c.name);
    if (m) return Math.min(2, Number(m[1]));
  }
  return 0;
}

function plainMaterial(m: THREE.Material): THREE.Material {
  const src = m as THREE.MeshStandardMaterial;
  if (src.isMeshStandardMaterial) return src.clone();
  const out = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  const any = m as unknown as { color?: THREE.Color; map?: THREE.Texture | null; alphaTest?: number; side?: THREE.Side; transparent?: boolean };
  if (any.color) out.color.copy(any.color);
  out.map = any.map ?? null;
  out.alphaTest = any.alphaTest ?? 0;
  out.side = any.side ?? THREE.FrontSide;
  return out;
}

/** Modell → LOD-Stufen (je Stufe eine Geometrie mit Gruppen); null, wenn nicht ladbar */
export async function modelMeshSet(ref: string): Promise<FoliageMeshSet | null> {
  const root = await loadModel(ref);
  if (!root) return null;
  root.updateMatrixWorld(true);
  const byLod: { geo: THREE.BufferGeometry; mat: THREE.Material }[][] = [[], [], []];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) return;
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    const g = m.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    g.morphAttributes = {};
    g.applyMatrix4(m.matrixWorld);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    g.clearGroups();
    byLod[lodIndex(o, root)].push({ geo: g, mat });
  });
  const lods: FoliageLod[] = [];
  for (const list of byLod) {
    if (!list.length) break;
    let geos = list.map((l) => l.geo);
    if (geos.some((g) => !g.index)) geos = geos.map((g) => (g.index ? g.toNonIndexed() : g));
    const geometry = mergeGeometries(geos, true);
    if (!geometry) break;
    lods.push({ geometry, materials: list.map((l) => plainMaterial(l.mat)) });
  }
  if (!lods.length) return null;
  const b = boundsOf(lods[0].geometry);
  return { lods, height: b.height, radius: b.radius, minY: b.minY, trunk: THREE.MathUtils.clamp(b.radius * 0.12, 0.08, 0.6), crownBottom: b.height * 0.35 };
}

export function disposeMeshSet(s: FoliageMeshSet): void {
  for (const l of s.lods) {
    l.geometry.dispose();
    for (const m of l.materials) m.dispose();
  }
}

// ---------- Impostor ----------

export const IMPOSTOR_FRAMES = 8;

export interface ImpostorAtlas {
  albedo: THREE.WebGLRenderTarget;
  normal: THREE.WebGLRenderTarget;
  /** halbe Breite, Unter-/Oberkante (lokal, Skalierung 1) */
  halfW: number;
  yMin: number;
  yMax: number;
  dispose(): void;
}

/** 8 Ansichten (Kamera bei Winkel θ_k = k·45°, Richtung (sin θ, 0, cos θ)) als Atlas backen */
export function bakeImpostor(renderer: THREE.WebGLRenderer, set: FoliageMeshSet, tint: THREE.Color): ImpostorAtlas {
  const lod = set.lods[0];
  const halfW = set.radius * 1.04;
  const yMin = set.minY;
  const yMax = set.height * 1.02;
  const FH = 256;
  const FW = THREE.MathUtils.clamp(Math.round((FH * 2 * halfW) / Math.max(0.01, yMax - yMin) / 4) * 4, 64, 256);
  const W = FW * IMPOSTOR_FRAMES;
  const mk = (srgb: boolean) => {
    const rt = new THREE.WebGLRenderTarget(W, FH, { depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    if (srgb) rt.texture.colorSpace = THREE.SRGBColorSpace;
    return rt;
  };
  const albedo = mk(true);
  const normal = mk(false);

  const scene = new THREE.Scene();
  const basic = lod.materials.map((m) => {
    const s = m as THREE.MeshStandardMaterial;
    return new THREE.MeshBasicMaterial({ color: s.color ?? 0xffffff, map: s.map ?? null, vertexColors: !!s.vertexColors, alphaTest: Math.max(0.3, s.alphaTest || 0), side: THREE.DoubleSide });
  });
  const nmat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>(lod.geometry, basic.length === 1 ? basic[0] : basic);
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-halfW, halfW, yMax, yMin, 0.01, halfW * 4 + 10);

  const prevTarget = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevShadow = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;

  const pass = (rt: THREE.WebGLRenderTarget, mat: THREE.Material | THREE.Material[], clear: THREE.Color) => {
    mesh.material = mat;
    renderer.setRenderTarget(rt);
    rt.scissorTest = false;
    rt.viewport.set(0, 0, W, FH);
    renderer.setClearColor(clear, 0);
    renderer.clear(true, true, true);
    rt.scissorTest = true;
    for (let k = 0; k < IMPOSTOR_FRAMES; k++) {
      const th = (k / IMPOSTOR_FRAMES) * Math.PI * 2;
      const r = halfW * 2 + 5;
      cam.position.set(Math.sin(th) * r, 0, Math.cos(th) * r);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      rt.viewport.set(k * FW, 0, FW, FH);
      rt.scissor.set(k * FW, 0, FW, FH);
      renderer.render(scene, cam);
    }
    rt.scissorTest = false;
    rt.viewport.set(0, 0, W, FH);
  };
  pass(albedo, basic.length === 1 ? basic[0] : basic, tint);
  pass(normal, nmat, new THREE.Color(0.5, 0.5, 1));

  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAuto;
  renderer.setClearColor(prevColor, prevAlpha);
  renderer.shadowMap.autoUpdate = prevShadow;
  for (const m of basic) m.dispose();
  nmat.dispose();

  return {
    albedo,
    normal,
    halfW,
    yMin,
    yMax,
    dispose() {
      albedo.dispose();
      normal.dispose();
    },
  };
}
