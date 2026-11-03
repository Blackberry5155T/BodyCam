import * as THREE from 'three';

export interface ShotResult {
  hit: boolean;
  point?: THREE.Vector3;
  distance?: number;
}

export class Shooter {
  private raycaster = new THREE.Raycaster();
  private tracerGroup: THREE.Group;
  private hitMarkers: { mesh: THREE.Mesh | THREE.Line; ttl: number }[] = [];

  constructor(scene: THREE.Scene, private targets: THREE.Object3D[]) {
    this.tracerGroup = new THREE.Group();
    scene.add(this.tracerGroup);
  }

  fire(camera: THREE.Camera): ShotResult {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersections = this.raycaster.intersectObjects(this.targets, true);
    const origin = this.raycaster.ray.origin.clone();

    if (intersections.length === 0) {
      return { hit: false };
    }

    const hit = intersections[0];
    this.spawnTracer(origin, hit.point);
    this.spawnHitMarker(hit.point, hit.face?.normal);

    return { hit: true, point: hit.point.clone(), distance: hit.distance };
  }

  private spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    const material = new THREE.LineBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.8 });
    const line = new THREE.Line(geometry, material);
    this.tracerGroup.add(line);
    this.hitMarkers.push({ mesh: line, ttl: 0.06 });
  }

  private spawnHitMarker(point: THREE.Vector3, normal?: THREE.Vector3): void {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xff5533 }),
    );
    marker.position.copy(point);
    if (normal) marker.position.addScaledVector(normal, 0.01);
    this.tracerGroup.add(marker);
    this.hitMarkers.push({ mesh: marker, ttl: 1.2 });
  }

  update(dt: number): void {
    for (let i = this.hitMarkers.length - 1; i >= 0; i--) {
      const m = this.hitMarkers[i];
      m.ttl -= dt;
      if (m.ttl <= 0) {
        this.tracerGroup.remove(m.mesh);
        m.mesh.geometry.dispose();
        (m.mesh.material as THREE.Material).dispose();
        this.hitMarkers.splice(i, 1);
      }
    }
  }
}
