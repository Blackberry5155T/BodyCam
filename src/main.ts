import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { MAPS, loadBundledMap } from './maps/index.ts';
import { CAMERA_DROP, CAMERA_FORWARD, PlayerController } from './player/controller.ts';
import { PlayerBody } from './player/body.ts';
import { Shooter, isSolid } from './combat/shooting.ts';
import { BodycamShader } from './rendering/postfx/bodycam.ts';
import { Settings, TERRAIN_DETAIL, keyLabel, type SettingsData } from './core/settings.ts';
import { Input } from './core/input.ts';
import { Terminal } from './world/props/terminal.ts';
import { loadMap, type MapNode } from './world/mapLoader.ts';
import { loadLocalMap, onMapSaved } from './world/mapStore.ts';
import { browserBlobs, NO_BLOBS, type BlobSource } from './world/blobStore.ts';
import type { MapData } from './world/mapFormat.ts';
import { ScriptRuntime } from './scripting/runtime.ts';
import { ScreenRuntime } from './scripting/screenRuntime.ts';
import { SCREEN_PX, defaultScreen } from './world/screen.ts';
import type { ScreenSurface } from './world/assets.ts';
import type { FocusTarget } from './player/controller.ts';
import { Weather, WEATHER_OPTIONS, type ReflectionQuality } from './world/weather.ts';
import { WEATHER_TYPE, weatherWorld } from './world/weatherObject.ts';
import { volumeFX } from './world/volumetrics.ts';
import { VolumePass } from './rendering/volumePass.ts';
import { PhysicsWorld, initPhysics } from './physics/physics.ts';
import { LandscapeRenderer, updateLandscapes } from './world/landscape/render.ts';
import { landscapeOf } from './world/landscape/asset.ts';
import { SCALE } from './world/collision.ts';
import { LoadingScreen } from './ui/loadingScreen.ts';
import { ThirdPersonCam } from './dev/thirdPerson.ts';

const FOG_MIN = 5;
const FOG_MAX = 60;
const EXPOSURE = 1.15;
// Sichtweite der Kamera (m); der Distanznebel blendet meist deutlich früher aus
const CAMERA_FAR = 2000;
// Spieler-Sichtweite (5…60) ist relativ zu 60 m; die Map kann sie für große Landscapes hochskalieren
const BASE_VIEW = 60;
const PLAYER_EYE = SCALE.playerHeight + 0.05;
const TERMINAL_RANGE = 3.2;
const INTERACT_RANGE = 3.2;
// Basiswerte des Bodycam-Shaders (Einstellungen skalieren diese)
const LENS = { distortion: 0.24, aberration: 0.007, grain: 0.075, vignette: 0.8 };

const app = document.getElementById('app')!;
const blocker = document.getElementById('blocker')!;
const stats = document.getElementById('stats')!;
const info = document.getElementById('info')!;
const prompt = document.getElementById('prompt')!;
const messageEl = document.getElementById('message')!;
const recEl = document.getElementById('rec')!;
const unitEl = document.getElementById('unit')!;
const recTime = document.getElementById('rec-time')!;

const loading = new LoadingScreen('game');
await loading.step(0.05, 'Map wird geladen …');

const showError = (msg: string) => {
  if (loading.visible) loading.fail(msg);
  blocker.classList.remove('hidden');
  blocker.textContent = msg;
};
window.addEventListener('error', (e) => showError(`Fehler: ${e.message}`));
document.addEventListener('pointerlockerror', () =>
  showError(
    'Pointer Lock wurde vom Browser abgelehnt.\nBitte http://localhost:5173 direkt in Chrome/Edge öffnen (nicht im VS-Code-Browser) und erneut klicken.',
  ),
);
blocker.style.whiteSpace = 'pre-line';

