import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import type { Collider } from './level.ts';
import { SCALE } from './level.ts';

const WALK_SPEED = 3.5; // m/s, grob an realistischem Gehtempo orientiert
const SPRINT_SPEED = 6.5;
const JUMP_SPEED = 4.5;
const GRAVITY = -9.81;
const STEP_HEIGHT = 0.3;

export class PlayerController {
  readonly controls: PointerLockControls;
  private velocity = new THREE.Vector3();
  private onGround = true;
  private keys = new Set<string>();
  private colliders: Collider[];

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement, colliders: Collider[], spawn: THREE.Vector3) {
    this.controls = new PointerLockControls(camera, domElement);
    this.colliders = colliders;
    camera.position.copy(spawn);

    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  get object(): THREE.Object3D {
    return this.controls.object;
  }

  update(dt: number): void {
    const forward = this.keys.has('KeyW') ? 1 : this.keys.has('KeyS') ? -1 : 0;
    const strafe = this.keys.has('KeyD') ? 1 : this.keys.has('KeyA') ? -1 : 0;
    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = sprinting ? SPRINT_SPEED : WALK_SPEED;

    const camera = this.controls.object;

    // Blickrichtung (nur Yaw) für planare Bewegung, Pitch ignorieren
    const lookDir = new THREE.Vector3();
    camera.getWorldDirection(lookDir);
    lookDir.y = 0;
    lookDir.normalize();
    const rightDir = new THREE.Vector3().crossVectors(lookDir, camera.up).normalize();

    const worldMove = new THREE.Vector3()
      .addScaledVector(lookDir, forward)
      .addScaledVector(rightDir, strafe);
    if (worldMove.lengthSq() > 0) worldMove.normalize();
    worldMove.multiplyScalar(speed);

    this.velocity.x = worldMove.x;
    this.velocity.z = worldMove.z;

    if (this.keys.has('Space') && this.onGround) {
      this.velocity.y = JUMP_SPEED;
      this.onGround = false;
    }

    this.velocity.y += GRAVITY * dt;

    const pos = camera.position;

    // X-Achse bewegen + kollidieren
    pos.x += this.velocity.x * dt;
    this.resolveCollisionsAxis(pos, 'x');

    // Z-Achse bewegen + kollidieren
    pos.z += this.velocity.z * dt;
    this.resolveCollisionsAxis(pos, 'z');

    // Y-Achse: auf höchster Oberfläche unter den Füßen landen
    const prevFeet = pos.y - SCALE.playerHeight;
    pos.y += this.velocity.y * dt;
    const ground = this.groundHeight(pos, prevFeet);
    if (pos.y - SCALE.playerHeight <= ground) {
      pos.y = ground + SCALE.playerHeight;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
  }

  private groundHeight(pos: THREE.Vector3, prevFeet: number): number {
    const r = SCALE.playerRadius;
    let ground = 0;
    for (const c of this.colliders) {
      const top = c.type === 'box' ? c.max.y : c.maxY;
      if (top > prevFeet + STEP_HEIGHT || top <= ground) continue;
      if (c.type === 'box') {
        const cx = THREE.MathUtils.clamp(pos.x, c.min.x, c.max.x);
        const cz = THREE.MathUtils.clamp(pos.z, c.min.z, c.max.z);
        if ((pos.x - cx) ** 2 + (pos.z - cz) ** 2 < r * r) ground = c.max.y;
      } else {
        const d = Math.hypot(pos.x - c.center.x, pos.z - c.center.y);
        if (d < c.radius + r) ground = c.maxY;
      }
    }
    return ground;
  }

  private resolveCollisionsAxis(pos: THREE.Vector3, axis: 'x' | 'z'): void {
    const r = SCALE.playerRadius;
    const feetY = pos.y - SCALE.playerHeight + STEP_HEIGHT;
    const headY = pos.y - 0.1;

    for (const c of this.colliders) {
      if (c.type === 'box') {
        if (feetY >= c.max.y || headY <= c.min.y) continue;
        const closestX = THREE.MathUtils.clamp(pos.x, c.min.x, c.max.x);
        const closestZ = THREE.MathUtils.clamp(pos.z, c.min.z, c.max.z);
        const dx = pos.x - closestX;
        const dz = pos.z - closestZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < r * r) {
          const dist = Math.sqrt(distSq) || 0.0001;
          const push = (r - dist) / dist;
          if (axis === 'x') pos.x += dx * push;
          else pos.z += dz * push;
        }
      } else {
        if (feetY >= c.maxY || headY <= c.minY) continue;
        const dx = pos.x - c.center.x;
        const dz = pos.z - c.center.y;
        const distSq = dx * dx + dz * dz;
        const minDist = r + c.radius;
        if (distSq < minDist * minDist) {
          const dist = Math.sqrt(distSq) || 0.0001;
          const push = (minDist - dist) / dist;
          if (axis === 'x') pos.x += dx * push;
          else pos.z += dz * push;
        }
      }
    }
  }
}
