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

const CAM = { back: 7.4, height: 3.1, lookAhead: 7.0, lookUp: 1.15, posLag: 7.0, fovLag: 4.0 };

function hash01(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function createView(track, { width, height }) {
  const pal = track.scenery.palette;
  const scene = new THREE.Scene();

  const skyColor = new THREE.Color().setHSL(pal.skyHue, 0.52, 0.74);
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 130, 400);

  const grass = new THREE.Color().setHSL(pal.grassHue, 0.45, pal.grassLight);
  scene.add(new THREE.HemisphereLight(0xd8e8ff, grass.clone().multiplyScalar(0.6), 1.05));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(60, 100, 30);
  scene.add(sun);

  buildGround(scene, track, grass);
  buildTrackSurface(scene, track, pal);
  buildWalls(scene, track);
  buildStartGantry(scene, track);
  const padRig = buildBoostPads(scene, track);
  buildScenery(scene, track);
  const carRig = buildCar(scene);

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

    // boost pads dim while on cooldown
    for (let i = 0; i < padRig.meshes.length; i++) {
      const on = world.pads[i].cooldown <= 0;
      padRig.meshes[i].material = on ? padRig.onMat : padRig.offMat;
    }

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
    mats.add(padRig.onMat);
    mats.add(padRig.offMat);
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
  }

  return { scene, camera, update, dispose };
}

// ---------------------------------------------------------------------------

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
  const unlit = () => new THREE.MeshBasicMaterial({ vertexColors: true });

  // edge lines
  for (const side of [1, -1]) {
    const g = ribbonGeometry(
      track,
      (i) => side * (track.halfWidth[i] - 0.35),
      (i) => side * (track.halfWidth[i] - 0.75),
      0.02,
      () => white,
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

function buildWalls(scene, track) {
  const N = track.n;
  const H = 1.15;
  const base = new THREE.Color(0xc9ccd4);
  const tint = new THREE.Color(0xaab6c9);
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

function buildScenery(scene, track) {
  const { trees, rocks, towers } = track.scenery;
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();

  if (trees.length > 0) {
    const canopyGeo = new THREE.ConeGeometry(1.6, 3.6, 7);
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.36, 1.6, 5);
    const canopy = new THREE.InstancedMesh(
      canopyGeo,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      trees.length,
    );
    const trunk = new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshLambertMaterial({ color: 0x6b4a2a }),
      trees.length,
    );
    trees.forEach((t, i) => {
      tmp.position.set(t.x, 1.6 * t.scale + 1.8 * t.scale, t.y);
      tmp.rotation.set(0, t.rot, 0);
      tmp.scale.setScalar(t.scale);
      tmp.updateMatrix();
      canopy.setMatrixAt(i, tmp.matrix);
      col.setHSL(0.29 + 0.1 * t.hue, 0.5, 0.28 + 0.12 * t.hue);
      canopy.setColorAt(i, col);
      tmp.position.set(t.x, 0.8 * t.scale, t.y);
      tmp.updateMatrix();
      trunk.setMatrixAt(i, tmp.matrix);
    });
    canopy.instanceMatrix.needsUpdate = true;
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    scene.add(canopy, trunk);
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

function buildCar(scene) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const paint = new THREE.MeshLambertMaterial({ color: 0xff6a00 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1c1e24 });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.55, 1.85), paint);
  chassis.position.y = 0.55;
  body.add(chassis);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 1.5), paint);
  nose.position.set(2.35, 0.45, 0);
  body.add(nose);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 1.35), dark);
  cabin.position.set(-0.25, 1.05, 0);
  body.add(cabin);

  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 2.0), dark);
  spoiler.position.set(-2.0, 1.15, 0);
  body.add(spoiler);
  for (const z of [-0.7, 0.7]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), dark);
    strut.position.set(-2.0, 0.9, z);
    body.add(strut);
  }

  // brake lights (shared material toggled in update)
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x5a0f0f });
  for (const z of [-0.55, 0.55]) {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.5), brakeMat);
    light.position.set(-2.06, 0.6, z);
    body.add(light);
  }

  // wheels: geometry pre-rotated so the axle is local Z; front pairs sit in
  // pivot groups that yaw with the steering angle
  const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.32, 12);
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
    pivot.position.set(wx, 0.38, wz);
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
  flame.position.set(-2.9, 0.55, 0);
  flame.visible = false;
  group.add(flame);

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
  return { group, body, wheels, frontPivots, brakeMat, flame };
}
