// Playable build. The sim steps at exactly 20 Hz off a fixed-timestep
// accumulator — identical dynamics to the recorded dataset — while rendering
// runs at display rate. Keyboard is sampled at frame boundaries, exactly like
// the dataset's one-action-per-frame convention.

import * as THREE from 'three';
import { World, FPS } from '../sim/world.js';
import { createView } from '../render/scene.js';

const params = new URLSearchParams(location.search);
let seed = parseInt(params.get('seed') || '1', 10) >>> 0;
let botMode = params.get('bot') === '1';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

let world;
let view;

function reset(newSeed) {
  seed = newSeed >>> 0;
  world = new World(seed);
  if (view) view.dispose();
  view = createView(world.track, { width: innerWidth, height: innerHeight });
  view.camera.aspect = innerWidth / innerHeight;
  view.camera.updateProjectionMatrix();
  const url = new URL(location.href);
  url.searchParams.set('seed', String(seed));
  history.replaceState(null, '', url);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  if (view) {
    view.camera.aspect = innerWidth / innerHeight;
    view.camera.updateProjectionMatrix();
  }
}
addEventListener('resize', resize);

// --- keyboard -> 6-key action set (same names as the dataset vocabulary)
const KEYMAP = {
  KeyW: 'W', ArrowUp: 'W',
  KeyS: 'S', ArrowDown: 'S',
  KeyA: 'A', ArrowLeft: 'A',
  KeyD: 'D', ArrowRight: 'D',
  Space: 'Space',
  ShiftLeft: 'LShiftKey', ShiftRight: 'LShiftKey',
};
const held = { W: false, S: false, A: false, D: false, Space: false, LShiftKey: false };
addEventListener('keydown', (e) => {
  const k = KEYMAP[e.code];
  if (k) {
    held[k] = true;
    e.preventDefault();
  }
  if (e.code === 'KeyB') botMode = !botMode;
  if (e.code === 'KeyN') reset(seed + 1);
  if (e.code === 'KeyR') reset(seed);
});
addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (k) {
    held[k] = false;
    e.preventDefault();
  }
});

// --- fixed-timestep loop
const hud = document.getElementById('hud');
const boostFillHtml = '<div id="boostbar"><div id="boostfill" style="width:{W}%"></div></div>';
let last = performance.now();
let acc = 0;

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  acc += dt;
  while (acc >= 1 / FPS) {
    acc -= 1 / FPS;
    world.stepFrame(botMode ? null : { ...held });
  }
  view.update(world, dt);
  renderer.render(view.scene, view.camera);

  const c = world.car;
  hud.innerHTML =
    `${Math.round(Math.abs(c.u) * 3.6)} km/h · lap ${world.lap + 1} · seed ${seed}` +
    (botMode ? ' · BOT' : '') +
    boostFillHtml.replace('{W}', String(Math.round(c.boost)));
}

reset(seed);
resize();
requestAnimationFrame(tick);
