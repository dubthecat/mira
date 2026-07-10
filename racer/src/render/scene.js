// Three.js view of a sim World. Pure function of the track data + car state,
// so the browser game and the headless recorder render identically.
//
// Sim plane (x, y) maps to world (x, z); sim heading theta maps to
// mesh.rotation.y = -theta (so car-local +X is forward, +Z is left).
//
// Visual design notes (they matter for the world model, not just looks):
// - every surface carries deterministic per-vertex color noise => optical flow
//   is visible everywhere, so the model can infer ego-motion from any view.
// - five uniquely colored towers ring the circuit as global landmarks =>
//   the model can re-localize after spins instead of hallucinating track.
// - brake lights / steered front wheels / boost flame make every action key
//   visually observable, tightening the action->pixels association.

import * as THREE from 'three';
import { makeSpec, BIOMES, WEAPON_KINDS } from '../spec/schema.js';

const CAM = { back: 7.4, height: 3.1, lookAhead: 7.0, lookUp: 1.15, posLag: 7.0, fovLag: 4.0 };

function hash01(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// biome base + the track's per-seed jitter (stored as absolute meadow-relative
// values in scenery.palette; converted to deltas here) => varied looks within
// one coherent biome
function resolvePalette(track, spec) {
  const b = BIOMES[spec.world.biome];
  // trackless modes have no per-seed scenery jitter; use the biome base
  const j = track ? track.scenery.palette : { grassHue: 0.31, grassLight: 0.37, skyHue: 0.58, asphaltLight: 0.2 };
  return {
    ...b,
    grassHue: b.grassHue + (j.grassHue - 0.31),
    grassLight: b.grassLight + (j.grassLight - 0.37),
    skyHue: b.skyHue + (j.skyHue - 0.58),
    asphaltLight: b.asphaltLight + (j.asphaltLight - 0.2),
  };
}

// Mode scene builders (non-circuit archetypes): each exports
// buildModeScene(scene, world, pal, shared) -> { update(world, dt),
// buildAvatar?(scene, spec) } — shared gives them the reusable pieces.
import { buildSoccerScene } from './modes/soccer.js';
import { buildShooterScene } from './modes/shooter.js';
import { buildAdventureScene } from './modes/adventure.js';

const MODE_SCENES = {
  soccer: buildSoccerScene,
  shooter: buildShooterScene,
  adventure: buildAdventureScene,
};

export function createView(world, { width, height }) {
  const spec = world.spec || makeSpec();
  const track = world.track || null;
  const pal = resolvePalette(track, spec);
  const scene = new THREE.Scene();

  const skyColor = new THREE.Color().setHSL(pal.skyHue, pal.skySat, pal.skyLight);
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, pal.fogNear, pal.fogFar);
  buildSkyDome(scene, pal, skyColor);

  const grass = new THREE.Color().setHSL(pal.grassHue, pal.grassSat, pal.grassLight);
  const hemiIntensity = 0.25 + 1.1 * pal.skyLight;
  scene.add(new THREE.HemisphereLight(0xd8e8ff, grass.clone().multiplyScalar(0.6), hemiIntensity));
  const sun = new THREE.DirectionalLight(0xffffff, pal.sunIntensity);
  sun.position.set(60, 100, 30);
  scene.add(sun);

  let padRig = { meshes: [], onMat: null, offMat: null };
  let modeScene = null;
  let carRig;
  if (world.mode && spec.archetype !== 'circuit') {
    const shared = { buildCar, buildEntities, updateEntities, hash01, grass };
    modeScene = MODE_SCENES[spec.archetype](scene, world, pal, shared);
    carRig = modeScene.buildAvatar
      ? modeScene.buildAvatar(scene, spec)
      : buildCar(scene, spec.vehicle.color, spec.vehicle.body);
  } else {
    buildGround(scene, track, grass);
    buildTrackSurface(scene, track, pal);
    buildWalls(scene, track, pal);
    buildStartGantry(scene, track);
    padRig = buildBoostPads(scene, track);
    buildScenery(scene, track, pal);
    carRig = buildCar(scene, spec.vehicle.color, spec.vehicle.body);
  }
  const entityRig = buildEntities(scene, spec, track);
  const particles = buildParticles(scene);
  let evCursor = 0; // world.events consumed so far (for event-driven bursts)

  // --- chase camera
  const camera = new THREE.PerspectiveCamera(62, width / height, 0.3, 600);
  const camState = { pos: new THREE.Vector3(), fov: 62, initialized: false };

  function update(world, dt) {
    const c = world.car;
    const keys = world.lastKeys || {};

    // car rig
    carRig.group.position.set(c.x, 0, c.y);
    carRig.group.rotation.y = -c.heading;
    carRig.body.rotation.x = THREE.MathUtils.clamp(-c.slip * 0.012, -0.09, 0.09);
    const spin = (c.u * dt) / 0.38;
    for (const w of carRig.wheels) w.rotation.z -= spin;
    for (const p of carRig.frontPivots) p.rotation.y = c.steer * 0.9;
    carRig.brakeMat.color.setHex(keys.S ? 0xff2020 : 0x5a0f0f);
    carRig.flame.visible = c.boosting;
    if (c.boosting) {
      const s = 1 + 0.25 * Math.sin(world.frame * 2.1);
      carRig.flame.scale.set(s, 1, 1);
    }
    // death blink only — non-fatal damage keeps the car visible (the white
    // paint flash below carries that feedback; a vanishing car would teach
    // the model that damage teleports the player)
    const blinking = (world.respawnSub || 0) > 0;
    carRig.group.visible = !blinking || world.frame % 6 < 3;

    // damage feedback: paint flashes white for the first ~3 frames of invuln
    const invulnMax = (world.spec?.rules.contactInvulnFrames || 0) * 3;
    const justHit = (world.invulnSub || 0) > invulnMax - 9 && (world.invulnSub || 0) > 0;
    carRig.paintMat.color.setHex(justHit ? 0xffffff : carRig.paintColor);

    // muzzle flash: visible for ~2 frames after each shot (fire cooldown is
    // reset to its max on Fired, so "near max" == "just fired")
    if (carRig.flashMesh) {
      const w = world.spec.weapon;
      const cdMax = w.enabled ? Math.round(60 / WEAPON_KINDS[w.kind].fireRate) : 0;
      carRig.flashMesh.visible = w.enabled && (world.fireCooldownSub || 0) > cdMax - 6;
      if (carRig.flashMesh.visible) {
        carRig.flashMesh.scale.setScalar(1 + 0.4 * ((world.frame + 1) % 2));
      }
    }

    updateEntities(entityRig, world);

    // --- particles: event bursts + state emitters (deterministic under the
    // recorder's fixed dt; purely cosmetic at play time)
    for (; evCursor < world.events.length; evCursor++) {
      const e = world.events[evCursor];
      if (e.name === 'MonsterKilled') {
        const m = world.entities.monsters[e.data.id];
        if (m) particles.burst(m.x, 1.2, m.y, 14, m.cfg.color, 9, 0.7);
      } else if (e.name === 'CarDamaged') {
        particles.burst(c.x, 1.0, c.y, 8, 0xff5533, 7, 0.45);
      } else if (e.name === 'Fired') {
        const fx2 = Math.cos(c.heading);
        const fy2 = Math.sin(c.heading);
        particles.burst(c.x + fx2 * 2.6, 1.1, c.y + fy2 * 2.6, 3, 0xd8d8cf, 2.5, 0.35);
      }
    }
    if (c.drifting && Math.abs(c.u) > 8 && world.frame % 2 === 0) {
      const bx = c.x - Math.cos(c.heading) * 1.6;
      const by = c.y - Math.sin(c.heading) * 1.6;
      particles.puff(bx, 0.3, by, 0x9a938a, 0.55);
    }
    if (c.boosting) {
      const bx = c.x - Math.cos(c.heading) * 2.8;
      const by = c.y - Math.sin(c.heading) * 2.8;
      particles.puff(bx, 0.55, by, 0xffa428, 0.3);
    }
    particles.update(dt);

    // boost pads dim while on cooldown (circuit only)
    for (let i = 0; i < padRig.meshes.length; i++) {
      const on = world.pads[i].cooldown <= 0;
      padRig.meshes[i].material = on ? padRig.onMat : padRig.offMat;
    }
    if (modeScene) modeScene.update(world, dt);

    // camera
    const fx = Math.cos(c.heading);
    const fy = Math.sin(c.heading);
    const tx = c.x - fx * CAM.back;
    const tz = c.y - fy * CAM.back;
    if (!camState.initialized) {
      camState.pos.set(tx, CAM.height, tz);
      camState.initialized = true;
    } else {
      const a = 1 - Math.exp(-CAM.posLag * dt);
      camState.pos.x += (tx - camState.pos.x) * a;
      camState.pos.y += (CAM.height - camState.pos.y) * a;
      camState.pos.z += (tz - camState.pos.z) * a;
    }
    camera.position.copy(camState.pos);
    camera.lookAt(c.x + fx * CAM.lookAhead, CAM.lookUp, c.y + fy * CAM.lookAhead);

    const fovT = 62 + 16 * Math.min(Math.abs(c.u) / 46, 1);
    camState.fov += (fovT - camState.fov) * (1 - Math.exp(-CAM.fovLag * dt));
    if (Math.abs(camState.fov - camera.fov) > 0.05) {
      camera.fov = camState.fov;
      camera.updateProjectionMatrix();
    }
  }

  function dispose() {
    const geos = new Set();
    const mats = new Set();
    scene.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
      }
    });
    // pad materials are swapped in update(), so the inactive one may not be
    // reachable by traversal
    if (padRig.onMat) mats.add(padRig.onMat);
    if (padRig.offMat) mats.add(padRig.offMat);
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
  }

  return { scene, camera, update, dispose };
}

