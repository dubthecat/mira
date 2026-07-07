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
const THREE = await import('three');

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

// --- glyph atlas UV decode ----------------------------------------------------
// Mirror of hud.js's atlas layout (8x2 grid, glyphs laid out row-major in this
// order). setGlyph writes each slot's uv attribute as TL,TR,BL,BR with
// u0=col/8, u1=(col+1)/8, v1=1-row/2, v0=1-(row+1)/2 — so a slot's uv rect maps
// back to exactly one atlas cell. A never-set slot keeps PlaneGeometry's
// default full-[0,1] uvs, which decode to null (cell width mismatch).
const ATLAS_GLYPHS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'L', 'x', 'kmh', 'heart', 'ammo'];
const ATLAS_COLS = 8;
const ATLAS_ROWS = 2;
function decodeGlyph(slot) {
  const a = slot.geometry.getAttribute('uv');
  const u0 = a.getX(0);
  const v1 = a.getY(0);
  const u1 = a.getX(1);
  const v0 = a.getY(2);
  if (Math.abs((u1 - u0) - 1 / ATLAS_COLS) > 1e-9 || Math.abs((v1 - v0) - 1 / ATLAS_ROWS) > 1e-9) return null;
  const col = Math.round(u0 * ATLAS_COLS);
  const row = Math.round((1 - v1) * ATLAS_ROWS);
  if (col < 0 || col >= ATLAS_COLS || row < 0 || row >= ATLAS_ROWS) return null;
  const i = row * ATLAS_COLS + col;
  return i < ATLAS_GLYPHS.length ? ATLAS_GLYPHS[i] : null;
}
// glyph slots (digit/icon meshes) in construction order; hud.js tags them by
// initializing userData.glyph
const glyphSlotsOf = (scene) => scene.children.filter((m) => m.isMesh && 'glyph' in m.userData);
// concatenate the decoded glyphs of the *visible* slots, left to right
function readGlyphs(slots) {
  let out = '';
  for (const m of slots) {
    if (!m.visible) continue;
    const g = decodeGlyph(m);
    out += g === null ? '?' : g;
  }
  return out;
}
// world-space 2D bbox of a mesh's geometry (handles rotated ticks + the ribbon)
function bboxOf(mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  return { minX, minY, maxX, maxY };
}
// axis-aligned rectangular "track": per*4 points tracing a box of half-extents
// (hx, hy); with per*4 == 80 == hud.js's MM_SAMPLES every point (including all
// four corners) survives the minimap downsample, so the fit transform is exact
function boxTrack(hx, hy, per = 20) {
  const n = per * 4;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < per; i++) {
    const tx = -hx + (2 * hx * i) / per;
    const ty = -hy + (2 * hy * i) / per;
    xs[i] = tx;
    ys[i] = -hy;
    xs[per + i] = hx;
    ys[per + i] = ty;
    xs[2 * per + i] = -tx;
    ys[2 * per + i] = hy;
    xs[3 * per + i] = -hx;
    ys[3 * per + i] = -ty;
  }
  return { n, xs, ys };
}
function sweep(name, fn) {
  try {
    fn();
  } catch (e) {
    check(name, false, e.stack || String(e));
  }
}
const carAt = (x, y, u = 0, boost = 0) => ({ car: { x, y, u, boost } });

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

// ============================================================================
// Parametric sweeps: HUD element <-> engine variable correctness at the
// mesh/UV level. Each sweep builds an isolated HUD (only the element under
// test) so glyph slots are identifiable by construction order.
// ============================================================================

const SPEED_MAX_KMH = 180;
const BAR_W = 120; // speed/boost bar width at scale 1
const HEALTH_GREEN = 0x2ee648;
const HEALTH_RED = 0xff2e2e;
const PIP_ON = 0xffffff;

// --- 9. SPEED sweep -----------------------------------------------------------
sweep('SPEED sweep', () => {
  const h = createHud(makeSpec({ hud: { elements: ['speed'] } }), { width: 512, height: 288 });
  const badFill = [];
  const badDigit = [];
  let labelOk = true;
  for (const u of [0, 5, 12.5, 25, 50, 60]) {
    h.render(renderer, carAt(0, 0, u));
    const sc = capturedScene;
    const fill = byName(sc, 'speedFill')[0];
    const kmh = Math.abs(u) * 3.6;
    const wantW = Math.max(Math.min(kmh / SPEED_MAX_KMH, 1) * BAR_W, 1e-4);
    if (!approx(fill.scale.x, wantW, 1e-9)) badFill.push(`u=${u}: fill ${fill.scale.x} != ${wantW}`);
    const slots = glyphSlotsOf(sc); // [digit, digit, digit, kmh-label]
    const got = readGlyphs(slots.slice(0, 3));
    const want = String(Math.round(kmh));
    if (got !== want) badDigit.push(`u=${u}: digits '${got}' != '${want}'`);
    if (decodeGlyph(slots[3]) !== 'kmh') labelOk = false;
  }
  check('SPEED sweep: fill width clamps at 180 km/h', badFill.length === 0, badFill.join('; '));
  check('SPEED sweep: digit UVs == String(Math.round(|u|*3.6))', badDigit.length === 0, badDigit.join('; '));
  check('SPEED sweep: km/h label glyph intact', labelOk);
  h.dispose();
});

