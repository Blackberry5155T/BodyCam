import * as THREE from 'three';
import { Shooter, type ShotResult } from '../combat/shooting.ts';
import type { PlayerController } from '../player/controller.ts';
import type { HitZone, PlayerBody } from '../player/body.ts';
import type { Settings } from '../core/settings.ts';
import { RAPIER, SIGHT_QUERY, type PhysicsWorld } from '../physics/physics.ts';
import type { LoadedMap } from '../world/mapLoader.ts';
import { NavGrid } from './navGrid.ts';
import { Npc, type NpcProfile, type NpcWorld, type Threat } from './npc.ts';

// Trainingsmodus: aktiv, sobald die Map NPC-Spawnpunkte (Typ "npcspawn") enthält.
// Hält ständig eine wachsende Zahl Gegner am Leben (Wellen), verteilt Rollen im Trupp, wertet Treffer aus
// und verwaltet Gesundheit, Tod und Neustart des Spielers. NPCs liegen in einem festen Pool, damit sich die
// Zahl der Lichter (Taschenlampen) nie ändert → kein Shader-Recompile beim Spawnen.

export const NPC_SPAWN_TYPE = 'npcspawn';

const POOL = 6;
const PLAYER_HP = 100;
const REGEN_DELAY = 5;
const REGEN_RATE = 14;
/** Schaden des Spielers an NPCs je Zone */
const DMG_TO_NPC: Record<HitZone, number> = { head: 100, torso: 34, limb: 20 };
/** Schaden der NPCs am Spieler je Zone */
const DMG_TO_PLAYER: Record<HitZone, number> = { head: 24, torso: 12, limb: 7 };

export interface TrainingOptions {
  scene: THREE.Scene;
  physics: PhysicsWorld;
  settings: Settings;
  level: LoadedMap;
  player: PlayerController;
  playerBody: PlayerBody;
  /** Ziel-Liste des Spieler-Shooters; NPC-Körper werden ergänzt */
  playerTargets: THREE.Object3D[];
  onPlayerHurt?: (strength: number) => void;
}

interface SpawnPoint {
  pos: THREE.Vector3;
  yaw: number;
}

export class TrainingMode {
  readonly npcs: Npc[] = [];
  private nav: NavGrid;
  private shooter: Shooter;
  private npcTargets: THREE.Object3D[];
  private spawns: SpawnPoint[];
  private playerSpawn: THREE.Vector3;
  private playerSpawnYaw: number;
  private threat: Threat;
  private world: NpcWorld;

  health = PLAYER_HP;
  private regenDelay = 0;
  private dead = false;
  private deadTimer = 0;
  kills = 0;
  private best = 0;
  private headshots = 0;
  private spawnTimer = 2.5;
  private roleTimer = 0;
  private intelTimer = 0;
  private lastSighting = -Infinity;
  private time = 0;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  private hud: TrainingHud;

  /** Trainingsmodus für diese Map, falls sie NPC-Spawnpunkte hat */
  static create(o: TrainingOptions): TrainingMode | null {
    const nodes = o.level.nodes.filter((n) => n.data.type === NPC_SPAWN_TYPE);
    if (!nodes.length) return null;
    const spawns = nodes.map((n) => {
      n.root.updateMatrixWorld(true);
      return { pos: new THREE.Vector3().setFromMatrixPosition(n.root.matrixWorld), yaw: n.root.rotation.y };
    });
    return new TrainingMode(o, spawns);
  }

