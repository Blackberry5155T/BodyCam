import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { MAPS } from './maps/index.ts';
import { CAMERA_DROP, CAMERA_FORWARD, PlayerController } from './player/controller.ts';
import { PlayerBody } from './player/body.ts';
import { Shooter, isSolid } from './combat/shooting.ts';
import { BodycamShader } from './rendering/postfx/bodycam.ts';
import { Settings, keyLabel, type SettingsData } from './core/settings.ts';
import { Input } from './core/input.ts';
import { Terminal } from './world/props/terminal.ts';
import { loadMap, type MapNode } from './world/mapLoader.ts';
import { loadLocalMap, mapStorageKey } from './world/mapStore.ts';
import type { MapData } from './world/mapFormat.ts';
import { ScriptRuntime } from './scripting/runtime.ts';

const FOG_MIN = 5;
const FOG_MAX = 60;
const EXPOSURE = 1.15;
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

const showError = (msg: string) => {
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

// --- Map wählen: /?map=start (mitgeliefert) oder /?map=local:<Name> (aus dem Map-Editor) ---
const mapParam = new URLSearchParams(location.search).get('map') ?? 'start';
let mapData: MapData = MAPS.start;
if (mapParam.startsWith('local:')) {
  const local = loadLocalMap(mapParam.slice(6));
  if (local) mapData = local;
  else console.warn(`Lokale Map "${mapParam.slice(6)}" nicht gefunden — lade Startmap`);
} else if (MAPS[mapParam]) {
  mapData = MAPS[mapParam];
}
// Speichert der Editor diese Map erneut, lädt der Spiel-Tab automatisch neu
window.addEventListener('storage', (e) => {
  if (mapParam.startsWith('local:') && e.key === mapStorageKey(mapParam.slice(6))) {
    allowUnload = true; // kein "Seite verlassen?"-Dialog beim automatischen Neuladen
    location.reload();
  }
});
const world = mapData.world;

const settings = new Settings();
const input = new Input(settings);

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const pixelRatio = () => Math.min(window.devicePixelRatio * settings.data.renderScale, 2);
renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE * world.exposure;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(world.background);

// Distanz-Fade: linearer Nebel, Sichtweite = far
const fog = new THREE.Fog(world.fogColor, 1, settings.data.viewDistance);
scene.fog = fog;

const camera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.05, 200);
scene.add(camera);

// --- Map: Geometrie, Lichter, Volumetrik; Himmel/Sonne/Bodennebel aus den World Settings ---
const anisotropy = renderer.capabilities.getMaxAnisotropy();
const level = loadMap(mapData, { anisotropy, editor: false });
scene.add(level.group);
// Fog-Plane: bodennahe Nebelschicht, grobe Simulation für Sichtlinien-Tests
const fogPlane = level.world.groundFog;

const player = new PlayerController(camera, document.body, level.colliders, level.spawn, input, settings, level.spawnYaw);
// Spielerkörper aus Würfeln; hält die Taschenlampe in der linken Hand
const body = new PlayerBody(scene);
const shooter = new Shooter(scene, [level.group]);
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
lookRay.far = Math.max(TERMINAL_RANGE, INTERACT_RANGE);
let lookingAtTerminal = false;

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
  log: (msg, isError) => (isError ? console.warn(msg) : console.log(msg)),
});
scripts.start();
let interactNode: MapNode | null = null;
window.addEventListener('keydown', (e) => {
  if (!e.repeat && player.isLocked && !terminalActive()) scripts.keyPressed(e.code);
});

// --- Post-Processing: Szene → Bloom → Tonemapping/sRGB → Bodycam-Linse ---
const renderTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, renderTarget);
composer.setPixelRatio(pixelRatio());
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
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
      break;
    case 'viewDistance':
      fog.far = d.viewDistance;
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

for (const k of ['brightness', 'fogEnabled', 'viewDistance', 'bloom', 'renderScale', 'shadows', 'hudOverlay', 'bindings'] as const) {
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
  }
});

document.addEventListener('mousemove', (e) => {
  if (player.isLocked && terminal?.active) terminal.moveCursor(e.movementX, e.movementY);
});

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !player.isLocked) return;
  if (terminal?.active) {
    terminal.pointerDown();
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
  if (e.button === 0) terminal?.pointerUp();
});

window.addEventListener(
  'wheel',
  (e) => {
    // Strg+Mausrad (z. B. beim Schleichen) würde sonst die Seite zoomen
    if (e.ctrlKey) e.preventDefault();
    if (terminalActive()) return;
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
      } else if (terminal && lookingAtTerminal) {
        player.setFocus(terminal.focusTarget(camera.aspect, CAMERA_DROP, CAMERA_FORWARD));
        terminal.enter();
      } else if (interactNode) {
        scripts.interact(interactNode);
      }
      break;
    case 'flashlight':
      if (!terminalActive()) body.toggleFlashlight();
      break;
    case 'fog':
      if (!terminalActive()) settings.set('fogEnabled', !settings.data.fogEnabled);
      break;
    case 'hud': {
      if (terminalActive()) break;
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
});

// --- Loop ---
const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;
const pad = (n: number) => String(n).padStart(2, '0');
const COVER_LABEL = { none: '', over: 'darüber', left: 'links vorbei', right: 'rechts vorbei', blocked: 'kein Platz' };

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  player.update(dt);
  shooter.update(dt);
  scripts.update(dt);
  level.update(dt, t);
  terminal?.update(dt);
  camera.updateMatrixWorld();
  body.setRelaxed(terminalActive());
  body.update(dt, player.getAnimState(), camera);

  // Blickt der Spieler auf das Terminal oder ein benutzbares Map-Objekt?
  lookingAtTerminal = false;
  interactNode = null;
  let promptText = '';
  if (!terminalActive()) {
    lookRay.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hit = lookRay.intersectObject(level.group, true).find((h) => isSolid(h.object));
    if (terminal && hit?.object === terminal.screenMesh && hit.distance <= TERMINAL_RANGE) {
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
  prompt.textContent = `[${keyLabel(settings.data.bindings.interact)}] ${promptText}`;
  prompt.classList.toggle('hidden', !promptText || !player.isLocked);
  if (messageTimer > 0) {
    messageTimer -= dt;
    if (messageTimer <= 0) messageEl.classList.add('hidden');
  }

  // Bodycam-Linse: am Terminal stark reduziert, damit das Menü lesbar bleibt
  menuBlend += ((terminalActive() ? 1 : 0) - menuBlend) * (1 - Math.exp(-5 * dt));
  const d = settings.data;
  const u = bodycam.uniforms;
  u.uDistortion.value = LENS.distortion * d.lensDistortion * (1 - menuBlend * 0.8);
  u.uAberration.value = LENS.aberration * d.aberration * (1 - menuBlend * 0.6);
  u.uGrain.value = LENS.grain * d.grain;
  u.uVignette.value = LENS.vignette * d.vignette * (1 - menuBlend * 0.4);
  glitch = Math.max(0, glitch - dt * 5);
  u.uTime.value = t;
  u.uGlitch.value = glitch;

  composer.render(dt);

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
    `FPS ${fps} · ${mapData.name}<br>` +
    `Pos ${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}<br>` +
    `Sichtweite ${d.fogEnabled ? d.viewDistance + ' m' : 'aus'}<br>` +
    `Schüsse ${shots} · ${lastShot}<br>` +
    `Haltung ${player.isCrouching ? 'geduckt' : 'stehend'}${player.isAiming ? ' · zielt' : ''}` +
    (player.coverState !== 'none' ? ` · Deckung: ${COVER_LABEL[player.coverState]}` : '');
});