// --- 10. BOOST sweep ------------------------------------------------------------
sweep('BOOST sweep', () => {
  const h = createHud(makeSpec({ hud: { elements: ['boost'] } }), { width: 512, height: 288 });
  const bad = [];
  for (const b of [0, 33.3, 100, 0.1, 66.66666666, 99.999]) {
    h.render(renderer, carAt(0, 0, 0, b));
    const fill = byName(capturedScene, 'boostFill')[0];
    const frac = Math.min(Math.max(b / 100, 0), 1);
    const wantW = Math.max(frac * BAR_W, 1e-4);
    if (!approx(fill.scale.x, wantW, 1e-9)) bad.push(`boost=${b}: fill ${fill.scale.x} != ${wantW}`);
  }
  check('BOOST sweep: fill widths incl. float values', bad.length === 0, bad.join('; '));
  h.dispose();
});

// --- 11. HEALTH sweep -----------------------------------------------------------
sweep('HEALTH sweep', () => {
  // returns per-case mismatches for a given healthMax spec
  const run = (healthMax, cases) => {
    const h = createHud(
      makeSpec({ hud: { elements: ['health'] }, rules: { healthMax } }),
      { width: 512, height: 288 },
    );
    const bad = [];
    for (const [hp, wantLit, wantColor] of cases) {
      h.render(renderer, { ...carAt(0, 0), health: hp });
      // fill segments = the non-glyph meshes carrying the green/red material,
      // in construction (left-to-right) order; bg quads keep the dark off-mat
      const fills = capturedScene.children.filter((m) => m.isMesh && !('glyph' in m.userData) &&
        (m.material.color.getHex() === HEALTH_GREEN || m.material.color.getHex() === HEALTH_RED));
      if (fills.length !== 10) { bad.push(`hp=${hp}: ${fills.length} fill segs != 10`); continue; }
      const lit = fills.filter((f) => f.visible).length;
      if (lit !== wantLit) bad.push(`hp=${hp}: lit ${lit} != ${wantLit}`);
      if (!fills.every((f, i) => f.visible === (i < lit))) bad.push(`hp=${hp}: lit segs not a left prefix`);
      const wantHex = wantColor === 'red' ? HEALTH_RED : HEALTH_GREEN;
      if (wantLit > 0 && fills[0].material.color.getHex() !== wantHex) {
        bad.push(`hp=${hp}: color 0x${fills[0].material.color.getHex().toString(16)} != ${wantColor}`);
      }
    }
    h.dispose();
    return bad;
  };
  const bad100 = run(100, [
    [0, 0, 'red'], [1, 1, 'red'], [29, 3, 'red'], [30, 3, 'red'],
    [31, 3, 'green'], [99, 10, 'green'], [100, 10, 'green'], [undefined, 10, 'green'],
  ]);
  check('HEALTH sweep: healthMax=100 lit segments + red at <=30%', bad100.length === 0, bad100.join('; '));
  const bad200 = run(200, [
    [30, 2, 'red'], [60, 3, 'red'], [100, 5, 'green'], [200, 10, 'green'],
  ]);
  check('HEALTH sweep: healthMax=200 maps by fraction', bad200.length === 0, bad200.join('; '));
});

// --- 12. AMMO sweep -------------------------------------------------------------
sweep('AMMO sweep', () => {
  const h = createHud(
    makeSpec({ hud: { elements: ['ammo'] }, weapon: { enabled: true, ammoMax: 24 } }),
    { width: 512, height: 288 },
  );
  const bad = [];
  for (const [a, want] of [[0, '0'], [7, '7'], [24, '24'], [undefined, '0'], [30, '24'], [999, '24']]) {
    h.render(renderer, { ...carAt(0, 0), ammo: a });
    const slots = glyphSlotsOf(capturedScene); // [digit, digit, 'x', bullet]
    const got = readGlyphs(slots.slice(0, 2));
    if (got !== want) bad.push(`ammo=${a}: '${got}' != '${want}'`);
  }
  const slots = glyphSlotsOf(capturedScene);
  check('AMMO sweep: digits + clamp to ammoMax=24', bad.length === 0, bad.join('; '));
  check('AMMO sweep: x + bullet icon glyphs intact',
    decodeGlyph(slots[2]) === 'x' && decodeGlyph(slots[3]) === 'ammo',
    `got '${decodeGlyph(slots[2])}', '${decodeGlyph(slots[3])}'`);
  h.dispose();
});