// --- Map wählen: /?map=<id> (mitgeliefert: src/maps oder public/maps/<id>/) oder /?map=local:<Name> (aus dem Map-Editor) ---
const mapParam = new URLSearchParams(location.search).get('map') ?? 'start';
let mapData: MapData = MAPS.start;
let mapBlobs: BlobSource = NO_BLOBS;
if (mapParam.startsWith('local:')) {
  const name = mapParam.slice(6);
  const local = await loadLocalMap(name);
  if (local) {
    mapData = local;
    mapBlobs = browserBlobs;
  } else console.warn(`Lokale Map "${name}" nicht gefunden — lade Startmap`);
  // Speichert der Editor diese Map erneut, lädt der Spiel-Tab automatisch neu
  onMapSaved((saved) => {
    if (saved !== name) return;
    allowUnload = true; // kein "Seite verlassen?"-Dialog beim automatischen Neuladen
    location.reload();
  });
} else {
  const bundled = await loadBundledMap(mapParam);
  if (bundled) ({ map: mapData, blobs: mapBlobs } = bundled);
  else console.warn(`Map "${mapParam}" nicht gefunden — lade Startmap`);
}
const world = mapData.world;
await loading.step(0.2, `Welt „${mapData.name}“ wird aufgebaut …`);

const settings = new Settings();
settings.viewScale = Math.max(1, (world.viewDistance ?? BASE_VIEW) / BASE_VIEW);
const fogFar = (v: number) => v * settings.viewScale;
const input = new Input(settings);

// --- Renderer ---
// Reversed-Z: hohe Tiefengenauigkeit auch auf große Distanzen (Landscape), kein Z-Fighting in der Ferne
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', reversedDepthBuffer: true });
const pixelRatio = () => Math.min(window.devicePixelRatio * settings.data.renderScale, 2);
renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE * world.exposure;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(world.background);

// Distanz-Fade: linearer Nebel, Sichtweite = far
const fog = new THREE.Fog(world.fogColor, 1, fogFar(settings.data.viewDistance));
scene.fog = fog;

const camera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.05, Math.max(CAMERA_FAR, BASE_VIEW * settings.viewScale * 1.2));
scene.add(camera);

// --- Map: Geometrie, Lichter, Volumetrik; Himmel/Sonne/Bodennebel aus den World Settings ---
const anisotropy = renderer.capabilities.getMaxAnisotropy();
const level = loadMap(mapData, { anisotropy, editor: false, blobs: mapBlobs });
scene.add(level.group);
// Fog-Plane: bodennahe Nebelschicht, grobe Simulation für Sichtlinien-Tests
const fogPlane = level.world.groundFog;
// Landscape-Höhen werden asynchron geladen (Blob) — vor Spawn und Physik abwarten
await loading.track(
  level.nodes.map((n) => n.instance?.ready).filter((p): p is Promise<void> => !!p),
  0.3,
  0.6,
  'Landscapes & Modelle',
);
// Spawn unter einem Hügel (Landscape nachträglich geformt) → auf die Oberfläche heben
for (const n of level.nodes) {
  const ls = landscapeOf(n.instance);
  if (!ls) continue;
  n.root.updateMatrixWorld(true);
  const o = new THREE.Vector3().setFromMatrixPosition(n.root.matrixWorld);
  const ground = ls.heightAt(level.spawn.x - o.x, level.spawn.z - o.z);
  if (ground !== null && level.spawn.y < o.y + ground + PLAYER_EYE) level.spawn.y = o.y + ground + PLAYER_EYE;
}

// Physik (Rapier/WASM): Kollision des Spielers, Abfragen für Deckung/Kopffreiheit
await loading.step(0.62, 'Physik wird gestartet …');
await initPhysics();
const physics = new PhysicsWorld(world.groundPlane);
physics.sync(level.colliders);
physics.step(1 / 60);
await loading.step(0.7, 'Spieler, Wetter & Scripts …');
const player = new PlayerController(camera, document.body, physics, level.spawn, input, settings, level.spawnYaw);
// Spielerkörper aus Würfeln; hält die Taschenlampe in der linken Hand
const body = new PlayerBody(scene, physics);
const shooter = new Shooter(scene, [level.group]);
// Wetter: Niederschlag, nasser Boden, Pfützen mit Spiegelungen
body.root.userData.noWeather = true;
const weather = new Weather(renderer, scene, level.world);
// Wetter-Objekt (falls vorhanden) steuert Wetter + Windrichtung; folgt auch Drehungen durch Scripts
const weatherNode = level.nodes.find((n) => n.data.type === WEATHER_TYPE);
const weatherQuat = new THREE.Quaternion();
const applyWeather = () => {
  if (!weatherNode) return weather.apply(world);
  weatherQuat.copy(weatherNode.root.quaternion);
  weather.apply(weatherWorld(world, weatherNode.data, weatherQuat));
};
applyWeather();
weather.setLamp(body.flashlight);
// Volumetrik: Taschenlampe beleuchtet Nebel/Rauch (inkl. Schatten im Lichtkegel)
volumeFX.setLamp(body.flashlight);
volumeFX.setQuality(settings.data.volumetrics);
// Partikel (Rauch, Flammen, Funken) kollidieren mit denselben Collidern wie der Spieler
volumeFX.setColliders(level.colliders, world.groundPlane);
// Developer: Third-Person-Ansicht (nur im Vite-Dev-Server, Taste V, Alt+Mausrad = Abstand)
const thirdPerson = import.meta.env.DEV ? new ThirdPersonCam(physics) : null;
let shots = 0;
let lastShot = '–';

