// In-page recording harness driven by headless.js via page.evaluate.
//
// Frame/action alignment follows the dataset contract exactly: the pixels
// captured for frame t show the state BEFORE action t; the keys recorded on
// action line t are what the bot held while stepping to frame t+1. Physics
// line t describes the same state as frame t's pixels. The HUD is rendered
// into the captured frames — UI is part of what the world model learns.

import * as THREE from 'three';
import { World, FPS } from '../sim/world.js';
import { createView } from '../render/scene.js';
import { createHud } from '../render/hud.js';
import { makeSpec } from '../spec/schema.js';

let world = null;
let view = null;
let hud = null;
let renderer = null;
let recordStartFrame = 0;

function renderFrame() {
  renderer.render(view.scene, view.camera);
  hud.render(renderer, world);
}

window.__init = (config) => {
  if (hud) hud.dispose();
  if (view) view.dispose();
  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
  }
  const spec = makeSpec(config.spec || {});
  world = new World(config.seed >>> 0, spec);
  renderer = new THREE.WebGLRenderer({
    antialias: config.antialias !== false,
    preserveDrawingBuffer: true,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(config.width, config.height);
  document.body.appendChild(renderer.domElement);
  view = createView(world.track, { width: config.width, height: config.height, spec });
  hud = createHud(spec, { width: config.width, height: config.height });

  // unrecorded warmup for varied starting states (speed, mid-corner, ...).
  // The frame counter stays MONOTONIC: entity clocks and respawn timers are
  // keyed to it, and rewinding it teleports frame-clocked entities between
  // recorded frames 0 and 1. Dataset-relative indices are rebased below.
  for (let i = 0; i < (config.warmupFrames || 0); i++) world.stepFrame();
  world.events = [];
  recordStartFrame = world.frame;

  // render frame 0 (camera initializes exactly on target — no settle drift)
  view.update(world, 1 / FPS);
  renderFrame();

  // test hook: pixel-level HUD verification reads world state + canvas together
  window.__world = world;

  return {
    seed: world.seed,
    trackLength: Math.round(world.track.length * 100) / 100,
    actionKeys: world.actionKeys,
    specName: spec.name,
  };
};

// Record n frames; returns capture data for each.
window.__stepBatch = (n) => {
  const frames = [];
  const actions = [];
  const physics = [];
  for (let i = 0; i < n; i++) {
    // capture state S_t (already rendered), physics of the same instant
    frames.push(renderer.domElement.toDataURL('image/png'));
    physics.push(world.snapshot());
    // apply action K_t -> S_{t+1}
    const { keys } = world.stepFrame();
    actions.push(world.actionKeys.filter((k) => keys[k]));
    // render S_{t+1} for the next iteration/batch
    view.update(world, 1 / FPS);
    renderFrame();
  }
  return { frames, actions, physics };
};

window.__episodeMeta = () => ({
  seed: world.seed,
  frames: world.frame - recordStartFrame,
  events: world.events.map((e) => ({ ...e, frame: e.frame - recordStartFrame })),
  laps: world.lap,
  score: world.score,
  progress: Math.round(world.progress),
  trackLength: Math.round(world.track.length * 100) / 100,
});

window.__ready = true;
