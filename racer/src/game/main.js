// Playable build. The sim steps at exactly 20 Hz off a fixed-timestep
// accumulator — identical dynamics to the recorded dataset — while rendering
// runs at display rate. Keyboard is sampled at frame boundaries, exactly like
// the dataset's one-action-per-frame convention.
//
// URL params: ?seed=7           pick the procedural seed
//             ?bot=1            start with the bot driving
//             ?spec=<path>      load a GameSpec json (e.g. runs/x/spec.json)
//             ?prompt=<text>    compile a spec from a prompt right here

import * as THREE from 'three';
import { World, FPS } from '../sim/world.js';
import { createView } from '../render/scene.js';
import { createHud } from '../render/hud.js';
import { makeSpec } from '../spec/schema.js';
import { compileSpec } from '../spec/compile.js';

const params = new URLSearchParams(location.search);
let seed = parseInt(params.get('seed') || '1', 10) >>> 0;
let botMode = params.get('bot') === '1';

async function loadSpec() {
  const specPath = params.get('spec');
  const prompt = params.get('prompt');
  if (specPath) {
    const res = await fetch(specPath);
    if (!res.ok) throw new Error(`failed to load spec ${specPath}: ${res.status}`);
    return makeSpec(await res.json());
  }
  if (prompt) {
    return compileSpec(prompt, { seed, variety: parseFloat(params.get('variety') || '0') });
  }
  return makeSpec();
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

let spec;
let world;
let view;
let hud;

function reset(newSeed) {
  seed = newSeed >>> 0;
  world = new World(seed, spec);
  if (hud) hud.dispose();
  if (view) view.dispose();
  view = createView(world, { width: innerWidth, height: innerHeight });
  hud = createHud(spec, { width: innerWidth, height: innerHeight });
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
  if (spec) {
    // HUD layout is resolution-dependent; rebuild on resize
    if (hud) hud.dispose();
    hud = createHud(spec, { width: innerWidth, height: innerHeight });
  }
}
addEventListener('resize', resize);

// --- keyboard -> action set (same names as the dataset vocabulary)
const KEYMAP = {
  KeyW: 'W', ArrowUp: 'W',
  KeyS: 'S', ArrowDown: 'S',
  KeyA: 'A', ArrowLeft: 'A',
  KeyD: 'D', ArrowRight: 'D',
  Space: 'Space',
  ShiftLeft: 'LShiftKey', ShiftRight: 'LShiftKey',
  KeyF: 'F',
};
const held = { W: false, S: false, A: false, D: false, Space: false, LShiftKey: false, F: false };
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
const hudDiv = document.getElementById('hud');
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
  hud.render(renderer, world);

  const c = world.car;
  const combat = world.spec.entities.monsters.length > 0 || world.spec.weapon.enabled;
  hudDiv.innerHTML =
    `${Math.round(Math.abs(c.u) * 3.6)} km/h · lap ${world.lap + 1} · seed ${seed} · ${spec.name}` +
    (combat ? ` · hp ${world.health} · ammo ${world.ammo} · score ${world.score}` : '') +
    (botMode ? ' · BOT' : '') +
    boostFillHtml.replace('{W}', String(Math.round(c.boost)));
}

loadSpec()
  .then((s) => {
    spec = s;
    reset(seed);
    resize();
    requestAnimationFrame(tick);
  })
  .catch((e) => {
    document.getElementById('hud').textContent = String(e);
    throw e;
  });