// --- 13. SCORE sweep ------------------------------------------------------------
sweep('SCORE sweep', () => {
  const h = createHud(makeSpec({ hud: { elements: ['score'] } }), { width: 512, height: 288 });
  const bad = [];
  // overflow beyond 6 digits clamps to NUM_CAP[6] = 999999 (setNumber), no crash
  for (const [v, want] of [
    [0, '000000'], [100, '000100'], [54321, '054321'], [999999, '999999'], [1234567, '999999'],
  ]) {
    h.render(renderer, { ...carAt(0, 0), score: v });
    const slots = glyphSlotsOf(capturedScene);
    if (slots.length !== 6 || slots.some((m) => !m.visible)) bad.push(`score=${v}: not all 6 slots visible`);
    const got = readGlyphs(slots);
    if (got !== want) bad.push(`score=${v}: '${got}' != '${want}'`);
  }
  check('SCORE sweep: zero-padded 6 digits, overflow clamps to 999999', bad.length === 0, bad.join('; '));
  h.dispose();
});

// --- 14. LAP sweep --------------------------------------------------------------
sweep('LAP sweep', () => {
  const h = createHud(makeSpec({ hud: { elements: ['lap'] } }), { width: 512, height: 288 });
  const bad = [];
  for (let lap = 0; lap <= 7; lap++) {
    h.render(renderer, { ...carAt(0, 0), lap });
    const slots = glyphSlotsOf(capturedScene); // ['L', digit, digit]
    if (decodeGlyph(slots[0]) !== 'L') bad.push(`lap=${lap}: 'L' glyph missing`);
    const got = readGlyphs(slots.slice(1, 3));
    const want = String(lap + 1);
    if (got !== want) bad.push(`lap=${lap}: digits '${got}' != '${want}'`);
    const pips = capturedScene.children.filter((m) => m.isMesh && !('glyph' in m.userData));
    if (pips.length !== 5) { bad.push(`lap=${lap}: ${pips.length} pips != 5`); continue; }
    const wantLit = Math.min(lap + 1, 5);
    if (!pips.every((p, i) => (p.material.color.getHex() === PIP_ON) === (i < wantLit))) {
      bad.push(`lap=${lap}: lit pips != left prefix of ${wantLit}`);
    }
  }
  check('LAP sweep: L<n> glyphs + pip lighting (caps at 5 pips)', bad.length === 0, bad.join('; '));
  h.dispose();
});

