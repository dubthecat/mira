// HUD smoke check: imports hud.js in plain node (no browser) by stubbing the
// one DOM entry point it uses — document.createElement('canvas') — with a
// recording 2D-context fake. Verifies createHud/render/dispose don't throw,
// the renderer contract (autoClear saved/restored, depth-only clear), mesh
// budget, bar layout math and minimap containment. Run:
//   node racer/test/hud_check.mjs
// (three resolves from racer/node_modules for imports made by racer/src files)

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

// --- minimal DOM stub (installed before hud.js is loaded) --------------------
const ctxCalls = [];
function makeCtx2d() {
  const state = {};
  return new Proxy(state, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'measureText') return () => ({ width: 10 });
      // any method: no-op that records its name
      return (...args) => { ctxCalls.push(p); };
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return { style: {} };
    return { width: 0, height: 0, style: {}, getContext: () => makeCtx2d() };
  },
};

// --- imports (hud.js itself does `import 'three'`, resolved via racer/) -----
const { makeSpec } = await import('../src/spec/schema.js');
const { createHud } = await import('../src/render/hud.js');

const ALL = ['speed', 'boost', 'health', 'ammo', 'score', 'lap', 'minimap'];
const spec = makeSpec({
  hud: { elements: ALL, scale: 1.0 },
  weapon: { enabled: true, ammoMax: 24 },
  entities: { monsters: [{ type: 'chaser', count: 3 }] },
});

// --- fake world with every field populated ----------------------------------
function ellipseTrack(n = 200) {
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    xs[i] = 140 * Math.cos(a);
    ys[i] = 90 * Math.sin(a);
  }
  return { n, xs, ys };
}
const track = ellipseTrack();
const world = {
  car: { x: track.xs[0], y: track.ys[0], u: 25, boost: 55 },
  health: 40,
  ammo: 7,
  score: 12345,
  lap: 2,
  track,
  entities: {
    monsters: [
      { x: 30, y: 10, alive: true },
      { x: -50, y: 40, alive: false },
      { x: 0, y: -80, alive: true },
    ],
  },
};

// --- stub renderer -----------------------------------------------------------
const calls = { clearDepth: 0, render: 0, autoClearDuringDraw: [] };
let capturedScene = null;
let capturedCamera = null;
const renderer = {
  autoClear: true,
  clearDepth() {
    calls.clearDepth++;
    calls.autoClearDuringDraw.push(this.autoClear);
  },
  render(sc, cam) {
    calls.render++;
    calls.autoClearDuringDraw.push(this.autoClear);
    capturedScene = sc;
    capturedCamera = cam;
  },
  getSize(t) { if (t) { t.x = 512; t.y = 288; } return t; },
};

function meshes(scene) {
  const out = [];
  scene.traverse((o) => { if (o.isMesh) out.push(o); });
  return out;
}
const byName = (scene, name) => meshes(scene).filter((m) => m.name === name);
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- 1. construction + first render -----------------------------------------
let hud;
try {
  hud = createHud(spec, { width: 512, height: 288 });
  check('createHud (all elements) returns render/dispose',
    typeof hud.render === 'function' && typeof hud.dispose === 'function');
} catch (e) {
  check('createHud (all elements)', false, e.stack || String(e));
  process.exit(1);
}
check('glyph atlas drew onto stub canvas', ctxCalls.includes('fillText') && ctxCalls.includes('strokeText'));

try {
  hud.render(renderer, world);
  check('render() does not throw', true);
} catch (e) {
  check('render() does not throw', false, e.stack || String(e));
  process.exit(1);
}
check('clearDepth called exactly once', calls.clearDepth === 1, `got ${calls.clearDepth}`);
check('scene rendered exactly once', calls.render === 1, `got ${calls.render}`);
check('autoClear=false while drawing overlay', calls.autoClearDuringDraw.every((v) => v === false));
check('autoClear restored after render', renderer.autoClear === true);
check('camera is 0..width / 0..height ortho',
  capturedCamera.isOrthographicCamera && capturedCamera.left === 0 &&
  capturedCamera.right === 512 && capturedCamera.top === 288 && capturedCamera.bottom === 0);

// --- 2. mesh budget -----------------------------------------------------------
// speed 6 (frame+fill+3 digits+kmh) | boost 2 | health 21 (heart+10 bg+10 fill)
// ammo 4 (icon+x+2 digits) | score 6 | lap 8 (L+2 digits+5 pips)
// minimap 7 (bg+track+tick+car+3 monster dots)  => 54
const EXPECTED_MESHES = 54;
const all = meshes(capturedScene);
check(`mesh count == ${EXPECTED_MESHES}`, all.length === EXPECTED_MESHES, `got ${all.length}`);

