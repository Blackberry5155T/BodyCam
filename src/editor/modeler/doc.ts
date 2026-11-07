import * as THREE from 'three';
import { defaultColorFor } from '../../world/materials.ts';
import { EditMesh, makePrimitive, primitiveDefaults, type MeshJSON } from './mesh.ts';

// Modell-Dokument des Modelers: mehrere Objekte (je ein Polygon-Netz mit Transformation), Material-Slots,
// Kollision. Wird als JSON in die .glb geschrieben, damit das Modell später wieder bearbeitet werden kann.

export interface MatSlot {
  name: string;
  /** Schlüssel aus MATERIALS */
  material: string;
  color: string;
  roughness?: number;
  metalness?: number;
  /** Textur-Wiederholung (1 = 2 m je Kachel wie im Level) */
  uvScale: number;
}

export type ModelCollision = 'none' | 'box' | 'convex' | 'mesh';

export const COLLISION_OPTIONS: { value: ModelCollision; label: string }[] = [
  { value: 'box', label: 'Quader (Umriss)' },
  { value: 'convex', label: 'Konvexe Hülle' },
  { value: 'mesh', label: 'Exakt (Dreiecke)' },
  { value: 'none', label: 'Keine' },
];

export interface MObject {
  id: string;
  name: string;
  mesh: EditMesh;
  pos: THREE.Vector3;
  rot: THREE.Euler;
  scale: THREE.Vector3;
  /** Glatt schattieren (mit Winkelgrenze, wie „Auto Smooth“) */
  smooth: boolean;
  smoothAngle: number;
  visible: boolean;
}

export interface ModelDoc {
  name: string;
  objects: MObject[];
  materials: MatSlot[];
  collision: ModelCollision;
  /** Gespeichert unter (idb:modeler/<Name>.glb) */
  ref?: string;
}

interface ObjectJSON {
  id: string;
  name: string;
  mesh: MeshJSON;
  pos: number[];
  rot: number[];
  scale: number[];
  smooth: boolean;
  smoothAngle: number;
  visible?: boolean;
}

export interface DocJSON {
  v: 1;
  name: string;
  collision: ModelCollision;
  materials: MatSlot[];
  objects: ObjectJSON[];
}

let idCounter = 0;
export const newId = (): string => `o${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export function defaultSlot(material = 'farbe', name = 'Material'): MatSlot {
  return { name, material, color: material === 'farbe' ? '#b4b4b4' : defaultColorFor(material), uvScale: 1 };
}

export function newObject(name: string, mesh: EditMesh): MObject {
  return {
    id: newId(),
    name,
    mesh,
    pos: new THREE.Vector3(),
    rot: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
    smooth: false,
    smoothAngle: 30,
    visible: true,
  };
}

/** Neues Modell: Würfel 1 m, steht auf dem Boden */
export function newDoc(name = 'Neues Modell'): ModelDoc {
  const cube = newObject('Würfel', makePrimitive('cube', primitiveDefaults('cube')));
  cube.pos.y = 0.5;
  return { name, objects: [cube], materials: [defaultSlot()], collision: 'box' };
}

export function objectMatrix(o: MObject, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out.compose(o.pos, new THREE.Quaternion().setFromEuler(o.rot), o.scale);
}

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

export function docToJSON(d: ModelDoc): DocJSON {
  return {
    v: 1,
    name: d.name,
    collision: d.collision,
    materials: d.materials.map((m) => ({ ...m })),
    objects: d.objects.map((o) => ({
      id: o.id,
      name: o.name,
      mesh: o.mesh.toJSON(),
      pos: o.pos.toArray().map(r5),
      rot: [o.rot.x, o.rot.y, o.rot.z].map(r5),
      scale: o.scale.toArray().map(r5),
      smooth: o.smooth,
      smoothAngle: o.smoothAngle,
      visible: o.visible,
    })),
  };
}

export function docFromJSON(j: DocJSON): ModelDoc {
  return {
    name: j.name || 'Modell',
    collision: j.collision ?? 'box',
    materials: j.materials?.length ? j.materials.map((m) => ({ ...defaultSlot(), ...m })) : [defaultSlot()],
    objects: (j.objects ?? []).map((o) => ({
      id: o.id || newId(),
      name: o.name || 'Objekt',
      mesh: EditMesh.fromJSON(o.mesh),
      pos: new THREE.Vector3().fromArray(o.pos ?? [0, 0, 0]),
      rot: new THREE.Euler(o.rot?.[0] ?? 0, o.rot?.[1] ?? 0, o.rot?.[2] ?? 0),
      scale: new THREE.Vector3().fromArray(o.scale ?? [1, 1, 1]),
      smooth: !!o.smooth,
      smoothAngle: o.smoothAngle ?? 30,
      visible: o.visible !== false,
    })),
  };
}

export function isDocJSON(x: unknown): x is DocJSON {
  return !!x && typeof x === 'object' && (x as DocJSON).v === 1 && Array.isArray((x as DocJSON).objects);
}

/** Rückgängig/Wiederholen über Schnappschüsse (Dokument + Bearbeitungszustand) */
export interface Snapshot {
  doc: string;
  /** frei verwendbarer Zustand des Modelers (aktives Objekt, Modus, Auswahl) */
  state: string;
  label: string;
}

export class History {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  /** Zustand nach der letzten Änderung (aktuell) */
  private current: Snapshot | null = null;
  limit = 80;

  reset(s: Snapshot): void {
    this.undoStack = [];
    this.redoStack = [];
    this.current = s;
  }

  /** Neuen Zustand nach einer Änderung festhalten */
  push(s: Snapshot): void {
    if (this.current) {
      if (this.current.doc === s.doc && this.current.state === s.state) return;
      this.undoStack.push(this.current);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.current = s;
    this.redoStack = [];
  }

  /** Letzten Schritt ersetzen (Redo-Panel: Parameter nachträglich ändern) */
  replace(s: Snapshot): void {
    this.current = s;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): Snapshot | null {
    const s = this.undoStack.pop();
    if (!s || !this.current) return null;
    this.redoStack.push(this.current);
    const label = this.current.label;
    this.current = s;
    return { ...s, label };
  }

  redo(): Snapshot | null {
    const s = this.redoStack.pop();
    if (!s || !this.current) return null;
    this.undoStack.push(this.current);
    this.current = s;
    return s;
  }

  /** Zustand vor der letzten Änderung (für das Redo-Panel) */
  peekPrevious(): Snapshot | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }
}
