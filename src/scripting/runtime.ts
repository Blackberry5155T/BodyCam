import * as THREE from 'three';
import type { Collider } from '../world/collision.ts';
import { SCALE } from '../world/collision.ts';
import { refreshColliders, type MapNode } from '../world/mapLoader.ts';
import { isWeatherType, type WeatherType } from '../world/weather.ts';

// Script-Runtime für Map-Objekte. Die Blöcke aus dem Editor werden zu JavaScript übersetzt
// (scripting/blocks.ts), das hier gegen eine kleine API pro Objekt läuft:
//   api.on('start', async () => { await api.glideBy(0, 2, 0, 1); ... });
// Wie in Scratch geben Schleifen pro Durchlauf einen Frame ab (api.frame()), damit nichts einfriert.

export type ScriptEvent = 'start' | 'tick' | 'interact' | 'hit' | 'enter' | 'leave' | 'near' | 'key' | 'message';

export interface RuntimeHost {
  /** Fußposition des Spielers (bzw. der Editor-Kamera beim Simulieren) */
  playerPosition(): THREE.Vector3;
  teleportPlayer(feet: THREE.Vector3, yawDeg?: number): void;
  showMessage(text: string, seconds: number): void;
  keyDown(code: string): boolean;
  /** Wetter wechseln (weich überblendet) */
  setWeather?(type: WeatherType, intensity: number): void;
  log?(msg: string, isError: boolean): void;
  /** Jede Nachricht (auch an Bildschirme weiterreichen) */
  onBroadcast?(msg: string): void;
}

interface Handler {
  event: ScriptEvent;
  fn: () => Promise<void>;
  arg?: string | number;
  running: number;
  /** für 'near': war der Spieler zuletzt in Reichweite? */
  inside?: boolean;
}

interface Waiter {
  until: number; // Spielzeit
  resolve: () => void;
}

interface Tween {
  node: MapNode;
  kind: 'pos' | 'rot';
  from: THREE.Vector3;
  to: THREE.Vector3;
  start: number;
  duration: number;
  resolve: () => void;
}

class StopScript extends Error {}

const DEG = THREE.MathUtils.DEG2RAD;

interface ObjectScript {
  node: MapNode;
  handlers: Handler[];
  playerInside: boolean;
  /** Objekt hat eigene (geklonte) Materialien für Farbänderungen */
  ownMaterials: boolean;
}

export class ScriptRuntime {
  time = 0;
  private scripts: ObjectScript[] = [];
  private byNode = new Map<MapNode, ObjectScript>();
  private frameWaiters: (() => void)[] = [];
  private timers: Waiter[] = [];
  private tweens: Tween[] = [];
  private dirty = new Set<MapNode>();
  private running = false;
  private box = new THREE.Box3();
  private nodesByName = new Map<string, MapNode>();

  constructor(
    private nodes: MapNode[],
    private colliders: Collider[],
    private host: RuntimeHost,
  ) {}

  /** Scripts kompilieren und 'start' auslösen */
  start(): void {
    this.running = true;
    for (const n of this.nodes) this.nodesByName.set(n.data.name, n);
    for (const node of this.nodes) {
      const code = node.data.script?.code;
      if (!code?.trim()) continue;
      const script: ObjectScript = { node, handlers: [], playerInside: false, ownMaterials: false };
      const api = this.makeApi(script);
      try {
        new Function('api', `"use strict";\n${code}`)(api);
      } catch (e) {
        this.report(node, e);
        continue;
      }
      if (script.handlers.length) {
        this.scripts.push(script);
        this.byNode.set(node, script);
      }
    }
    this.fireAll('start');
  }

  stop(): void {
    this.running = false;
    this.scripts = [];
    this.byNode.clear();
    this.frameWaiters = [];
    this.timers = [];
    this.tweens = [];
  }

  get hasScripts(): boolean {
    return this.scripts.length > 0;
  }