// ---------------------------------------------------------------------------

// Gradient sky: inverted vertex-colored dome (zenith darker/deeper than the
// horizon, which melts into the fog color) + a sun disc billboard aligned
// with the directional light. Far richer horizon than a flat clear color.
function buildSkyDome(scene, pal, skyColor) {
  const geo = new THREE.SphereGeometry(520, 20, 12);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const zenith = new THREE.Color().setHSL(
    pal.skyHue,
    Math.min(1, pal.skySat * 1.15),
    Math.max(0.03, pal.skyLight * 0.62),
  );
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, pos.getY(i) / 520)); // 0 horizon, 1 zenith
    c.copy(skyColor).lerp(zenith, Math.pow(t, 0.8));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const dome = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  dome.renderOrder = -2;
  scene.add(dome);

  // sun disc along the light direction (60,100,30), pushed to the dome
  const sunDir = new THREE.Vector3(60, 100, 30).normalize();
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(26, 20),
    new THREE.MeshBasicMaterial({
      color: pal.sunIntensity < 0.6 ? 0xd9e6ff : 0xfff2c4, // moon at night
      fog: false,
      depthWrite: false,
      transparent: true,
      opacity: pal.sunIntensity < 0.6 ? 0.7 : 0.95,
    }),
  );
  disc.position.copy(sunDir.multiplyScalar(495));
  disc.lookAt(0, 0, 0);
  disc.renderOrder = -1;
  scene.add(disc);
}

