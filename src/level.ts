import * as THREE from 'three';

// Referenz-Maßstab (siehe BodyCam-Entwicklungsplan.md, Phase 1):
// Charaktergröße ~1.8m, Türbreite ~1.0m, Deckungshöhe ~1.2m, Korridorbreite ~2.2m.
export const SCALE = {
  playerHeight: 1.8,
  playerRadius: 0.35,
  doorWidth: 1.0,
  doorHeight: 2.1,
  coverHeight: 1.2,
  corridorWidth: 2.2,
};

export interface BoxCollider {
  type: 'box';
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export interface CylinderCollider {
  type: 'cylinder';
  center: THREE.Vector2; // xz
  radius: number;
  minY: number;
  maxY: number;
}

export type Collider = BoxCollider | CylinderCollider;

const wallMat = new THREE.MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.9 });
const floorMat = new THREE.MeshStandardMaterial({ color: 0x3b3e42, roughness: 1 });
const coverMat = new THREE.MeshStandardMaterial({ color: 0x6b5a45, roughness: 0.85 });
const pillarMat = new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.8 });
const doorFrameMat = new THREE.MeshStandardMaterial({ color: 0x8a7a3a, roughness: 0.7 });

export interface BuiltLevel {
  group: THREE.Group;
  colliders: Collider[];
  spawn: THREE.Vector3;
}

function addBox(
  group: THREE.Group,
  colliders: Collider[],
  center: THREE.Vector3,
  size: THREE.Vector3,
  material: THREE.Material,
  collidable = true,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.position.copy(center);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  if (collidable) {
    colliders.push({
      type: 'box',
      min: new THREE.Vector3(center.x - size.x / 2, center.y - size.y / 2, center.z - size.z / 2),
      max: new THREE.Vector3(center.x + size.x / 2, center.y + size.y / 2, center.z + size.z / 2),
    });
  }
  return mesh;
}

function addCylinder(
  group: THREE.Group,
  colliders: Collider[],
  center: THREE.Vector3,
  radius: number,
  height: number,
  material: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 16), material);
  mesh.position.copy(center);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  colliders.push({
    type: 'cylinder',
    center: new THREE.Vector2(center.x, center.z),
    radius,
    minY: center.y - height / 2,
    maxY: center.y + height / 2,
  });
  return mesh;
}

// Baut einen einfachen Blockout-Rundlauf: Flur -> Raum A (Deckung) -> Raum B (Pfeiler) -> zurück zum Flur.
// Alles Primitive, keine finalen Assets — reine Maß- und Sichtlinien-Validierung.
export function buildLevel(): BuiltLevel {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const wallHeight = 3;
  const wallThickness = 0.3;

  // Boden
  const floorSize = 40;
  addBox(
    group,
    colliders,
    new THREE.Vector3(0, -0.05, 0),
    new THREE.Vector3(floorSize, 0.1, floorSize),
    floorMat,
  );

  // Außenwände des Gesamtareals (grobe Box-Umgrenzung)
  const half = floorSize / 2;
  addBox(group, colliders, new THREE.Vector3(0, wallHeight / 2, -half), new THREE.Vector3(floorSize, wallHeight, wallThickness), wallMat);
  addBox(group, colliders, new THREE.Vector3(0, wallHeight / 2, half), new THREE.Vector3(floorSize, wallHeight, wallThickness), wallMat);
  addBox(group, colliders, new THREE.Vector3(-half, wallHeight / 2, 0), new THREE.Vector3(wallThickness, wallHeight, floorSize), wallMat);
  addBox(group, colliders, new THREE.Vector3(half, wallHeight / 2, 0), new THREE.Vector3(wallThickness, wallHeight, floorSize), wallMat);

  // Flur (Korridor) entlang Z, Breite = SCALE.corridorWidth, mit Türdurchgang in eine Wand
  const corridorLength = 10;
  const corridorZStart = -half + corridorLength / 2 + wallThickness;
  addBox(
    group,
    colliders,
    new THREE.Vector3(-SCALE.corridorWidth / 2 - wallThickness / 2, wallHeight / 2, corridorZStart),
    new THREE.Vector3(wallThickness, wallHeight, corridorLength),
    wallMat,
  );
  addBox(
    group,
    colliders,
    new THREE.Vector3(SCALE.corridorWidth / 2 + wallThickness / 2, wallHeight / 2, corridorZStart),
    new THREE.Vector3(wallThickness, wallHeight, corridorLength),
    wallMat,
  );

  // Türrahmen am Ende des Flurs (lichte Breite = doorWidth, Höhe = doorHeight)
  const doorZ = corridorZStart + corridorLength / 2 + wallThickness / 2;
  const roomAHalfWidth = 6;
  const frameWallHeightAbove = wallHeight - SCALE.doorHeight;
  const segWidth = roomAHalfWidth - SCALE.doorWidth / 2;
  for (const side of [-1, 1]) {
    addBox(
      group,
      colliders,
      new THREE.Vector3(side * (SCALE.doorWidth / 2 + segWidth / 2), wallHeight / 2, doorZ),
      new THREE.Vector3(segWidth, wallHeight, wallThickness),
      doorFrameMat,
    );
  }
  addBox(
    group,
    colliders,
    new THREE.Vector3(0, SCALE.doorHeight + frameWallHeightAbove / 2, doorZ),
    new THREE.Vector3(SCALE.doorWidth, frameWallHeightAbove, wallThickness),
    doorFrameMat,
  );

  // Raum A: Deckungsobjekte in Würfel-/Boxform, Höhe = coverHeight, zum Sichtlinien-Testen
  const roomACenterZ = doorZ + 7;
  for (const [x, z] of [[-2.5, -1], [2.5, 1], [0, 3]] as const) {
    addBox(
      group,
      colliders,
      new THREE.Vector3(x, SCALE.coverHeight / 2, roomACenterZ + z),
      new THREE.Vector3(1.4, SCALE.coverHeight, 0.6),
      coverMat,
    );
  }

  // Raum B: Pfeiler (Zylinder) für Line-of-Sight-Breaking, Nebel-Sichttest
  const roomBCenterZ = roomACenterZ + 9;
  const pillarPositions: [number, number][] = [
    [-3, roomBCenterZ - 2],
    [3, roomBCenterZ - 2],
    [-3, roomBCenterZ + 2],
    [3, roomBCenterZ + 2],
  ];
  for (const [x, z] of pillarPositions) {
    addCylinder(group, colliders, new THREE.Vector3(x, wallHeight / 2, z), 0.5, wallHeight, pillarMat);
  }

  // Referenz-Würfel (1m Kantenlänge) zur visuellen Maßstabsprüfung
  addBox(group, colliders, new THREE.Vector3(-4, 0.5, roomACenterZ - 3), new THREE.Vector3(1, 1, 1), coverMat);

  // Referenz-Charakter (1.8m Box) neben der Tür
  addBox(
    group,
    colliders,
    new THREE.Vector3(1.5, SCALE.playerHeight / 2, doorZ + 1),
    new THREE.Vector3(SCALE.playerRadius * 2, SCALE.playerHeight, SCALE.playerRadius * 2),
    new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.8 }),
  );

  return {
    group,
    colliders,
    spawn: new THREE.Vector3(0, SCALE.playerHeight, -half + 3),
  };
}