  private constructor(
    private o: TrainingOptions,
    spawns: SpawnPoint[],
  ) {
    this.spawns = spawns;
    const ps = o.player.feet;
    this.playerSpawn = ps.clone();
    this.playerSpawnYaw = o.level.spawnYaw;

    // Navigationsraster über alle Spawnpunkte (+ Rand)
    const pts = [ps, ...spawns.map((s) => s.pos)];
    const pad = 14;
    this.nav = new NavGrid(
      o.physics,
      {
        minX: Math.min(...pts.map((p) => p.x)) - pad,
        maxX: Math.max(...pts.map((p) => p.x)) + pad,
        minZ: Math.min(...pts.map((p) => p.z)) - pad,
        maxZ: Math.max(...pts.map((p) => p.z)) + pad,
      },
      ps.y,
    );

    for (let i = 0; i < POOL; i++) {
      const npc = new Npc(o.scene, o.physics, o.settings);
      this.npcs.push(npc);
      o.playerTargets.push(npc.body.root);
    }
    this.npcTargets = [o.level.group, o.playerBody.root, ...this.npcs.map((n) => n.body.root)];
    // eigener Shooter (Mündungsfeuer-Licht der Gegner)
    this.shooter = new Shooter(o.scene, this.npcTargets);

    const player = o.player;
    this.threat = {
      eye: player.position,
      feet: new THREE.Vector3(),
      velocity: player.velocity,
      crouching: false,
      flashlight: true,
      alive: true,
    };
    this.world = {
      physics: o.physics,
      nav: this.nav,
      threat: this.threat,
      squad: this.npcs,
      difficulty: 0,
      fire: (npc) => this.npcFire(npc),
      report: (npc) => this.report(npc),
    };
    this.hud = new TrainingHud();
    this.hud.message('TRAINING — Gegner rücken an. Deckung nutzen!', 3.5);
  }

  get playerDead(): boolean {
    return this.dead;
  }

  private get alive(): Npc[] {
    return this.npcs.filter((n) => n.alive);
  }

  private get wave(): number {
    return 1 + Math.floor(this.kills / 5);
  }