// --- Terminal (Hauptmenü im Bildschirm), Position kommt aus der Map ---
let terminal: Terminal | null = null;
if (level.terminal) {
  terminal = new Terminal(settings, input, level.terminal.center, level.terminal.normal, () => player.setFocus(null), anisotropy);
  level.group.add(terminal.group);
  level.colliders.push(terminal.collider);
}
const terminalActive = () => terminal?.active ?? false;
const lookRay = new THREE.Raycaster();
lookRay.far = 20; // große Bildschirme sind aus der Ferne bedienbar; Reichweiten werden einzeln geprüft
let lookingAtTerminal = false;

// --- Programmierbare Bildschirme (Figuren + Blöcke aus dem Editor) ---
interface GameScreen {
  node: MapNode;
  surf: ScreenSurface;
  rt: ScreenRuntime;
  control: string;
  prompt: string;
}
const gameScreens: GameScreen[] = [];
/** Bildschirm, an den der Spieler herangetreten ist (Maus steuert den Cursor) */
let activeScreen: GameScreen | null = null;
/** Bildschirm im Fadenkreuz */
let aimScreen: GameScreen | null = null;
const SCREEN_MENU_FOV = 50;
const SCREEN_CURSOR_SPEED = 0.55;
const _sc = new THREE.Vector3();
const _sn = new THREE.Vector3();
const _sq = new THREE.Quaternion();

/** Kamera-Ziel vor dem Bildschirm (wie beim Terminal), Augenhöhe bleibt die des Spielers */
function screenFocus(gs: GameScreen): FocusTarget | null {
  gs.surf.mesh.getWorldPosition(_sc);
  _sn.set(0, 0, 1).applyQuaternion(gs.surf.mesh.getWorldQuaternion(_sq));
  const horiz = Math.hypot(_sn.x, _sn.z);
  if (horiz < 0.5) return null; // liegt flach (Boden/Decke) → nur Zielen
  const nx = _sn.x / horiz;
  const nz = _sn.z / horiz;
  const halfV = THREE.MathUtils.degToRad(SCREEN_MENU_FOV / 2);
  const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  const need = Math.min(6, Math.max(gs.surf.heightM / 2 / 0.9 / Math.tan(halfV), gs.surf.widthM / 2 / 0.92 / Math.tan(halfH)) + 0.03);
  const dy = _sc.y - camera.position.y;
  const hd = Math.max(0.35, Math.sqrt(Math.max(0, need * need - dy * dy)));
  const d = hd + CAMERA_FORWARD;
  return { x: _sc.x + nx * d, z: _sc.z + nz * d, yaw: Math.atan2(nx, nz), pitch: Math.atan2(dy, hd), fov: SCREEN_MENU_FOV };
}

function enterScreen(gs: GameScreen): void {
  const focus = screenFocus(gs);
  if (!focus) {
    gs.rt.enter();
    return;
  }
  activeScreen = gs;
  player.setFocus(focus);
  gs.rt.showCursor = true;
  gs.rt.enter();
}

function leaveScreen(): void {
  const gs = activeScreen;
  if (!gs) return;
  activeScreen = null;
  gs.rt.clearCursor();
  gs.rt.showCursor = false;
  gs.rt.exit();
  player.setFocus(null);
}

