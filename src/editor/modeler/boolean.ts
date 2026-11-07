import * as THREE from 'three';
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { buildGeometry } from './build.ts';
import { EditMesh, weld } from './mesh.ts';
import { polygonize, recalcNormals } from './ops.ts';

// Boolean-Modifikator (Anwenden): Objekt mit einem zweiten verrechnen (Vereinigen/Abziehen/Schnitt).
// Das Ergebnis wird wieder zu einem Polygon-Netz (Punkte verschweißt, ebene Dreiecke zu n-Ecken).

export type BoolOp = 'union' | 'difference' | 'intersect';

export const BOOL_OPS: { value: BoolOp; label: string }[] = [
  { value: 'difference', label: 'Abziehen' },
  { value: 'union', label: 'Vereinigen' },
  { value: 'intersect', label: 'Schnittmenge' },
];

function brushOf(m: EditMesh, matrix: THREE.Matrix4, tag: number): Brush {
  const { geometry } = buildGeometry(m, { smooth: false, smoothAngle: 0 });
  const slots = Math.max(1, ...m.faces.map((f) => f.m + 1));
  const mats: THREE.Material[] = [];
  for (let i = 0; i < slots; i++) {
    const mat = new THREE.MeshBasicMaterial();
    mat.userData.slot = { tag, m: i };
    mats.push(mat);
  }
  geometry.deleteAttribute('uv');
  const b = new Brush(geometry, mats);
  matrix.decompose(b.position, b.quaternion, b.scale);
  b.updateMatrixWorld(true);
  return b;
}

/**
 * `target` (Matrix `tm`) mit `tool` (Matrix `om`) verrechnen. Ergebnis im lokalen Raum von `target`.
 * Flächen des Werkzeugs behalten ihr Material, wenn `keepToolMaterial`, sonst bekommen sie `fallbackMat`.
 */
export function booleanMesh(target: EditMesh, tm: THREE.Matrix4, tool: EditMesh, om: THREE.Matrix4, op: BoolOp, toolMat: (m: number) => number): EditMesh {
  const a = brushOf(target, tm, 0);
  const b = brushOf(tool, om, 1);
  const ev = new Evaluator();
  ev.attributes = ['position', 'normal'];
  ev.useGroups = true;
  const res = ev.evaluate(a, b, op === 'union' ? ADDITION : op === 'difference' ? SUBTRACTION : INTERSECTION);
  const geo = res.geometry;
  const mats = (Array.isArray(res.material) ? res.material : [res.material]) as THREE.Material[];
  const inv = tm.clone().invert();
  const out = new EditMesh();
  const pos = geo.attributes.position;
  const index = geo.index;
  const total = index ? index.count : pos.count;
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: total, materialIndex: 0 }];
  const v = new THREE.Vector3();
  const vi = new Map<number, number>();
  const vert = (i: number) => {
    let r = vi.get(i);
    if (r === undefined) vi.set(i, (r = out.addVert(v.fromBufferAttribute(pos, i).applyMatrix4(inv))));
    return r;
  };
  for (const g of groups) {
    const slot = mats[g.materialIndex ?? 0]?.userData.slot as { tag: number; m: number } | undefined;
    const mat = !slot ? 0 : slot.tag === 0 ? slot.m : toolMat(slot.m);
    const end = Math.min(total, g.start + g.count);
    for (let i = g.start; i + 2 < end; i += 3) {
      const x = index ? index.getX(i) : i;
      const y = index ? index.getX(i + 1) : i + 1;
      const z = index ? index.getX(i + 2) : i + 2;
      out.addFace([vert(x), vert(y), vert(z)], mat);
    }
  }
  for (const br of [a, b, res]) {
    br.geometry.dispose();
    for (const m of (Array.isArray(br.material) ? br.material : [br.material]) as THREE.Material[]) m.dispose();
  }
  weld(out, 1e-5);
  out.validate();
  polygonize(out);
  if (tm.determinant() < 0) recalcNormals(out);
  return out;
}