// --- 15. MINIMAP sweep ----------------------------------------------------------
sweep('MINIMAP sweep', () => {
  // layout for elements=['minimap'] only (no score -> top-right), 512x288, s=1:
  const W = 512;
  const H = 288;
  const BOX = 70;
  const X0 = W - BOX - 10;
  const Y0 = (H - 10) - BOX;
  const sqTrack = boxTrack(50, 50); // extent 100 -> k = (70 - 2*6) / 100
  const K = (BOX - 12) / 100;
  const expect = (x, y) => {
    let px = (X0 + BOX / 2) + x * K; // cx = cy = 0 for a centered square
    let py = (Y0 + BOX / 2) + -y * K;
    px = Math.min(Math.max(px, X0 + 1), X0 + BOX - 1);
    py = Math.min(Math.max(py, Y0 + 1), Y0 + BOX - 1);
    return [px, py];
  };
  const near = (mesh, x, y) => Math.abs(mesh.position.x - x) <= 1 && Math.abs(mesh.position.y - y) <= 1;

  const h = createHud(
    makeSpec({ hud: { elements: ['minimap'] }, entities: { monsters: [{ type: 'chaser', count: 3 }] } }),
    { width: W, height: H },
  );
  const monsters = [
    { x: -50, y: -50, alive: true },
    { x: 50, y: 50, alive: false },
    { x: 0, y: 0, alive: true },
  ];
  h.render(renderer, { ...carAt(35, -20), track: sqTrack, entities: { monsters } });
  const sc = capturedScene;
  const mmCarDot = byName(sc, 'mmCar')[0];
  const bg = byName(sc, 'mmBg')[0];
  check('MINIMAP sweep: box top-right without score',
    approx(bg.position.x, X0) && approx(bg.position.y, Y0), `got (${bg.position.x},${bg.position.y})`);
  {
    const [ex, ey] = expect(35, -20);
    check('MINIMAP sweep: car dot at fit+flip position (<=1px)', near(mmCarDot, ex, ey),
      `got (${mmCarDot.position.x},${mmCarDot.position.y}) want (${ex},${ey})`);
  }
  const mmDots = byName(sc, 'mmDot');
  {
    const [ax, ay] = expect(-50, -50);
    const [cx2, cy2] = expect(0, 0);
    check('MINIMAP sweep: 2 of 3 dots visible at expected positions (one dead)',
      mmDots.length === 3 && mmDots[0].visible && !mmDots[1].visible && mmDots[2].visible &&
      near(mmDots[0], ax, ay) && near(mmDots[2], cx2, cy2),
      `dots vis=[${mmDots.map((d) => d.visible)}] p0=(${mmDots[0].position.x},${mmDots[0].position.y}) p2=(${mmDots[2].position.x},${mmDots[2].position.y})`);
  }
  // y-flip direction: +y in sim moves the dot *down* the screen (py < box center)
  h.render(renderer, { ...carAt(0, 40), track: sqTrack, entities: { monsters } });
  {
    const [, ey] = expect(0, 40);
    check('MINIMAP sweep: y-flip (+y sim -> below box center)',
      near(mmCarDot, X0 + BOX / 2, ey) && mmCarDot.position.y < Y0 + BOX / 2,
      `got py=${mmCarDot.position.y} want ${ey}`);
  }
  // far-outside car clamps to 1px inside the box edge
  h.render(renderer, { ...carAt(1000, -1000), track: sqTrack, entities: { monsters } });
  check('MINIMAP sweep: off-track car clamps to box edge',
    near(mmCarDot, X0 + BOX - 1, Y0 + BOX - 1),
    `got (${mmCarDot.position.x},${mmCarDot.position.y})`);
  // square ribbon stays inside the box
  {
    const a = byName(sc, 'mmTrack')[0].geometry.getAttribute('position');
    let okRibbon = a.count === 160;
    for (let i = 0; i < a.count && okRibbon; i++) {
      okRibbon = a.getX(i) >= X0 && a.getX(i) <= X0 + BOX && a.getY(i) >= Y0 && a.getY(i) <= Y0 + BOX;
    }
    check('MINIMAP sweep: square ribbon inside box', okRibbon);
  }
  // track identity change refills the ribbon (attribute version bump + tick move)
  {
    const attr = byName(sc, 'mmTrack')[0].geometry.getAttribute('position');
    const v0 = attr.version;
    h.render(renderer, { ...carAt(0, 0), track: sqTrack, entities: { monsters } });
    const sameOk = attr.version === v0;
    const rect = boxTrack(100, 25); // ext 200 -> k = 58/200; sample 0 = (-100,-25)
    h.render(renderer, { ...carAt(0, 0), track: rect, entities: { monsters } });
    const tick = byName(sc, 'mmTick')[0];
    const kr = (BOX - 12) / 200;
    const tickOk = near(tick, (X0 + BOX / 2) - 100 * kr, (Y0 + BOX / 2) + 25 * kr);
    check('MINIMAP sweep: ribbon refills only on track identity change',
      sameOk && attr.version === v0 + 1 && tickOk,
      `sameVersion=${sameOk} newVersion=${attr.version - v0} tick=(${tick.position.x},${tick.position.y})`);
  }
  h.dispose();

  // dot buffer caps at MM_MAX_DOTS=64 even when the spec asks for 80
  const hCap = createHud(
    makeSpec({
      hud: { elements: ['minimap'] },
      entities: { monsters: [{ type: 'chaser', count: 40 }, { type: 'patroller', count: 40 }] },
    }),
    { width: W, height: H },
  );
  const horde = [];
  for (let i = 0; i < 80; i++) horde.push({ x: (i % 20) * 5 - 50, y: ((i / 20) | 0) * 30 - 50, alive: true });
  hCap.render(renderer, { ...carAt(0, 0), track: sqTrack, entities: { monsters: horde } });
  const capDots = byName(capturedScene, 'mmDot');
  check('MINIMAP sweep: dot buffer caps at 64 (spec asks 80)',
    capDots.length === 64 && capDots.every((d) => d.visible),
    `got ${capDots.length} dots, ${capDots.filter((d) => d.visible).length} visible`);
  hCap.dispose();
});