  update(dt: number): void {
    this.time += dt;
    const player = this.o.player;
    const t = this.threat;
    t.feet.copy(player.feet);
    t.crouching = player.isCrouching;
    t.flashlight = this.o.playerBody.isFlashlightOn;
    t.alive = !this.dead;
    this.world.difficulty = Math.min(1, this.kills / 30);

    // Gesundheit / Tod
    if (this.dead) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) this.restart();
    } else {
      this.regenDelay -= dt;
      if (this.regenDelay <= 0) this.health = Math.min(PLAYER_HP, this.health + REGEN_RATE * dt);
      this.spawner(dt);
      this.coordinate(dt);
    }

    for (const n of this.npcs) n.update(dt, this.world);
    this.shooter.update(dt);
    this.hud.update(dt, {
      health: this.health,
      wave: this.wave,
      kills: this.kills,
      best: this.best,
      alive: this.alive.length,
      dead: this.dead,
      yaw: player.lookYaw,
    }, player.position);
  }

  // ---------------------------------------------------------------- Spawner & Trupp

  private spawner(dt: number): void {
    const maxAlive = Math.min(POOL, 2 + Math.floor(this.kills / 4));
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0 || this.alive.length >= maxAlive) return;
    const npc = this.npcs.find((n) => !n.active);
    if (!npc) return;
    const sp = this.pickSpawn();
    if (!sp) return;
    this.spawnTimer = Math.max(1.2, 4 - this.kills * 0.08);
    const d = this.world.difficulty;
    const skill = THREE.MathUtils.clamp(0.25 + Math.random() * 0.5 + d * 0.35, 0, 1);
    const profile: NpcProfile = {
      aggression: 0.3 + Math.random() * 0.65,
      skill,
      reaction: THREE.MathUtils.lerp(0.55, 0.2, skill),
      discipline: Math.random(),
    };
    // grobe Ahnung, wo der Spieler ist
    const intel = this.threat.feet.clone();
    intel.x += (Math.random() - 0.5) * 10;
    intel.z += (Math.random() - 0.5) * 10;
    const feet = this.nav.nearest(sp.pos.x, sp.pos.z, 3) ?? sp.pos;
    const yaw = Math.atan2(-(intel.x - feet.x), -(intel.z - feet.z));
    npc.spawn(feet, yaw, profile, intel);
  }

  /** Spawnpunkt außer Sicht und nicht zu nah am Spieler, nicht auf einem anderen NPC */
  private pickSpawn(): SpawnPoint | null {
    const eye = this.o.player.position;
    const scored = this.spawns
      .map((s) => {
        const d = Math.hypot(s.pos.x - eye.x, s.pos.z - eye.z);
        if (d < 10) return null;
        if (this.alive.some((n) => n.feet.distanceTo(s.pos) < 2.5)) return null;
        const hidden = !this.lineClear(eye, _v.copy(s.pos).setY(s.pos.y + 1.6));
        return { s, score: (hidden ? 100 : 0) + Math.min(d, 30) + Math.random() * 12 };
      })
      .filter((x): x is { s: SpawnPoint; score: number } => !!x)
      .sort((a, b) => b.score - a.score);
    return scored[0]?.s ?? null;
  }

  /** Rollen verteilen, Spieler „jagen“, wenn ihn niemand sieht */
  private coordinate(dt: number): void {
    const alive = this.alive;
    if ((this.roleTimer -= dt) <= 0) {
      this.roleTimer = 1;
      const f = this.threat.feet;
      alive.sort((a, b) => a.feet.distanceTo(f) - b.feet.distanceTo(f));
      alive.forEach((n, i) => {
        if (i === 0) n.role = 'assault';
        else if (i === alive.length - 1 && alive.length >= 2) n.role = 'flanker';
        else if (i === 2 && alive.length >= 4) n.role = 'flanker';
        else n.role = 'support';
      });
    }
    if (alive.some((n) => n.visible)) this.lastSighting = this.time;
    if ((this.intelTimer -= dt) <= 0 && this.time - this.lastSighting > 6) {
      this.intelTimer = 6;
      for (const n of alive) n.know(this.threat.feet, 4);
    }
  }

  private report(from: Npc): void {
    // Funkspruch: alle anderen erfahren die Position (etwas ungenau)
    for (const n of this.npcs) if (n !== from && n.alive && !n.visible) n.know(this.threat.feet, 1.2);
  }

  // ---------------------------------------------------------------- Schüsse

  private npcFire(npc: Npc): void {
    const res = this.shooter.fire(npc.camera, npc.body.getMuzzle(npc.camera), { targets: this.npcTargets, ignore: npc.body.root });
    if (!res.hit || !res.object) {
      // Kugel pfeift am Spieler vorbei
      this.nearMissPlayer(npc);
      return;
    }
    const zone = (res.object.userData.hitZone as HitZone | undefined) ?? 'limb';
    if (isUnder(res.object, this.o.playerBody.root)) {
      this.hurtPlayer(DMG_TO_PLAYER[zone], npc);
      return;
    }
    const other = npcOf(res.object);
    if (other && other !== npc) other.damage(DMG_TO_NPC[zone] * 0.5, npc.feet);
    else this.nearMissPlayer(npc);
  }

  private nearMissPlayer(npc: Npc): void {
    npc.camera.getWorldDirection(_dir);
    _v.copy(this.o.player.position).sub(npc.camera.position);
    const along = _v.dot(_dir);
    if (along <= 0) return;
    const miss = _v.addScaledVector(_dir, -along).length();
    if (miss < 1.2) {
      this.o.onPlayerHurt?.(0.15);
      this.hud.indicate(npc.feet, 0.35);
    }
  }

  private hurtPlayer(amount: number, npc: Npc): void {
    if (this.dead) return;
    const dmg = amount * (0.75 + 0.45 * this.world.difficulty);
    this.health -= dmg;
    this.regenDelay = REGEN_DELAY;
    this.o.player.hurt(0.4 + dmg / 30);
    this.o.onPlayerHurt?.(0.3 + dmg / 40);
    this.hud.indicate(npc.feet, 1);
    this.hud.flash(dmg / 30);
    if (this.health <= 0) this.die();
  }

  /** Schuss des Spielers auswerten: Treffer, Unterdrückung (knapp vorbei), Gehör */
  playerShot(origin: THREE.Vector3, dir: THREE.Vector3, result: ShotResult): void {
    if (this.dead) return;
    const end = result.point ?? _end.copy(origin).addScaledVector(dir, 120);
    const len = origin.distanceTo(end);
    let hitNpc: Npc | null = null;
    if (result.hit && result.object) {
      hitNpc = npcOf(result.object);
      if (hitNpc) {
        const zone = (result.object.userData.hitZone as HitZone | undefined) ?? 'limb';
        const killed = hitNpc.damage(DMG_TO_NPC[zone], this.threat.feet);
        this.hud.hitmarker(killed, zone === 'head');
        if (killed) {
          this.kills++;
          if (zone === 'head') this.headshots++;
          this.best = Math.max(this.best, this.kills);
          if (this.kills % 5 === 0) this.hud.message(`WELLE ${this.wave}`, 2);
        }
      }
    }
    for (const n of this.npcs) {
      if (!n.alive || n === hitNpc) continue;
      _v.copy(n.controller.position).setY(n.controller.position.y - 0.5).sub(origin);
      const along = THREE.MathUtils.clamp(_v.dot(dir), 0, len);
      const miss = _v.addScaledVector(dir, -along).length();
      n.hearShot(this.threat.feet, miss);
    }
  }

  private die(): void {
    this.dead = true;
    this.health = 0;
    this.deadTimer = 4.5;
    this.o.player.disabled = true;
    this.hud.message(`AUSGESCHALTET — ${this.kills} Kills (${this.headshots} Kopftreffer) · Welle ${this.wave}`, 4.5);
  }

  private restart(): void {
    for (const n of this.npcs) n.deactivate();
    this.dead = false;
    this.health = PLAYER_HP;
    this.kills = 0;
    this.headshots = 0;
    this.spawnTimer = 2.5;
    this.o.player.disabled = false;
    this.o.player.teleportFeet(this.playerSpawn, this.playerSpawnYaw);
    this.o.player.setLook(this.playerSpawnYaw, 0);
    this.hud.message('NEUSTART', 1.5);
  }

  private lineClear(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const d = a.distanceTo(b);
    if (d < 1e-4) return true;
    this.ray.origin = { x: a.x, y: a.y, z: a.z };
    this.ray.dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d, z: (b.z - a.z) / d };
    return !this.o.physics.world.castRay(this.ray, d - 0.05, true, undefined, SIGHT_QUERY);
  }
}

