import * as THREE from 'three';
import type { Collider } from '../world/collision.ts';
import type { BodyAnimState } from './body.ts';
import type { Input } from '../core/input.ts';
import type { Settings } from '../core/settings.ts';
import { SCALE, closestXZ, colliderMaxY, colliderMinY } from '../world/collision.ts';

const WALK_SPEED = 3.2; // m/s, grob an realistischem Gehtempo orientiert
const SPRINT_SPEED = 6.0;
const JUMP_SPEED = 4.5;
const GRAVITY = -9.81;
const STEP_HEIGHT = 0.3;
const GROUND_ACCEL = 11; // Beschleunigungsrate am Boden (1/s), gibt Gewicht
const AIR_ACCEL = 1.5;

const MOUSE_SENSITIVITY = 0.0021;
const LOOK_SMOOTHING = 22; // höher = direkter; niedrig = schwerere, trägere Kamera
export const CAMERA_DROP = 0.3; // Bodycam sitzt auf Brusthöhe, unter Augenhöhe
export const CAMERA_FORWARD = 0.17; // vor der Brust, damit der Rumpf-Würfel nicht im Bild hängt
const SPRINT_FOV_BONUS = 6;

// Schleichen / Zielen / Deckung
export const STAND_EYE = SCALE.playerHeight; // Augenhöhe stehend (= Höhe des Kollisionskörpers)
export const CROUCH_EYE = 1.2; // geduckt: Brustkamera ~0.9 m → hinter 1.2-m-Deckung verborgen
const CROUCH_SPEED = 1.6;
const AIM_SPEED_FACTOR = 0.65;
const AIM_FOV = 12; // FOV-Reduktion beim Zielen
const HEIGHT_RATE = 9; // wie schnell zwischen Stehen/Ducken/Hochkommen geblendet wird
const COVER_REACH = 1.3; // so weit vor dem Körpermittelpunkt wird nach Deckung gesucht
const PEEK_CLEARANCE = 0.2; // Kamera/Waffe so weit über die Deckungskante heben
const LEAN_DIST = 0.5; // seitliches Vorbeugen an der Deckung vorbei
const LEAN_PROBE_RADIUS = 0.15;

/** Ziel für den Autopiloten (z. B. vor das Terminal treten) */
export interface FocusTarget {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  fov: number;
}

// Gedämpfte Feder für Landung/Rückstoß
class Spring {
  value = 0;
  velocity = 0;
  constructor(
    private stiffness: number,
    private damping: number,
  ) {}
  update(dt: number): void {
    const accel = -this.stiffness * this.value - this.damping * this.velocity;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;
  }
}

const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

export class PlayerController {
  /** Augenposition (Kollisionskörper), nicht die gerenderte Kameraposition */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  isLocked = false;

  private onGround = true;
  private groundSpeed = 0;
  private sprinting = false;
  /** aktuelle Augenhöhe über den Füßen (Stehen ↔ Ducken ↔ über Deckung hochkommen) */
  private height = STAND_EYE;
  private crouching = false;
  private aiming = false;
  private aimBlend = 0;
  private lean = 0; // seitlicher Versatz der Kamera in m (+ = rechts)
  private leanSide = 1; // bevorzugte Seite beim Vorbeugen (folgt der letzten Strafe-Richtung)
  /** Deckungszustand (für Debug-Anzeige) */
  coverState: 'none' | 'over' | 'left' | 'right' | 'blocked' = 'none';
  private focus: FocusTarget | null = null;
  private lockListeners: ((locked: boolean) => void)[] = [];

  // Blick: Ziel (Maus) und geglättete Ansicht
  private yaw = 0;
  private pitch = 0;
  private viewYaw = 0;
  private viewPitch = 0;
  private mouseDX = 0;
  private turnSway = 0;

  // Bewegungseffekte
  private time = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private strafeRoll = 0;
  private trauma = 0;
  private fov = 80;
  private landing = new Spring(170, 14);
  private recoilPitch = new Spring(150, 15);
  private recoilYaw = new Spring(150, 15);
  private recoilRoll = new Spring(150, 12);

