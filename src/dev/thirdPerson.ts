import * as THREE from 'three';
import { RAPIER, WORLD_QUERY, type PhysicsWorld } from '../physics/physics.ts';

// Developer-Werkzeug: Third-Person-Ansicht zum Prüfen von Körper-Animationen, Schatten und Lampe.
// Nur zum Rendern — Spiellogik (Schießen, Zielstrahl, Lampe) nutzt weiter die Bodycam-Pose.
// Die Kamera wird vor dem Rendern versetzt und danach wiederhergestellt.

const DISTANCE = 2.8;
const SHOULDER = 0.45; // seitlicher Versatz nach rechts (Über-die-Schulter)
const LIFT = 0.25; // Pivot leicht über Augenhöhe
const WALL_MARGIN = 0.2;
const MIN_DIST = 0.4;
const ZOOM_MIN = 1;
const ZOOM_MAX = 12;

export class ThirdPersonCam {
  enabled = false;
  private distance = DISTANCE;
  private savedPos = new THREE.Vector3();
  private savedQuat = new THREE.Quaternion();
  private pivot = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  constructor(private physics: PhysicsWorld) {}

  toggle(): boolean {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  /** Abstand ändern (Alt+Mausrad) */
  zoom(delta: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance * (delta > 0 ? 1.12 : 1 / 1.12), ZOOM_MIN, ZOOM_MAX);
  }

  /** Kamera hinter den Spieler setzen (Blickrichtung bleibt die der Bodycam) */
  apply(camera: THREE.PerspectiveCamera, eye: THREE.Vector3): void {
    this.savedPos.copy(camera.position);
    this.savedQuat.copy(camera.quaternion);
    this.pivot.copy(eye);
    this.pivot.y += LIFT;

    // Rechts- und Rückwärtsvektor der Kamera
    const q = camera.quaternion;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    this.dir.copy(back).multiplyScalar(this.distance).addScaledVector(right, SHOULDER);
    const len = this.dir.length();
    this.dir.divideScalar(len);

    // Nicht durch Wände schauen: Strahl vom Pivot zur Wunschposition
    this.ray.origin = { x: this.pivot.x, y: this.pivot.y, z: this.pivot.z };
    this.ray.dir = { x: this.dir.x, y: this.dir.y, z: this.dir.z };
    const hit = this.physics.world.castRay(this.ray, len, true, undefined, WORLD_QUERY);
    const dist = hit ? Math.max(MIN_DIST, hit.timeOfImpact - WALL_MARGIN) : len;

    camera.position.copy(this.pivot).addScaledVector(this.dir, dist);
    camera.updateMatrixWorld();
  }

  /** Bodycam-Pose zurücksetzen (nach dem Rendern) */
  restore(camera: THREE.PerspectiveCamera): void {
    camera.position.copy(this.savedPos);
    camera.quaternion.copy(this.savedQuat);
    camera.updateMatrixWorld();
  }
}