// Pooled particle system: one THREE.Points draw call, fixed pool, ring-buffer
// spawning. Fade is faked by lerping particle color toward the fog color
// (PointsMaterial has no per-point alpha without custom shaders — and shaders
// are what we avoid under SwiftShader).
function buildParticles(scene, poolSize = 160) {
  const positions = new Float32Array(poolSize * 3);
  const colors = new Float32Array(poolSize * 3);
  const parts = [];
  for (let i = 0; i < poolSize; i++) {
    positions[i * 3 + 1] = -100; // parked underground
    parts.push({ vx: 0, vy: 0, vz: 0, life: 0, ttl: 1, r: 0, g: 0, b: 0 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ vertexColors: true, size: 0.6, sizeAttenuation: true, depthWrite: false }),
  );
  points.frustumCulled = false;
  scene.add(points);

  let cursor = 0;
  const tmp = new THREE.Color();
  const fog = new THREE.Color();

  function spawn(x, y, z, vx, vy, vz, ttl, color) {
    const i = cursor;
    cursor = (cursor + 1) % poolSize;
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    tmp.setHex(color);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
    const p = parts[i];
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.life = ttl;
    p.ttl = ttl;
    p.r = tmp.r;
    p.g = tmp.g;
    p.b = tmp.b;
  }

  return {
    // radial explosion at a sim point (y = height)
    burst(x, y, z, n, color, speed, ttl) {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const up = 2 + 3 * hash01(k * 17 + n);
        spawn(x, y, z, Math.cos(a) * speed, up, Math.sin(a) * speed, ttl * (0.6 + 0.4 * hash01(k + 3)), color);
      }
    },
    // single soft puff (dust/smoke)
    puff(x, y, z, color, ttl) {
      spawn(x, y, z, 0, 1.6, 0, ttl, color);
    },
    update(dt) {
      fog.copy(scene.fog ? scene.fog.color : tmp.setHex(0x000000));
      for (let i = 0; i < poolSize; i++) {
        const p = parts[i];
        if (p.life <= 0) continue;
        p.life -= dt;
        positions[i * 3] += p.vx * dt;
        positions[i * 3 + 1] += p.vy * dt;
        positions[i * 3 + 2] += p.vz * dt;
        p.vy -= 6 * dt; // light gravity
        if (p.life <= 0) {
          positions[i * 3 + 1] = -100;
          continue;
        }
        const f = Math.max(0, p.life / p.ttl); // 1 -> 0
        colors[i * 3] = fog.r + (p.r - fog.r) * f;
        colors[i * 3 + 1] = fog.g + (p.g - fog.g) * f;
        colors[i * 3 + 2] = fog.b + (p.b - fog.b) * f;
      }
      geo.getAttribute('position').needsUpdate = true;
      geo.getAttribute('color').needsUpdate = true;
    },
  };
}

function buildGround(scene, track, grass) {
  const b = track.bounds;
  const ext = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 1.6 + 200;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const geo = new THREE.PlaneGeometry(ext, ext, 56, 56);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    // deterministic mottling so grass shows motion parallax
    const n = 0.9 + 0.2 * hash01(i);
    c.copy(grass).multiplyScalar(n);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, -0.02, cy);
  scene.add(mesh);
}

