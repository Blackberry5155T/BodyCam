import * as THREE from 'three';
import { SCALE } from '../world/collision.ts';
import { setupLightShadow } from '../world/lightShadow.ts';
import { RAPIER, WORLD_QUERY, type PhysicsWorld } from '../physics/physics.ts';

// Blockout-Spielerkörper aus Würfeln mit Gelenk-Hierarchie (Pivot = Gelenk, Würfel hängt daran).
// Die Gelenknamen/-struktur entsprechen einem üblichen Humanoid-Rig, damit später ein echtes
// Modell mit Bones dieselben prozeduralen Animationen übernehmen kann.
//
// Konvention: Körper schaut nach -Z. rotation.x > 0 schwingt ein hängendes Glied nach vorn
// (bei nach oben zeigenden Gliedern wie dem Rumpf: nach hinten).
//
// Animation:
// - Beine: Fußziele aus dem Schrittzyklus, per Raycast auf den Boden gesetzt (Treppen, Hänge),
//   Becken senkt sich, falls ein Fuß tiefer steht; analytische 2-Glied-IK, Fuß folgt der Bodennormale.
// - Arme: Hand-Zielpunkte im Blickrahmen (Hüfte, Anschlag, Low-Ready, Sprint, Deckung), 2-Glied-IK
//   von der Schulter aus. Die Pistole zeigt auf den Blickpunkt, verkantet beim seitlichen Vorbeugen.

export type BodyCover = 'none' | 'over' | 'left' | 'right' | 'blocked';

export interface BodyAnimState {
  eye: THREE.Vector3; // Augenposition (Kollisionskörper)
  eyeHeight: number;
  yaw: number;
  pitch: number;
  velocity: THREE.Vector3;
  onGround: boolean;
  phase: number; // Schrittphase, π pro Schritt
  walk: number; // 0 = Stand, 1 = Gehen, 2 = Sprint
  sprinting: boolean;
  landing: number; // Landefeder (negativ = eingefedert)
  time: number;
  aim: number; // 0 = Hüfthaltung, 1 = Waffe im Anschlag (rechte Maustaste)
  lean: number; // seitliches Vorbeugen der Kamera in m (+ = rechts)
  crouching: boolean; // Schleich-Taste gehalten
  cover: BodyCover; // Deckungszustand (über Kante / seitlich vorbeugen)
  water: number; // Wassertiefe an den Füßen (m, 0 = trocken)
  swim: number; // 0..1 Schwimmen
}

/** Nasse Kleidung: unterhalb der Wasserlinie (Welt-Y) dunkler und glänzender */
function patchWet(mat: THREE.MeshStandardMaterial, wetY: { value: number }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWetY = wetY;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWetH;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWetH = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWetH;\nuniform float uWetY;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nfloat wetK = smoothstep(uWetY + 0.04, uWetY - 0.04, vWetH);\ndiffuseColor.rgb *= mix(1.0, 0.5, wetK);',
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.3, wetK);');
  };
  mat.customProgramCacheKey = () => 'body-wet';
}

const STAND_EYE = SCALE.playerHeight; // Augenhöhe stehend (wie im Controller)
const ANKLE_HEIGHT = 0.08;
const LEAN_REF = 0.5; // volle seitliche Vorbeuge (wie LEAN_DIST im Controller)

interface Limb {
  joint: THREE.Object3D;
  mesh: THREE.Mesh;
}

interface Side {
  thigh: Limb;
  shin: Limb;
  foot: Limb;
  upperArm: Limb;
  forearm: Limb;
  hand: Limb;
}

/** Bodenkontakt je Fuß (Weltkoordinaten, gedämpft gegen Sprünge an Stufenkanten) */
interface FootGround {
  y: number;
  normal: THREE.Vector3;
  init: boolean;
}

const DIM = {
  hipHeight: 0.92,
  hipWidth: 0.1,
  thigh: new THREE.Vector3(0.15, 0.42, 0.16),
  shin: new THREE.Vector3(0.12, 0.42, 0.13),
  foot: new THREE.Vector3(0.11, 0.08, 0.27),
  torso: new THREE.Vector3(0.4, 0.55, 0.24),
  head: new THREE.Vector3(0.22, 0.26, 0.24),
  shoulderWidth: 0.25,
  upperArm: new THREE.Vector3(0.1, 0.3, 0.1),
  forearm: new THREE.Vector3(0.09, 0.27, 0.09),
  hand: new THREE.Vector3(0.085, 0.1, 0.045),
};

const L_THIGH = DIM.thigh.y;
const L_SHIN = DIM.shin.y;
const L_LEG = L_THIGH + L_SHIN;
const L_UPPER = DIM.upperArm.y;
const L_FORE = DIM.forearm.y;

// Bodenabtastung unter den Füßen
const PROBE_UP = 0.5; // Strahl startet so weit über der Fußsohle der Kapsel
const PROBE_DOWN = 0.6; // … und reicht so weit darunter
const MAX_FOOT_RISE = 0.4; // höhere Treffer sind Hindernisse, keine Stufen
const BALL_Z = -0.11; // Fußballen relativ zum Knöchel (lokal, -Z = vorn): bestimmt die Stufe
const HEEL_Z = 0.06; // Ferse/Zehe (Abrollen); in der Schwungphase zusätzlich vorausschauen
const TOE_Z = -0.2;
const SWING_AHEAD = -0.3; // Schwungfuß hebt sich schon vor der Stufenkante
// Rumpf: um diese Höhe über der Hüfte bleibt die Brust beim Vorbeugen stehen (Hüfte geht nach hinten),
// damit der Rumpf nicht vor die Brustkamera kippt
const CHEST_PIVOT = 0.55;
// Arme: Drehpunkt des Zielrahmens = Schulterlinie (unter dem Auge)
const SHOULDER_DROP = DIM.hipHeight + DIM.torso.y - 0.04 - STAND_EYE; // negativ: unter Augenhöhe
const AIM_DISTANCE = 15; // Konvergenzpunkt der Waffe auf der Blickachse
const CAMERA_DROP = 0.3; // wie im Controller

