import * as THREE from 'three';
import { volumeFX } from '../world/volumetrics.ts';

export interface ShotResult {
  hit: boolean;
  point?: THREE.Vector3;
  distance?: number;
  object?: THREE.Object3D;
}

interface Effect {
  object: THREE.Line | THREE.Points;
  ttl: number;
  maxTtl: number;
  velocities?: Float32Array;
  gravity?: number;
}

/** Trifft ein Strahl dieses Objekt? (sichtbar, keine Volumetrik/Hilfsobjekte) */
export function isSolid(o: THREE.Object3D): boolean {
  for (let c: THREE.Object3D | null = o; c; c = c.parent) {
    if (!c.visible || c.userData.noShot || c.userData.editorHelper) return false;
  }
  return !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine && !(o as THREE.Sprite).isSprite;
}

const MUZZLE_OFFSET = new THREE.Vector3(0.16, -0.2, -0.55); // Waffe rechts unterhalb der Brustkamera
const FLASH_TIME = 0.05;
const MAX_HOLES = 80;

export class Shooter {
  private raycaster = new THREE.Raycaster();
  private group = new THREE.Group();
  private effects: Effect[] = [];
  private holes: THREE.Mesh[] = [];
  private flash = new THREE.PointLight(0xffb866, 0, 10, 2);
  private flashTime = 0;
  private holeGeo = new THREE.CircleGeometry(0.02, 12);
  private holeMat = new THREE.MeshStandardMaterial({
    color: 0x0c0c0c,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });

  constructor(
    scene: THREE.Scene,
    private targets: THREE.Object3D[],
  ) {
    scene.add(this.group);
    // Licht existiert dauerhaft (Intensität 0), damit beim ersten Schuss kein Shader-Recompile ruckelt
    scene.add(this.flash);
    // Mündungsfeuer beleuchtet Nebel und Rauch
    volumeFX.addLight(this.flash);
  }

  fire(camera: THREE.Camera, muzzlePos?: THREE.Vector3): ShotResult {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const ray = this.raycaster.ray;
    const muzzle = muzzlePos ?? MUZZLE_OFFSET.clone().applyMatrix4(camera.matrixWorld);

    this.flash.position.copy(muzzle);
    this.flashTime = FLASH_TIME;

    // Unsichtbare und rein optische Objekte (Nebel, Partikel) werden durchschossen
    const hit = this.raycaster.intersectObjects(this.targets, true).find((h) => isSolid(h.object));
    const end = hit ? hit.point : ray.origin.clone().addScaledVector(ray.direction, 120);
    this.spawnTracer(muzzle, end);
    // Schussbahn reißt eine Schneise in Nebel/Rauch, Feuer sprühen Funken
    volumeFX.addShot(muzzle, end);

    if (!hit) return { hit: false };

    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : ray.direction.clone().negate();
    this.spawnHole(hit.point, normal);
    this.spawnImpact(hit.point, normal);

    return { hit: true, point: hit.point.clone(), distance: hit.distance, object: hit.object };
  }

  private spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    // Nur ein kurzes Stück der Flugbahn zeigen, ab etwas Abstand zur Mündung
    const dir = to.clone().sub(from);
    const len = dir.length();
    dir.normalize();
    const start = from.clone().addScaledVector(dir, Math.min(1.5, len * 0.3));
    const geometry = new THREE.BufferGeometry().setFromPoints([start, to]);
    const material = new THREE.LineBasicMaterial({
      color: 0xffe2a0,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.addEffect({ object: new THREE.Line(geometry, material), ttl: 0.04, maxTtl: 0.04 });
  }

  private spawnHole(point: THREE.Vector3, normal: THREE.Vector3): void {
    const hole = new THREE.Mesh(this.holeGeo, this.holeMat);
    hole.position.copy(point).addScaledVector(normal, 0.002);
    hole.lookAt(point.clone().add(normal));
    hole.rotateZ(Math.random() * Math.PI * 2);
    hole.scale.setScalar(0.7 + Math.random() * 0.6);
    this.group.add(hole);
    this.holes.push(hole);
    if (this.holes.length > MAX_HOLES) this.group.remove(this.holes.shift()!);
  }

  private spawnImpact(point: THREE.Vector3, normal: THREE.Vector3): void {
    // Funken: schnell, leuchtend, fallen
    this.addEffect(this.particles(point, normal, 10, 3.5, 1.6, { color: 0xffb04a, size: 0.035, additive: true }, 0.3, 9.81));
    // Staub: langsam, grau, schwebt
    this.addEffect(this.particles(point, normal, 14, 0.7, 0.5, { color: 0x8a8580, size: 0.09, additive: false }, 0.9, 0.6));
  }

  private particles(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    count: number,
    speed: number,
    spread: number,
    look: { color: number; size: number; additive: boolean },
    ttl: number,
    gravity: number,
  ): Effect {
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions.set([point.x, point.y, point.z], i * 3);
      const s = speed * (0.4 + Math.random() * 0.6);
      velocities[i * 3] = normal.x * s + (Math.random() - 0.5) * spread;
      velocities[i * 3 + 1] = normal.y * s + (Math.random() - 0.5) * spread + 0.3;
      velocities[i * 3 + 2] = normal.z * s + (Math.random() - 0.5) * spread;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: look.color,
      size: look.size,
      transparent: true,
      opacity: look.additive ? 1 : 0.5,
      depthWrite: false,
      blending: look.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    return { object: new THREE.Points(geo, mat), ttl, maxTtl: ttl, velocities, gravity };
  }

  private addEffect(effect: Effect): void {
    this.group.add(effect.object);
    this.effects.push(effect);
  }

  update(dt: number): void {
    this.flashTime = Math.max(0, this.flashTime - dt);
    this.flash.intensity = (this.flashTime / FLASH_TIME) * 40;

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.ttl -= dt;
      if (e.ttl <= 0) {
        this.group.remove(e.object);
        e.object.geometry.dispose();
        (e.object.material as THREE.Material).dispose();
        this.effects.splice(i, 1);
        continue;
      }
      if (e.velocities) {
        const attr = e.object.geometry.attributes.position as THREE.BufferAttribute;
        const p = attr.array as Float32Array;
        const v = e.velocities;
        const drag = Math.exp(-2 * dt);
        for (let j = 0; j < v.length; j += 3) {
          v[j] *= drag;
          v[j + 1] = v[j + 1] * drag - (e.gravity ?? 0) * dt;
          v[j + 2] *= drag;
          p[j] += v[j] * dt;
          p[j + 1] += v[j + 1] * dt;
          p[j + 2] += v[j + 2] * dt;
        }
        attr.needsUpdate = true;
        const mat = e.object.material as THREE.PointsMaterial;
        const life = e.ttl / e.maxTtl;
        mat.opacity = mat.blending === THREE.AdditiveBlending ? life : 0.5 * life;
      }
    }
  }
}