function ribbonGeometry(track, latInner, latOuter, y, colorFn) {
  // builds a closed strip between two lateral offsets; offsets may be
  // functions of sample index (to track half-width variation)
  const N = track.n;
  const positions = new Float32Array(N * 2 * 3);
  const colors = new Float32Array(N * 2 * 3);
  const idx = [];
  for (let i = 0; i < N; i++) {
    const nx = -Math.sin(track.theta[i]);
    const ny = Math.cos(track.theta[i]);
    const li = typeof latInner === 'function' ? latInner(i) : latInner;
    const lo = typeof latOuter === 'function' ? latOuter(i) : latOuter;
    positions[i * 6 + 0] = track.xs[i] + nx * li;
    positions[i * 6 + 1] = y;
    positions[i * 6 + 2] = track.ys[i] + ny * li;
    positions[i * 6 + 3] = track.xs[i] + nx * lo;
    positions[i * 6 + 4] = y;
    positions[i * 6 + 5] = track.ys[i] + ny * lo;
    const col = colorFn(i);
    for (let k = 0; k < 2; k++) {
      colors[i * 6 + k * 3] = col.r;
      colors[i * 6 + k * 3 + 1] = col.g;
      colors[i * 6 + k * 3 + 2] = col.b;
    }
    const a = i * 2;
    const bIdx = ((i + 1) % N) * 2;
    // sim (x,y) -> world (x,z) mirrors handedness; the front-facing (+Y)
    // winding additionally depends on which lateral offset is greater
    if (li >= lo) idx.push(a, bIdx, a + 1, a + 1, bIdx, bIdx + 1);
    else idx.push(a, a + 1, bIdx, a + 1, bIdx + 1, bIdx);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(idx);
  const normals = new Float32Array(N * 2 * 3);
  for (let i = 0; i < N * 2; i++) normals[i * 3 + 1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geo;
}

function buildTrackSurface(scene, track, pal) {
  const asphalt = new THREE.Color().setHSL(0.62, 0.05, pal.asphaltLight);
  const cTmp = new THREE.Color();

  // main ribbon with subtle per-sample brightness noise
  const geo = ribbonGeometry(
    track,
    (i) => track.halfWidth[i],
    (i) => -track.halfWidth[i],
    0,
    (i) => cTmp.copy(asphalt).multiplyScalar(0.92 + 0.16 * hash01(i)),
  );
  scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));

  const white = new THREE.Color(0xe8e8ea);
  const edge = new THREE.Color(pal.edgeColor);
  const unlit = () => new THREE.MeshBasicMaterial({ vertexColors: true });

  // edge lines (emissive-looking accent color on night/lava biomes)
  for (const side of [1, -1]) {
    const g = ribbonGeometry(
      track,
      (i) => side * (track.halfWidth[i] - 0.35),
      (i) => side * (track.halfWidth[i] - 0.75),
      0.02,
      () => edge,
    );
    scene.add(new THREE.Mesh(g, unlit()));
  }

  // center dashes: 3 m on, 5 m off
  {
    const g = ribbonGeometry(track, 0.14, -0.14, 0.02, () => white);
    // hide "off" samples by collapsing them to the centerline
    const posAttr = g.getAttribute('position');
    for (let i = 0; i < track.n; i++) {
      if (i % 8 >= 3) {
        for (const k of [0, 3]) {
          posAttr.array[i * 6 + k] = track.xs[i];
          posAttr.array[i * 6 + k + 2] = track.ys[i];
        }
      }
    }
    scene.add(new THREE.Mesh(g, unlit()));
  }

  // kerbs on tight corners: red/white alternation
  const red = new THREE.Color(0xd8332a);
  for (const side of [1, -1]) {
    const g = ribbonGeometry(
      track,
      (i) => side * (Math.abs(track.kappa[i]) > 0.02 ? track.halfWidth[i] + 0.05 : track.halfWidth[i]),
      (i) => side * (Math.abs(track.kappa[i]) > 0.02 ? track.halfWidth[i] + 1.1 : track.halfWidth[i]),
      0.03,
      (i) => (Math.floor(i / 2) % 2 === 0 ? red : white),
    );
    scene.add(new THREE.Mesh(g, unlit()));
  }

  // start/finish checker band across the track at s=0
  {
    const N = track.n;
    const rows = 2;
    const black = new THREE.Color(0x151515);
    const group = new THREE.Group();
    for (let r = 0; r < rows; r++) {
      const i = (r + 1) % N;
      const hw = track.halfWidth[i];
      const cells = Math.floor((hw * 2) / 1.2);
      for (let cIdx = 0; cIdx < cells; cIdx++) {
        const lat0 = -hw + (cIdx * 2 * hw) / cells;
        const lat1 = -hw + ((cIdx + 1) * 2 * hw) / cells;
        const col = (cIdx + r) % 2 === 0 ? white : black;
        const nx = -Math.sin(track.theta[i]);
        const ny = Math.cos(track.theta[i]);
        const fx = Math.cos(track.theta[i]);
        const fy = Math.sin(track.theta[i]);
        const g = new THREE.PlaneGeometry(0.95, lat1 - lat0);
        g.rotateX(-Math.PI / 2);
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col }));
        const midLat = (lat0 + lat1) / 2;
        m.position.set(
          track.xs[i] + nx * midLat + fx * 0,
          0.04,
          track.ys[i] + ny * midLat + fy * 0,
        );
        m.rotation.y = -track.theta[i];
        group.add(m);
      }
    }
    scene.add(group);
  }
}

