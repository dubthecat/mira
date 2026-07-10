// HUD overlay: a pure function of (spec, world) composited on top of the 3D
// frame. The HUD is baked into every recorded frame, so the world model must
// be able to learn it — every element reads a live engine variable and nothing
// else (no wall-clock, no interpolation state), keeping frames reproducible
// from (seed, spec, actions).
//
// Rendering: own Scene + OrthographicCamera(0..width, 0..height, y-up).
// render() leaves the color buffer alone (autoClear off), clears depth only,
// and draws the overlay. All text/icons come from ONE CanvasTexture atlas
// built at init; digit slots are pre-built plane meshes whose UVs are swapped
// per frame — render() performs no allocations.
//
// Layout constants are tuned for 512x288 dataset frames (chunky + legible at
// that resolution) and multiplied by spec.hud.scale.

import * as THREE from 'three';

const EMPTY = [];
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const NUM_CAP = [0, 9, 99, 999, 9999, 99999, 999999];

const SPEED_MAX_KMH = 180;
const HEALTH_SEGS = 10;
const LAP_PIPS = 5;
const MM_SAMPLES = 80; // minimap centerline downsample count
const MM_MAX_DOTS = 64;

// --- glyph atlas ------------------------------------------------------------

// 8x4 keeps every cell edge a dyadic rational (k/8, k/4) so the Float32 uv
// attribute holds them exactly — the test suite's UV decoder relies on that
const ATLAS_COLS = 8;
const ATLAS_ROWS = 4;
const CELL = 64;
const GLYPH_ORDER = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'L', 'x', 'kmh', 'heart', 'ammo',
  'gem', 'W', 'A', 'V', 'E',
];

// smallest signed representation of an angle, (-pi, pi]
function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function drawGlyph(ctx, name, x, y) {
  const cx = x + CELL / 2;
  const cy = y + CELL / 2;
  ctx.lineJoin = 'round';
  if (name === 'heart') {
    ctx.beginPath();
    ctx.moveTo(cx, cy + 20);
    ctx.bezierCurveTo(cx - 28, cy - 2, cx - 17, cy - 24, cx, cy - 9);
    ctx.bezierCurveTo(cx + 17, cy - 24, cx + 28, cy - 2, cx, cy + 20);
    ctx.closePath();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.fillStyle = '#ff3040';
    ctx.fill();
  } else if (name === 'ammo') {
    // bullet: round-nosed cartridge
    ctx.beginPath();
    ctx.moveTo(cx - 9, cy + 22);
    ctx.lineTo(cx - 9, cy - 4);
    ctx.quadraticCurveTo(cx - 9, cy - 22, cx, cy - 24);
    ctx.quadraticCurveTo(cx + 9, cy - 22, cx + 9, cy - 4);
    ctx.lineTo(cx + 9, cy + 22);
    ctx.closePath();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.fillStyle = '#ffd11a';
    ctx.fill();
  } else if (name === 'gem') {
    // relic gem: faceted diamond with a girdle line
    ctx.beginPath();
    ctx.moveTo(cx, cy - 24);
    ctx.lineTo(cx + 17, cy);
    ctx.lineTo(cx, cy + 24);
    ctx.lineTo(cx - 17, cy);
    ctx.closePath();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.fillStyle = '#3ae8c8';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 17, cy);
    ctx.lineTo(cx + 17, cy);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3;
    ctx.stroke();
  } else {
    const text = name === 'kmh' ? 'km/h' : name;
    ctx.font = name === 'kmh' ? 'bold 26px monospace' : 'bold 52px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = name === 'kmh' ? 6 : 9;
    ctx.strokeText(text, cx, cy);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, cx, cy);
  }
}

function buildAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * CELL;
  canvas.height = ATLAS_ROWS * CELL;
  const ctx = canvas.getContext('2d');
  const uv = new Map();
  for (let i = 0; i < GLYPH_ORDER.length; i++) {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;
    drawGlyph(ctx, GLYPH_ORDER[i], col * CELL, row * CELL);
    uv.set(GLYPH_ORDER[i], {
      u0: col / ATLAS_COLS,
      u1: (col + 1) / ATLAS_COLS,
      v0: 1 - (row + 1) / ATLAS_ROWS, // flipY texture: canvas top -> v=1
      v1: 1 - row / ATLAS_ROWS,
    });
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return { tex, uv };
}

// --- hud --------------------------------------------------------------------

