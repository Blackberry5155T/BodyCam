import * as THREE from 'three';

/**
 * Schattenkarten von Lampen (Punkt-/Spotlichter) nur so oft neu rendern, wie man es sieht.
 * three rendert sonst JEDE Schattenkarte in JEDEM Frame – ein Punktlicht kostet sechs Szenen-Durchläufe.
 *
 *  - nah an der Kamera und im Bild: jeden Frame
 *  - weiter weg: jeden 2. bzw. 4. Frame (versetzt, damit nicht alle im selben Frame fällig sind)
 *  - Lichtkugel außerhalb des Sichtfelds: selten
 *  - ausgeschaltet oder komplett hinter dem Distanznebel: gar nicht
 *
 * Die Karte bleibt dazwischen gültig (statische Geometrie ändert sich nicht); nur Schatten bewegter Objekte
 * hängen bei fernen Lampen ein paar Frames nach. Die Sonne (Kaskaden folgen der Kamera) und ausgenommene
 * Lichter (Taschenlampe) laufen weiter in jedem Frame.
 */

type LocalLight = THREE.PointLight | THREE.SpotLight;

const _pos = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();

export class ShadowScheduler {
  private lights: LocalLight[] = [];
  private exclude = new Set<THREE.Object3D>();
  private frame = 0;
  private scanTimer = 0;

  constructor(
    private scene: THREE.Scene,
    exclude: THREE.Object3D[] = [],
  ) {
    for (const o of exclude) this.exclude.add(o);
  }

  /** Lichter neu einsammeln (Modelle und Effekte entstehen auch nach dem Laden) */
  private scan(): void {
    this.lights.length = 0;
    this.scene.traverse((o) => {
      const l = o as THREE.Object3D & { isPointLight?: boolean; isSpotLight?: boolean };
      if ((!l.isPointLight && !l.isSpotLight) || !l.castShadow || this.exclude.has(l)) return;
      this.lights.push(l as LocalLight);
    });
  }

  /** Vor dem Rendern: legt fest, welche Schattenkarten dieser Frame erneuert. viewDistance = Sichtweite (Nebel). */
  update(camera: THREE.Camera, dt: number, viewDistance: number): void {
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = 1;
      this.scan();
    }
    this.frame++;
    camera.getWorldPosition(_cam);
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, camera.reversedDepth);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const s = l.shadow;
      s.autoUpdate = false;
      if (!s.map) {
        // noch keine Karte (neu, Qualität geändert): sofort
        s.needsUpdate = true;
        continue;
      }
      if (l.intensity <= 0.001) continue;
      l.getWorldPosition(_pos);
      const range = l.distance > 0 ? l.distance : 40;
      const d = _pos.distanceTo(_cam);
      if (d - range > viewDistance * 1.15) continue;
      let every: number;
      if (!_frustum.intersectsSphere(_sphere.set(_pos, range))) every = 10;
      else if (d < range + 6) every = 1;
      else if (d < range + 22) every = 2;
      else every = 4;
      if ((this.frame + i * 3) % every === 0) s.needsUpdate = true;
    }
  }

  /** Alle Lichter wieder in jedem Frame (z. B. beim Abschalten) */
  release(): void {
    for (const l of this.lights) l.shadow.autoUpdate = true;
  }
}
