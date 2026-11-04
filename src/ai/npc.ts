import * as THREE from 'three';
import { CAMERA_DROP, CROUCH_EYE, PlayerController } from '../player/controller.ts';
import { PlayerBody } from '../player/body.ts';
import type { Action, Settings } from '../core/settings.ts';
import { RAPIER, WORLD_QUERY, type PhysicsWorld } from '../physics/physics.ts';
import type { NavGrid } from './navGrid.ts';

// Gegner-KI. Jeder NPC steuert einen echten PlayerController + PlayerBody über „gedrückte Tasten“
// (vorwärts/seitwärts, Sprint, Ducken, Zielen, Springen, Taschenlampe, Schießen) und einen Blickwinkel —
// er hat also exakt die Fähigkeiten und Einschränkungen des Spielers: Sprint nur vorwärts und ohne Zielen,
// über Deckung hochkommen bzw. seitlich vorbeugen beim Zielen aus der Hocke, Rückstoß, Trägheit.
//
// Aufbau:
// - Wahrnehmung (10 Hz): Sichtkegel + Sichtlinie (Rapier-Strahlen), Aufmerksamkeit baut sich je nach
//   Entfernung/Haltung/Taschenlampe des Spielers auf; Hören von Schüssen; Meldungen im Trupp.
// - Entscheidung (≈3 Hz): Zustände advance / engage / cover / flank / search, abhängig von Rolle
//   (assault, flanker, support), Persönlichkeit, Gesundheit und Unterdrückung (Beschuss).
// - Ausführung (jeden Frame): Wegsuche im NavGrid, Ausweichen, Feststeck-Erkennung, Zielen mit
//   menschlicher Drehgeschwindigkeit und wanderndem Zielfehler, Feuerstöße.

export type NpcState = 'advance' | 'engage' | 'cover' | 'flank' | 'search';
export type NpcRole = 'assault' | 'flanker' | 'support';

/** Was die KI über den Spieler wissen darf (Wahrnehmung prüft Sichtlinie selbst) */
export interface Threat {
  eye: THREE.Vector3;
  feet: THREE.Vector3;
  velocity: THREE.Vector3;
  crouching: boolean;
  flashlight: boolean;
  alive: boolean;
}

export interface NpcWorld {
  physics: PhysicsWorld;
  nav: NavGrid;
  threat: Threat;
  squad: readonly Npc[];
  /** 0 = leicht … 1 = schwer (steigt mit den Wellen) */
  difficulty: number;
  /** Schuss abgeben — Treffer wertet der Trainingsmodus aus */
  fire(npc: Npc): void;
  /** Sichtung an den Trupp melden */
  report(npc: Npc): void;
}

export interface NpcProfile {
  aggression: number; // 0..1: drängt nach vorn, nimmt seltener Deckung
  skill: number; // 0..1: Zielgenauigkeit, Drehgeschwindigkeit
  reaction: number; // s bis zum ersten Schuss nach Sichtung
  discipline: number; // 0..1: Lampe aus in Deckung/beim Flankieren, schleicht, hält Positionen
}

class AiInput {
  private keys = new Set<Action>();
  down(a: Action): boolean {
    return this.keys.has(a);
  }
  set(a: Action, on: boolean): void {
    if (on) this.keys.add(a);
    else this.keys.delete(a);
  }
  clear(): void {
    this.keys.clear();
  }
}

const TAU = Math.PI * 2;
const wrap = (a: number) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

const FOV_HALF = 1.25; // ~72° zur Seite
const SIGHT_RANGE = 70;
const ARRIVE = 0.45;
const CHEST_DROP = 0.45; // Brust unter Augenhöhe des Ziels

export class Npc {
  readonly body: PlayerBody;
  readonly controller: PlayerController;
  readonly camera = new THREE.PerspectiveCamera(80, 16 / 9, 0.05, 200);
  private input = new AiInput();

  active = false;
  alive = false;
  health = 100;
  state: NpcState = 'advance';
  role: NpcRole = 'support';
  private p: NpcProfile = { aggression: 0.5, skill: 0.5, reaction: 0.3, discipline: 0.5 };

  // Wahrnehmung / Wissen
  private awareness = 0;
  visible = false;
  lastSeen = -Infinity;
  readonly lastKnown = new THREE.Vector3();
  hasIntel = false;
  private reactUntil = 0;
  suppression = 0;

