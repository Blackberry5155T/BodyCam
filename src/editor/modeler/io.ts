import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MODELER_PREFIX, getModelBlob, putModel } from '../../world/modelStore.ts';
import { buildGeometry, exportPlaceholder, slotMaterial } from './build.ts';
import { defaultSlot, docFromJSON, docToJSON, isDocJSON, newDoc, newObject, objectMatrix, type MatSlot, type ModelDoc } from './doc.ts';
import { EditMesh, weld } from './mesh.ts';
import { mirroredMesh, polygonize } from './ops.ts';

// Speichern & Laden der Modeler-Modelle als .glb. Der Bearbeitungsstand (Polygon-Netze) steckt als JSON
// in den glTF-„extras“ des Wurzelknotens; Materialien tragen ihren Level-Material-Schlüssel (bcMat),
// damit Spiel und Editor beim Laden die echten, texturierten Materialien einsetzen.

export const safeName = (name: string): string =>
  name
    .trim()
    .replace(/[^\wäöüÄÖÜß\- ]/g, '_')
    .slice(0, 60) || 'Modell';

export const refForName = (name: string): string => `${MODELER_PREFIX}${safeName(name)}.glb`;

/** Szene für den Export aufbauen (sichtbare Objekte, Geometrie wie im Spiel) */
function buildScene(doc: ModelDoc, real: boolean): THREE.Group {
  const root = new THREE.Group();
  root.name = safeName(doc.name);
  const mats = doc.materials.map((s) => {
    if (!real) return exportPlaceholder(s);
    const m = slotMaterial(s).clone();
    m.name = s.name;
    m.userData = { bcMat: exportPlaceholder(s).userData.bcMat };
    return m;
  });
  for (const o of doc.objects) {
    if (!o.visible || !o.mesh.faces.length) continue;
    const { geometry } = buildGeometry(mirroredMesh(o.mesh, o.mirror), {
      smooth: o.smooth,
      smoothAngle: o.smoothAngle,
      uvScale: (i) => doc.materials[i]?.uvScale ?? 1,
      uvMatrix: objectMatrix(o),
    });
    const used = new Set(geometry.groups.map((g) => g.materialIndex ?? 0));
    // nur benutzte Slots (Indizes der Gruppen bleiben gleich, unbenutzte bekommen das erste Material)
    const list = mats.map((m, i) => (used.has(i) ? m : mats[[...used][0] ?? 0]));
    const mesh = new THREE.Mesh(geometry, list.length ? list : mats[0]);
    mesh.name = o.name;
    mesh.position.copy(o.pos);
    mesh.rotation.copy(o.rot);
    mesh.scale.copy(o.scale);
    root.add(mesh);
  }
  return root;
}

async function toGlb(root: THREE.Object3D): Promise<Blob> {
  const data = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
  return new Blob([data as ArrayBuffer], { type: 'model/gltf-binary' });
}

function disposeScene(root: THREE.Object3D): void {
  root.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
  });
}

/** Im Browser (Content Browser → Modelle/Eigene) speichern; liefert die Referenz */
export async function saveDoc(doc: ModelDoc): Promise<string> {
  const root = buildScene(doc, false);
  root.userData.bodycam = { model: docToJSON(doc), collision: doc.collision };
  try {
    const ref = refForName(doc.name);
    await putModel(ref.slice(4), await toGlb(root));
    return ref;
  } finally {
    disposeScene(root);
  }
}

/** .glb mit eingebetteten Texturen zum Herunterladen (für andere Programme) */
export async function exportGlb(doc: ModelDoc): Promise<Blob> {
  const root = buildScene(doc, true);
  root.userData.bodycam = { model: docToJSON(doc), collision: doc.collision };
  try {
    return await toGlb(root);
  } finally {
    root.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Modell laden: Modeler-Modelle mit Bearbeitungsstand, andere .glb werden in Polygon-Netze umgewandelt */
export async function loadDoc(ref: string): Promise<ModelDoc | null> {
  const blob = await getModelBlob(ref);
  if (!blob) return null;
  const doc = await docFromGlb(await blob.arrayBuffer(), ref.split('/').pop()!.replace(/^idb:/, '').replace(/\.(glb|gltf)$/i, ''));
  if (ref.startsWith(MODELER_PREFIX)) doc.ref = ref;
  return doc;
}

export async function docFromGlb(data: ArrayBuffer, name: string): Promise<ModelDoc> {
  const gltf = await new GLTFLoader().parseAsync(data, '');
  let stored: unknown = null;
  gltf.scene.traverse((o) => {
    const bc = o.userData.bodycam as { model?: unknown } | undefined;
    if (!stored && bc?.model) stored = bc.model;
  });
  if (isDocJSON(stored)) return docFromJSON(stored);
  return importScene(gltf.scene, name);
}

/** Fremdes Modell übernehmen: je Mesh ein Objekt, Materialien als einfarbige Slots */
export function importScene(scene: THREE.Object3D, name: string): ModelDoc {
  const doc = newDoc(name);
  doc.objects = [];
  doc.materials = [];
  const slotOf = new Map<THREE.Material, number>();
  const slot = (mat: THREE.Material): number => {
    let i = slotOf.get(mat);
    if (i !== undefined) return i;
    const std = mat as THREE.MeshStandardMaterial;
    const bc = mat.userData?.bcMat as Partial<MatSlot> | undefined;
    const s: MatSlot = bc?.material
      ? { ...defaultSlot(bc.material), ...bc, name: mat.name || `Material ${doc.materials.length + 1}` }
      : {
          ...defaultSlot(),
          name: mat.name || `Material ${doc.materials.length + 1}`,
          color: std.color ? `#${std.color.getHexString()}` : '#b4b4b4',
          roughness: std.roughness ?? 0.75,
          metalness: std.metalness ?? 0,
        };
    i = doc.materials.push(s) - 1;
    slotOf.set(mat, i);
    return i;
  };
  scene.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  scene.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    if (!pos) return;
    const m = new EditMesh();
    for (let i = 0; i < pos.count; i++) m.addVert(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const idx = g.index;
    const at = (i: number) => (idx ? idx.getX(i) : i);
    const count = idx ? idx.count : pos.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const gr of groups) {
      const s = slot(mats[gr.materialIndex ?? 0] ?? mats[0]);
      for (let i = gr.start; i + 2 < Math.min(count, gr.start + gr.count); i += 3) m.addFace([at(i), at(i + 1), at(i + 2)], s);
    }
    weld(m, 1e-5);
    m.validate();
    if (m.faces.length < 20000) polygonize(m);
    const obj = newObject(mesh.name || `Objekt ${doc.objects.length + 1}`, m);
    doc.objects.push(obj);
  });
  if (!doc.materials.length) doc.materials.push(defaultSlot());
  return doc;
}