  update(dt: number): void {
    if (!this.running) return;
    this.time += dt;
    const t = this.time;

    // Tweens (gleiten / drehen über Zeit)
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      const k = tw.duration <= 0 ? 1 : Math.min(1, (t - tw.start) / tw.duration);
      const e = k * k * (3 - 2 * k);
      if (tw.kind === 'pos') tw.node.root.position.lerpVectors(tw.from, tw.to, e);
      else {
        const r = tw.from.clone().lerp(tw.to, e).multiplyScalar(DEG);
        tw.node.root.rotation.set(r.x, r.y, r.z);
      }
      this.dirty.add(tw.node);
      if (k >= 1) {
        this.tweens.splice(i, 1);
        tw.resolve();
      }
    }

    // Wartende Coroutinen fortsetzen
    const frames = this.frameWaiters;
    this.frameWaiters = [];
    for (const r of frames) r();
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].until <= t) {
        const w = this.timers[i];
        this.timers.splice(i, 1);
        w.resolve();
      }
    }

    // Spieler-bezogene Ereignisse
    const player = this.host.playerPosition();
    const body = player.clone();
    body.y += SCALE.playerHeight / 2;
    for (const s of this.scripts) {
      let hasTrigger = false;
      for (const h of s.handlers) {
        if (h.event === 'tick' && h.running === 0) this.run(s, h);
        else if (h.event === 'enter' || h.event === 'leave') hasTrigger = true;
        else if (h.event === 'near') {
          const inside = s.node.root.getWorldPosition(new THREE.Vector3()).distanceTo(body) < Number(h.arg ?? 3);
          if (inside && !h.inside) this.run(s, h);
          h.inside = inside;
        }
      }
      if (hasTrigger) {
        this.boundsOf(s.node);
        const inside = this.box.distanceToPoint(body) <= SCALE.playerRadius;
        if (inside !== s.playerInside) {
          s.playerInside = inside;
          this.fire(s, inside ? 'enter' : 'leave');
        }
      }
    }

    // Kollision bewegter Objekte nachziehen
    for (const n of this.dirty) {
      n.root.updateMatrixWorld(true);
      refreshColliders(n, this.colliders);
    }
    this.dirty.clear();
  }

  // ---------- Ereignisse von außen ----------

  findNode(obj: THREE.Object3D | null): MapNode | null {
    for (let o = obj; o; o = o.parent) if (o.userData.mapNode) return o.userData.mapNode as MapNode;
    return null;
  }

  /** Text für die Benutzen-Anzeige, falls das Objekt ein 'interact'-Script hat */
  interactPrompt(node: MapNode | null): string | null {
    const h = node && this.byNode.get(node)?.handlers.find((x) => x.event === 'interact');
    return h ? String(h.arg || 'Benutzen') : null;
  }

  interact(node: MapNode): void {
    const s = this.byNode.get(node);
    if (s) this.fire(s, 'interact');
  }

  hit(node: MapNode): void {
    const s = this.byNode.get(node);
    if (s) this.fire(s, 'hit');
  }

  keyPressed(code: string): void {
    for (const s of this.scripts) for (const h of s.handlers) if (h.event === 'key' && h.arg === code) this.run(s, h);
  }

  /** Objekt per Name zeigen/verstecken (für Bildschirm-Scripts) */
  setObjectVisible(name: string, show: boolean): void {
    const n = this.nodesByName.get(String(name));
    if (n) n.root.visible = !!show;
  }

  broadcast(msg: string): void {
    this.host.onBroadcast?.(msg);
    for (const s of this.scripts) for (const h of s.handlers) if (h.event === 'message' && h.arg === msg) this.run(s, h);
  }

  // ---------- intern ----------

  private fireAll(event: ScriptEvent): void {
    for (const s of this.scripts) this.fire(s, event);
  }

  private fire(s: ObjectScript, event: ScriptEvent): void {
    for (const h of s.handlers) if (h.event === event) this.run(s, h);
  }

  private run(s: ObjectScript, h: Handler): void {
    if (!this.running) return;
    h.running++;
    h.fn()
      .catch((e) => {
        if (!(e instanceof StopScript)) this.report(s.node, e);
      })
      .finally(() => h.running--);
  }

  private report(node: MapNode, e: unknown): void {
    const msg = `Script-Fehler in "${node.data.name}": ${e instanceof Error ? e.message : String(e)}`;
    console.warn(msg, e);
    this.host.log?.(msg, true);
  }

  private boundsOf(node: MapNode): THREE.Box3 {
    node.root.updateMatrixWorld(true);
    if (node.data.type === 'trigger') {
      return this.box.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(node.root.matrixWorld);
    }
    this.box.makeEmpty();
    if (node.instance) this.box.expandByObject(node.instance.object, true);
    if (this.box.isEmpty()) this.box.setFromCenterAndSize(node.root.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(1, 1, 1));
    return this.box;
  }

  private frame(): Promise<void> {
    if (!this.running) return new Promise(() => {});
    return new Promise((r) => this.frameWaiters.push(r));
  }

  private wait(sec: number): Promise<void> {
    if (!this.running) return new Promise(() => {});
    return new Promise((resolve) => this.timers.push({ until: this.time + Math.max(0, sec), resolve }));
  }

  private tween(node: MapNode, kind: 'pos' | 'rot', to: THREE.Vector3, sec: number): Promise<void> {
    // laufende Tweens derselben Art ersetzen
    this.tweens = this.tweens.filter((t) => {
      if (t.node === node && t.kind === kind) {
        t.resolve();
        return false;
      }
      return true;
    });
    const r = node.root;
    const from = kind === 'pos' ? r.position.clone() : new THREE.Vector3(r.rotation.x / DEG, r.rotation.y / DEG, r.rotation.z / DEG);
    return new Promise((resolve) => this.tweens.push({ node, kind, from, to, start: this.time, duration: sec, resolve }));
  }

  private makeApi(s: ObjectScript) {
    const node = s.node;
    const root = node.root;
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
    const moved = () => this.dirty.add(node);
    const materials = (): THREE.MeshStandardMaterial[] => {
      const meshes = node.instance?.colorables ?? [];
      if (!s.ownMaterials) {
        for (const m of meshes) {
          const mat = m.material as THREE.MeshStandardMaterial;
          if (mat.userData.shared) m.material = mat.clone();
        }
        s.ownMaterials = true;
      }
      return meshes.map((m) => m.material as THREE.MeshStandardMaterial).filter((m) => m.isMeshStandardMaterial);
    };
    const light = () => node.instance?.light;
    const fx = () => node.instance?.effect;
    const other = (name: string) => this.nodesByName.get(String(name)) ?? null;

    return {
      on: (event: ScriptEvent, fn: () => Promise<void>, arg?: string | number) => {
        s.handlers.push({ event, fn, arg, running: 0 });
      },
      frame: () => this.frame(),
      wait: (sec: unknown) => this.wait(num(sec)),
      stop: () => {
        throw new StopScript();
      },
      // Bewegung
      moveBy: (x: unknown, y: unknown, z: unknown) => {
        root.position.add(new THREE.Vector3(num(x), num(y), num(z)));
        moved();
      },
      moveTo: (x: unknown, y: unknown, z: unknown) => {
        root.position.set(num(x), num(y), num(z));
        moved();
      },
      moveForward: (d: unknown) => {
        root.translateZ(-num(d));
        moved();
      },
      glideTo: (x: unknown, y: unknown, z: unknown, sec: unknown) =>
        this.tween(node, 'pos', new THREE.Vector3(num(x), num(y), num(z)), num(sec)),
      glideBy: (x: unknown, y: unknown, z: unknown, sec: unknown) =>
        this.tween(node, 'pos', root.position.clone().add(new THREE.Vector3(num(x), num(y), num(z))), num(sec)),
      rotateBy: (x: unknown, y: unknown, z: unknown) => {
        root.rotation.set(root.rotation.x + num(x) * DEG, root.rotation.y + num(y) * DEG, root.rotation.z + num(z) * DEG);
        moved();
      },
      setRotation: (x: unknown, y: unknown, z: unknown) => {
        root.rotation.set(num(x) * DEG, num(y) * DEG, num(z) * DEG);
        moved();
      },
      turnBy: (x: unknown, y: unknown, z: unknown, sec: unknown) => {
        const r = root.rotation;
        return this.tween(node, 'rot', new THREE.Vector3(r.x / DEG + num(x), r.y / DEG + num(y), r.z / DEG + num(z)), num(sec));
      },
      setScale: (x: unknown, y: unknown, z: unknown) => {
        if (node.def.fixedScale || node.def.rebuildOnScale) return;
        root.scale.set(num(x) || 0.001, num(y) || 0.001, num(z) || 0.001);
        moved();
      },
      pos: (axis: 'x' | 'y' | 'z') => root.position[axis],
      rot: (axis: 'x' | 'y' | 'z') => root.rotation[axis] / DEG,
      // Aussehen
      show: () => (root.visible = true),
      hide: () => (root.visible = false),
      setColor: (c: string) => materials().forEach((m) => m.color.set(c)),
      setGlow: (c: string, intensity: unknown) =>
        materials().forEach((m) => {
          m.emissive.set(c);
          m.emissiveIntensity = num(intensity);
        }),
      setCollision: (on: boolean) => {
        node.collisionEnabled = !!on;
        moved();
      },
      // Licht
      lightSet: (mode: 'on' | 'off' | 'toggle') => {
        const l = light();
        if (l) l.setOn(mode === 'toggle' ? !l.isOn() : mode === 'on');
      },
      lightIntensity: (v: unknown) => light()?.setIntensity(num(v)),
      lightChangeIntensity: (v: unknown) => {
        const l = light();
        if (l) l.setIntensity(l.getIntensity() + num(v));
      },
      lightColor: (c: string) => light()?.setColor(c),
      lightFlicker: (on: boolean) => light()?.setFlicker(!!on),
      lightIsOn: () => light()?.isOn() ?? false,
      // Effekte (Feuer, Rauch, Funken)
      fxSet: (mode: 'on' | 'off' | 'toggle') => {
        const e = fx();
        if (e) e.setOn(mode === 'toggle' ? !e.on : mode === 'on');
      },
      fxIntensity: (v: unknown) => fx()?.setIntensity(Math.min(3, Math.max(0, num(v) / 100))),
      fxBurst: (v: unknown) => fx()?.burst(Math.min(5, Math.max(0, num(v)))),
      fxIsOn: () => fx()?.on ?? false,
      // Ereignisse & Welt
      broadcast: (msg: unknown) => this.broadcast(String(msg)),
      teleportPlayer: (x: unknown, y: unknown, z: unknown) => this.host.teleportPlayer(new THREE.Vector3(num(x), num(y), num(z))),
      showText: (text: unknown, sec: unknown) => this.host.showMessage(String(text), num(sec)),
      setWeather: (type: unknown, intensity: unknown) => {
        if (isWeatherType(type)) this.host.setWeather?.(type, THREE.MathUtils.clamp(num(intensity), 0, 2));
      },
      log: (v: unknown) => this.host.log?.(`[${node.data.name}] ${String(v)}`, false),
      // Fühlen
      distanceToPlayer: () => {
        const p = this.host.playerPosition().clone();
        p.y += SCALE.playerHeight / 2;
        return root.getWorldPosition(new THREE.Vector3()).distanceTo(p);
      },
      playerPos: (axis: 'x' | 'y' | 'z') => this.host.playerPosition()[axis],
      keyDown: (code: string) => this.host.keyDown(code),
      time: () => this.time,
      playerInside: () => s.playerInside,
      // andere Objekte
      objPos: (name: string, axis: 'x' | 'y' | 'z') => other(name)?.root.position[axis] ?? 0,
      objShow: (name: string, show: boolean) => {
        const n = other(name);
        if (n) n.root.visible = !!show;
      },
    };
  }
}
