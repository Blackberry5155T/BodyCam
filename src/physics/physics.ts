import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { colliderMinY, type Collider } from '../world/collision.ts';

// Physik-Welt auf Basis von Rapier (WASM).
// Die Map liefert weiterhin eine einfache Collider-Liste (box/obox/rbox/cylinder); sie wird jeden Frame
// mit der Rapier-Welt abgeglichen (neue Collider anlegen, entfernte löschen). Scripts, die Objekte bewegen,
// ersetzen ihre Collider in der Liste (refreshColliders) — das reicht für den Abgleich.
// Landscapes liefern Heightfields (je Komponente; mit Löchern als Trimesh). Später: Brushes/Modelle, Wasser.

let ready: Promise<void> | null = null;

/** Rapier (WASM) laden; muss vor `new PhysicsWorld()` abgewartet werden */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

/** Kollisionsgruppen: Spieler-Kapsel ist nicht Teil der Welt-Abfragen */
const GROUP_WORLD = 0x0001;
const GROUP_PLAYER = 0x0002;
const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);
/** Abfragen, die nur Welt-Geometrie treffen sollen */
export const WORLD_QUERY = groups(0xffff, GROUP_WORLD);

const GROUND_HALF = 50000; // 100 × 100 km

interface Entry {
  rc: RAPIER.Collider;
  stamp: number;
}

const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3(0, 1, 0);

export class PhysicsWorld {
  readonly world: RAPIER.World;
  private entries = new Map<Collider, Entry>();
  /** Rapier-Collider-Handle → Map-Collider (für Filter, z. B. Unterkante) */
  private byHandle = new Map<number, Collider>();
  private stamp = 0;
  private ground: RAPIER.Collider | null = null;

  constructor(groundPlane = true) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.setGroundPlane(groundPlane);
  }

  /** Unsichtbarer, unendlicher Boden bei y = 0 (wie bisher implizit im Spieler-Controller) */
  setGroundPlane(on: boolean): void {
    if (on === !!this.ground) return;
    if (this.ground) {
      this.world.removeCollider(this.ground, false);
      this.ground = null;
      return;
    }
    const desc = RAPIER.ColliderDesc.cuboid(GROUND_HALF, 1, GROUND_HALF).setTranslation(0, -1, 0).setCollisionGroups(groups(GROUP_WORLD, 0xffff));
    this.ground = this.world.createCollider(desc);
  }

  /** Map-Collider-Liste mit der Rapier-Welt abgleichen (billig, solange sich nichts ändert) */
  sync(list: readonly Collider[]): void {
    const s = ++this.stamp;
    for (const c of list) {
      const e = this.entries.get(c);
      if (e) e.stamp = s;
      else {
        const rc = this.world.createCollider(describe(c));
        this.entries.set(c, { rc, stamp: s });
        this.byHandle.set(rc.handle, c);
      }
    }
    if (this.entries.size === list.length) return;
    for (const [c, e] of this.entries) {
      if (e.stamp === s) continue;
      this.byHandle.delete(e.rc.handle);
      this.world.removeCollider(e.rc, false);
      this.entries.delete(c);
    }
  }

  /** Map-Collider zu einem Rapier-Collider (null für Boden, Spieler, …) */
  source(rc: RAPIER.Collider): Collider | null {
    return this.byHandle.get(rc.handle) ?? null;
  }

  /** Unterkante eines Rapier-Colliders (Weltkoordinaten) */
  minY(rc: RAPIER.Collider): number {
    const c = this.byHandle.get(rc.handle);
    if (c) return colliderMinY(c);
    return rc === this.ground ? -2 : -Infinity;
  }

  /** Broadphase aktualisieren (neue/verschobene Collider für Abfragen sichtbar machen) */
  step(dt: number): void {
    this.world.timestep = Math.max(dt, 1 / 240);
    this.world.step();
  }

  /** Kapsel für einen Charakter (nicht Teil der Welt-Abfragen) */
  createCharacterCapsule(halfHeight: number, radius: number): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.capsule(halfHeight, radius).setCollisionGroups(groups(GROUP_PLAYER, GROUP_WORLD));
    return this.world.createCollider(desc);
  }

  dispose(): void {
    this.world.free();
    this.entries.clear();
    this.byHandle.clear();
  }
}

function describe(c: Collider): RAPIER.ColliderDesc {
  let desc: RAPIER.ColliderDesc;
  switch (c.type) {
    case 'box': {
      const hx = Math.max((c.max.x - c.min.x) / 2, 1e-3);
      const hy = Math.max((c.max.y - c.min.y) / 2, 1e-3);
      const hz = Math.max((c.max.z - c.min.z) / 2, 1e-3);
      desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(c.min.x + hx, c.min.y + hy, c.min.z + hz);
      break;
    }
    case 'obox': {
      _q.setFromAxisAngle(_axis, c.yaw);
      desc = RAPIER.ColliderDesc.cuboid(Math.max(c.half.x, 1e-3), Math.max(c.half.y, 1e-3), Math.max(c.half.z, 1e-3))
        .setTranslation(c.center.x, c.center.y, c.center.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
      break;
    }
    case 'rbox': {
      const q = c.quat;
      desc = RAPIER.ColliderDesc.cuboid(Math.max(c.half.x, 1e-3), Math.max(c.half.y, 1e-3), Math.max(c.half.z, 1e-3))
        .setTranslation(c.center.x, c.center.y, c.center.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      break;
    }
    case 'cylinder': {
      const hh = Math.max((c.maxY - c.minY) / 2, 1e-3);
      desc = RAPIER.ColliderDesc.cylinder(hh, Math.max(c.radius, 1e-3)).setTranslation(c.center.x, c.minY + hh, c.center.y);
      break;
    }
    case 'heightfield':
      // Rapier: Höhen spaltenweise, Feld ist um die Translation zentriert, scale = Gesamtgröße
      desc = RAPIER.ColliderDesc.heightfield(c.rows, c.cols, c.heights, { x: c.sizeX, y: 1, z: c.sizeZ }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES).setTranslation(c.center.x, c.center.y, c.center.z);
      break;
    case 'trimesh':
      desc = RAPIER.ColliderDesc.trimesh(c.vertices, c.indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
      break;
  }
  return desc.setCollisionGroups(groups(GROUP_WORLD, 0xffff));
}

export { RAPIER };