// --- Map-Scripts (Blöcke aus dem Editor) ---
let messageTimer = 0;
const scripts = new ScriptRuntime(level.nodes, level.colliders, {
  playerPosition: () => player.feet,
  teleportPlayer: (feet) => player.teleportFeet(feet),
  showMessage: (text, seconds) => {
    messageEl.textContent = text;
    messageEl.classList.remove('hidden');
    messageTimer = seconds;
  },
  keyDown: (code) => player.isLocked && input.keyDown(code),
  setWeather: (type, intensity) => weather.setWeather(type, intensity),
  log: (msg, isError) => (isError ? console.warn(msg) : console.log(msg)),
  onBroadcast: (msg) => {
    for (const gs of gameScreens) gs.rt.receive(msg);
  },
});
for (const node of level.nodes) {
  const surf = node.instance?.screen;
  if (!surf) continue;
  const gs = {
    node,
    surf,
    control: String(node.data.props.control ?? 'focus'),
    prompt: String(node.data.props.prompt ?? '') || 'Bildschirm benutzen',
  } as GameScreen;
  gs.rt = new ScreenRuntime(node.data.screen ?? defaultScreen(), surf.stageH, {
    broadcast: (msg) => scripts.broadcast(msg),
    showMessage: (text, seconds) => {
      messageEl.textContent = text;
      messageEl.classList.remove('hidden');
      messageTimer = seconds;
    },
    keyDown: (code) => player.isLocked && input.keyDown(code),
    teleportPlayer: (x, y, z) => {
      if (activeScreen === gs) leaveScreen();
      player.teleportFeet(new THREE.Vector3(x, y, z));
    },
    objShow: (name, show) => scripts.setObjectVisible(name, show),
    setWeather: (type, intensity) => weather.setWeather(type as Parameters<typeof weather.setWeather>[0], intensity),
    log: (msg, isError) => (isError ? console.warn(msg) : console.log(msg)),
    exit: () => {
      if (activeScreen === gs) leaveScreen();
      else gs.rt.exit();
    },
  }, node.data.name);
  gs.rt.showCursor = false;
  gameScreens.push(gs);
}
const uiActive = () => terminalActive() || activeScreen !== null;
scripts.start();
for (const gs of gameScreens) gs.rt.start();
let interactNode: MapNode | null = null;
window.addEventListener('keydown', (e) => {
  if (e.repeat || !player.isLocked) return;
  if (thirdPerson && e.code === 'KeyV' && !uiActive()) {
    body.setThirdPerson(thirdPerson.toggle());
    return;
  }
  if (activeScreen) activeScreen.rt.keyPressed(e.code);
  else if (!terminalActive()) {
    scripts.keyPressed(e.code);
    for (const gs of gameScreens) if (gs.control !== 'focus' || gs.rt.used) gs.rt.keyPressed(e.code);
  }
});

// --- Post-Processing: Szene → Bloom → Tonemapping/sRGB → Bodycam-Linse ---
// Tiefentextur: Volumen (Nebel, Rauch, Feuer) lesen die Szenentiefe und enden sauber an Geometrie
const renderTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType) });
const composer = new EffectComposer(renderer, renderTarget);
composer.setPixelRatio(pixelRatio());
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new VolumePass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.5, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const bodycam = new ShaderPass(BodycamShader);
composer.addPass(bodycam);

const updateResolution = () => {
  const pr = pixelRatio();
  renderer.setPixelRatio(pr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setPixelRatio(pr);
  composer.setSize(window.innerWidth, window.innerHeight);
  bodycam.uniforms.uResolution.value.set(window.innerWidth * pr, window.innerHeight * pr);
};

// --- Einstellungen anwenden ---
const shadowLights: { shadow: THREE.LightShadow; base: number }[] = [];
scene.traverse((o) => {
  const l = o as THREE.Object3D & { isLight?: boolean; shadow?: THREE.LightShadow };
  if (l.isLight && l.castShadow && l.shadow) shadowLights.push({ shadow: l.shadow, base: l.shadow.mapSize.x });
});

const applyShadows = (level: number) => {
  const enabled = level > 0;
  if (renderer.shadowMap.enabled !== enabled) {
    renderer.shadowMap.enabled = enabled;
    // Shader müssen mit/ohne Schatten-Code neu gebaut werden
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
    });
  }
  const factor = level === 1 ? 0.5 : 1;
  for (const l of shadowLights) {
    const size = l.base * factor;
    if (l.shadow.mapSize.x !== size) {
      l.shadow.mapSize.set(size, size);
      l.shadow.map?.dispose();
      (l.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
    }
  }
};