function buildWalls(scene, track, pal) {
  const N = track.n;
  const H = 1.15;
  // walls take the biome's cast so each game family has a distinct corridor
  const base = new THREE.Color().setHSL(pal.skyHue, 0.14, Math.max(0.22, pal.skyLight * 0.95));
  const tint = base.clone().offsetHSL(0.02, 0.06, -0.09);
  for (const side of [1, -1]) {
    const positions = new Float32Array(N * 2 * 3);
    const colors = new Float32Array(N * 2 * 3);
    const idx = [];
    for (let i = 0; i < N; i++) {
      const nx = -Math.sin(track.theta[i]);
      const ny = Math.cos(track.theta[i]);
      const lat = side * (track.halfWidth[i] + 0.5);
      const x = track.xs[i] + nx * lat;
      const z = track.ys[i] + ny * lat;
      positions[i * 6 + 0] = x;
      positions[i * 6 + 1] = 0;
      positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = x;
      positions[i * 6 + 4] = H;
      positions[i * 6 + 5] = z;
      const col = Math.floor(i / 4) % 2 === 0 ? base : tint;
      for (let k = 0; k < 2; k++) {
        colors[i * 6 + k * 3] = col.r;
        colors[i * 6 + k * 3 + 1] = col.g;
        colors[i * 6 + k * 3 + 2] = col.b;
      }
      const a = i * 2;
      const b = ((i + 1) % N) * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    scene.add(
      new THREE.Mesh(
        geo,
        new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      ),
    );
  }
}

function buildStartGantry(scene, track) {
  const i = 0;
  const hw = track.halfWidth[i] + 1.0;
  const nx = -Math.sin(track.theta[i]);
  const ny = Math.cos(track.theta[i]);
  const g = new THREE.Group();
  const pillarGeo = new THREE.BoxGeometry(0.7, 6.2, 0.7);
  const mat = new THREE.MeshLambertMaterial({ color: 0x2c3440 });
  for (const side of [1, -1]) {
    const p = new THREE.Mesh(pillarGeo, mat);
    p.position.set(track.xs[i] + nx * side * hw, 3.1, track.ys[i] + ny * side * hw);
    g.add(p);
  }
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 1.0, hw * 2),
    new THREE.MeshLambertMaterial({ color: 0xe23b3b }),
  );
  beam.position.set(track.xs[i], 6.0, track.ys[i]);
  beam.rotation.y = -track.theta[i];
  g.add(beam);
  scene.add(g);
}

function buildBoostPads(scene, track) {
  const onMat = new THREE.MeshBasicMaterial({ color: 0x18e0ff });
  const offMat = new THREE.MeshBasicMaterial({ color: 0x22505c });
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x0a7d94 });
  const meshes = [];
  const circGeo = new THREE.CircleGeometry(1.35, 20);
  circGeo.rotateX(-Math.PI / 2);
  const ringGeo = new THREE.RingGeometry(1.35, 1.75, 20);
  ringGeo.rotateX(-Math.PI / 2);
  for (const pad of track.pads) {
    const m = new THREE.Mesh(circGeo, onMat);
    m.position.set(pad.x, 0.05, pad.y);
    scene.add(m);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(pad.x, 0.045, pad.y);
    scene.add(ring);
    meshes.push(m);
  }
  return { meshes, onMat, offMat };
}