  constructor(
    private camera: THREE.PerspectiveCamera,
    private domElement: HTMLElement,
    private colliders: Collider[],
    spawn: THREE.Vector3,
    private input: Input,
    private settings: Settings,
    spawnYaw = 0,
  ) {
    this.position.copy(spawn);
    this.yaw = this.viewYaw = spawnYaw;
    camera.rotation.order = 'YXZ';
    this.fov = settings.data.fov;

    document.addEventListener('mousemove', (e) => {
      if (!this.isLocked || this.focus) return;
      const sens = MOUSE_SENSITIVITY * this.settings.data.mouseSensitivity;
      this.yaw -= e.movementX * sens;
      this.pitch -= e.movementY * sens * (this.settings.data.invertY ? -1 : 1);
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.45, 1.45);
      this.mouseDX += e.movementX;
    });

    document.addEventListener('pointerlockchange', () => {
      this.isLocked = document.pointerLockElement === this.domElement;
      if (!this.isLocked) this.input.clear();
      for (const fn of this.lockListeners) fn(this.isLocked);
    });

    this.updateCamera(0, false);
  }

  lock(): void {
    const result = this.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
    result?.catch?.(() => {}); // Fehler meldet das 'pointerlockerror'-Event
  }

  onLockChange(fn: (locked: boolean) => void): void {
    this.lockListeners.push(fn);
  }

  /** Autopilot setzen (null = Spieler steuert wieder selbst) */
  setFocus(target: FocusTarget | null): void {
    this.focus = target;
    if (target) {
      // Ziel-Yaw auf die nächstgelegene Umdrehung legen, damit nicht um 360° gedreht wird
      const twoPi = Math.PI * 2;
      target.yaw = this.yaw + ((((target.yaw - this.yaw) % twoPi) + twoPi * 1.5) % twoPi) - Math.PI;
    }
  }

  /** Spieler versetzen (z. B. per Map-Script), Geschwindigkeit wird zurückgesetzt */
  teleport(eye: THREE.Vector3, yaw?: number): void {
    this.position.copy(eye);
    this.velocity.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = this.viewYaw = yaw;
  }

  /** Fußposition (unabhängig davon, ob der Spieler steht oder geduckt ist) */
  get feet(): THREE.Vector3 {
    return this.position.clone().setY(this.position.y - this.height);
  }

  teleportFeet(feet: THREE.Vector3, yaw?: number): void {
    this.teleport(feet.clone().setY(feet.y + this.height), yaw);
  }

  get isCrouching(): boolean {
    return this.crouching;
  }

  get isAiming(): boolean {
    return this.aiming;
  }

  get hasFocus(): boolean {
    return this.focus !== null;
  }

  /** Waffenrückstoß: Kamera springt hoch, leichtes seitliches Verreißen, Erschütterung */
  kick(): void {
    this.recoilPitch.velocity += 2.6;
    this.recoilYaw.velocity += (Math.random() - 0.5) * 1.6;
    this.recoilRoll.velocity += (Math.random() - 0.5) * 1.2;
    this.pitch = Math.min(this.pitch + 0.005, 1.45); // geringes bleibendes Hochziehen
    this.trauma = Math.min(1, this.trauma + 0.35);
  }

  update(dt: number): void {
    this.time += dt;
    const active = this.isLocked && !this.focus;
    const down = (a: Parameters<Input['down']>[0]) => active && this.input.down(a);
    const forward = down('forward') ? 1 : down('back') ? -1 : 0;
    const strafe = down('right') ? 1 : down('left') ? -1 : 0;
    this.crouching = down('crouch');
    this.aiming = down('aim');
    const sprinting = down('sprint') && forward > 0 && !this.crouching && !this.aiming;
    let speed = sprinting ? SPRINT_SPEED : this.crouching ? CROUCH_SPEED : WALK_SPEED;
    if (this.aiming) speed *= AIM_SPEED_FACTOR;
    this.sprinting = sprinting;
    if (strafe !== 0) this.leanSide = strafe;
    this.aimBlend = damp(this.aimBlend, this.aiming ? 1 : 0, 12, dt);

    // Körperhöhe: Ducken, beim Zielen hinter Deckung darüber hochkommen oder seitlich vorbeugen.
    // Die Füße bleiben fest, nur die Augenhöhe ändert sich.
    const feetY = this.position.y - this.height;
    const stance = this.stanceTarget(feetY);
    const maxHeight = Math.max(this.headroom(this.position.x, this.position.z, feetY), CROUCH_EYE);
    const targetHeight = Math.min(stance.height, maxHeight);
    this.height = dt === 0 ? targetHeight : damp(this.height, targetHeight, HEIGHT_RATE, dt);
    this.lean = dt === 0 ? stance.lean : damp(this.lean, stance.lean, 8, dt);
    this.position.y = feetY + this.height;

    // Planare Bewegung nach Ziel-Yaw (nicht nach geglätteter Ansicht → direkte Steuerung)
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wish = new THREE.Vector2(-sin * forward + cos * strafe, -cos * forward - sin * strafe);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);

    if (this.focus) {
      // Autopilot: zum Zielpunkt gehen (abbremsen kurz davor) und Blick ausrichten
      const f = this.focus;
      wish.set(f.x - this.position.x, f.z - this.position.z);
      const dist = wish.length();
      if (dist > 0.01) wish.multiplyScalar(Math.min(WALK_SPEED * 0.6, dist * 4) / dist);
      else wish.set(0, 0);
      this.yaw = damp(this.yaw, f.yaw, 6, dt);
      this.pitch = damp(this.pitch, f.pitch, 6, dt);
    }

    const accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;
    this.velocity.x = damp(this.velocity.x, wish.x, accel, dt);
    this.velocity.z = damp(this.velocity.z, wish.y, accel, dt);

    if (down('jump') && this.onGround && !this.crouching) {
      this.velocity.y = JUMP_SPEED;
      this.onGround = false;
    }
    this.velocity.y += GRAVITY * dt;

    const pos = this.position;
    const prevX = pos.x;
    const prevZ = pos.z;

    pos.x += this.velocity.x * dt;
    this.resolveCollisionsAxis(pos, 'x');
    pos.z += this.velocity.z * dt;
    this.resolveCollisionsAxis(pos, 'z');

    // Tatsächliche Bewegung übernehmen → an Wänden entlang gleiten, kein Kopfwippen beim Gegen-die-Wand-Laufen
    if (dt > 0) {
      this.velocity.x = (pos.x - prevX) / dt;
      this.velocity.z = (pos.z - prevZ) / dt;
    }
    this.groundSpeed = Math.hypot(this.velocity.x, this.velocity.z);

    // Y-Achse: auf höchster Oberfläche unter den Füßen landen
    const wasOnGround = this.onGround;
    const fallSpeed = this.velocity.y;
    const prevFeet = pos.y - this.height;
    pos.y += this.velocity.y * dt;
    const ground = this.groundHeight(pos, prevFeet);
    if (pos.y - this.height <= ground) {
      pos.y = ground + this.height;
      this.velocity.y = 0;
      this.onGround = true;
      if (!wasOnGround) {
        const impact = Math.min(-fallSpeed, 10);
        this.landing.velocity -= impact * 0.32;
        this.trauma = Math.min(1, this.trauma + impact * 0.04);
      }
    } else {
      this.onGround = false;
    }

    this.updateCamera(dt, sprinting);
  }

  private updateCamera(dt: number, sprinting: boolean): void {
    const t = this.time;

    // Trägheit der Blickrichtung (Kamera am Körper, nicht am Kopf)
    if (dt === 0) {
      this.viewYaw = this.yaw;
      this.viewPitch = this.pitch;
    } else {
      this.viewYaw = damp(this.viewYaw, this.yaw, LOOK_SMOOTHING, dt);
      this.viewPitch = damp(this.viewPitch, this.pitch, LOOK_SMOOTHING, dt);
    }

    // Schrittrhythmus: Phase läuft π pro Schritt
    const moveFactor = this.onGround ? Math.min(this.groundSpeed / WALK_SPEED, 2) : 0;
    this.bobAmount = damp(this.bobAmount, moveFactor, 7, dt);
    const stride = 1.0 + 0.05 * this.groundSpeed;
    this.bobPhase += (this.groundSpeed / stride) * Math.PI * dt;
    const walk = Math.min(this.bobAmount, 1);
    const run = Math.max(0, this.bobAmount - 1);
    const steady = 1 - this.aimBlend * 0.5; // beim Zielen ruhigere Kamera
    const a = walk * (1 + run * 0.9) * this.settings.data.cameraShake * steady;
    const ph = this.bobPhase;
    const shakeMul = this.settings.data.cameraShake * (this.focus ? 0.35 : 1) * steady;
    // Fußaufsetzen als Ruck nach unten statt reiner Sinus
    const bobY = -Math.abs(Math.sin(ph)) * 0.045 * a + 0.0225 * a;
    const bobX = Math.sin(ph) * 0.022 * a;
    const bobRoll = Math.sin(ph) * 0.011 * a;
    const bobPitch = (Math.abs(Math.sin(ph)) - 0.5) * 0.012 * a;
    const bobYaw = Math.sin(ph) * 0.005 * a;

    // Seitliche Neigung beim Strafen
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const lateral = this.velocity.x * cos - this.velocity.z * sin;
    this.strafeRoll = damp(this.strafeRoll, -lateral * 0.009 * this.settings.data.cameraShake, 6, dt);

    // Neigung beim schnellen Drehen
    const turnRate = dt > 0 ? this.mouseDX / dt : 0;
    this.mouseDX = 0;
    this.turnSway = damp(this.turnSway, THREE.MathUtils.clamp(-turnRate * 0.000018, -0.045, 0.045), 6, dt);

    // Atmung im Stand + niederfrequentes Handkamera-Rauschen
    const idle = 1 - walk;
    const breathe = Math.sin(t * 1.35);
    const n1 = Math.sin(t * 0.9) + Math.sin(t * 2.1 + 1.3) * 0.5 + Math.sin(t * 3.7 + 2.1) * 0.25;
    const n2 = Math.sin(t * 0.7 + 4.0) + Math.sin(t * 1.9 + 0.4) * 0.5 + Math.sin(t * 4.3 + 1.1) * 0.25;
    const breathPitch = (breathe * 0.0035 * (0.4 + idle) + n1 * 0.0012) * shakeMul;
    const breathYaw = n2 * 0.0012 * shakeMul;
    const breathY = breathe * 0.006 * idle * shakeMul;

    // Erschütterung (Trauma), quadratisch für weichen Ausklang
    this.trauma = Math.max(0, this.trauma - dt * 2.0);
    const shake = this.trauma * this.trauma * this.settings.data.cameraShake;
    const shakeP = (Math.sin(t * 53.1) + Math.sin(t * 77.7 + 1.0)) * 0.5 * shake * 0.012;
    const shakeY = (Math.sin(t * 61.3 + 2.0) + Math.sin(t * 89.1)) * 0.5 * shake * 0.012;
    const shakeR = Math.sin(t * 47.9 + 3.0) * shake * 0.015;

    if (dt > 0) {
      // Federn in Teilschritten für Stabilität bei niedrigen FPS
      const steps = Math.ceil(dt / (1 / 120));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        this.landing.update(h);
        this.recoilPitch.update(h);
        this.recoilYaw.update(h);
        this.recoilRoll.update(h);
      }
    }

    const cam = this.camera;
    const fx = -Math.sin(this.viewYaw) * CAMERA_FORWARD;
    const fz = -Math.cos(this.viewYaw) * CAMERA_FORWARD;
    // Vorbeugen: Kamera entlang des Rechts-Vektors der Blickrichtung versetzen und mitkippen
    const leanX = Math.cos(this.viewYaw) * this.lean;
    const leanZ = -Math.sin(this.viewYaw) * this.lean;
    cam.position.set(
      this.position.x + cos * bobX + fx + leanX,
      this.position.y - CAMERA_DROP + bobY + breathY + this.landing.value,
      this.position.z - sin * bobX + fz + leanZ,
    );
    cam.rotation.set(
      this.viewPitch + bobPitch + breathPitch + this.recoilPitch.value + this.landing.value * 0.5 + shakeP,
      this.viewYaw + bobYaw + breathYaw + this.recoilYaw.value + shakeY,
      bobRoll + this.strafeRoll + this.turnSway + this.recoilRoll.value + shakeR - this.lean * 0.25,
    );

    const baseFov = this.settings.data.fov;
    const targetFov = this.focus
      ? this.focus.fov
      : sprinting && this.groundSpeed > WALK_SPEED * 1.1
        ? baseFov + SPRINT_FOV_BONUS
        : baseFov - this.aimBlend * AIM_FOV;
    this.fov = dt === 0 ? targetFov : damp(this.fov, targetFov, 4, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Zustand für die Körperanimation (entkoppelt, damit später echte Modelle dieselben Daten nutzen) */
  getAnimState(): BodyAnimState {
    return {
      eye: this.position,
      eyeHeight: this.height,
      yaw: this.viewYaw,
      pitch: this.viewPitch,
      velocity: this.velocity,
      onGround: this.onGround,
      phase: this.bobPhase,
      walk: this.bobAmount,
      sprinting: this.sprinting,
      landing: this.landing.value,
      time: this.time,
      aim: this.aimBlend,
      lean: this.lean,
    };
  }

  /**
   * Ziel-Augenhöhe und seitlicher Versatz für die aktuelle Haltung.
   * Geduckt + Zielen vor einer Deckung: über die Kante hochkommen, wenn sie niedrig genug ist,
   * sonst seitlich daran vorbeibeugen (zuerst zur zuletzt gestrafeten Seite, sonst rechts).
   */
  private stanceTarget(feetY: number): { height: number; lean: number } {
    if (!this.crouching) {
      this.coverState = 'none';
      return { height: STAND_EYE, lean: 0 };
    }
    if (!this.aiming || !this.onGround) {
      this.coverState = 'none';
      return { height: CROUCH_EYE, lean: 0 };
    }

    // Immer von der geduckten Kamerahöhe aus prüfen → kein Flattern, wenn man schon hochgekommen ist
    const camY = feetY + CROUCH_EYE - CAMERA_DROP;
    const x = this.position.x;
    const z = this.position.z;
    const dx = -Math.sin(this.yaw);
    const dz = -Math.cos(this.yaw);
    const top = this.coverTop(x, z, dx, dz, camY);
    if (top === null) {
      this.coverState = 'none';
      return { height: CROUCH_EYE, lean: 0 };
    }

    // Über die Deckung: Kamera (und damit die Waffe) knapp über die Kante heben
    const overEye = top + PEEK_CLEARANCE + CAMERA_DROP - feetY;
    if (overEye <= STAND_EYE && this.coverTop(x, z, dx, dz, feetY + overEye - CAMERA_DROP) === null) {
      this.coverState = 'over';
      return { height: Math.max(CROUCH_EYE, overEye), lean: 0 };
    }

    // Neben die Deckung: seitlich versetzte Position muss frei sein und freie Sicht nach vorn haben
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    for (const side of [this.leanSide, -this.leanSide]) {
      const ox = x + rx * side * LEAN_DIST;
      const oz = z + rz * side * LEAN_DIST;
      if (this.pointBlocked(x + rx * side * LEAN_DIST * 0.5, z + rz * side * LEAN_DIST * 0.5, camY)) continue;
      if (this.pointBlocked(ox, oz, camY)) continue;
      if (this.coverTop(ox, oz, dx, dz, camY) !== null) continue;
      this.coverState = side > 0 ? 'right' : 'left';
      return { height: CROUCH_EYE, lean: side * LEAN_DIST };
    }

    this.coverState = 'blocked';
    return { height: CROUCH_EYE, lean: 0 };
  }

  /** Oberkante der höchsten Deckung, die auf Höhe y direkt vor dem Punkt steht (null = frei) */
  private coverTop(x: number, z: number, dx: number, dz: number, y: number): number | null {
    let top: number | null = null;
    for (let t = SCALE.playerRadius * 0.6; t <= COVER_REACH; t += 0.08) {
      const px = x + dx * t;
      const pz = z + dz * t;
      for (const c of this.colliders) {
        if (y <= colliderMinY(c) || y >= colliderMaxY(c)) continue;
        const d = closestXZ(c, px, pz);
        const r = c.type === 'cylinder' ? c.radius : 0.04;
        if (d.distSq < r * r) top = Math.max(top ?? -Infinity, colliderMaxY(c));
      }
    }
    return top;
  }

  /** Steckt ein dünner Körper (Kopf/Kamera) an dieser Stelle in einem Collider? */
  private pointBlocked(x: number, z: number, camY: number): boolean {
    const lo = camY - 0.4;
    const hi = camY + 0.35;
    for (const c of this.colliders) {
      if (hi <= colliderMinY(c) || lo >= colliderMaxY(c)) continue;
      const d = closestXZ(c, x, z);
      const r = c.type === 'cylinder' ? c.radius + LEAN_PROBE_RADIUS : LEAN_PROBE_RADIUS;
      if (d.distSq < r * r) return true;
    }
    return false;
  }

  /** Maximale Augenhöhe unter niedrigen Decken/Objekten (Aufstehen aus der Hocke) */
  private headroom(x: number, z: number, feetY: number): number {
    const r = SCALE.playerRadius;
    let max = STAND_EYE;
    for (const c of this.colliders) {
      const bottom = colliderMinY(c);
      // Nur Objekte über dem geduckten Kopf; alles darunter blockiert ohnehin seitlich
      if (bottom < feetY + CROUCH_EYE - 0.15 || bottom > feetY + STAND_EYE + 0.1) continue;
      const d = closestXZ(c, x, z);
      const reach = c.type === 'cylinder' ? c.radius + r : r;
      if (d.distSq < reach * reach) max = Math.min(max, bottom - feetY - 0.05);
    }
    return max;
  }

  private groundHeight(pos: THREE.Vector3, prevFeet: number): number {
    const r = SCALE.playerRadius;
    let ground = 0;
    for (const c of this.colliders) {
      const top = colliderMaxY(c);
      if (top > prevFeet + STEP_HEIGHT || top <= ground) continue;
      const d = closestXZ(c, pos.x, pos.z);
      const reach = c.type === 'cylinder' ? c.radius + r : r;
      if (d.distSq < reach * reach) ground = top;
    }
    return ground;
  }

  private resolveCollisionsAxis(pos: THREE.Vector3, axis: 'x' | 'z'): void {
    const r = SCALE.playerRadius;
    const feetY = pos.y - this.height + STEP_HEIGHT;
    const headY = pos.y - 0.1;

    for (const c of this.colliders) {
      if (feetY >= colliderMaxY(c) || headY <= colliderMinY(c)) continue;
      const d = closestXZ(c, pos.x, pos.z);
      const minDist = c.type === 'cylinder' ? r + c.radius : r;
      if (d.distSq < minDist * minDist) {
        const dist = Math.sqrt(d.distSq) || 0.0001;
        const push = (minDist - dist) / dist;
        if (axis === 'x') pos.x += d.dx * push;
        else pos.z += d.dz * push;
      }
    }
  }
}