const applySetting = (key: keyof SettingsData) => {
  const d = settings.data;
  switch (key) {
    case 'brightness':
      renderer.toneMappingExposure = EXPOSURE * world.exposure * d.brightness;
      break;
    case 'fogEnabled':
      scene.fog = d.fogEnabled ? fog : null;
      fogPlane.visible = d.fogEnabled && world.groundFog;
      level.world.setFog(d.fogEnabled);
      break;
    case 'viewDistance':
      fog.far = fogFar(d.viewDistance);
      break;
    case 'terrainDetail':
      LandscapeRenderer.detail = TERRAIN_DETAIL[d.terrainDetail] ?? 2.5;
      break;
    case 'bloom':
      bloom.enabled = d.bloom;
      break;
    case 'renderScale':
      updateResolution();
      break;
    case 'shadows':
      applyShadows(d.shadows);
      break;
    case 'reflections':
      weather.setReflectionQuality(d.reflections as ReflectionQuality);
      break;
    case 'volumetrics':
      volumeFX.setQuality(d.volumetrics);
      break;
    case 'hudOverlay':
      recEl.classList.toggle('hidden', !d.hudOverlay);
      unitEl.classList.toggle('hidden', !d.hudOverlay);
      break;
    case 'bindings':
      updateInfo();
      break;
  }
};
settings.onChange(applySetting);

const updateInfo = () => {
  const k = (a: keyof SettingsData['bindings']) => keyLabel(settings.data.bindings[a]);
  info.innerHTML =
    `${k('forward')}${k('left')}${k('back')}${k('right')} Bewegen · ${k('sprint')} Sprint · ${k('crouch')} Schleichen · ${k('jump')} Springen<br>` +
    `Linksklick Schießen · ${k('aim')} Zielen (geduckt: über/neben Deckung) · ${k('flashlight')} Taschenlampe · ${k('interact')} Benutzen<br>` +
    `Mausrad Sichtweite · ${k('fog')} Nebel · ${k('hud')} Debug-Text`;
};

for (const k of ['brightness', 'fogEnabled', 'viewDistance', 'bloom', 'renderScale', 'shadows', 'reflections', 'terrainDetail', 'hudOverlay', 'bindings'] as const) {
  applySetting(k);
}

let glitch = 0;
let menuBlend = 0;

// --- Eingabe ---
blocker.addEventListener('click', () => {
  if (!document.body.requestPointerLock) {
    showError('Dieser Browser unterstützt Pointer Lock nicht. Bitte Chrome/Edge verwenden.');
    return;
  }
  player.lock();
});
player.onLockChange((locked) => {
  blocker.classList.toggle('hidden', locked);
  if (!locked) {
    terminal?.cancelCapture();
    terminal?.pointerUp();
    activeScreen?.rt.pointerUp();
  }
});

document.addEventListener('mousemove', (e) => {
  if (player.isLocked && terminal?.active) terminal.moveCursor(e.movementX, e.movementY);
  if (player.isLocked && activeScreen) activeScreen.rt.moveCursor(e.movementX * SCREEN_CURSOR_SPEED, e.movementY * SCREEN_CURSOR_SPEED);
});

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !player.isLocked) return;
  if (terminal?.active) {
    terminal.pointerDown();
    return;
  }
  if (activeScreen) {
    activeScreen.rt.pointerDown();
    return;
  }
  if (player.hasFocus) return;
  shots++;
  const result = shooter.fire(camera, body.getMuzzle(camera));
  player.kick();
  body.kick();
  glitch = Math.min(1, glitch + 0.55);
  lastShot = result.hit ? `Treffer @ ${result.distance!.toFixed(1)} m` : 'kein Treffer';
  const hitNode = scripts.findNode(result.object ?? null);
  if (hitNode) scripts.hit(hitNode);
});
window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  terminal?.pointerUp();
  activeScreen?.rt.pointerUp();
});

window.addEventListener(
  'wheel',
  (e) => {
    // Strg+Mausrad (z. B. beim Schleichen) würde sonst die Seite zoomen
    if (e.ctrlKey || e.altKey) e.preventDefault();
    if (uiActive()) return;
    if (e.altKey && thirdPerson?.enabled) {
      thirdPerson.zoom(e.deltaY);
      return;
    }
    settings.set('viewDistance', THREE.MathUtils.clamp(settings.data.viewDistance + Math.sign(e.deltaY) * 2, FOG_MIN, FOG_MAX));
  },
  { passive: false },
);