  private time = 0;
  private thinkTimer = 0;
  private perceiveTimer = 0;

  // Bewegung
  private path: THREE.Vector3[] | null = null;
  private pathGoal = new THREE.Vector3();
  private pathTimer = 0;
  private move = new THREE.Vector2();
  private stuckTime = 0;
  private detourTime = 0;
  private detourSign = 1;
  private strafeDir = 1;
  private strafeTimer = 0;
  private holdTimer = 0;

  // Taktik
  private cover: THREE.Vector3 | null = null;
  private coverPhase: 'hide' | 'peek' = 'hide';
  private coverTimer = 0;
  private coverSearchAt = 0;
  private peekSaw = false;
  private dryPeeks = 0;
  private flankGoal: THREE.Vector3 | null = null;
  private flankUntil = 0;
  private searchGoal: THREE.Vector3 | null = null;
  private searchLook = 0;

  // Zielen / Feuern
  private desiredYaw = 0;
  private desiredPitch = 0;
  private aimErr = new THREE.Vector2();
  private aimErrTarget = new THREE.Vector2();
  private aimErrTimer = 0;
  private aimHead = false;
  private trackTime = 0;
  private fireCooldown = 0;
  private burstLeft = 0;
  private wantFire = false;

  private deathTime = 0;
  private deathBaseY = 0;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  private jumpRequest = false;

  constructor(
    scene: THREE.Scene,
    private physics: PhysicsWorld,
    settings: Settings,
  ) {
    const far = new THREE.Vector3(0, -500, 0);
    this.controller = new PlayerController(this.camera, document.body, physics, far, this.input, settings, 0, true);
    this.body = new PlayerBody(scene, physics, { npc: true });
    this.body.root.userData.npc = this;
    this.body.root.userData.noWeather = true;
    this.body.root.rotation.order = 'YXZ';
    this.body.setHidden(true);
  }

  /** Fußposition */
  get feet(): THREE.Vector3 {
    const c = this.controller;
    return _feet.set(c.position.x, c.position.y - c.eyeHeight, c.position.z);
  }

  /** Ziel-Deckungspunkt (für Absprache im Trupp) */
  get coverPos(): THREE.Vector3 | null {
    return this.cover;
  }

  spawn(feet: THREE.Vector3, yaw: number, profile: NpcProfile, intel: THREE.Vector3 | null): void {
    this.p = profile;
    this.controller.teleportFeet(feet, yaw);
    this.controller.setLook(yaw, 0);
    this.desiredYaw = yaw;
    this.desiredPitch = 0;
    this.body.resetPose();
    this.body.setHidden(false);
    this.body.setFlashlight(true);
    this.input.clear();
    this.active = this.alive = true;
    this.health = 100;
    this.state = 'advance';
    this.cover = this.flankGoal = this.searchGoal = this.path = null;
    this.awareness = 0;
    this.visible = false;
    this.lastSeen = -Infinity;
    this.suppression = 0;
    this.burstLeft = 0;
    this.fireCooldown = 0;
    this.trackTime = 0;
    this.hasIntel = !!intel;
    if (intel) this.lastKnown.copy(intel);
    this.thinkTimer = Math.random() * 0.3;
    this.perceiveTimer = Math.random() * 0.1;
  }

  deactivate(): void {
    this.active = this.alive = false;
    this.input.clear();
    this.body.setHidden(true);
  }

  /** Treffer: Schaden, Zusammenzucken, Position des Schützen ist bekannt */
  damage(amount: number, from: THREE.Vector3): boolean {
    if (!this.alive) return false;
    this.health -= amount;
    this.suppression = Math.min(2, this.suppression + 1);
    this.controller.hurt(0.7);
    this.aimErr.x += gauss() * 0.08;
    this.aimErr.y += gauss() * 0.05;
    this.know(from, 0.5);
    if (this.health <= 0) {
      this.kill();
      return true;
    }
    return false;
  }

  /** Schuss gehört (Entfernung zur Quelle bestimmt die Ungenauigkeit), Kugel flog nah vorbei → Unterdrückung */
  hearShot(origin: THREE.Vector3, nearMiss: number): void {
    if (!this.alive) return;
    const d = origin.distanceTo(this.controller.position);
    if (d > 60) return;
    if (nearMiss < 1.6) this.suppression = Math.min(2, this.suppression + (1.6 - nearMiss) * 0.7);
    if (!this.visible) this.know(origin, d * 0.06 + (nearMiss < 1.6 ? 0 : 1.5));
  }