function isUnder(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let c: THREE.Object3D | null = o; c; c = c.parent) if (c === root) return true;
  return false;
}

function npcOf(o: THREE.Object3D): Npc | null {
  for (let c: THREE.Object3D | null = o; c; c = c.parent) if (c.userData.npc) return c.userData.npc as Npc;
  return null;
}

// ---------------------------------------------------------------- HUD

interface HudState {
  health: number;
  wave: number;
  kills: number;
  best: number;
  alive: number;
  dead: boolean;
  yaw: number;
}

const HUD_CSS = `
#tr-top { position:absolute; top:5vh; left:50%; transform:translateX(-50%); font-size:14px; letter-spacing:.12em; opacity:.85; text-align:center; }
#tr-top b { color:#e3242b; font-weight:normal; }
#tr-health { position:absolute; bottom:12vh; left:50%; transform:translateX(-50%); width:220px; height:6px; border:1px solid rgba(232,232,224,.6); }
#tr-health i { position:absolute; inset:1px; right:auto; background:#e8e8e0; transition:background .2s; }
#tr-health.low i { background:#e3242b; }
#tr-hp { position:absolute; bottom:calc(12vh + 10px); left:50%; transform:translateX(-50%); font-size:12px; opacity:.7; }
#tr-blood { position:absolute; inset:0; opacity:0; background:radial-gradient(ellipse at center, transparent 45%, rgba(150,0,0,.85) 100%); }
#tr-hit { position:absolute; left:50%; top:50%; width:22px; height:22px; margin:-11px 0 0 -11px; opacity:0; }
#tr-hit::before, #tr-hit::after { content:''; position:absolute; left:50%; top:0; width:2px; height:100%; margin-left:-1px; background:currentColor; }
#tr-hit::before { transform:rotate(45deg); } #tr-hit::after { transform:rotate(-45deg); }
#tr-msg { position:absolute; left:50%; top:22%; transform:translateX(-50%); font-size:22px; letter-spacing:.15em; padding:8px 18px; background:rgba(0,0,0,.45); border-left:3px solid #e3242b; opacity:0; white-space:nowrap; }
.tr-dir { position:absolute; left:50%; top:50%; width:0; height:0; }
.tr-dir i { position:absolute; left:-40px; top:-150px; width:80px; height:14px; border-radius:50% 50% 0 0; border-top:4px solid rgba(227,36,43,.95); }
`;