function buildScenery(scene, track, pal) {
  const density = pal.scatterDensity;
  const trees = track.scenery.trees.slice(0, Math.floor(track.scenery.trees.length * density));
  const rocks = track.scenery.rocks.slice(0, Math.floor(track.scenery.rocks.length * density));
  const { towers } = track.scenery;
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();

  if (trees.length > 0) {
    // biome flora: pine cones, cactus columns, or bare rock spires
    const kind = pal.treeKind;
    const canopyGeo =
      kind === 'cactus'
        ? new THREE.CylinderGeometry(0.55, 0.65, 3.4, 7)
        : kind === 'rockspire'
          ? new THREE.ConeGeometry(1.2, 5.2, 6)
          : new THREE.ConeGeometry(1.6, 3.6, 7);
    const canopyY = kind === 'cactus' ? 1.7 : kind === 'rockspire' ? 2.6 : 3.4;
    const hasTrunk = kind === 'pine';
    const colorAt = (t, c) => {
      if (kind === 'cactus') c.setHSL(0.33 + 0.06 * t.hue, 0.45, 0.3 + 0.1 * t.hue);
      else if (kind === 'rockspire') c.setHSL(0.02 + 0.04 * t.hue, 0.25, 0.18 + 0.14 * t.hue);
      else c.setHSL(0.29 + 0.1 * t.hue, 0.5, 0.28 + 0.12 * t.hue);
    };
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.36, 1.6, 5);
    const canopy = new THREE.InstancedMesh(
      canopyGeo,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      trees.length,
    );
    const trunk = hasTrunk
      ? new THREE.InstancedMesh(
          trunkGeo,
          new THREE.MeshLambertMaterial({ color: 0x6b4a2a }),
          trees.length,
        )
      : null;
    trees.forEach((t, i) => {
      tmp.position.set(t.x, canopyY * t.scale, t.y);
      tmp.rotation.set(0, t.rot, 0);
      tmp.scale.setScalar(t.scale);
      tmp.updateMatrix();
      canopy.setMatrixAt(i, tmp.matrix);
      colorAt(t, col);
      canopy.setColorAt(i, col);
      if (trunk) {
        tmp.position.set(t.x, 0.8 * t.scale, t.y);
        tmp.updateMatrix();
        trunk.setMatrixAt(i, tmp.matrix);
      }
    });
    canopy.instanceMatrix.needsUpdate = true;
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    scene.add(canopy);
    if (trunk) {
      trunk.instanceMatrix.needsUpdate = true;
      scene.add(trunk);
    }
  }

  if (rocks.length > 0) {
    const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);
    const rock = new THREE.InstancedMesh(
      rockGeo,
      new THREE.MeshLambertMaterial({ color: 0x8d8d93 }),
      rocks.length,
    );
    rocks.forEach((r, i) => {
      tmp.position.set(r.x, 0.45 * r.scale, r.y);
      tmp.rotation.set(r.rot, r.rot * 1.7, 0);
      tmp.scale.setScalar(r.scale);
      tmp.updateMatrix();
      rock.setMatrixAt(i, tmp.matrix);
    });
    rock.instanceMatrix.needsUpdate = true;
    scene.add(rock);
  }

  for (const t of towers) {
    const tower = new THREE.Mesh(
      new THREE.BoxGeometry(t.width, t.height, t.width),
      new THREE.MeshLambertMaterial({ color: t.color }),
    );
    tower.position.set(t.x, t.height / 2, t.y);
    scene.add(tower);
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(t.width * 0.42, 10, 8),
      new THREE.MeshBasicMaterial({ color: t.color }),
    );
    beacon.position.set(t.x, t.height + t.width * 0.42, t.y);
    scene.add(beacon);
  }
}

