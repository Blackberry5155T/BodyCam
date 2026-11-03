import * as THREE from 'three';
import { buildLevel } from './level.ts';
import { PlayerController } from './player.ts';
import { Shooter } from './shooting.ts';

const FOG_COLOR = 0x8c9296;
const FOG_MIN = 5;
const FOG_MAX = 60;

const app = document.getElementById('app')!;
const blocker = document.getElementById('blocker')!;
const stats = document.getElementById('stats')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(FOG_COLOR);

// Distanz-Fade: linearer Nebel, Sichtweite = far
let fogFar = 25;
let fogEnabled = true;
const fog = new THREE.Fog(FOG_COLOR, 1, fogFar);
scene.fog = fog;

// Fog-Plane: bodennahe Nebelschicht, grobe Simulation für Sichtlinien-Tests
const fogPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshBasicMaterial({ color: FOG_COLOR, transparent: true, opacity: 0.35, depthWrite: false }),
);
fogPlane.rotation.x = -Math.PI / 2;
fogPlane.position.y = 0.4;
scene.add(fogPlane);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);

scene.add(new THREE.HemisphereLight(0xbfc8d0, 0x2a2a2a, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(10, 20, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25 });
scene.add(sun);

const level = buildLevel();
scene.add(level.group);

const player = new PlayerController(camera, document.body, level.colliders, level.spawn);
scene.add(player.object);

const shooter = new Shooter(scene, [level.group]);
let shots = 0;
let lastShot = '–';

blocker.addEventListener('click', () => player.controls.lock());
player.controls.addEventListener('lock', () => blocker.classList.add('hidden'));
player.controls.addEventListener('unlock', () => blocker.classList.remove('hidden'));

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !player.controls.isLocked) return;
  shots++;
  const result = shooter.fire(camera);
  lastShot = result.hit ? `Treffer @ ${result.distance!.toFixed(1)} m` : 'kein Treffer';
});

window.addEventListener('wheel', (e) => {
  fogFar = THREE.MathUtils.clamp(fogFar + Math.sign(e.deltaY) * 2, FOG_MIN, FOG_MAX);
  fog.far = fogFar;
});

window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyF') return;
  fogEnabled = !fogEnabled;
  scene.fog = fogEnabled ? fog : null;
  fogPlane.visible = fogEnabled;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;
let fps = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (player.controls.isLocked) player.update(dt);
  shooter.update(dt);
  renderer.render(scene, camera);

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
  }
  const p = camera.position;
  stats.innerHTML =
    `FPS ${fps}<br>` +
    `Pos ${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}<br>` +
    `Sichtweite ${fogEnabled ? fogFar + ' m' : 'aus'}<br>` +
    `Schüsse ${shots} · ${lastShot}`;
});