  /** Information über die Spielerposition (mit Ungenauigkeit) */
  know(pos: THREE.Vector3, noise: number): void {
    this.lastKnown.set(pos.x + gauss() * noise, pos.y, pos.z + gauss() * noise);
    this.hasIntel = true;
  }

  private kill(): void {
    this.alive = false;
    this.input.clear();
    this.deathTime = 0;
    this.deathBaseY = this.body.root.position.y;
    this.cover = null;
  }

  update(dt: number, w: NpcWorld): void {
    if (!this.active) return;
    if (!this.alive) {
      this.updateDead(dt);
      return;
    }
    this.time += dt;
    this.fireCooldown -= dt;
    this.suppression = Math.max(0, this.suppression - dt * 0.45);
    this.pathTimer -= dt;
    if ((this.perceiveTimer -= dt) <= 0) {
      this.perceiveTimer = 0.1;
      this.perceive(w);
    }
    if ((this.thinkTimer -= dt) <= 0) {
      this.thinkTimer = rand(0.22, 0.4);
      this.think(w);
    }
    this.act(dt, w);
    this.controller.update(dt);
    this.camera.updateMatrixWorld();
    this.body.update(dt, this.controller.getAnimState(), this.camera);
    this.tryFire(w);
  }

  private updateDead(dt: number): void {
    this.deathTime += dt;
    const k = Math.min(1, this.deathTime / 0.6);
    const e = k * k;
    this.body.root.rotation.x = e * 1.5; // nach hinten umfallen
    this.body.root.position.y = this.deathBaseY + 0.12 * e;
    this.body.root.updateMatrixWorld(true);
    if (this.deathTime > 7) this.deactivate();
  }

  // ---------------------------------------------------------------- Wahrnehmung

  private perceive(w: NpcWorld): void {
    const t = w.threat;
    const was = this.visible;
    if (!t.alive) {
      this.visible = false;
      this.awareness = 0;
      return;
    }
    const eye = this.controller.position;
    const dx = t.eye.x - eye.x;
    const dz = t.eye.z - eye.z;
    const d = Math.hypot(dx, dz, t.eye.y - eye.y);
    const off = Math.abs(wrap(Math.atan2(-dx, -dz) - this.controller.lookYaw));
    let vis = 0;
    if ((off < FOV_HALF || d < 3) && d < SIGHT_RANGE) {
      _chest.copy(t.eye).setY(t.eye.y - CHEST_DROP);
      if (this.clear(eye, t.eye) || this.clear(eye, _chest)) {
        const speed = Math.hypot(t.velocity.x, t.velocity.z);
        vis = clamp(1.5 - d / 40, 0.2, 1.2) * (t.crouching ? 0.6 : 1) * (t.flashlight ? 1.4 : 1) * (speed > 4 ? 1.3 : 1);
        // Peripherie sieht schlechter
        if (off > 0.7) vis *= 0.55;
      }
    }
    const rate = (this.hasIntel ? 8 : 2.5) * vis;
    this.awareness = vis > 0 ? Math.min(1, this.awareness + rate * 0.1) : Math.max(0, this.awareness - 0.04);
    this.visible = vis > 0 && this.awareness >= 1;
    if (this.visible) {
      this.lastKnown.copy(t.feet);
      this.lastSeen = this.time;
      this.hasIntel = true;
      w.report(this);
      if (!was) {
        this.reactUntil = this.time + this.p.reaction * (1 - 0.4 * w.difficulty);
        this.trackTime = 0;
      }
    }
  }

  // ---------------------------------------------------------------- Entscheidung