// Meshes for monsters/projectiles/pickups. Monster mesh order matches
// EntitySystem's spawn order (spec groups in sequence), so index == id.
function buildEntities(scene, spec, track) {
  const rig = { monsters: [], projectiles: [], pickups: [], projGeo: null };

  for (const group of spec.entities.monsters) {
    for (let i = 0; i < group.count; i++) {
      const g = new THREE.Group();
      const scale = group.scale || 1;
      let baseColor;
      if (group.type === 'chaser') {
        baseColor = group.color !== undefined ? group.color : 0x8a2be2;
        const mat = new THREE.MeshLambertMaterial({ color: baseColor });
        const body = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6 * scale, 0), mat);
        body.position.y = 1.1 * scale;
        g.add(body);
        const eye = new THREE.Mesh(
          new THREE.SphereGeometry(0.35 * scale, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xfff23d }),
        );
        eye.position.set(1.2 * scale, 1.4 * scale, 0);
        g.add(eye);
        rig.monsters.push({ group: g, mat, baseColor });
      } else if (group.type === 'patroller') {
        baseColor = group.color !== undefined ? group.color : 0x1fa34a;
        const mat = new THREE.MeshLambertMaterial({ color: baseColor });
        const body = new THREE.Mesh(new THREE.BoxGeometry(2.6 * scale, 1.4 * scale, 2.0 * scale), mat);
        body.position.y = 0.9 * scale;
        g.add(body);
        for (const z of [-0.5, 0.5]) {
          const eye = new THREE.Mesh(
            new THREE.SphereGeometry(0.22 * scale, 8, 6),
            new THREE.MeshBasicMaterial({ color: 0xffffff }),
          );
          eye.position.set(1.3 * scale, 1.2 * scale, z * scale);
          g.add(eye);
        }
        rig.monsters.push({ group: g, mat, baseColor });
      } else {
        // turret
        baseColor = group.color !== undefined ? group.color : 0xb8443c;
        // (turrets get their shadow below like everyone else)
        const mat = new THREE.MeshLambertMaterial({ color: baseColor });
        const base = new THREE.Mesh(new THREE.CylinderGeometry(1.7 * scale, 2.0 * scale, 1.5 * scale, 10), mat);
        base.position.y = 0.75 * scale;
        g.add(base);
        const barrel = new THREE.Mesh(
          new THREE.BoxGeometry(2.4 * scale, 0.4 * scale, 0.4 * scale),
          new THREE.MeshLambertMaterial({ color: 0x2b2b31 }),
        );
        barrel.position.set(1.0 * scale, 1.5 * scale, 0);
        g.add(barrel);
        rig.monsters.push({ group: g, mat, baseColor });
      }
      // grounding blob shadow (same trick as the car's)
      const shGeo = new THREE.CircleGeometry(1.7 * (group.scale || 1), 12);
      shGeo.rotateX(-Math.PI / 2);
      const sh = new THREE.Mesh(
        shGeo,
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
      );
      sh.position.y = 0.02;
      g.add(sh);
      scene.add(g);
    }
  }

  // projectile pool sized to the sim's worst case: each turret keeps at most
  // ceil(ttl/fireEvery)=2 shots alive; the player at most pellets*fireRate*ttl
  const turretShots = spec.entities.monsters
    .filter((g) => g.type === 'turret')
    .reduce((n, g) => n + g.count * 2, 0);
  const playerShots = spec.weapon.enabled ? (spec.weapon.kind === 'spread' ? 12 : 8) : 0;
  const poolSize = Math.min(256, Math.max(16, turretShots + playerShots + 8));
  rig.projGeo = new THREE.SphereGeometry(0.32, 8, 6);
  for (let i = 0; i < poolSize; i++) {
    const m = new THREE.Mesh(rig.projGeo, new THREE.MeshBasicMaterial({ color: 0x37e0ff }));
    m.visible = false;
    scene.add(m);
    rig.projectiles.push(m);
  }

  for (const group of spec.entities.pickups) {
    for (let i = 0; i < group.count; i++) {
      const g = new THREE.Group();
      if (group.kind === 'health') {
        const mat = new THREE.MeshBasicMaterial({ color: 0x2ee65f });
        const a = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.5), mat);
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 1.5), mat);
        a.position.y = b.position.y = 0.9;
        g.add(a, b);
      } else {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(0.9, 0.9, 0.9),
          new THREE.MeshBasicMaterial({ color: 0xffd11a }),
        );
        m.position.y = 0.9;
        g.add(m);
      }
      scene.add(g);
      rig.pickups.push(g);
    }
  }
  return rig;
}

function updateEntities(rig, world) {
  const ents = world.entities;
  if (!ents) return;

  for (let i = 0; i < rig.monsters.length && i < ents.monsters.length; i++) {
    const m = ents.monsters[i];
    const r = rig.monsters[i];
    r.group.visible = m.alive;
    if (!m.alive) continue;
    r.group.position.set(m.x, 0, m.y);
    r.group.rotation.y = -m.heading;
    if (m.type === 'chaser') {
      // deterministic bob keyed to the frame clock, plus a hover arc when
      // crossing the wall line so they float over the barrier, not through it
      const hover = Math.max(0, 1 - (m.wallGap ?? 99) / 2.2);
      r.group.position.y = 0.15 * Math.sin(world.frame * 0.35 + m.phase) + 1.5 * hover;
    }
    r.mat.color.setHex(m.hitFlash > 0 ? 0xffffff : r.baseColor);
  }

  let pi = 0;
  for (const p of ents.projectiles) {
    if (!p.alive || pi >= rig.projectiles.length) continue;
    const mesh = rig.projectiles[pi++];
    mesh.visible = true;
    mesh.position.set(p.x, 1.0, p.y);
    mesh.material.color.setHex(p.hostile ? 0xff5040 : 0x37e0ff);
  }
  for (; pi < rig.projectiles.length; pi++) rig.projectiles[pi].visible = false;

  for (let i = 0; i < rig.pickups.length && i < ents.pickups.length; i++) {
    const pk = ents.pickups[i];
    const g = rig.pickups[i];
    g.visible = pk.cooldown <= 0;
    g.position.set(pk.x, 0, pk.y);
    g.rotation.y = world.frame * 0.08;
  }
}