class TrainingHud {
  private top: HTMLElement;
  private bar: HTMLElement;
  private barFill: HTMLElement;
  private hp: HTMLElement;
  private blood: HTMLElement;
  private hit: HTMLElement;
  private msg: HTMLElement;
  private root: HTMLElement;
  private dirs: { el: HTMLElement; pos: THREE.Vector3; t: number }[] = [];
  private bloodAmt = 0;
  private hitT = 0;
  private msgT = 0;
  private lastText = '';

  constructor() {
    const style = document.createElement('style');
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
    this.root = document.getElementById('hud') ?? document.body;
    const el = (id: string, html = '') => {
      const e = document.createElement('div');
      e.id = id;
      e.innerHTML = html;
      this.root.appendChild(e);
      return e;
    };
    this.blood = el('tr-blood');
    this.top = el('tr-top');
    this.bar = el('tr-health', '<i></i>');
    this.barFill = this.bar.querySelector('i')!;
    this.hp = el('tr-hp');
    this.hit = el('tr-hit');
    this.msg = el('tr-msg');
  }

  message(text: string, seconds: number): void {
    this.msg.textContent = text;
    this.msgT = seconds;
  }

  hitmarker(kill: boolean, head: boolean): void {
    this.hitT = kill ? 0.45 : 0.2;
    this.hit.style.color = kill ? '#e3242b' : head ? '#ffd27a' : '#e8e8e0';
  }

  flash(strength: number): void {
    this.bloodAmt = Math.min(1, this.bloodAmt + 0.35 + strength * 0.4);
  }

  /** Richtungsanzeige für Beschuss (Bogen um die Bildmitte) */
  indicate(from: THREE.Vector3, strength: number): void {
    const el = document.createElement('div');
    el.className = 'tr-dir';
    el.innerHTML = '<i></i>';
    this.root.appendChild(el);
    this.dirs.push({ el, pos: from.clone(), t: 1.2 * strength });
  }

  update(dt: number, s: HudState, me: THREE.Vector3): void {
    const text = s.dead
      ? 'TRAINING · <b>AUSGESCHALTET</b>'
      : `TRAINING · WELLE ${s.wave} · KILLS ${s.kills} · GEGNER ${s.alive}${s.best > s.kills ? ` · REKORD ${s.best}` : ''}`;
    if (text !== this.lastText) {
      this.top.innerHTML = text;
      this.lastText = text;
    }
    const hpPct = Math.max(0, s.health) / PLAYER_HP;
    this.barFill.style.width = `${(hpPct * 218).toFixed(0)}px`;
    this.bar.classList.toggle('low', hpPct < 0.35);
    this.hp.textContent = `${Math.ceil(Math.max(0, s.health))} HP`;
    // niedrige Gesundheit: Rand bleibt leicht rot
    const base = s.dead ? 0.9 : Math.max(0, 0.5 - hpPct) * 1.2;
    this.bloodAmt = Math.max(base, this.bloodAmt - dt * 1.4);
    this.blood.style.opacity = this.bloodAmt.toFixed(3);
    this.hitT = Math.max(0, this.hitT - dt);
    this.hit.style.opacity = this.hitT > 0 ? '1' : '0';
    this.msgT = Math.max(0, this.msgT - dt);
    this.msg.style.opacity = Math.min(1, this.msgT * 2).toFixed(2);
    for (let i = this.dirs.length - 1; i >= 0; i--) {
      const d = this.dirs[i];
      d.t -= dt;
      if (d.t <= 0) {
        d.el.remove();
        this.dirs.splice(i, 1);
        continue;
      }
      d.el.style.opacity = Math.min(1, d.t * 1.5).toFixed(2);
      const ang = Math.atan2(-(d.pos.x - me.x), -(d.pos.z - me.z));
      d.el.style.transform = `rotate(${(-(ang - s.yaw) * 180) / Math.PI}deg)`;
    }
  }
}

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _end = new THREE.Vector3();