  private think(w: NpcWorld): void {
    const t = w.threat;
    if (!t.alive) {
      this.cover = null;
      this.state = 'search';
      return;
    }
    const feet = this.feet;
    const lost = this.time - this.lastSeen;

    // Deckung noch gut? Aus der Hocke darf der Spieler uns nicht sehen (sonst wurden wir flankiert)
    if (this.cover && this.atCover(feet)) {
      _v.copy(this.cover).setY(this.cover.y + CROUCH_EYE - 0.1);
      const from = this.visible ? t.eye : _v2.copy(this.lastKnown).setY(this.lastKnown.y + 1.6);
      if (this.clear(_v, from)) {
        this.cover = null;
        this.coverSearchAt = 0;
      }
    }

    if (lost < 1) {
      // Feindkontakt
      if (this.cover) {
        this.state = 'cover';
        return;
      }
      const hurt = this.health < 45;
      const wantCover =
        hurt || this.suppression > 0.6 || (this.role !== 'assault' && Math.random() < 0.45 * (1 - this.p.aggression)) || (this.role === 'support' && Math.random() < 0.3);
      if (wantCover && this.time >= this.coverSearchAt) {
        this.coverSearchAt = this.time + 1.5;
        const c = this.findCover(w, hurt);
        if (c) {
          this.cover = c;
          this.coverPhase = 'hide';
          this.coverTimer = rand(0.2, 0.6);
          this.dryPeeks = 0;
          this.state = 'cover';
          return;
        }
      }
      this.state = 'engage';
      return;
    }
    if (!this.hasIntel) {
      this.state = 'search';
      return;
    }
    // Kontakt verloren: Position halten, flankieren oder vorrücken
    if (this.cover && lost < 3 + this.p.discipline * 4 && this.dryPeeks < 2) {
      this.state = 'cover';
      return;
    }
    this.cover = null;
    const d = Math.hypot(feet.x - this.lastKnown.x, feet.z - this.lastKnown.z);
    if (this.state === 'search' && d < 6) return;
    if (d < 2.5) {
      this.state = 'search';
      this.searchGoal = null;
      this.searchLook = rand(1.5, 2.5);
    } else if (this.role === 'flanker' && d > 6) this.state = 'flank';
    else this.state = 'advance';
  }