// --- 16. RESOLUTION/SCALE sweep ---------------------------------------------------
sweep('RESOLUTION sweep', () => {
  const bad = [];
  for (const [W, H, S] of [[512, 288, 1], [512, 288, 1.5], [1024, 576, 1], [1024, 576, 1.5]]) {
    const h = createHud(
      makeSpec({
        hud: { elements: ALL, scale: S },
        weapon: { enabled: true, ammoMax: 24 },
        entities: { monsters: [{ type: 'chaser', count: 3 }] },
      }),
      { width: W, height: H },
    );
    h.render(renderer, {
      car: { x: 35, y: -20, u: 25, boost: 55 },
      health: 40,
      ammo: 7,
      score: 123456,
      lap: 3,
      track: boxTrack(50, 50),
      entities: {
        monsters: [
          { x: -50, y: -50, alive: true },
          { x: 50, y: 50, alive: false },
          { x: 0, y: 0, alive: true },
        ],
      },
    });
    const sc = capturedScene;
    sc.updateMatrixWorld(true);
    for (const m of meshes(sc)) {
      if (!m.visible) continue; // hidden digit slots / dead dots park anywhere
      const b = bboxOf(m);
      if (b.minX < -1e-6 || b.minY < -1e-6 || b.maxX > W + 1e-6 || b.maxY > H + 1e-6) {
        bad.push(`${W}x${H}@${S} ${m.name || 'mesh'} [${b.minX.toFixed(1)},${b.minY.toFixed(1)},${b.maxX.toFixed(1)},${b.maxY.toFixed(1)}]`);
      }
    }
    h.dispose();
  }
  check('RESOLUTION sweep: all visible bboxes inside viewport (2 sizes x 2 scales)',
    bad.length === 0, bad.slice(0, 8).join('; '));
});

// --- 17. RENDER STABILITY sweep -----------------------------------------------------
sweep('STABILITY sweep', () => {
  const h = createHud(
    makeSpec({
      hud: { elements: ALL, scale: 1 },
      weapon: { enabled: true, ammoMax: 24 },
      entities: { monsters: [{ type: 'chaser', count: 3 }] },
    }),
    { width: 512, height: 288 },
  );
  const trackA = boxTrack(50, 50);
  const trackB = boxTrack(100, 25);
  let seed = 0xC0FFEE;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const w = {
    car: { x: 0, y: 0, u: 0, boost: 0 },
    health: 100,
    ammo: 0,
    score: 0,
    lap: 0,
    track: trackA,
    entities: {
      monsters: [
        { x: 0, y: 0, alive: true },
        { x: 0, y: 0, alive: true },
        { x: 0, y: 0, alive: true },
      ],
    },
  };
  h.render(renderer, w);
  const sc = capturedScene;
  const nChildren = sc.children.length;
  const nMeshes = meshes(sc).length;
  const hasGC = typeof global.gc === 'function';
  if (hasGC) global.gc();
  const heap0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200; i++) {
    w.car.u = (rnd() - 0.5) * 140;
    w.car.boost = rnd() * 120 - 10;
    w.car.x = (rnd() - 0.5) * 400;
    w.car.y = (rnd() - 0.5) * 400;
    w.health = rnd() < 0.1 ? undefined : rnd() * 110 - 5;
    w.ammo = rnd() < 0.1 ? undefined : (rnd() * 30) | 0;
    w.score = (rnd() * 1200000) | 0;
    w.lap = (rnd() * 9) | 0;
    if (i % 37 === 36) w.track = w.track === trackA ? trackB : trackA; // exercises rebuild
    for (const m of w.entities.monsters) {
      m.x = (rnd() - 0.5) * 120;
      m.y = (rnd() - 0.5) * 120;
      m.alive = rnd() > 0.3;
    }
    h.render(renderer, w);
  }
  if (hasGC) global.gc();
  const heapGrowth = process.memoryUsage().heapUsed - heap0;
  check('STABILITY sweep: 200 seeded renders keep scene child/mesh count constant',
    capturedScene.children.length === nChildren && meshes(capturedScene).length === nMeshes,
    `children ${nChildren} -> ${capturedScene.children.length}, meshes ${nMeshes} -> ${meshes(capturedScene).length}`);
  if (hasGC) {
    check('STABILITY sweep: heap growth < 1.5MB across 200 renders (post-gc)',
      heapGrowth < 1.5 * 1024 * 1024, `grew ${heapGrowth} bytes`);
  } else {
    console.log('INFO STABILITY sweep: global.gc unavailable (rerun with node --expose-gc for the heap check); scene child count stands in');
  }
  check('STABILITY sweep: autoClear restored after burst', renderer.autoClear === true);
  h.dispose();
});

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