const FLASHLIGHT_INTENSITY = 45;
const NPC_FLASHLIGHT_INTENSITY = 30;

/** Trefferzone eines Körperteils (userData.hitZone), für Schadensberechnung */
export type HitZone = 'head' | 'torso' | 'limb';

export interface BodyOptions {
  /** NPC-Körper: eigene Farben, sichtbarer Kopf, Taschenlampe ohne Schatten (spart Shadow-Pässe) */
  npc?: boolean;
}

const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

function limb(parent: THREE.Object3D, pivot: THREE.Vector3, size: THREE.Vector3, mat: THREE.Material, name: string, meshOffset = new THREE.Vector3()): Limb {
  const joint = new THREE.Object3D();
  joint.name = name;
  joint.position.copy(pivot);
  joint.rotation.order = 'YXZ';
  parent.add(joint);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
  mesh.position.set(0, -size.y / 2, 0).add(meshOffset);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  joint.add(mesh);
  return { joint, mesh };
}

function box(parent: THREE.Object3D, size: [number, number, number], pos: [number, number, number], mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  m.position.set(...pos);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** Weltrotation eines Glieds, dessen lokale -Y-Achse entlang `dir` zeigt; `xHint` legt die Drehung um die Achse fest */
function boneQuat(out: THREE.Quaternion, dir: THREE.Vector3, xHint: THREE.Vector3): THREE.Quaternion {
  _by.copy(dir).normalize().negate();
  _bx.copy(xHint).addScaledVector(_by, -xHint.dot(_by));
  if (_bx.lengthSq() < 1e-8) _bx.set(1, 0, 0).addScaledVector(_by, -_by.x);
  _bx.normalize();
  _bz.crossVectors(_bx, _by);
  _m.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_m);
}

/** Rotation aus Achsen: X = oben (Waffe), -Y = vorn (Lauf) */
function gripQuat(out: THREE.Quaternion, forward: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  _by.copy(forward).negate();
  _bx.copy(up).addScaledVector(_by, -up.dot(_by)).normalize();
  _bz.crossVectors(_bx, _by);
  _m.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_m);
}

export class PlayerBody {
  readonly root = new THREE.Group();
  readonly flashlight: THREE.SpotLight;
  private hips: THREE.Object3D;
  private torso: Limb;
  private neck: THREE.Object3D;
  private left: Side;
  private right: Side;
  private torch: THREE.Group;
  private torchLens: THREE.MeshStandardMaterial;
  private torchMeshes: THREE.Mesh[] = [];
  private muzzle = new THREE.Object3D();
  private head: THREE.Mesh;
  private headHidden: THREE.Material;
  private headVisible: THREE.Material;
  private flashTarget = new THREE.Object3D();
  private aimPoint = new THREE.Vector3();

  private flashlightOn = true;
  private flashBlend = 1; // 0 = linke Hand stützt Waffe, 1 = linke Hand hält Lampe
  private airBlend = 0;
  private sprintBlend = 0;
  private relaxed = false;
  private relaxBlend = 0; // 1 = Arme locker hängend (z. B. am Terminal)
  private recoil = 0;
  private recoilVel = 0;
  private fireHold = 0; // nach einem Schuss kurz im Anschlag bleiben (auch aus Low-Ready/Sprint)
  private fireBlend = 0;
  private coverOver = 0; // 1 = zielt über eine Deckungskante
  private readyBlend = 0; // 1 = Low-Ready (geduckt, nicht zielend)

  // Beine
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private ground: [FootGround, FootGround] = [
    { y: 0, normal: new THREE.Vector3(0, 1, 0), init: false },
    { y: 0, normal: new THREE.Vector3(0, 1, 0), init: false },
  ];
  private pelvisDrop = 0;
  private legPhase = 0; // Gangphase der Beine, π pro Schritt
  private gait = 0; // 0 = Stand, 1 = Gangzyklus aktiv
  private grade = 0; // Steigung entlang der Bewegung (Höhe/Strecke), Treppen und Hänge
  private lastRootY = Number.NaN;
  private lampIntensity = FLASHLIGHT_INTENSITY;
  private meshes: THREE.Mesh[] = [];
  /** Wasserlinie der nassen Kleidung (Welt-Y), trocknet langsam ab */
  private wetY = { value: -1e4 };
  private wetH = -1;

