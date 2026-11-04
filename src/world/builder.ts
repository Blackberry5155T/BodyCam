import * as THREE from 'three';
import type { Collider } from './collision.ts';
import { setupLightShadow } from './lightShadow.ts';

// Werkzeuge zum Bauen von Maps aus Primitiven: Boxen/Zylinder mit Collidern,
// Lampen mit optionalem Flackern, Welt-skalierte UVs. Jede Map in src/maps/ nutzt den MapBuilder.

/** Ergebnis eines Map-Aufbaus, wie es main.ts erwartet */
export interface BuiltMap {
  group: THREE.Group;
  colliders: Collider[];
  spawn: THREE.Vector3;
  update(dt: number): void;
}

export interface LampOptions {
  color: number;
  intensity: number;
  distance: number;
  size: THREE.Vector3;
  shadow?: boolean;
  flicker?: boolean;
}

interface Lamp {
  light: THREE.PointLight;
  tube: THREE.MeshStandardMaterial;
  baseIntensity: number;
  baseEmissive: number;
  flicker: boolean;
  on: boolean;
  timer: number;
}

const LAMP_EMISSIVE = 6;
const fixtureMat = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.5, metalness: 0.6 });

// Welt-skalierte UVs: Texturen kacheln über Box-Grenzen hinweg nahtlos (1 Textur = 2m)
export function applyWorldUV(geo: THREE.BufferGeometry, center: THREE.Vector3, scale = 0.5): void {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i) + center.x;
    const py = pos.getY(i) + center.y;
    const pz = pos.getZ(i) + center.z;
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);
    let u: number;
    let v: number;
    if (Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz)) {
      u = nx > 0 ? -pz : pz;
      v = py;
    } else if (Math.abs(ny) >= Math.abs(nz)) {
      u = px;
      v = ny > 0 ? -pz : pz;
    } else {
      u = nz > 0 ? px : -px;
      v = py;
    }
    uv.setXY(i, u * scale, v * scale);
  }
  uv.needsUpdate = true;
}

export class MapBuilder {
  readonly group = new THREE.Group();
  readonly colliders: Collider[] = [];
  private lamps: Lamp[] = [];

  box(
    center: THREE.Vector3,
    size: THREE.Vector3,
    material: THREE.Material,
    opts: { collidable?: boolean; castShadow?: boolean } = {},
  ): THREE.Mesh {
    const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
    applyWorldUV(geo, center);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(center);
    mesh.castShadow = opts.castShadow ?? true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    if (opts.collidable ?? true) {
      this.colliders.push({
        type: 'box',
        min: new THREE.Vector3(center.x - size.x / 2, center.y - size.y / 2, center.z - size.z / 2),
        max: new THREE.Vector3(center.x + size.x / 2, center.y + size.y / 2, center.z + size.z / 2),
      });
    }
    return mesh;
  }

  cylinder(center: THREE.Vector3, radius: number, height: number, material: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 32), material);
    mesh.position.copy(center);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.colliders.push({
      type: 'cylinder',
      center: new THREE.Vector2(center.x, center.z),
      radius,
      minY: center.y - height / 2,
      maxY: center.y + height / 2,
    });
    return mesh;
  }

  /** Leuchtstoffröhre/Lampe: Gehäuse + emissive Röhre (für Bloom) + PointLight */
  lamp(pos: THREE.Vector3, opts: LampOptions): void {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(opts.size.x + 0.06, 0.05, opts.size.z + 0.06), fixtureMat);
    housing.position.copy(pos).add(new THREE.Vector3(0, 0.03, 0));
    this.group.add(housing);

    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: opts.color,
      emissiveIntensity: LAMP_EMISSIVE,
      roughness: 0.3,
    });
    const tube = new THREE.Mesh(new THREE.BoxGeometry(opts.size.x, opts.size.y, opts.size.z), tubeMat);
    tube.position.copy(pos);
    this.group.add(tube);

    const light = new THREE.PointLight(opts.color, opts.intensity, opts.distance, 2);
    light.position.copy(pos).add(new THREE.Vector3(0, -0.12, 0));
    if (opts.shadow) setupLightShadow(light);
    this.group.add(light);

    this.lamps.push({
      light,
      tube: tubeMat,
      baseIntensity: opts.intensity,
      baseEmissive: LAMP_EMISSIVE,
      flicker: !!opts.flicker,
      on: true,
      timer: 1,
    });
  }

  finish(spawn: THREE.Vector3): BuiltMap {
    const lamps = this.lamps;
    return {
      group: this.group,
      colliders: this.colliders,
      spawn,
      update(dt: number) {
        for (const l of lamps) {
          if (l.flicker) {
            l.timer -= dt;
            if (l.timer <= 0) {
              l.on = !l.on;
              // Meist an, gelegentlich kurze Aussetzer — teils als schnelle Serie
              l.timer = l.on ? (Math.random() < 0.3 ? 0.05 : 0.4 + Math.random() * 3) : 0.03 + Math.random() * 0.12;
            }
          }
          const k = l.on ? 1 : 0.04;
          l.light.intensity = l.baseIntensity * k;
          l.tube.emissiveIntensity = l.baseEmissive * k;
        }
      },
    };
  }
}
