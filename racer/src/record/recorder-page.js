// In-page recording harness driven by headless.js via page.evaluate.
//
// Frame/action alignment follows the dataset contract exactly: the pixels
// captured for frame t show the state BEFORE action t; the keys recorded on
// action line t are what the bot held while stepping to frame t+1. Physics
// line t describes the same state as frame t's pixels.

import * as THREE from 'three';
import { World, FPS, ACTION_KEYS } from '../sim/world.js';
import { createView } from '../render/scene.js';

let world = null;
let view = null;
let renderer = null;

window.__init = (config) => {
  if (view) view.dispose();
  if (renderer) {
    renderer.dispose();
    renderer.domElement.remove();
  }
  world = new World(config.seed >>> 0);
  renderer = new THREE.WebGLRenderer({
    antialias: config.antialias !== false,
    preserveDrawingBuffer: true,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(config.width, config.height);
  document.body.appendChild(renderer.domElement);
  view = createView(world.track, { width: config.width, height: config.height });

  // unrecorded warmup for varied starting states (speed, mid-corner, ...)
  for (let i = 0; i < (config.warmupFrames || 0); i++) world.stepFrame();
  world.frame = 0;
  world.events = [];

  // render frame 0 (camera initializes exactly on target — no settle drift)
  view.update(world, 1 / FPS);
  renderer.render(view.scene, view.camera);

  return {
    seed: world.seed,
    trackLength: Math.round(world.track.length * 100) / 100,
    actionKeys: ACTION_KEYS,
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
    actions.push(ACTION_KEYS.filter((k) => keys[k]));
    // render S_{t+1} for the next iteration/batch
    view.update(world, 1 / FPS);
    renderer.render(view.scene, view.camera);
  }
  return { frames, actions, physics };
};

window.__episodeMeta = () => ({
  seed: world.seed,
  frames: world.frame,
  events: world.events,
  laps: world.lap,
  progress: Math.round(world.progress),
  trackLength: Math.round(world.track.length * 100) / 100,
});

window.__ready = true;