  constructor(
    scene: THREE.Scene,
    private physics: PhysicsWorld | null = null,
    opts: BodyOptions = {},
  ) {
    const npc = !!opts.npc;
    const jacket = new THREE.MeshStandardMaterial({ color: npc ? 0x4a4632 : 0x2a3038, roughness: 0.85 });
    const vest = new THREE.MeshStandardMaterial({ color: npc ? 0x5a4a30 : 0x23282b, roughness: 0.8 });
    const pants = new THREE.MeshStandardMaterial({ color: npc ? 0x3a3a2c : 0x2c2f33, roughness: 0.9 });
    const gloves = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.7 });
    const boots = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.6 });
    for (const m of [jacket, vest, pants, gloves, boots]) patchWet(m, this.wetY);
    // Kopf: in der eigenen Kamera unsichtbar, wirft aber Schatten
    // (Shadow-Pass nutzt eigenes Depth-Material, colorWrite/depthWrite werden dort ignoriert)
    const shadowOnly = new THREE.MeshStandardMaterial({ colorWrite: false, depthWrite: false });

    this.hips = new THREE.Object3D();
    this.hips.name = 'hips';
    this.hips.position.y = DIM.hipHeight;
    this.root.add(this.hips);

    // Rumpf (Gelenk an der Hüfte, Würfel nach oben)
    this.torso = limb(this.hips, new THREE.Vector3(), DIM.torso, vest, 'spine', new THREE.Vector3(0, DIM.torso.y, 0));
    this.neck = new THREE.Object3D();
    this.neck.name = 'neck';
    this.neck.position.y = DIM.torso.y + 0.04;
    this.neck.rotation.order = 'YXZ';
    this.torso.joint.add(this.neck);
    const head = new THREE.Mesh(new THREE.BoxGeometry(DIM.head.x, DIM.head.y, DIM.head.z), shadowOnly);
    head.position.y = DIM.head.y / 2;
    head.castShadow = true;
    this.neck.add(head);
    this.head = head;
    this.headHidden = shadowOnly;
    this.headVisible = new THREE.MeshStandardMaterial({ color: 0x8a6f5c, roughness: 0.8 });

    const makeSide = (s: 1 | -1): Side => {
      const thigh = limb(this.hips, new THREE.Vector3(s * DIM.hipWidth, 0, 0), DIM.thigh, pants, `thigh_${s}`);
      // IK: erst in der Beinebene beugen (X), dann die Ebene seitlich kippen (Z)
      thigh.joint.rotation.order = 'ZXY';
      const shin = limb(thigh.joint, new THREE.Vector3(0, -DIM.thigh.y, 0), DIM.shin, pants, `shin_${s}`);
      const foot = limb(shin.joint, new THREE.Vector3(0, -DIM.shin.y, 0), DIM.foot, boots, `foot_${s}`, new THREE.Vector3(0, 0, -0.06));
      const shoulder = new THREE.Vector3(s * DIM.shoulderWidth, DIM.torso.y - 0.04, 0);
      const upperArm = limb(this.torso.joint, shoulder, DIM.upperArm, jacket, `upperArm_${s}`);
      const forearm = limb(upperArm.joint, new THREE.Vector3(0, -DIM.upperArm.y, 0), DIM.forearm, jacket, `forearm_${s}`);
      const hand = limb(forearm.joint, new THREE.Vector3(0, -DIM.forearm.y, 0), DIM.hand, gloves, `hand_${s}`);
      return { thigh, shin, foot, upperArm, forearm, hand };
    };
    this.left = makeSide(-1);
    this.right = makeSide(1);

    // Pistole (Blockout) in der rechten Hand. Hand-Achsen beim Zielen: -Y = Lauf, +X = oben, Z = seitlich
    const steel = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.42, metalness: 0.65 });
    const polymer = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.75, metalness: 0.1 });
    const gun = new THREE.Group();
    gun.name = 'pistol';
    this.right.hand.joint.add(gun);
    box(gun, [0.034, 0.19, 0.027], [0.06, -0.08, 0], steel); // Schlitten
    box(gun, [0.02, 0.13, 0.024], [0.034, -0.075, 0], polymer); // Rahmen
    box(gun, [0.11, 0.036, 0.025], [-0.008, -0.03, 0], polymer); // Griff (steckt in der Faust)
    box(gun, [0.026, 0.006, 0.012], [0.012, -0.112, 0], polymer); // Abzugsbügel vorn
    box(gun, [0.008, 0.012, 0.006], [0.081, -0.165, 0], steel); // Korn
    this.muzzle.position.set(0.06, -0.178, 0);
    gun.add(this.muzzle);

    // Taschenlampe in der linken Hand; richtet sich per lookAt auf den (verzögerten) Zielpunkt aus
    this.torch = new THREE.Group();
    this.torch.position.set(0, -DIM.hand.y * 0.6, -0.02);
    this.left.hand.joint.add(this.torch);
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.022, 0.15, 12),
      new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.4, metalness: 0.7 }),
    );
    body.rotation.x = Math.PI / 2; // Achse entlang +Z (lookAt-Richtung)
    body.castShadow = true;
    this.torch.add(body);
    this.torchMeshes.push(body);
    this.torchLens = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff0dc, emissiveIntensity: 4 });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.02, 12), this.torchLens);
    lens.position.z = 0.0755;
    this.torch.add(lens);
    this.torchMeshes.push(lens);

    // Spotlight bleibt immer in der Szene, nur Intensität wird geschaltet → kein Shader-Recompile
    this.lampIntensity = npc ? NPC_FLASHLIGHT_INTENSITY : FLASHLIGHT_INTENSITY;
    this.flashlight = new THREE.SpotLight(0xfff0dc, this.lampIntensity, 30, 0.42, 0.55, 2);
    this.flashlight.position.z = 0.09;
    if (!npc) {
      setupLightShadow(this.flashlight, 1024);
      this.flashlight.shadow.radius = 1;
    }
    this.torch.add(this.flashlight);
    this.flashlight.target = this.flashTarget;
    scene.add(this.flashTarget);

    scene.add(this.root);

    // Trefferzonen: Kopf, Rumpf, sonst Gliedmaßen/Ausrüstung
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      this.meshes.push(m);
      m.userData.hitZone = m === head ? 'head' : m === this.torso.mesh ? 'torso' : 'limb';
    });
    if (npc) this.setThirdPerson(true);
  }

  /** Körper ein-/ausblenden (Pool für NPCs). Das Licht bleibt in der Szene (nur Intensität 0) → kein Shader-Recompile */
  setHidden(hidden: boolean): void {
    for (const m of this.meshes) m.visible = !hidden;
    if (hidden) {
      this.flashlight.intensity = 0;
      this.torchLens.emissiveIntensity = 0;
    }
  }

  setFlashlight(on: boolean): void {
    this.flashlightOn = on;
  }

  /** Körper-Pose zurücksetzen (Respawn: Füße/Schrittphase neu aufsetzen) */
  resetPose(): void {
    this.ground[0].init = false;
    this.ground[1].init = false;
    this.lastRootY = Number.NaN;
    this.aimPoint.set(0, 0, 0);
    this.pelvisDrop = 0;
    this.root.rotation.set(0, 0, 0);
  }

  /** Dev-Third-Person: Kopf sichtbar machen (in der Bodycam nur Schatten) */
  setThirdPerson(on: boolean): void {
    this.head.material = on ? this.headVisible : this.headHidden;
  }

  setRelaxed(relaxed: boolean): void {
    this.relaxed = relaxed;
  }

  toggleFlashlight(): void {
    this.flashlightOn = !this.flashlightOn;
  }

  get isFlashlightOn(): boolean {
    return this.flashlightOn;
  }

  /** Rückstoß-Impuls für die Arme; Waffe kommt kurz in den Anschlag */
  kick(): void {
    this.recoilVel += 9;
    this.fireHold = 0.9;
  }

  /** Mündungsposition der Pistole in Weltkoordinaten */
  getMuzzle(_camera: THREE.Camera, out = new THREE.Vector3()): THREE.Vector3 {
    return this.muzzle.getWorldPosition(out);
  }

  update(dt: number, s: BodyAnimState, camera: THREE.Camera): void {
    const t = s.time;

    // --- Wurzel: Füße auf Boden, dreht mit Blick-Yaw ---
    // Beim Vorbeugen wandert der Körper halb mit, den Rest übernimmt die Rumpfneigung
    const rightX = Math.cos(s.yaw);
    const rightZ = -Math.sin(s.yaw);
    const leanShift = s.lean * 0.5;
    this.root.position.set(s.eye.x + rightX * leanShift, s.eye.y - s.eyeHeight, s.eye.z + rightZ * leanShift);
    this.root.rotation.y = s.yaw;

    // Steigung aus der Höhenänderung der Füße (Autostep auf Treppen, Hänge) relativ zur Laufstrecke
    const rootY = this.root.position.y;
    const planar = Math.hypot(s.velocity.x, s.velocity.z);
    if (dt > 0) {
      const dy = rootY - this.lastRootY;
      const g = Number.isFinite(dy) && Math.abs(dy) < 0.5 && s.onGround && planar > 0.3 ? clamp(dy / dt / planar, -1, 1) : 0;
      this.grade = damp(this.grade, g, 5, dt);
    }
    this.lastRootY = rootY;

    // Nasse Kleidung: Wasserlinie (relativ zu den Füßen) folgt sofort nach oben, trocknet langsam (Saugeffekt +5 cm)
    this.wetH = Math.max(this.wetH - dt * 0.015, s.water > 0.02 ? s.water + 0.05 : -1);
    this.wetY.value = rootY + this.wetH;

    // --- Zustandsblends ---
    this.airBlend = damp(this.airBlend, s.onGround ? 0 : 1, 10, dt);
    this.sprintBlend = damp(this.sprintBlend, s.sprinting && s.walk > 1.1 ? 1 : 0, 6, dt);
    this.flashBlend = damp(this.flashBlend, this.flashlightOn && !this.relaxed ? 1 : 0, 7, dt); // am Terminal automatisch aus
    this.relaxBlend = damp(this.relaxBlend, this.relaxed ? 1 : 0, 5, dt);
    this.fireHold = Math.max(0, this.fireHold - dt);
    this.fireBlend = damp(this.fireBlend, this.fireHold > 0 ? 1 : 0, this.fireHold > 0 ? 20 : 4, dt);
    this.coverOver = damp(this.coverOver, s.cover === 'over' ? 1 : 0, 8, dt);
    this.readyBlend = damp(this.readyBlend, s.crouching && s.aim < 0.5 ? 1 : 0, 6, dt);

    // Rückstoß-Feder
    const steps = Math.max(1, Math.ceil(dt * 120));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.recoilVel += (-260 * this.recoil - 22 * this.recoilVel) * h;
      this.recoil += this.recoilVel * h;
    }

    // Bewegungsrichtung lokal zum Körper
    const sin = Math.sin(s.yaw);
    const cos = Math.cos(s.yaw);
    const fwd = -s.velocity.x * sin - s.velocity.z * cos;
    const lat = s.velocity.x * cos - s.velocity.z * sin;
    const speed = Math.hypot(fwd, lat);
    const dirF = speed > 0.05 ? fwd / speed : 1;
    const dirR = speed > 0.05 ? lat / speed : 0;
    const walk = Math.min(s.walk, 1);
    const run = Math.max(0, s.walk - 1);
    const idle = 1 - walk;
    const air = this.airBlend;

    // --- Hüfte / Rumpf ---
    const crouch = clamp(-s.landing * 5, 0, 1);
    // Hocke: Hüfte sinkt um die fehlende Augenhöhe, die Bein-IK knickt die Knie passend ein
    const hipDrop = Math.max(0, STAND_EYE - s.eyeHeight);
    const sneak = clamp(hipDrop / 0.6, 0, 1); // 0 = stehend, 1 = ganz geduckt
    const climb = clamp(this.grade, -0.6, 0.8) * walk; // + bergauf/treppauf
    const lean =
      0.05 * walk * dirF + this.sprintBlend * 0.14 + crouch * 0.15 + sneak * 0.32 + this.coverOver * 0.12 + climb * 0.22 * Math.sign(dirF || 1);
    // Rumpf kippt nach vorn um einen Punkt auf Brusthöhe → Hüfte schiebt nach hinten (wie beim echten Hocken)
    const hipBack = Math.sin(lean) * CHEST_PIVOT;

    // --- Gangzyklus der Beine ---
    // Eigene Phase (unabhängig vom Kamera-Bobbing) mit realistischer Schrittlänge. Stand- und Schwungphase
    // getrennt: in der Standphase wandert der Fuß genau mit der Laufgeschwindigkeit nach hinten → er steht
    // in der Welt fest (kein Rutschen, auf Treppen bleibt er auf seiner Stufe).
    this.gait = damp(this.gait, s.onGround ? clamp((speed - 0.08) / 0.5, 0, 1) : 0, 8, dt);
    const gait = this.gait;
    const stepLen = lerp(0.45 + 0.13 * speed, 0.34 + 0.12 * speed, sneak);
    if (s.onGround) this.legPhase = (this.legPhase + (speed / stepLen) * Math.PI * dt) % (Math.PI * 4);
    const ph = this.legPhase;
    // Duty-Faktor = Anteil der Standphase; klein genug, dass der Standfuß-Weg erreichbar bleibt
    // (langsam/geduckt: Doppelstand, Sprint: Flugphase)
    const duty = clamp(0.8 / (2 * stepLen), 0.3, 0.62);
    const excursion = 2 * duty * stepLen * gait;
    const hipYaw = -Math.cos(ph) * 0.06 * gait; // Becken dreht mit dem vorderen Bein
    const baseHipY = DIM.hipHeight - hipDrop + s.landing - 0.012 * walk;

    // --- Fußziele (Root-Raum) aus Schrittzyklus + Bodenabtastung ---
    const stepHeight = (0.08 + 0.05 * run) * (1 - sneak * 0.35) * (1 + Math.max(0, this.grade) * 1.5);
    const stance = DIM.hipWidth + 0.015 + sneak * 0.06; // geduckt breiter
    const leanN = clamp(s.lean / LEAN_REF, -1, 1);
    const sides = [this.left, this.right] as const;
    const targets = [_ankle[0], _ankle[1]];
    const lifts = [0, 0];
    const pitches = [0, 0];
    const smooth = THREE.MathUtils.smoothstep;
    let pelvisNeed = 0;
    for (let i = 0; i < 2; i++) {
      const posX = i === 0 ? -1 : 1; // links / rechts
      const u = (ph / (2 * Math.PI) + (i === 0 ? 0 : 0.5)) % 1; // Zyklus je Fuß, Beine um ½ versetzt
      let rel: number; // Fußposition entlang der Laufrichtung relativ zur Hüfte
      let lift: number;
      let pitch: number; // + Zehen hoch (Fersenaufsatz), − Zehen runter (Abdruck)
      if (u < duty) {
        const k = u / duty;
        rel = excursion * (0.5 - k);
        lift = 0;
        pitch = 0.22 * (1 - smooth(k, 0, 0.25)) - 0.5 * smooth(k, 0.72, 1);
      } else {
        const k = (u - duty) / (1 - duty);
        rel = -0.5 * excursion * Math.cos(Math.PI * k); // hinten → vorn, weich
        lift = Math.sin(Math.PI * k);
        pitch = lerp(-0.5, 0.22, smooth(k, 0.1, 0.9));
      }
      lift *= gait;
      pitch *= gait * dirF;
      lifts[i] = lift;
      pitches[i] = pitch;
      let fx = posX * stance + rel * dirR * 0.7;
      let fz = -rel * dirF;
      // Geduckter Stand: Füße versetzt (links vor), stabilere Schusshaltung
      fz += (i === 0 ? -0.13 : 0.1) * sneak * idle;
      // Vorbeugen: Füße bleiben unter der Kapsel, der äußere Fuß tritt zur Seite heraus
      fx -= leanShift;
      if (posX * leanN > 0) fx += s.lean * 0.35;

      const gy = this.probeFoot(this.ground[i], fx, fz, lift > 0.15, s.onGround, dt) - rootY;
      // Abrollen über Zehe bzw. Ferse hebt den Knöchel an; am Hang steht der Knöchel senkrecht zur Sohle
      const roll = pitch < 0 ? -TOE_Z * Math.sin(-pitch) : HEEL_Z * Math.sin(pitch);
      const ankle = ANKLE_HEIGHT / Math.max(this.ground[i].normal.y, 0.6);
      targets[i].set(fx, gy + ankle + lift * stepHeight + roll, fz);

      // Wie weit muss das Becken sinken, damit das Bein den Fuß erreicht?
      const hx = posX * DIM.hipWidth * Math.cos(hipYaw);
      const hz = hipBack - posX * DIM.hipWidth * Math.sin(hipYaw);
      const horiz = Math.hypot(fx - hx, fz - hz);
      const vert = baseHipY - targets[i].y;
      const reach = L_LEG * 0.995;
      if (horiz < reach) pelvisNeed = Math.max(pelvisNeed, vert - Math.sqrt(reach * reach - horiz * horiz));
    }
    pelvisNeed = clamp(pelvisNeed, 0, 0.45) * (1 - air);
    // schnell absenken (Fuß darf nicht in der Luft hängen), langsamer wieder hoch
    this.pelvisDrop = damp(this.pelvisDrop, pelvisNeed, pelvisNeed > this.pelvisDrop ? 30 : 9, dt);

    this.hips.position.set(0, baseHipY - this.pelvisDrop, hipBack);
    this.hips.rotation.set(0, hipYaw, 0);

    // Seitlich vorbeugen: Schulterlinie soll den restlichen Kameraversatz erreichen
    const leanRoll = -Math.asin(clamp((s.lean - leanShift) / DIM.torso.y, -1, 1));
    this.torso.joint.rotation.set(-lean + Math.sin(t * 1.35) * 0.01, -hipYaw * 1.4, -dirR * 0.04 * walk + leanRoll);
    // Kopf folgt dem Blick (Schatten/Third-Person), gleicht Rumpfneigung aus
    this.neck.rotation.set(clamp(s.pitch, -1.1, 1.1) * 0.75 + lean, 0, -leanRoll * 0.6);

    // --- Beine: IK auf die Fußziele (im Sprung: angezogene Pose) ---
    _hipsQInv.copy(this.hips.quaternion).invert();
    for (let i = 0; i < 2; i++) {
      const side = sides[i];
      // Ziel relativ zum Hüftgelenk, im Becken-Raum
      _v.copy(targets[i]).sub(this.hips.position).applyQuaternion(_hipsQInv).sub(side.thigh.joint.position);
      if (air > 0.001) {
        const a = i === 0 ? 0.65 : 0.15;
        const k = i === 0 ? -1.1 : -0.6;
        _v2.set(0, -(L_THIGH * Math.cos(a) + L_SHIN * Math.cos(a + k)), -(L_THIGH * Math.sin(a) + L_SHIN * Math.sin(a + k)));
        _v.lerp(_v2, air);
      }
      this.solveLeg(side, _v);
    }
    this.root.updateMatrixWorld(true);

    // Füße: Sohle parallel zur Bodennormale, in der Schwungphase abrollen
    _fwdW.set(-sin, 0, -cos);
    for (let i = 0; i < 2; i++) {
      const side = sides[i];
      const lift = lifts[i];
      const up = _v.copy(this.ground[i].normal).lerp(_upW, clamp(lift * 1.5, 0, 1)).normalize();
      // Fuß zeigt nach vorn (leicht nach außen gedreht), auf die Bodenebene projiziert
      const toeOut = (i === 0 ? 1 : -1) * 0.08;
      _v2.copy(_fwdW).applyAxisAngle(_upW, toeOut);
      _v2.addScaledVector(up, -_v2.dot(up)).normalize();
      _by.copy(up);
      _bz.copy(_v2).negate();
      _bx.crossVectors(_by, _bz);
      _m.makeBasis(_bx, _by, _bz);
      _q.setFromRotationMatrix(_m);
      // Abrollen: Fersenaufsatz Zehen hoch, Abdruck Zehen runter
      _q2.setFromAxisAngle(_xAxis, pitches[i]);
      _q.multiply(_q2);
      side.shin.joint.getWorldQuaternion(_q2);
      side.foot.joint.quaternion.copy(_q2.invert().multiply(_q));
      if (air > 0.001) {
        _e.set(i === 0 ? 0.35 : 0.25, 0, 0, 'YXZ');
        side.foot.joint.quaternion.slerp(_q2.setFromEuler(_e), air);
      }
    }

    // --- Arme: Hand-Zielpunkte im Blickrahmen, IK von der Schulter ---
    const ads = s.aim;
    const fb = this.flashBlend;
    const fire = this.fireBlend;
    const low = this.sprintBlend * (1 - fire);
    const ready = this.readyBlend * (1 - ads) * (1 - fire) * (1 - low);
    const steady = 1 - ads * 0.6;
    const r = this.recoil;

    // Zielrahmen: Gier + (begrenztes) Nicken des Blicks, Drehpunkt auf Schulterhöhe ohne Kamerawackeln.
    // Verkanten beim seitlichen Vorbeugen (Kamera rollt mit, Waffe etwas stärker)
    const cant = -s.lean * 0.25 - leanN * 0.3 * ads;
    _e.set(clamp(s.pitch, -1.0, 1.15), s.yaw, cant, 'YXZ');
    _frameQ.setFromEuler(_e);
    _pivot.set(s.eye.x + rightX * s.lean, s.eye.y + SHOULDER_DROP, s.eye.z + rightZ * s.lean);
    _e.set(s.pitch, s.yaw, 0, 'YXZ');
    _aimDir.set(0, 0, -1).applyQuaternion(_q.setFromEuler(_e));
    _aimTarget.set(s.eye.x + rightX * s.lean, s.eye.y - CAMERA_DROP, s.eye.z + rightZ * s.lean).addScaledVector(_aimDir, AIM_DISTANCE);
    _frameUp.set(0, 1, 0).applyQuaternion(_frameQ);
    _frameRight.set(1, 0, 0).applyQuaternion(_frameQ);

    // Rechte Hand (Waffe)
    const p = _v.set(lerp(0.03, 0.0, ads) - 0.03 * (1 - fb) * (1 - ads), lerp(-0.13, -0.075, ads), lerp(-0.5, -0.47, ads));
    p.lerp(_v2.set(0.04, -0.27, -0.42), ready); // Low-Ready: Mündung vor die Füße
    p.lerp(_v2.set(0.07, -0.33, -0.3), low); // Sprint: Tiefhalte nah am Körper
    p.z -= 0.035 * this.coverOver * ads; // über Deckung: Arme weiter ausgestreckt
    p.x += (Math.sin(ph) * 0.014 * walk + Math.sin(t * 0.9) * 0.003) * steady;
    p.y += (Math.sin(ph * 2) * 0.012 * walk + Math.sin(t * 1.35) * 0.004) * steady;
    p.z += r * 0.07;
    p.y += r * 0.02;
    _handR.copy(p).applyQuaternion(_frameQ).add(_pivot);
    // Lauf zeigt auf den Blickpunkt; Low-Ready/Sprint kippen ihn nach unten, Rückstoß nach oben
    const gunPitch = -0.55 * ready - 1.0 * low + r * 0.6;
    _gunFwd.subVectors(_aimTarget, _handR).normalize();
    _gunRight.crossVectors(_gunFwd, _frameUp).normalize();
    _gunUp.crossVectors(_gunRight, _gunFwd);
    _v2.copy(_gunFwd).multiplyScalar(Math.cos(gunPitch)).addScaledVector(_gunUp, Math.sin(gunPitch));
    _gunUp.multiplyScalar(Math.cos(gunPitch)).addScaledVector(_gunFwd, -Math.sin(gunPitch));
    _gunFwd.copy(_v2);
    gripQuat(_qHandR, _gunFwd, _gunUp);
    // Ellbogen nach unten außen
    _poleR.set(0, -1, 0).addScaledVector(_frameRight, 0.7);
    this.solveArm(this.right, _handR, _poleR, _qHandR);

    // Linke Hand: stützt die Waffe (0) oder hält die Lampe am Kopf (1)
    _handL.copy(_handR).addScaledVector(_gunRight, -0.05).addScaledVector(_gunUp, -0.012).addScaledVector(_gunFwd, 0.012);
    _v2.copy(_gunUp).applyAxisAngle(_gunFwd, -0.5); // Hand umgreift die Faust von links unten
    gripQuat(_qHandL, _gunFwd, _v2);
    _poleL.set(0, -1, 0).addScaledVector(_frameRight, -0.5);
    if (fb > 0.001) {
      const tp = _v.set(lerp(-0.33, -0.25, ads), lerp(0.33, 0.25, ads), lerp(-0.42, -0.45, ads));
      tp.lerp(_v2.set(-0.3, 0.18, -0.42), ready);
      tp.lerp(_v2.set(-0.22, -0.18, -0.32), low);
      tp.x += Math.sin(ph) * 0.012 * walk * steady;
      tp.y += (Math.sin(ph * 2 + 0.6) * 0.012 * walk + Math.sin(t * 1.35 + 0.4) * 0.004) * steady;
      tp.applyQuaternion(_frameQ).add(_pivot);
      _handL.lerp(tp, fb);
      _v2.subVectors(_aimTarget, tp).normalize();
      _q.copy(gripQuat(_q2, _v2, _frameUp));
      _qHandL.slerp(_q, fb);
      _v2.set(0, -0.5, 0).addScaledVector(_frameRight, -1);
      _poleL.lerp(_v2, fb);
    }
    this.solveArm(this.left, _handL, _poleL, _qHandL);

    // Locker: Arme hängen seitlich herab (überblendet die Zielhaltung)
    const rb = this.relaxBlend;
    if (rb > 0.001) {
      const armSwayX = Math.sin(ph * 2) * 0.035 * walk + Math.sin(t * 1.35) * 0.012;
      for (const [side, sign] of [[this.left, -1], [this.right, 1]] as const) {
        side.upperArm.joint.quaternion.slerp(_q.setFromEuler(_e.set(0.12 + armSwayX, 0, sign * 0.12, 'YXZ')), rb);
        side.forearm.joint.quaternion.slerp(_q.setFromEuler(_e.set(0.3, 0, 0, 'YXZ')), rb);
        side.hand.joint.quaternion.slerp(_q.identity(), rb);
      }
    }

    // --- Taschenlampe ---
    // Nur die Meshes ausblenden — das Licht selbst muss sichtbar bleiben (sonst Shader-Recompile)
    for (const m of this.torchMeshes) m.visible = fb > 0.05 && this.head.visible;
    // Zielpunkt folgt dem Blick mit leichter Verzögerung (Handführung)
    const camPos = _v.set(0, 0, 0);
    const camDir = _v2.set(0, 0, 0);
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);
    const desired = camPos.addScaledVector(camDir, 12);
    if (this.aimPoint.lengthSq() === 0) this.aimPoint.copy(desired);
    this.aimPoint.lerp(desired, 1 - Math.exp(-14 * dt));
    // Grundversatz: Lichtkegel sitzt tiefer; beim Sprinten vor die Füße,
    // auch am Terminal: nicht auf den spiegelnden Bildschirm leuchten
    const target = _v.copy(this.aimPoint);
    target.y -= 5.5 + (this.sprintBlend + this.relaxBlend) * 6;
    this.flashTarget.position.copy(target);
    this.root.updateMatrixWorld(true);
    this.torch.lookAt(target);

    const on = Math.max(0, (fb - 0.6) / 0.4);
    const flicker = 0.97 + Math.sin(t * 31) * 0.015 + Math.sin(t * 57) * 0.015;
    this.flashlight.intensity = this.lampIntensity * on * flicker;
    this.torchLens.emissiveIntensity = 4 * on;
  }

  /**
   * Bodenhöhe unter einem Fuß (Weltkoordinaten). Im Stand entscheidet der Fußballen, auf welcher Stufe
   * der Fuß steht (am Hang liegt die Sohle dank Normale ohnehin parallel auf). In der Schwungphase heben
   * Zehe/Ferse den Fuß schon vorab über eine Stufenkante. Gedämpft in Weltkoordinaten: ein Autostep der
   * Kapsel verschiebt keinen bereits stehenden Fuß.
   */
  private probeFoot(g: FootGround, fx: number, fz: number, swing: boolean, onGround: boolean, dt: number): number {
    const root = this.root.position;
    let best = -Infinity;
    _n.set(0, 1, 0);
    if (this.physics && onGround) {
      const c = Math.cos(this.root.rotation.y);
      const sn = Math.sin(this.root.rotation.y);
      for (const dz of swing ? SWING_PROBES : STANCE_PROBES) {
        const lz = fz + dz;
        this.ray.origin = { x: root.x + fx * c + lz * sn, y: root.y + PROBE_UP, z: root.z - fx * sn + lz * c };
        const hit = this.physics.world.castRayAndGetNormal(this.ray, PROBE_UP + PROBE_DOWN, true, undefined, WORLD_QUERY);
        // Start im Collider (toi 0) oder zu hoch → Hindernis, kein Tritt
        if (!hit || hit.timeOfImpact < 1e-4) continue;
        let y = root.y + PROBE_UP - hit.timeOfImpact;
        if (y - root.y > MAX_FOOT_RISE) continue;
        const n = hit.normal;
        // Höhe der getroffenen Ebene unter dem Knöchel (am Hang liegt der Ballen höher/tiefer)
        if (n.y >= 0.6) y += (n.x * dz * sn + n.z * dz * c) / n.y;
        // Stand: nur der Ballen; Schwung: höchster Punkt (über die Kante steigen)
        if (y <= best) continue;
        best = y;
        _n.set(n.x, n.y, n.z);
      }
    }
    if (best === -Infinity) {
      best = root.y;
      _n.set(0, 1, 0);
    }
    // Zu steile Normalen (Treppenkanten, Wände) nicht übernehmen
    if (_n.y < 0.6) _n.set(0, 1, 0);
    if (!g.init || Math.abs(best - g.y) > 1 || dt === 0) {
      g.y = best;
      g.normal.copy(_n);
      g.init = true;
    } else {
      g.y = damp(g.y, best, best > g.y ? (swing ? 50 : 35) : 22, dt);
      g.normal.lerp(_n, 1 - Math.exp(-12 * dt)).normalize();
    }
    return g.y;
  }

  /** Analytische 2-Glied-IK fürs Bein; Ziel = Knöchel relativ zum Hüftgelenk (Becken-Raum) */
  private solveLeg(side: Side, target: THREE.Vector3): void {
    const down = Math.max(-target.y, 0.05);
    const roll = clamp(Math.atan2(target.x, down), -1.2, 1.2);
    const inPlane = Math.hypot(target.x, down);
    const forward = -target.z;
    const d = clamp(Math.hypot(inPlane, forward), 0.12, L_LEG - 1e-4);
    const cosKnee = clamp((L_THIGH * L_THIGH + L_SHIN * L_SHIN - d * d) / (2 * L_THIGH * L_SHIN), -1, 1);
    const knee = -(Math.PI - Math.acos(cosKnee)); // negativ = Knie nach vorn, Unterschenkel nach hinten
    const alpha = Math.acos(clamp((L_THIGH * L_THIGH + d * d - L_SHIN * L_SHIN) / (2 * L_THIGH * d), -1, 1));
    const thigh = Math.atan2(forward, inPlane) + alpha;
    side.thigh.joint.rotation.set(thigh, 0, roll);
    side.shin.joint.rotation.set(knee, 0, 0);
  }

  /** 2-Glied-IK für einen Arm: Handgelenk zum Ziel, Ellbogen Richtung `pole`, Hand mit Weltrotation `handQ` */
  private solveArm(side: Side, target: THREE.Vector3, pole: THREE.Vector3, handQ: THREE.Quaternion): void {
    const ua = side.upperArm.joint;
    ua.getWorldPosition(_s);
    ua.parent!.getWorldQuaternion(_qp);
    _d.subVectors(target, _s);
    const dist = _d.length();
    if (dist < 1e-5) return;
    _d.divideScalar(dist);
    const reach = clamp(dist, 0.1, L_UPPER + L_FORE - 1e-3);
    const cosA = clamp((L_UPPER * L_UPPER + reach * reach - L_FORE * L_FORE) / (2 * L_UPPER * reach), -1, 1);
    _pole.copy(pole).addScaledVector(_d, -pole.dot(_d));
    if (_pole.lengthSq() < 1e-8) _pole.set(0, -1, 0).addScaledVector(_d, _d.y);
    _pole.normalize();
    _elbow.copy(_s).addScaledVector(_d, L_UPPER * cosA).addScaledVector(_pole, L_UPPER * Math.sqrt(1 - cosA * cosA));
    _wrist.copy(_s).addScaledVector(_d, reach);
    _n.crossVectors(_d, _pole); // Normale der Armebene = Scharnierachse des Ellbogens
    boneQuat(_qu, _v3.subVectors(_elbow, _s), _n);
    boneQuat(_qf, _v3.subVectors(_wrist, _elbow), _n);
    ua.quaternion.copy(_qp.invert().multiply(_qu));
    side.forearm.joint.quaternion.copy(_q3.copy(_qu).invert().multiply(_qf));
    side.hand.joint.quaternion.copy(_qf.invert().multiply(handQ));
  }
}

const STANCE_PROBES = [BALL_Z];
const SWING_PROBES = [BALL_Z, HEEL_Z, TOE_Z, SWING_AHEAD];

// Wiederverwendete Hilfsobjekte (keine Allokation pro Frame)
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _wrist = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _qu = new THREE.Quaternion();
const _qf = new THREE.Quaternion();
const _qHandR = new THREE.Quaternion();
const _qHandL = new THREE.Quaternion();
const _hipsQInv = new THREE.Quaternion();
const _e = new THREE.Euler();
const _ankle = [new THREE.Vector3(), new THREE.Vector3()];
const _upW = new THREE.Vector3(0, 1, 0);
const _xAxis = new THREE.Vector3(1, 0, 0);
const _fwdW = new THREE.Vector3();
const _frameQ = new THREE.Quaternion();
const _frameUp = new THREE.Vector3();
const _frameRight = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _aimTarget = new THREE.Vector3();
const _handR = new THREE.Vector3();
const _handL = new THREE.Vector3();
const _gunFwd = new THREE.Vector3();
const _gunRight = new THREE.Vector3();
const _gunUp = new THREE.Vector3();
const _poleR = new THREE.Vector3();
const _poleL = new THREE.Vector3();