// Strg ist Schleichen — Strg+W (Tab schließen) kann der Browser nicht abfangen lassen.
// Solange im Spiel, fragt der Browser deshalb vor dem Schließen nach.
let allowUnload = false;
window.addEventListener('beforeunload', (e) => {
  if (allowUnload || !player.isLocked) return;
  e.preventDefault();
  e.returnValue = '';
});

input.onPress((action) => {
  if (!player.isLocked) return;
  switch (action) {
    case 'interact':
      if (terminal?.active) {
        terminal.exit();
      } else if (activeScreen) {
        leaveScreen();
      } else if (aimScreen) {
        const gs = aimScreen;
        if (gs.control === 'focus') enterScreen(gs);
        else {
          if (!gs.rt.used) gs.rt.enter();
          gs.rt.pointerDown();
          setTimeout(() => gs.rt.pointerUp(), 120);
        }
      } else if (terminal && lookingAtTerminal) {
        player.setFocus(terminal.focusTarget(camera.aspect, CAMERA_DROP, CAMERA_FORWARD));
        terminal.enter();
      } else if (interactNode) {
        scripts.interact(interactNode);
      }
      break;
    case 'flashlight':
      if (!uiActive()) body.toggleFlashlight();
      break;
    case 'fog':
      if (!uiActive()) settings.set('fogEnabled', !settings.data.fogEnabled);
      break;
    case 'hud': {
      if (uiActive()) break;
      const hidden = stats.classList.toggle('hidden');
      info.classList.toggle('hidden', hidden);
      break;
    }
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  updateResolution();
  if (terminal?.active) player.setFocus(terminal.focusTarget(camera.aspect, CAMERA_DROP, CAMERA_FORWARD));
  if (activeScreen) {
    const f = screenFocus(activeScreen);
    if (f) player.setFocus(f);
  }
});

// --- Shader vorab kompilieren (sonst ruckeln die ersten Frames) ---
await loading.step(0.8, 'Shader werden kompiliert …');
try {
  await renderer.compileAsync(scene, camera);
} catch (e) {
  console.warn('Shader-Vorkompilierung fehlgeschlagen', e);
}
await loading.step(0.95, 'Erster Frame …');
let firstFrame = true;

// --- Loop ---
const timer = new THREE.Timer();
timer.connect(document);
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;
const pad = (n: number) => String(n).padStart(2, '0');
const WEATHER_LABEL = Object.fromEntries(WEATHER_OPTIONS.map((o) => [o.value, o.label])) as Record<string, string>;
const weatherNow = () => weather.type;
const COVER_LABEL = { none: '', over: 'darüber', left: 'links vorbei', right: 'rechts vorbei', blocked: 'kein Platz' };

renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  const t = timer.getElapsed();

  // Collider-Liste (Scripts bewegen Objekte) → Rapier, danach den Spieler bewegen
  physics.sync(level.colliders);
  physics.step(dt);
  player.update(dt);
  shooter.update(dt);
  // Volumetrik: Spieler verdrängt Nebel/Rauch, Wind/Regen vom Wetter, Lichter für die Streuung
  volumeFX.wind.copy(weather.windVector);
  volumeFX.rain = weather.rainAmount;
  volumeFX.setPlayer(player.feet, player.isCrouching ? 1.2 : 1.8, player.velocity);
  volumeFX.setAmbient(level.world.hemi, level.world.sun);
  volumeFX.update(dt, t, camera);
  scripts.update(dt);
  level.update(dt, t);
  terminal?.update(dt);
  for (const gs of gameScreens) {
    gs.rt.update(dt);
    gs.rt.draw(gs.surf.ctx, SCREEN_PX);
    gs.surf.texture.needsUpdate = true;
  }
  camera.updateMatrixWorld();
  body.setRelaxed(uiActive());
  const anim = player.getAnimState();
  body.update(dt, anim, camera);
  if (weatherNode && !weatherNode.root.quaternion.equals(weatherQuat)) applyWeather();
  weather.trackFeet(player.feet, anim.onGround);
  weather.update(dt, t, camera);

  // Blickt der Spieler auf das Terminal oder ein benutzbares Map-Objekt?
  lookingAtTerminal = false;
  interactNode = null;
  let promptText = '';
  let aimed: GameScreen | null = null;
  if (activeScreen) promptText = 'Zurück';
  else if (!uiActive()) {
    lookRay.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hit = lookRay.intersectObject(level.group, true).find((h) => isSolid(h.object));
    const gs = hit?.object.userData.screenSurface ? gameScreens.find((g) => g.surf.mesh === hit.object) : undefined;
    if (gs && hit && gs.control !== 'none' && hit.distance <= Math.max(INTERACT_RANGE, gs.surf.widthM * 1.6)) {
      aimed = gs;
      if (gs.control === 'aim' && hit.uv) {
        gs.rt.setCursorUV(hit.uv.x, hit.uv.y);
        gs.rt.showCursor = true;
        promptText = gs.rt.used ? 'Klicken' : gs.prompt;
      } else promptText = gs.prompt;
    } else if (terminal && hit?.object === terminal.screenMesh && hit.distance <= TERMINAL_RANGE) {
      lookingAtTerminal = true;
      promptText = 'Terminal benutzen';
    } else if (hit && hit.distance <= INTERACT_RANGE) {
      const node = scripts.findNode(hit.object);
      const text = scripts.interactPrompt(node);
      if (text) {
        interactNode = node;
        promptText = text;
      }
    }
  }
  if (aimScreen && aimScreen !== aimed && aimScreen !== activeScreen) {
    aimScreen.rt.clearCursor();
    aimScreen.rt.showCursor = false;
    if (aimScreen.control === 'aim') aimScreen.rt.exit();
  }
  aimScreen = aimed;
  prompt.textContent = `[${keyLabel(settings.data.bindings.interact)}] ${promptText}`;
  prompt.classList.toggle('hidden', !promptText || !player.isLocked);
  if (messageTimer > 0) {
    messageTimer -= dt;
    if (messageTimer <= 0) messageEl.classList.add('hidden');
  }

  // Bodycam-Linse: am Terminal stark reduziert, damit das Menü lesbar bleibt
  menuBlend += ((uiActive() ? 1 : 0) - menuBlend) * (1 - Math.exp(-5 * dt));
  const d = settings.data;
  const u = bodycam.uniforms;
  u.uDistortion.value = LENS.distortion * d.lensDistortion * (1 - menuBlend * 0.8);
  u.uAberration.value = LENS.aberration * d.aberration * (1 - menuBlend * 0.6);
  u.uGrain.value = LENS.grain * d.grain;
  u.uVignette.value = LENS.vignette * d.vignette * (1 - menuBlend * 0.4);
  glitch = Math.max(0, glitch - dt * 5);
  u.uTime.value = t;
  u.uGlitch.value = glitch;
  u.uRainLens.value = weather.lensRain;

  // Dev-Third-Person: nur fürs Rendern hinter den Spieler, danach Bodycam-Pose zurück
  const tp = thirdPerson?.enabled && !uiActive();
  if (tp) thirdPerson!.apply(camera, player.position);
  updateLandscapes(camera);
  weather.render(camera, dt);
  composer.render(dt);
  if (tp) thirdPerson!.restore(camera);
  if (firstFrame) {
    firstFrame = false;
    void loading.finish();
  }

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
    const now = new Date();
    recTime.textContent =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
  const p = player.position;
  stats.innerHTML =
    `FPS ${fps} · ${mapData.name}${thirdPerson?.enabled ? ' · [DEV] Third Person' : ''}<br>` +
    `Pos ${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}<br>` +
    `Sichtweite ${d.fogEnabled ? Math.round(fogFar(d.viewDistance)) + ' m' : 'aus'}<br>` +
    `Wetter ${WEATHER_LABEL[weatherNow()]} · Nässe ${Math.round(weather.wetness * 100)}% · Pfützen ${Math.round(weather.puddleFill * 100)}%` +
    (weather.snowCover > 0.005 ? ` · Schnee ${Math.round(weather.snowCover * 100)}%` : '') +
    `<br>` +
    `Schüsse ${shots} · ${lastShot}<br>` +
    `Haltung ${player.isCrouching ? 'geduckt' : 'stehend'}${player.isAiming ? ' · zielt' : ''}` +
    (player.coverState !== 'none' ? ` · Deckung: ${COVER_LABEL[player.coverState]}` : '');
});