// --- 3. layout math -----------------------------------------------------------
const speedFill = byName(capturedScene, 'speedFill')[0];
const boostFill = byName(capturedScene, 'boostFill')[0];
// u=25 m/s -> 90 km/h -> half of the 180 km/h bar (120 px wide) -> 60 px
check('speed fill = 60px at 90 km/h', speedFill && approx(speedFill.scale.x, 60),
  `got ${speedFill && speedFill.scale.x}`);
check('boost fill = 66px at boost 55', boostFill && approx(boostFill.scale.x, 66),
  `got ${boostFill && boostFill.scale.x}`);

const mmBg = byName(capturedScene, 'mmBg')[0];
const mmCar = byName(capturedScene, 'mmCar')[0];
const inBox = (m) =>
  m.position.x >= mmBg.position.x && m.position.x <= mmBg.position.x + mmBg.scale.x &&
  m.position.y >= mmBg.position.y && m.position.y <= mmBg.position.y + mmBg.scale.y;
check('minimap box ~70px', mmBg && approx(mmBg.scale.x, 70) && approx(mmBg.scale.y, 70));
check('minimap top-left when score present', mmBg && mmBg.position.x < 256 && mmBg.position.y > 144);
check('car dot inside minimap box', mmCar && inBox(mmCar));
const dots = byName(capturedScene, 'mmDot');
check('2 of 3 monster dots visible (one dead)',
  dots.length === 3 && dots.filter((d) => d.visible).length === 2 &&
  dots.filter((d) => d.visible).every(inBox));
const mmTrack = byName(capturedScene, 'mmTrack')[0];
{
  const a = mmTrack.geometry.getAttribute('position');
  let ok = a.count === 160; // 80 samples x 2 ribbon verts
  for (let i = 0; i < a.count && ok; i++) {
    const x = a.getX(i);
    const y = a.getY(i);
    ok = x >= mmBg.position.x && x <= mmBg.position.x + 70 && y >= mmBg.position.y && y <= mmBg.position.y + 70;
  }
  check('track polyline (160 verts) fits inside minimap box', ok);
}

// --- 4. undefined-field world + repeat renders (no mesh growth) ---------------
const world2 = {
  car: { x: 0, y: 0, u: 0, boost: 0 },
  lap: 0,
  track, // same track object: no rebuild path
};
try {
  hud.render(renderer, world2);
  hud.render(renderer, world2);
  check('render tolerates undefined health/ammo/score/entities', true);
} catch (e) {
  check('render tolerates undefined health/ammo/score/entities', false, e.stack || String(e));
}
check('mesh count stable across renders', meshes(capturedScene).length === EXPECTED_MESHES,
  `got ${meshes(capturedScene).length}`);
check('speed fill collapses at 0 km/h', speedFill.scale.x <= 1e-3, `got ${speedFill.scale.x}`);
check('autoClear still restored', renderer.autoClear === true);

// --- 5. track identity change triggers minimap rebuild ------------------------
try {
  const world3 = { ...world, track: ellipseTrack(300) };
  hud.render(renderer, world3);
  check('minimap rebuild on new track object', true);
} catch (e) {
  check('minimap rebuild on new track object', false, e.stack || String(e));
}

// --- 6. render against the real sim World ------------------------------------
try {
  const { World } = await import('../src/sim/world.js');
  const w = new World(3);
  for (let i = 0; i < 10; i++) w.stepFrame();
  hud.render(renderer, w);
  check('render against real sim World(3)', true);
} catch (e) {
  check('render against real sim World(3)', false, e.stack || String(e));
}

// --- 7. subset spec draws only listed elements --------------------------------
try {
  const small = createHud(makeSpec({ hud: { elements: ['speed', 'boost'] } }), { width: 512, height: 288 });
  small.render(renderer, world2);
  const n = meshes(capturedScene).length;
  check('subset spec (speed+boost) -> 8 meshes', n === 8, `got ${n}`);
  small.dispose();
} catch (e) {
  check('subset spec (speed+boost)', false, e.stack || String(e));
}

// --- 8. dispose ----------------------------------------------------------------
try {
  hud.dispose();
  check('dispose() does not throw', true);
} catch (e) {
  check('dispose() does not throw', false, e.stack || String(e));
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