// Three body silhouettes (visual only — the collision footprint is shared):
// sport = low wedge + spoiler, muscle = tall wide slab + hood scoop,
// buggy = short cab + roll cage + oversized wheels.
const BODY_STYLES = {
  sport: {
    chassis: [4.0, 0.55, 1.85, 0.55],
    nose: [0.9, 0.35, 1.5, 0.45, 2.35],
    cabin: [1.7, 0.55, 1.35, 1.05, -0.25],
    spoiler: true,
    scoop: false,
    cage: false,
    wheelR: 0.38,
    wheelW: 0.32,
  },
  muscle: {
    chassis: [4.3, 0.85, 2.1, 0.7],
    nose: [1.0, 0.55, 1.9, 0.6, 2.5],
    cabin: [1.6, 0.6, 1.7, 1.35, -0.7],
    spoiler: false,
    scoop: true,
    cage: false,
    wheelR: 0.44,
    wheelW: 0.4,
  },
  buggy: {
    chassis: [3.3, 0.45, 1.6, 0.75],
    nose: [0.7, 0.3, 1.2, 0.65, 1.9],
    cabin: [1.3, 0.5, 1.2, 1.25, -0.1],
    spoiler: false,
    scoop: false,
    cage: true,
    wheelR: 0.52,
    wheelW: 0.42,
  },
};

function buildCar(scene, color = 0xff6a00, bodyStyle = 'sport') {
  const style = BODY_STYLES[bodyStyle] || BODY_STYLES.sport;
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const paint = new THREE.MeshLambertMaterial({ color });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1c1e24 });

  const [cl, ch, cw, cy] = style.chassis;
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(cl, ch, cw), paint);
  chassis.position.y = cy;
  body.add(chassis);

  const [nl, nh, nw, ny, nx] = style.nose;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(nl, nh, nw), paint);
  nose.position.set(nx, ny, 0);
  body.add(nose);

  const [bl, bh, bw, by, bx] = style.cabin;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(bl, bh, bw), dark);
  cabin.position.set(bx, by, 0);
  body.add(cabin);

  // two-tone racing stripe down the hood (darkened paint shade)
  const stripeColor = new THREE.Color(color).multiplyScalar(0.5).getHex();
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(cl * 0.92, 0.05, 0.5),
    new THREE.MeshLambertMaterial({ color: stripeColor }),
  );
  stripe.position.set(0, cy + ch / 2 + 0.035, 0);
  body.add(stripe);

  if (style.spoiler) {
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 2.0), dark);
    spoiler.position.set(-2.0, 1.15, 0);
    body.add(spoiler);
    for (const z of [-0.7, 0.7]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), dark);
      strut.position.set(-2.0, 0.9, z);
      body.add(strut);
    }
  }
  if (style.scoop) {
    const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.28, 0.7), dark);
    scoop.position.set(1.5, style.chassis[3] + style.chassis[1] / 2 + 0.12, 0);
    body.add(scoop);
  }
  if (style.cage) {
    const barMat = dark;
    for (const [x0, z0] of [
      [0.55, 0.6],
      [0.55, -0.6],
      [-0.75, 0.6],
      [-0.75, -0.6],
    ]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.1), barMat);
      bar.position.set(x0, 1.35, z0);
      body.add(bar);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 1.35), barMat);
    roof.position.set(-0.1, 1.85, 0);
    body.add(roof);
  }

  // brake lights (shared material toggled in update)
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x5a0f0f });
  for (const z of [-0.55, 0.55]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.5), brakeMat);
    light.position.set(-(cl / 2) - 0.06, 0.6, z);
    body.add(light);
  }

  // wheels: geometry pre-rotated so the axle is local Z; front pairs sit in
  // pivot groups that yaw with the steering angle
  const wheelGeo = new THREE.CylinderGeometry(style.wheelR, style.wheelR, style.wheelW, 12);
  wheelGeo.rotateX(Math.PI / 2);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111114 });
  const wheels = [];
  const frontPivots = [];
  for (const [wx, wz, front] of [
    [1.35, 0.95, true],
    [1.35, -0.95, true],
    [-1.35, 0.95, false],
    [-1.35, -0.95, false],
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(wx, style.wheelR, wz);
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    pivot.add(wheel);
    body.add(pivot);
    wheels.push(wheel);
    if (front) frontPivots.push(pivot);
  }

  // boost flame: cone pointing backwards out of the tail
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.32, 1.5, 8),
    new THREE.MeshBasicMaterial({ color: 0xffb31a }),
  );
  flame.rotation.z = Math.PI / 2; // cone +Y axis -> -X (backwards)
  flame.position.set(-(cl / 2) - 0.9, 0.55, 0);
  flame.visible = false;
  group.add(flame);

  // muzzle flash at the nose (weapon feedback; toggled from update())
  // sits high enough to peek over the body from the chase camera
  const flashMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xfff3a0 }),
  );
  flashMesh.position.set(cl / 2 + 0.75, 1.05, 0);
  flashMesh.visible = false;
  group.add(flashMesh);

  // fake blob shadow
  const shadowGeo = new THREE.CircleGeometry(2.3, 18);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadow = new THREE.Mesh(
    shadowGeo,
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }),
  );
  shadow.position.y = 0.015;
  group.add(shadow);

  scene.add(group);
  return { group, body, wheels, frontPivots, brakeMat, flame, flashMesh, paintMat: paint, paintColor: color };
}