  /**
   * Deckungspunkt suchen: begehbare Stellen im Umkreis, an denen ein Hindernis (≤1.15 m vor uns) den Kopf in
   * der Hocke verdeckt, und von denen man über die Kante oder seitlich daran vorbei auf den Gegner schießen kann.
   */
  private findCover(w: NpcWorld, retreat: boolean): THREE.Vector3 | null {
    const feet = _f2.copy(this.feet);
    const threat = this.visible ? _t.copy(w.threat.eye) : _t.copy(this.lastKnown).setY(this.lastKnown.y + 1.6);
    const ideal = retreat ? 22 : this.role === 'assault' ? 8 : 14;
    let best: THREE.Vector3 | null = null;
    let bestScore = -Infinity;
    const myThreatD = Math.hypot(feet.x - threat.x, feet.z - threat.z);
    for (let n = 0; n < 28; n++) {
      const a = (n / 28) * TAU + rand(-0.1, 0.1);
      const r = 1.2 + (n % 4) * 2.6 + rand(0, 1.2);
      const p = w.nav.nearest(feet.x + Math.cos(a) * r, feet.z + Math.sin(a) * r, 0.6, _c);
      if (!p || Math.abs(p.y - feet.y) > 1) continue;
      const dT = Math.hypot(p.x - threat.x, p.z - threat.z);
      if (dT < 4) continue;
      // Platz schon von einem Kameraden belegt/angesteuert?
      let taken = false;
      for (const o of w.squad) {
        if (o === this || !o.alive) continue;
        const op = o.coverPos ?? o.feet;
        if (Math.hypot(op.x - p.x, op.z - p.z) < 1.6) taken = true;
      }
      if (taken) continue;
      // Verdeckt in der Hocke, Hindernis direkt davor
      _v.set(p.x, p.y + CROUCH_EYE - 0.1, p.z);
      const toi = this.blockedAt(_v, threat);
      if (toi === null || toi > 1.15) continue;
      // Schussmöglichkeit: stehend über die Kante oder seitlich vorbei
      const hx = threat.x - p.x;
      const hz = threat.z - p.z;
      const hl = Math.hypot(hx, hz) || 1;
      const rx = -hz / hl;
      const rz = hx / hl;
      const over = this.clear(_v.set(p.x, p.y + 1.55, p.z), threat);
      const side =
        !over &&
        (this.clear(_v.set(p.x + rx * 0.5, p.y + 0.9, p.z + rz * 0.5), threat) || this.clear(_v.set(p.x - rx * 0.5, p.y + 0.9, p.z - rz * 0.5), threat));
      if (!over && !side && !retreat) continue;
      let score = -r * 0.6 - Math.abs(dT - ideal) * 0.35 + (over ? 0.6 : 0) + (over || side ? 0 : -3);
      // vorsichtige NPCs laufen ungern auf den Gegner zu
      if (dT < myThreatD - 3) score -= (1 - this.p.aggression) * 2.5;
      if (score > bestScore) {
        bestScore = score;
        best = p.clone();
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- Ausführung

  private act(dt: number, w: NpcWorld): void {
    const t = w.threat;
    const feet = _f.copy(this.feet);
    const myPos = this.controller.position;
    this.move.set(0, 0);
    let sprint = false;
    let crouch = false;
    let aim = false;
    let faceMove = false;
    let lookTarget: THREE.Vector3 | null = null;
    this.wantFire = false;
    let flashlight = true;
    if (this.state === 'cover' && !this.cover) this.state = 'engage';

    // Zielpunkt am Gegner (Brust, gute Schützen manchmal Kopf)
    const aimPoint = _aim.copy(t.eye).setY(t.eye.y - (this.aimHead ? 0.05 : CHEST_DROP));
    const distT = Math.hypot(t.feet.x - feet.x, t.feet.z - feet.z);

    switch (this.state) {
      case 'engage': {
        const [minR, maxR] = this.role === 'assault' ? [3, 11] : [7, 22];
        aim = distT > 5;
        crouch = false;
        if (this.holdTimer > 0) {
          // kurz stehen bleiben und gezielt schießen (in der Hocke ruhiger)
          this.holdTimer -= dt;
          crouch = this.p.discipline > 0.4;
        } else if (distT > maxR) {
          this.goTo(t.feet, w);
        } else {
          const ax = t.feet.x - feet.x;
          const az = t.feet.z - feet.z;
          const l = Math.hypot(ax, az) || 1;
          // seitlich ausweichen (Strafing), bei zu kurzer Distanz zurückweichen
          this.strafeTimer -= dt;
          if (this.strafeTimer <= 0) {
            this.strafeTimer = rand(0.7, 2.0);
            if (Math.random() < 0.6) this.strafeDir *= -1;
            if (Math.random() < 0.25 * (1 - this.p.aggression) + 0.1) this.holdTimer = rand(0.8, 1.8);
          }
          const back = distT < minR ? -0.8 : 0;
          this.move.set((-az / l) * this.strafeDir + (ax / l) * back, (ax / l) * this.strafeDir + (az / l) * back);
          if (!this.probe(feet, this.move, w)) {
            this.strafeDir *= -1;
            this.move.set((-az / l) * this.strafeDir + (ax / l) * back, (ax / l) * this.strafeDir + (az / l) * back);
          }
        }
        lookTarget = this.visible ? aimPoint : _v3.copy(this.lastKnown).setY(this.lastKnown.y + 1.3);
        this.wantFire = true;
        break;
      }
      case 'cover': {
        const c = this.cover!;
        lookTarget = this.visible ? aimPoint : _v3.copy(this.lastKnown).setY(this.lastKnown.y + 1.3);
        if (!this.atCover(feet)) {
          const d = Math.hypot(c.x - feet.x, c.z - feet.z);
          this.goTo(c, w);
          sprint = d > 3 && !(this.visible && this.p.aggression > 0.7);
          crouch = d < 1.5;
          aim = !sprint && this.visible;
          faceMove = sprint;
          this.wantFire = this.visible && !sprint;
          flashlight = this.p.discipline < 0.6;
          break;
        }
        crouch = true;
        flashlight = this.p.discipline < 0.6;
        this.coverTimer -= dt;
        if (this.coverPhase === 'hide') {
          if (this.suppression > 0.9) this.coverTimer = Math.max(this.coverTimer, 0.35);
          if (this.coverTimer <= 0) {
            this.coverPhase = 'peek';
            this.coverTimer = rand(1.3, 2.6);
            this.peekSaw = false;
          }
        } else {
          aim = true; // Zielen aus der Hocke → Controller hebt über die Kante bzw. beugt seitlich vor
          this.wantFire = true;
          if (this.visible) this.peekSaw = true;
          const burstDone = this.peekSaw && this.burstLeft === 0 && this.fireCooldown > 0.3;
          if (this.coverTimer <= 0 || burstDone || this.suppression > 1.3) {
            this.coverPhase = 'hide';
            this.coverTimer = rand(0.6, 1.4) + (1 - this.p.aggression) * rand(0, 1.4) + this.suppression * 0.6;
            this.dryPeeks = this.peekSaw ? 0 : this.dryPeeks + 1;
          }
        }
        break;
      }
      case 'flank': {
        const lk = this.lastKnown;
        if (!this.flankGoal || this.time > this.flankUntil) {
          const base = Math.atan2(feet.z - lk.z, feet.x - lk.x);
          let best: THREE.Vector3 | null = null;
          let bestD = -Infinity;
          for (const s of [1, -1]) {
            const a = base + s * rand(1.2, 1.7);
            const p = w.nav.nearest(lk.x + Math.cos(a) * 9, lk.z + Math.sin(a) * 9, 3);
            if (!p) continue;
            // Seite wählen, auf der weniger Kameraden sind
            let spread = 0;
            for (const o of w.squad) if (o !== this && o.alive) spread += Math.min(8, o.feet.distanceTo(p));
            if (spread > bestD) {
              bestD = spread;
              best = p.clone();
            }
          }
          this.flankGoal = best;
          this.flankUntil = this.time + 14;
        }
        if (!this.flankGoal || this.goTo(this.flankGoal, w)) {
          this.flankGoal = null;
          this.state = 'advance';
          this.role = 'assault';
          break;
        }
        const dLk = Math.hypot(lk.x - feet.x, lk.z - feet.z);
        sprint = dLk > 14;
        crouch = !sprint && dLk < 11 && this.p.discipline > 0.35; // anschleichen
        faceMove = sprint;
        if (!sprint) lookTarget = _v3.copy(lk).setY(lk.y + 1.3);
        aim = !sprint && dLk < 12;
        flashlight = this.p.discipline < 0.5;
        this.wantFire = this.visible;
        break;
      }
      case 'advance': {
        const lk = this.lastKnown;
        const d = Math.hypot(lk.x - feet.x, lk.z - feet.z);
        this.goTo(lk, w);
        sprint = d > 12 && this.time - this.lastSeen > 1.5;
        crouch = !sprint && d < 7 && this.p.discipline > 0.65;
        faceMove = sprint || d > 14;
        if (!faceMove) lookTarget = _v3.copy(lk).setY(lk.y + 1.3);
        aim = !sprint && d < 14;
        this.wantFire = this.visible;
        break;
      }
      case 'search': {
        if (this.searchLook > 0) {
          // umsehen
          this.searchLook -= dt;
          this.desiredYaw = this.controller.lookYaw + Math.sin(this.time * 1.7) * 0.6;
          this.desiredPitch = -0.05;
          aim = true;
        } else {
          if (!this.searchGoal) {
            const base = this.hasIntel ? this.lastKnown : feet;
            this.searchGoal = w.nav.randomNear(base.x, base.z, 8)?.clone() ?? null;
          }
          if (!this.searchGoal || this.goTo(this.searchGoal, w)) {
            this.searchGoal = null;
            this.searchLook = rand(1, 2.2);
          }
          faceMove = true;
        }
        break;
      }
    }

    // Kameraden/Spieler nicht über den Haufen laufen
    if (this.move.lengthSq() > 0) {
      this.move.normalize();
      for (const o of w.squad) {
        if (o === this || !o.alive) continue;
        const of = o.feet;
        const dx = feet.x - of.x;
        const dz = feet.z - of.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.3 && d > 1e-3) this.move.add(_m2.set(dx / d, dz / d).multiplyScalar((1.3 - d) * 1.6));
      }
      const pdx = feet.x - t.feet.x;
      const pdz = feet.z - t.feet.z;
      const pd = Math.hypot(pdx, pdz);
      if (pd < 1.1 && pd > 1e-3) this.move.add(_m2.set(pdx / pd, pdz / pd).multiplyScalar((1.1 - pd) * 2));
      this.unstick(dt, sprint);
    } else this.stuckTime = 0;

    // --- Blick ---
    if (faceMove && this.move.lengthSq() > 0) {
      this.desiredYaw = Math.atan2(-this.move.x, -this.move.y);
      this.desiredPitch = -0.08;
    } else if (lookTarget) {
      this.updateAimError(dt, w);
      const cx = myPos.x;
      const cy = myPos.y - CAMERA_DROP;
      const cz = myPos.z;
      const dx = lookTarget.x - cx;
      const dz = lookTarget.z - cz;
      this.desiredYaw = Math.atan2(-dx, -dz) + (this.visible ? this.aimErr.x : 0);
      this.desiredPitch = Math.atan2(lookTarget.y - cy, Math.hypot(dx, dz)) + (this.visible ? this.aimErr.y : 0);
    }
    const turn = lerp(4.5, 9, this.p.skill) * (1 + w.difficulty * 0.3);
    const yaw0 = this.controller.lookYaw;
    const dy = wrap(this.desiredYaw - yaw0);
    const dp = this.desiredPitch - this.controller.lookPitch;
    const k = 1 - Math.exp(-14 * dt);
    const yaw = yaw0 + clamp(dy * k, -turn * dt, turn * dt);
    const pitch = this.controller.lookPitch + clamp(dp * k, -turn * dt, turn * dt);
    this.controller.setLook(yaw, pitch);

    // --- Tasten: Bewegungsrichtung relativ zum Blick auf 8 Richtungen (wie WASD) ---
    let fwd = 0;
    let str = 0;
    if (this.move.lengthSq() > 1e-4) {
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const l = this.move.length();
      const mf = (-sin * this.move.x - cos * this.move.y) / l;
      const ms = (cos * this.move.x - sin * this.move.y) / l;
      fwd = mf > 0.38 ? 1 : mf < -0.38 ? -1 : 0;
      str = ms > 0.38 ? 1 : ms < -0.38 ? -1 : 0;
    }
    const inp = this.input;
    inp.set('forward', fwd > 0);
    inp.set('back', fwd < 0);
    inp.set('right', str > 0);
    inp.set('left', str < 0);
    inp.set('sprint', sprint && fwd > 0);
    inp.set('crouch', crouch);
    inp.set('aim', aim && !(sprint && fwd > 0));
    inp.set('jump', this.jumpRequest);
    this.jumpRequest = false;
    this.body.setFlashlight(flashlight);
  }

  /** Weg zum Ziel folgen; true = angekommen */
  private goTo(goal: THREE.Vector3, w: NpcWorld): boolean {
    const feet = this.feet;
    const dGoal = Math.hypot(goal.x - feet.x, goal.z - feet.z);
    if (dGoal < ARRIVE) return true;
    if (!this.path || this.pathTimer <= 0 || this.pathGoal.distanceTo(goal) > 1) {
      this.path = w.nav.findPath(feet, goal);
      this.pathGoal.copy(goal);
      this.pathTimer = rand(0.8, 1.3);
    }
    const path = this.path;
    while (path && path.length > 1 && Math.hypot(path[0].x - feet.x, path[0].z - feet.z) < ARRIVE) path.shift();
    const next = path && path.length ? path[0] : goal;
    this.move.set(next.x - feet.x, next.z - feet.z);
    if (this.detourTime > 0) {
      // seitlich am Hindernis vorbei
      const x = this.move.x;
      this.move.x = -this.move.y * this.detourSign + x * 0.3;
      this.move.y = x * this.detourSign + this.move.y * 0.3;
    }
    return false;
  }

  /** Feststecken erkennen (will laufen, bewegt sich kaum) → ausweichen/springen, Weg neu planen */
  private unstick(dt: number, sprint: boolean): void {
    const v = this.controller.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (this.detourTime > 0) {
      this.detourTime -= dt;
      return;
    }
    if (speed < (sprint ? 0.8 : 0.35)) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
    if (this.stuckTime > 0.6) {
      this.stuckTime = 0;
      this.detourTime = rand(0.4, 0.9);
      this.detourSign = Math.random() < 0.5 ? 1 : -1;
      this.path = null;
      this.strafeDir *= -1;
      this.jumpRequest = this.controller.grounded; // niedriges Hindernis? drüber springen
    }
  }

  /** Ist ein kurzer Schritt in diese Richtung begehbar? */
  private probe(feet: THREE.Vector3, dir: THREE.Vector2, w: NpcWorld): boolean {
    const l = dir.length() || 1;
    return w.nav.lineClear(feet.x, feet.z, feet.x + (dir.x / l) * 1.2, feet.z + (dir.y / l) * 1.2);
  }

  private atCover(feet: THREE.Vector3): boolean {
    return !!this.cover && Math.hypot(this.cover.x - feet.x, this.cover.z - feet.z) < 0.6;
  }

  private updateAimError(dt: number, w: NpcWorld): void {
    if (this.visible) this.trackTime += dt;
    else this.trackTime = Math.max(0, this.trackTime - dt * 2);
    this.aimErrTimer -= dt;
    if (this.aimErrTimer <= 0) {
      this.aimErrTimer = rand(0.25, 0.5);
      const v = this.controller.velocity;
      const tv = w.threat.velocity;
      const spread =
        lerp(0.075, 0.02, this.p.skill) *
          (1 - 0.35 * w.difficulty) *
          (1 + Math.hypot(v.x, v.z) / 3) *
          (1 + Math.hypot(tv.x, tv.z) / 5) *
          (0.4 + 0.6 / (1 + this.trackTime * 0.8)) +
        this.suppression * 0.03;
      this.aimErrTarget.set(gauss() * spread, gauss() * spread * 0.6);
      this.aimHead = Math.random() < this.p.skill * 0.25 * (0.5 + w.difficulty);
    }
    this.aimErr.lerp(this.aimErrTarget, 1 - Math.exp(-6 * dt));
  }

  private tryFire(w: NpcWorld): void {
    if (!this.wantFire || !this.visible || !w.threat.alive) return;
    if (this.time < this.reactUntil || this.fireCooldown > 0) return;
    const t = w.threat;
    const cam = this.camera.position;
    const dist = cam.distanceTo(t.eye);
    if (this.controller.aimAmount < 0.7 && dist > 8) return;
    // erst schießen, wenn der Blick (inkl. gewolltem Zielfehler) eingeschwenkt ist
    if (Math.abs(wrap(this.desiredYaw - this.controller.lookYaw)) > 0.06 || Math.abs(this.desiredPitch - this.controller.lookPitch) > 0.06) return;
    // Sichtlinie von der Kamera (beim Spähen über Deckung evtl. noch verdeckt)
    _chest.copy(t.eye).setY(t.eye.y - CHEST_DROP);
    if (!this.clear(cam, _chest) && !this.clear(cam, t.eye)) return;
    // keine Kameraden in der Schusslinie
    this.camera.getWorldDirection(_dir);
    for (const o of w.squad) {
      if (o === this || !o.alive) continue;
      _v.copy(o.controller.position).setY(o.controller.position.y - 0.5).sub(cam);
      const along = _v.dot(_dir);
      if (along > 0 && along < dist && _v.addScaledVector(_dir, -along).length() < 0.6) {
        this.strafeTimer = 0;
        return;
      }
    }
    w.fire(this);
    this.controller.kick();
    this.body.kick();
    if (this.burstLeft <= 0) this.burstLeft = 2 + Math.floor(Math.random() * (2 + 3 * this.p.aggression));
    this.burstLeft--;
    this.fireCooldown = this.burstLeft > 0 ? rand(0.16, 0.3) : rand(0.5, 1.3) * (1.2 - this.p.aggression * 0.5) * (1 - 0.3 * w.difficulty);
  }

  // ---------------------------------------------------------------- Strahlen

  /** Freie Sichtlinie zwischen zwei Punkten (nur Welt-Geometrie) */
  private clear(a: THREE.Vector3, b: THREE.Vector3): boolean {
    return this.blockedAt(a, b) === null;
  }

  /** Entfernung zum ersten Hindernis zwischen a und b (null = frei) */
  private blockedAt(a: THREE.Vector3, b: THREE.Vector3): number | null {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) return null;
    this.ray.origin = { x: a.x, y: a.y, z: a.z };
    this.ray.dir = { x: dx / d, y: dy / d, z: dz / d };
    const hit = this.physics.world.castRay(this.ray, d - 0.05, true, undefined, WORLD_QUERY);
    return hit ? hit.timeOfImpact : null;
  }
}

const _feet = new THREE.Vector3();
const _f = new THREE.Vector3();
const _f2 = new THREE.Vector3();
const _t = new THREE.Vector3();
const _c = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _m2 = new THREE.Vector2();