export function createHud(spec, { width, height }) {
  const s = (spec.hud && spec.hud.scale) || 1;
  const elements = new Set((spec.hud && spec.hud.elements) || EMPTY);
  const healthMax = (spec.rules && spec.rules.healthMax) || 100;
  const ammoMax = (spec.weapon && spec.weapon.ammoMax) || 99;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, width, height, 0, -10, 10);

  const { tex: atlas, uv: atlasUV } = buildAtlas();
  const geometries = [];
  const materials = [];

  const mat = (opts) => {
    // transparent:true puts every HUD mesh in the transparent render list, so
    // renderOrder deterministically governs paint order (the opaque pass would
    // otherwise draw before, i.e. under, transparent backgrounds)
    const m = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, ...opts });
    materials.push(m);
    return m;
  };
  const glyphMat = mat({ map: atlas, transparent: true });
  const frameMat = mat({ color: 0x101318, transparent: true, opacity: 0.55 });
  const speedMat = mat({ color: 0xffb02e });
  const boostMat = mat({ color: 0x37e0ff });
  const healthOffMat = mat({ color: 0x38151a, transparent: true, opacity: 0.85 });
  const healthGreenMat = mat({ color: 0x2ee648 });
  const healthRedMat = mat({ color: 0xff2e2e });
  const pipOnMat = mat({ color: 0xffffff });
  const pipOffMat = mat({ color: 0x555a66, transparent: true, opacity: 0.7 });
  const mmBgMat = mat({ color: 0x000000, transparent: true, opacity: 0.42 });
  const whiteMat = mat({ color: 0xf2f2f6 });
  const redDotMat = mat({ color: 0xff3b30 });
  const tickMat = mat({ color: 0xffe14a });
  const matchUsMat = mat({ color: 0x1f4fa8, transparent: true, opacity: 0.8 }); // blue-tinted chip
  const matchThemMat = mat({ color: 0xa8681f, transparent: true, opacity: 0.8 }); // amber-tinted chip

  // shared unit quad with origin at its bottom-left corner: fills anchor left
  // (scale.x grows rightward), bars/frames position by corner
  const unitGeo = new THREE.PlaneGeometry(1, 1);
  unitGeo.translate(0.5, 0.5, 0);
  geometries.push(unitGeo);
  // centered unit quad for dots/ticks that rotate or sit on a point
  const centerGeo = new THREE.PlaneGeometry(1, 1);
  geometries.push(centerGeo);

  function quad(material, geo, x, y, w, h, order, name) {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, 0);
    m.scale.set(w, h, 1);
    m.renderOrder = order;
    m.frustumCulled = false;
    if (name) m.name = name;
    scene.add(m);
    return m;
  }

  // glyph slots own their geometry so per-slot UVs can be swapped in place
  function glyphSlot(x, y, w, h, name) {
    const g = new THREE.PlaneGeometry(1, 1);
    g.translate(0.5, 0.5, 0);
    geometries.push(g);
    const m = quad(glyphMat, g, x, y, w, h, 4, name);
    m.userData.glyph = null;
    return m;
  }

  function setGlyph(slot, name) {
    if (slot.userData.glyph === name) return;
    slot.userData.glyph = name;
    const r = atlasUV.get(name);
    const a = slot.geometry.getAttribute('uv');
    // PlaneGeometry vertex order: TL, TR, BL, BR
    a.setXY(0, r.u0, r.v1);
    a.setXY(1, r.u1, r.v1);
    a.setXY(2, r.u0, r.v0);
    a.setXY(3, r.u1, r.v0);
    a.needsUpdate = true;
  }

  // write an integer into fixed left-to-right digit slots; leading zeros are
  // hidden unless pad (score style). Clamped to what the slots can show.
  function setNumber(slots, value, pad) {
    let v = value > 0 ? Math.floor(value) : 0;
    const cap = NUM_CAP[slots.length];
    if (v > cap) v = cap;
    for (let i = slots.length - 1; i >= 0; i--) {
      const digit = v % 10;
      const show = pad || v > 0 || i === slots.length - 1;
      slots[i].visible = show;
      if (show) setGlyph(slots[i], DIGITS[digit]);
      v = (v / 10) | 0;
    }
  }

  // --- element construction (only those listed in spec.hud.elements) --------

  // bottom-left: speed bar (10,22) 120x10 + 3-digit km/h readout to its right;
  // boost bar (10,10) 120x8 beneath it
  let speed = null;
  if (elements.has('speed')) {
    const x = 10 * s;
    const y = (elements.has('boost') ? 22 : 10) * s;
    const w = 120 * s;
    const h = 10 * s;
    quad(frameMat, unitGeo, x - 2 * s, y - 2 * s, w + 4 * s, h + 4 * s, 1);
    const fill = quad(speedMat, unitGeo, x, y, 1, h, 2, 'speedFill');
    const dx = x + w + 8 * s;
    const dw = 16 * s;
    const slots = [
      glyphSlot(dx, y - 4 * s, dw, 22 * s),
      glyphSlot(dx + dw, y - 4 * s, dw, 22 * s),
      glyphSlot(dx + 2 * dw, y - 4 * s, dw, 22 * s),
    ];
    const label = glyphSlot(dx + 3 * dw + 2 * s, y - 3 * s, 30 * s, 20 * s);
    setGlyph(label, 'kmh');
    speed = { fill, slots, barW: w };
  }

  let boost = null;
  if (elements.has('boost')) {
    const x = 10 * s;
    const y = 10 * s;
    const w = 120 * s;
    const h = 8 * s;
    quad(frameMat, unitGeo, x - 2 * s, y - 2 * s, w + 4 * s, h + 4 * s, 1);
    boost = { fill: quad(boostMat, unitGeo, x, y, 1, h, 2, 'boostFill'), barW: w };
  }

  // top-left: heart icon + 10-segment health bar
  let health = null;
  if (elements.has('health')) {
    const y = height - 24 * s;
    const heart = glyphSlot(8 * s, y - 3 * s, 18 * s, 18 * s);
    setGlyph(heart, 'heart');
    const segW = 10 * s;
    const segH = 12 * s;
    const gap = 2 * s;
    const x0 = 30 * s;
    const fills = [];
    for (let i = 0; i < HEALTH_SEGS; i++) {
      const sx = x0 + i * (segW + gap);
      quad(healthOffMat, unitGeo, sx, y, segW, segH, 1);
      fills.push(quad(healthGreenMat, unitGeo, sx, y, segW, segH, 2));
    }
    health = { fills };
  }

  // bottom-right: bullet icon, 'x', 2-digit ammo count, right-aligned
  let ammo = null;
  if (elements.has('ammo')) {
    const dw = 18 * s;
    const x1 = width - 10 * s - 2 * dw;
    const slots = [glyphSlot(x1, 10 * s, dw, 26 * s), glyphSlot(x1 + dw, 10 * s, dw, 26 * s)];
    const x = glyphSlot(x1 - 13 * s, 13 * s, 13 * s, 18 * s);
    setGlyph(x, 'x');
    const icon = glyphSlot(x1 - 31 * s, 10 * s, 16 * s, 26 * s);
    setGlyph(icon, 'ammo');
    ammo = { slots };
  }

  // top-right: zero-padded 6-digit score
  let score = null;
  if (elements.has('score')) {
    const dw = 14 * s;
    const x0 = width - 10 * s - 6 * dw;
    const y = height - 28 * s;
    const slots = [];
    for (let i = 0; i < 6; i++) slots.push(glyphSlot(x0 + i * dw, y, dw, 20 * s));
    score = { slots };
  }

  // top-center rows stack downward (lap, match, objective, wave). Each mode's
  // spec uses one of these in practice, but combined specs must still lay out
  // without overlap; ctrTop is the top edge available to the next row.
  let ctrTop = height - 8 * s;

  // top-center: "L<n>" + lap pips beneath
  let lap = null;
  if (elements.has('lap')) {
    const dw = 14 * s;
    const y = ctrTop - 20 * s;
    const x0 = width / 2 - 1.5 * dw;
    const l = glyphSlot(x0, y, dw, 20 * s);
    setGlyph(l, 'L');
    const slots = [glyphSlot(x0 + dw, y, dw, 20 * s), glyphSlot(x0 + 2 * dw, y, dw, 20 * s)];
    const pips = [];
    const pw = 6 * s;
    const px0 = width / 2 - (LAP_PIPS * pw + (LAP_PIPS - 1) * 3 * s) / 2;
    for (let i = 0; i < LAP_PIPS; i++) {
      pips.push(quad(pipOffMat, unitGeo, px0 + i * (pw + 3 * s), ctrTop - 30 * s, pw, pw, 3));
    }
    lap = { slots, pips };
    ctrTop -= 34 * s; // glyph row (20) + pips (10) + gap (4)
  }

  // top-center: match scoreboard — blue "us" chip, dash, amber "them" chip,
  // two zero-padded digits per side (setNumber caps 2 slots at 99)
  let match = null;
  if (elements.has('match')) {
    const chipW = 36 * s;
    const chipH = 24 * s;
    const y0 = ctrTop - chipH;
    const dw = 14 * s;
    const usX = width / 2 - 8 * s - chipW;
    const themX = width / 2 + 8 * s;
    quad(matchUsMat, unitGeo, usX, y0, chipW, chipH, 1, 'matchUsChip');
    quad(matchThemMat, unitGeo, themX, y0, chipW, chipH, 1, 'matchThemChip');
    quad(whiteMat, unitGeo, width / 2 - 5 * s, y0 + chipH / 2 - 1.5 * s, 10 * s, 3 * s, 3, 'matchDash');
    const us = [glyphSlot(usX + 4 * s, y0 + 2 * s, dw, 20 * s), glyphSlot(usX + 4 * s + dw, y0 + 2 * s, dw, 20 * s)];
    const them = [glyphSlot(themX + 4 * s, y0 + 2 * s, dw, 20 * s), glyphSlot(themX + 4 * s + dw, y0 + 2 * s, dw, 20 * s)];
    match = { us, them };
    ctrTop = y0 - 4 * s;
  }

  // top-center: gem icon + "n/m" relic counter + a direction arrow that
  // rotates toward the objective target relative to the avatar's heading
  let objective = null;
  if (elements.has('objective')) {
    const dw = 14 * s;
    const y = ctrTop - 20 * s;
    const cx = width / 2;
    const icon = glyphSlot(cx - 44 * s, y, 16 * s, 20 * s, 'objGem');
    setGlyph(icon, 'gem');
    const n = [glyphSlot(cx - 26 * s, y, dw, 20 * s), glyphSlot(cx - 26 * s + dw, y, dw, 20 * s)];
    const slash = quad(whiteMat, centerGeo, cx + 2 * s, y + 10 * s, 3 * s, 18 * s, 3, 'objSlash');
    slash.rotation.z = -0.32;
    const m = [glyphSlot(cx + 8 * s, y, dw, 20 * s), glyphSlot(cx + 8 * s + dw, y, dw, 20 * s)];
    // arrow: a triangle mesh pointing +y (screen up) at rotation 0; update()
    // only rotates it — the atlas is never redrawn
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0.62, 0, -0.46, -0.5, 0, 0.46, -0.5, 0,
    ]), 3));
    geometries.push(tri);
    const arrow = new THREE.Mesh(tri, tickMat);
    arrow.position.set(cx + 46 * s, y + 10 * s, 0);
    arrow.scale.set(13 * s, 13 * s, 1);
    arrow.renderOrder = 5;
    arrow.frustumCulled = false;
    arrow.name = 'objArrow';
    scene.add(arrow);
    objective = { icon, n, slash, m, arrow };
    ctrTop = y - 4 * s;
  }

  // top-center: "WAVE n" badge (letter glyphs + 2 digits over a frame chip)
  let wave = null;
  if (elements.has('wave')) {
    const y = ctrTop - 20 * s;
    const lw = 13 * s;
    const dw = 14 * s;
    const x0 = width / 2 - 42 * s;
    const chip = quad(frameMat, unitGeo, x0 - 5 * s, y - 2 * s, 94 * s, 24 * s, 1, 'waveChip');
    const letters = [];
    const word = ['W', 'A', 'V', 'E'];
    for (let i = 0; i < word.length; i++) {
      const l = glyphSlot(x0 + i * lw, y, lw, 20 * s);
      setGlyph(l, word[i]);
      letters.push(l);
    }
    const slots = [
      glyphSlot(x0 + 4 * lw + 4 * s, y, dw, 20 * s),
      glyphSlot(x0 + 4 * lw + 4 * s + dw, y, dw, 20 * s),
    ];
    wave = { chip, letters, slots };
    ctrTop = y - 4 * s;
  }

  // minimap: ~70px box, top-right unless score claims that corner, then
  // top-left (dropped below the health bar when that is present too)
  let mm = null;
  if (elements.has('minimap')) {
    const box = 70 * s;
    const left = elements.has('score');
    const x0 = left ? 10 * s : width - box - 10 * s;
    const yTop = height - ((left && elements.has('health')) ? 38 : 10) * s;
    const y0 = yTop - box;
    quad(mmBgMat, unitGeo, x0, y0, box, box, 0, 'mmBg');

    // track centerline as a chunky closed ribbon (2 verts per sample);
    // positions are refilled whenever world.track changes identity
    const positions = new Float32Array(MM_SAMPLES * 2 * 3);
    const idx = [];
    for (let i = 0; i < MM_SAMPLES; i++) {
      const a = i * 2;
      const b = ((i + 1) % MM_SAMPLES) * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(idx);
    geometries.push(geo);
    const trackMesh = new THREE.Mesh(geo, whiteMat);
    trackMesh.renderOrder = 2;
    trackMesh.frustumCulled = false;
    trackMesh.name = 'mmTrack';
    scene.add(trackMesh);

    const tick = quad(tickMat, centerGeo, 0, 0, 2 * s, 9 * s, 3, 'mmTick');
    const car = quad(whiteMat, centerGeo, 0, 0, 5 * s, 5 * s, 5, 'mmCar');
    let nDots = 0;
    const monsterSpecs = (spec.entities && spec.entities.monsters) || EMPTY;
    for (const m of monsterSpecs) nDots += m.count || 0;
    nDots = Math.min(nDots, MM_MAX_DOTS);
    const dots = [];
    for (let i = 0; i < nDots; i++) {
      const d = quad(redDotMat, centerGeo, 0, 0, 4 * s, 4 * s, 3, 'mmDot');
      d.visible = false;
      dots.push(d);
    }
    mm = {
      box, x0, y0, pad: 6 * s, lineW: 0.9 * s,
      bcx: x0 + box / 2, bcy: y0 + box / 2,
      posAttr: geo.getAttribute('position'),
      trackRef: null, k: 1, cx: 0, cy: 0,
      tick, car, dots,
      // scratch buffers for rebuilds (init-time allocation only)
      u: new Float64Array(MM_SAMPLES),
      v: new Float64Array(MM_SAMPLES),
      sx: new Float64Array(MM_SAMPLES),
      sy: new Float64Array(MM_SAMPLES),
    };
  }

  // sim (x, y) -> minimap screen; v = -y mirrors the sim plane's y->z mapping
  // so the minimap matches a top-down view of the 3D world
  function mmSetDot(mesh, x, y) {
    let px = mm.bcx + (x - mm.cx) * mm.k;
    let py = mm.bcy + (-y - mm.cy) * mm.k;
    if (px < mm.x0 + s) px = mm.x0 + s;
    if (px > mm.x0 + mm.box - s) px = mm.x0 + mm.box - s;
    if (py < mm.y0 + s) py = mm.y0 + s;
    if (py > mm.y0 + mm.box - s) py = mm.y0 + mm.box - s;
    mesh.position.set(px, py, 0);
  }

  function rebuildMinimap(track) {
    mm.trackRef = track;
    const xs = track.xs;
    const ys = track.ys;
    const n = xs.length;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < MM_SAMPLES; i++) {
      const j = Math.floor((i * n) / MM_SAMPLES) % n;
      const u = xs[j];
      const v = -ys[j];
      mm.u[i] = u;
      mm.v[i] = v;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    mm.cx = (minU + maxU) / 2;
    mm.cy = (minV + maxV) / 2;
    const ext = Math.max(maxU - minU, maxV - minV, 1e-6);
    mm.k = (mm.box - 2 * mm.pad) / ext; // fit + center, aspect preserved

    for (let i = 0; i < MM_SAMPLES; i++) {
      mm.sx[i] = mm.bcx + (mm.u[i] - mm.cx) * mm.k;
      mm.sy[i] = mm.bcy + (mm.v[i] - mm.cy) * mm.k;
    }
    const a = mm.posAttr.array;
    for (let i = 0; i < MM_SAMPLES; i++) {
      const p = (i - 1 + MM_SAMPLES) % MM_SAMPLES;
      const q = (i + 1) % MM_SAMPLES;
      let tx = mm.sx[q] - mm.sx[p];
      let ty = mm.sy[q] - mm.sy[p];
      const len = Math.hypot(tx, ty) || 1;
      const nx = (-ty / len) * mm.lineW;
      const ny = (tx / len) * mm.lineW;
      a[i * 6 + 0] = mm.sx[i] + nx;
      a[i * 6 + 1] = mm.sy[i] + ny;
      a[i * 6 + 2] = 0;
      a[i * 6 + 3] = mm.sx[i] - nx;
      a[i * 6 + 4] = mm.sy[i] - ny;
      a[i * 6 + 5] = 0;
    }
    mm.posAttr.needsUpdate = true;

    // start-line tick at sample 0, laid across the track direction
    mm.tick.position.set(mm.sx[0], mm.sy[0], 0);
    mm.tick.rotation.z = Math.atan2(mm.sy[1] - mm.sy[0], mm.sx[1] - mm.sx[0]);
  }

  // --- per-frame update: mutate meshes only, never allocate -----------------

  function update(world) {
    const car = world.car;
    if (speed) {
      const kmh = Math.abs(car.u) * 3.6;
      let frac = kmh / SPEED_MAX_KMH;
      if (frac > 1) frac = 1;
      speed.fill.scale.x = Math.max(frac * speed.barW, 1e-4);
      setNumber(speed.slots, Math.round(kmh), false);
    }
    if (boost) {
      let frac = car.boost / 100;
      if (frac < 0) frac = 0;
      if (frac > 1) frac = 1;
      boost.fill.scale.x = Math.max(frac * boost.barW, 1e-4);
    }
    if (health) {
      let h = world.health === undefined ? healthMax : world.health;
      if (h < 0) h = 0;
      if (h > healthMax) h = healthMax;
      const frac = h / healthMax;
      const lit = frac <= 0 ? 0 : Math.max(1, Math.round(frac * HEALTH_SEGS));
      const fillMat = frac <= 0.3 ? healthRedMat : healthGreenMat;
      for (let i = 0; i < HEALTH_SEGS; i++) {
        health.fills[i].visible = i < lit;
        health.fills[i].material = fillMat;
      }
    }
    if (ammo) {
      let a = world.ammo === undefined ? 0 : world.ammo;
      if (a < 0) a = 0;
      if (a > ammoMax) a = ammoMax;
      setNumber(ammo.slots, a, false);
    }
    if (score) {
      setNumber(score.slots, world.score || 0, true);
    }
    if (lap) {
      const n = (world.lap || 0) + 1;
      setNumber(lap.slots, n, false);
      const lit = Math.min(n, LAP_PIPS);
      for (let i = 0; i < LAP_PIPS; i++) {
        lap.pips[i].material = i < lit ? pipOnMat : pipOffMat;
      }
    }
    if (match) {
      const ms = world.matchScore; // soccer mode; undefined reads as 0-0
      setNumber(match.us, ms ? ms.us : 0, true);
      setNumber(match.them, ms ? ms.them : 0, true);
    }
    if (objective) {
      const o = world.objective; // adventure mode; undefined hides the element
      const vis = o !== undefined && o !== null;
      objective.icon.visible = vis;
      objective.slash.visible = vis;
      objective.arrow.visible = vis;
      if (vis) {
        setNumber(objective.n, o.collected, false);
        setNumber(objective.m, o.total, false);
        // screen-space bearing to the target: 0 = dead ahead. The camera's up
        // is world +Y and sim y maps to 3D z, so a positive relative bearing
        // is screen-RIGHT — which is a NEGATIVE rotation of the up-pointing
        // triangle in the y-up ortho HUD.
        const a = wrapAngle(Math.atan2(o.targetY - car.y, o.targetX - car.x) - car.heading);
        objective.arrow.rotation.z = -a;
      } else {
        for (let i = 0; i < objective.n.length; i++) objective.n[i].visible = false;
        for (let i = 0; i < objective.m.length; i++) objective.m[i].visible = false;
      }
    }
    if (wave) {
      const n = world.wave; // shooter mode; wave 0 (pre-first-wave) stays hidden
      const vis = n !== undefined && n > 0;
      wave.chip.visible = vis;
      for (let i = 0; i < wave.letters.length; i++) wave.letters[i].visible = vis;
      if (vis) setNumber(wave.slots, n, false);
      else for (let i = 0; i < wave.slots.length; i++) wave.slots[i].visible = false;
    }
    if (mm) {
      const track = world.track;
      if (track && track.xs && track !== mm.trackRef) rebuildMinimap(track);
      if (mm.trackRef) {
        mmSetDot(mm.car, car.x, car.y);
        const monsters = (world.entities && world.entities.monsters) || EMPTY;
        for (let i = 0; i < mm.dots.length; i++) {
          const m = i < monsters.length ? monsters[i] : null;
          const vis = !!(m && m.alive !== false);
          mm.dots[i].visible = vis;
          if (vis) mmSetDot(mm.dots[i], m.x, m.y);
        }
      }
    }
  }

  function render(renderer, world) {
    update(world);
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth(); // overlay ignores 3D depth but never wipes color
    renderer.render(scene, camera);
    renderer.autoClear = prevAutoClear;
  }

  function dispose() {
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose(); // includes swapped-out bar/pip mats
    atlas.dispose();
  }

  return { render, dispose };
}
