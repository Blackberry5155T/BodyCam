import * as THREE from 'three';
import { SCALE } from '../world/collision.ts';

// Blockout-Spielerkörper aus Würfeln mit Gelenk-Hierarchie (Pivot = Gelenk, Würfel hängt daran).
// Die Gelenknamen/-struktur entsprechen einem üblichen Humanoid-Rig, damit später ein echtes
// Modell mit Bones dieselben prozeduralen Animationen übernehmen kann.
//
// Konvention: Körper schaut nach -Z. rotation.x > 0 schwingt ein hängendes Glied nach vorn.

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
}

const STAND_EYE = SCALE.playerHeight; // Augenhöhe stehend (wie im Controller)
const ANKLE_HEIGHT = 0.08;

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

const FLASHLIGHT_INTENSITY = 45;

const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

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

  constructor(scene: THREE.Scene) {
    const jacket = new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.85 });
    const vest = new THREE.MeshStandardMaterial({ color: 0x23282b, roughness: 0.8 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.9 });
    const gloves = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.7 });
    const boots = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.6 });
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
    this.torso.joint.add(this.neck);
    const head = new THREE.Mesh(new THREE.BoxGeometry(DIM.head.x, DIM.head.y, DIM.head.z), shadowOnly);
    head.position.y = DIM.head.y / 2;
    head.castShadow = true;
    this.neck.add(head);

    const makeSide = (s: 1 | -1): Side => {
      const thigh = limb(this.hips, new THREE.Vector3(s * DIM.hipWidth, 0, 0), DIM.thigh, pants, `thigh_${s}`);
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
    this.flashlight = new THREE.SpotLight(0xfff0dc, FLASHLIGHT_INTENSITY, 30, 0.42, 0.55, 2);
    this.flashlight.position.z = 0.09;
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.bias = -0.0006;
    this.flashlight.shadow.camera.near = 0.1;
    this.torch.add(this.flashlight);
    this.flashlight.target = this.flashTarget;
    scene.add(this.flashTarget);

    scene.add(this.root);
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

  /** Rückstoß-Impuls für die Arme */
  kick(): void {
    this.recoilVel += 9;
  }

  /** Mündungsposition (vor der rechten Hand) in Weltkoordinaten */
  getMuzzle(camera: THREE.Camera, out = new THREE.Vector3()): THREE.Vector3 {
    this.right.hand.joint.getWorldPosition(out);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    return out.addScaledVector(dir, 0.18);
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

    // --- Zustandsblends ---
    this.airBlend = damp(this.airBlend, s.onGround ? 0 : 1, 10, dt);
    this.sprintBlend = damp(this.sprintBlend, s.sprinting && s.walk > 1.1 ? 1 : 0, 6, dt);
    this.flashBlend = damp(this.flashBlend, this.flashlightOn && !this.relaxed ? 1 : 0, 7, dt); // am Terminal automatisch aus
    this.relaxBlend = damp(this.relaxBlend, this.relaxed ? 1 : 0, 5, dt);

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
    const ph = s.phase;

    // --- Hüfte / Rumpf ---
    const crouch = THREE.MathUtils.clamp(-s.landing * 5, 0, 1);
    // Hocke: Hüfte sinkt um die fehlende Augenhöhe, Beine knicken per einfacher 2-Glied-IK ein
    const hipDrop = Math.max(0, STAND_EYE - s.eyeHeight);
    const sneak = THREE.MathUtils.clamp(hipDrop / 0.6, 0, 1); // 0 = stehend, 1 = ganz geduckt
    const hipY = DIM.hipHeight - hipDrop;
    const legReach = THREE.MathUtils.clamp((hipY - ANKLE_HEIGHT) / (DIM.thigh.y + DIM.shin.y), -1, 1);
    const squat = Math.acos(legReach); // Oberschenkelwinkel nach vorn
    this.hips.position.y = hipY + s.landing + Math.abs(Math.sin(ph)) * 0.025 * walk - 0.012 * walk;
    this.hips.rotation.y = Math.sin(ph) * 0.06 * walk; // Becken dreht gegen die Schritte
    const lean = 0.05 * walk * dirF + this.sprintBlend * 0.14 + crouch * 0.15 + sneak * 0.3;
    // Seitlich vorbeugen: Schulterlinie soll den restlichen Kameraversatz erreichen
    const leanRoll = -Math.asin(THREE.MathUtils.clamp((s.lean - leanShift) / DIM.torso.y, -1, 1));
    this.torso.joint.rotation.set(
      lean + Math.sin(t * 1.35) * 0.01,
      -this.hips.rotation.y * 1.4,
      -dirR * 0.04 * walk + leanRoll,
    );

    // --- Beine ---
    const legAmp = (0.42 * walk + run * 0.28) * (1 - sneak * 0.45);
    const kneePhaseSign = dirF < -0.3 ? -1 : 1;
    for (const [side, sign] of [[this.left, 1], [this.right, -1]] as const) {
      const swing = Math.sin(ph) * sign * legAmp;
      const lift = Math.max(0, Math.cos(ph) * sign * kneePhaseSign); // Bein in der Luftphase
      let thighX = swing * dirF;
      let thighZ = swing * dirR * 0.7;
      let knee = -(0.08 + lift * (0.7 + run * 0.5)) * Math.min(legAmp / 0.42, 1.6);

      // Sprung/Fall: Beine anziehen, eines vor
      const airThigh = sign > 0 ? 0.65 : 0.15;
      const airKnee = sign > 0 ? -1.1 : -0.6;
      thighX = THREE.MathUtils.lerp(thighX, airThigh, this.airBlend);
      thighZ *= 1 - this.airBlend;
      knee = THREE.MathUtils.lerp(knee, airKnee, this.airBlend);

      // Landung: in die Knie gehen
      thighX += crouch * 0.55;
      knee -= crouch * 1.0;

      // Schleichen: Hocke — Oberschenkel nach vorn, Knie doppelt einknicken → Knöchel bleibt unter der Hüfte
      thighX += squat;
      knee -= squat * 2;

      side.thigh.joint.rotation.set(thighX, 0, thighZ + sign * -0.03);
      side.shin.joint.rotation.set(knee, 0, 0);
      // Fuß grob parallel zum Boden halten, Abrollen in der Schwungphase
      side.foot.joint.rotation.set(-(thighX + knee) * 0.85 + lift * 0.25 * walk, 0, -thighZ);
    }

    // --- Arme: zielen mit dem Blick-Pitch (relativ zur Rumpfneigung) ---
    const aim = s.pitch - lean;
    const ads = s.aim; // Anschlag: Waffe höher, näher zur Körpermitte, weniger Wackeln
    const steady = 1 - ads * 0.6;
    const armSwayX = (Math.sin(ph * 2) * 0.035 * walk + Math.sin(t * 1.35) * 0.012) * steady;
    const armSwayY = Math.sin(ph) * 0.04 * walk * steady;
    const low = this.sprintBlend; // Sprint: Waffe in Tiefhalte
    const runSwing = Math.sin(ph) * 0.18 * low;
    const r = this.recoil;

    // Rechter Arm: Waffenhand
    const R = this.right;
    R.upperArm.joint.rotation.set(
      1.15 + ads * 0.14 + aim + armSwayX - low * 0.75 + runSwing + r * 0.25,
      0.42 + ads * 0.2 + armSwayY,
      0,
    );
    R.forearm.joint.rotation.set(0.38 - ads * 0.12 + low * 0.35 + r * 0.55, 0, 0);
    R.hand.joint.rotation.set(0.05 - r * 0.4, 0, 0);

    // Linker Arm: blendet zwischen Waffe stützen (0) und Lampe halten (1)
    const L = this.left;
    const fb = this.flashBlend;
    const supportX = 1.1 + ads * 0.14 + aim - low * 0.8 + r * 0.25;
    const supportY = -0.62 - ads * 0.12;
    const torchX = 2.0 + aim - low * 0.9;
    const torchY = 0.22;
    L.upperArm.joint.rotation.set(
      THREE.MathUtils.lerp(supportX, torchX, fb) + armSwayX - runSwing,
      THREE.MathUtils.lerp(supportY, torchY, fb) - armSwayY,
      0,
    );
    L.forearm.joint.rotation.set(THREE.MathUtils.lerp(0.5 - ads * 0.12 + r * 0.4, 0.5, fb) + low * 0.35, 0, 0);
    L.hand.joint.rotation.set(0, 0, 0);

    // Locker: Arme hängen seitlich herab (überblendet die Zielhaltung)
    const rb = this.relaxBlend;
    if (rb > 0.001) {
      for (const [side, sign] of [[L, -1], [R, 1]] as const) {
        const ua = side.upperArm.joint.rotation;
        const fa = side.forearm.joint.rotation;
        ua.x = THREE.MathUtils.lerp(ua.x, 0.12 + armSwayX, rb);
        ua.y = THREE.MathUtils.lerp(ua.y, 0, rb);
        ua.z = THREE.MathUtils.lerp(ua.z, sign * 0.12, rb);
        fa.x = THREE.MathUtils.lerp(fa.x, 0.3, rb);
      }
    }

    // --- Taschenlampe ---
    // Nur die Meshes ausblenden — das Licht selbst muss sichtbar bleiben (sonst Shader-Recompile)
    for (const m of this.torchMeshes) m.visible = fb > 0.05;
    // Zielpunkt folgt dem Blick mit leichter Verzögerung (Handführung)
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);
    const desired = camPos.addScaledVector(camDir, 12);
    if (this.aimPoint.lengthSq() === 0) this.aimPoint.copy(desired);
    this.aimPoint.lerp(desired, 1 - Math.exp(-14 * dt));
    // Beim Sprinten zeigt die Lampe nach unten vor die Füße
    const target = this.aimPoint.clone();
    target.y -= 3 + (low + this.relaxBlend) * 6; // Grundversatz: Lichtkegel sitzt tiefer; // auch am Terminal: nicht auf den spiegelnden Bildschirm leuchten
    this.flashTarget.position.copy(target);
    this.root.updateMatrixWorld(true);
    this.torch.lookAt(target);

    const on = Math.max(0, (fb - 0.6) / 0.4);
    const flicker = 0.97 + Math.sin(t * 31) * 0.015 + Math.sin(t * 57) * 0.015;
    this.flashlight.intensity = FLASHLIGHT_INTENSITY * on * flicker;
    this.torchLens.emissiveIntensity = 4 * on;
  }
}
