// Adventure mode scene: open terrain inside a cliff ring, POI structures
// (ruins / obelisks / camps), floating relic gems with sky beams, and distant
// mesas for horizon depth. Everything is a deterministic function of
// (seed, spec): geometry variation comes from hash01 over stable indices or
// from forks of world.rng taken at build time.
//
// Visual design notes (for the world model, not just looks):
// - relic beams are visible from across the map => the objective is always
//   an observable pixel target, and the CURRENT target's beam is brighter
//   and taller, so "which way should I go" is readable from any frame.
// - obelisk tips carry unique bright colors => global landmarks for
//   re-localization, like the circuit's towers.
// - the cliff ring is the visible physical boundary the sim enforces, so
//   bounces at the rim always co-occur with rock pixels.

import * as THREE from 'three';

const LANDMARK_COLORS = [0x37e0ff, 0xffd11a, 0xff5aa0, 0x7dff6a, 0xb37dff, 0xff8a3d];
const GEM_COLOR = 0xff5df2;

function hash01(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function buildAdventureScene(scene, world, pal, shared) {
  const field = world.space;
  const extent = field.extent;
  const grass = shared.grass;

  buildTerrain(scene, extent, grass);
  buildCliffRing(scene, extent, pal);
  buildMesas(scene, extent, pal);
  const campFires = buildPois(scene, field.pois);
  const relicRigs = buildRelics(scene, world.relics);
  buildFlora(scene, world, pal, extent, field);

  function update(world) {
    const frame = world.frame;
    const o = world.objective;

    for (let i = 0; i < relicRigs.length; i++) {
      const rig = relicRigs[i];
      const rl = world.relics[i];
      const isTarget = o.targetIdx === i && o.collected < o.total;
      rig.gem.visible = !rl.collected;
      rig.beam.visible = !rl.collected && !isTarget;
      rig.beamTarget.visible = !rl.collected && isTarget;
      if (!rl.collected) {
        // slow spin + bob keyed to the frame clock (deterministic replay)
        rig.gem.rotation.y = frame * 0.07 + i * 1.3;
        rig.gem.position.y = 2.1 + 0.4 * Math.sin(frame * 0.11 + i * 0.9);
      }
    }

    for (const fire of campFires) {
      const s =
        1 + 0.26 * Math.sin(frame * 0.9 + fire.phase) + 0.13 * Math.sin(frame * 1.63 + fire.phase * 2.2);
      fire.mesh.scale.setScalar(Math.max(0.5, s));
      fire.mat.color.setHSL(
        0.055 + 0.02 * Math.sin(frame * 1.7 + fire.phase),
        1.0,
        0.55 + 0.08 * Math.sin(frame * 0.9 + fire.phase),
      );
    }
  }

  return { update };
}

// ---------------------------------------------------------------------------

// Big ground disc: per-vertex color mottling everywhere (visible optical flow
// for ego-motion), flat inside the play field, rolling bumps outside the
// cliff ring so the far terrain isn't a billiard table.
function buildTerrain(scene, extent, grass) {
  const size = extent * 3.4;
  const geo = new THREE.PlaneGeometry(size, size, 80, 80);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    const outsideT = Math.min(1, Math.max(0, (r - extent * 1.05) / (extent * 0.45)));
    pos.setY(i, outsideT * (1.5 + 4.5 * hash01(i * 3 + 11)));
    const n = 0.88 + 0.24 * hash01(i);
    c.copy(grass).multiplyScalar(n * (1 - 0.25 * outsideT));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.computeVertexNormals();
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.position.y = -0.02;
  scene.add(mesh);
}

// Two staggered rows of tall dark rock cones just outside the boundary — the
// visual wall the sim's cliff-ring constraint corresponds to.
function buildCliffRing(scene, extent, pal) {
  const unitCone = new THREE.ConeGeometry(1, 1, 7);
  unitCone.translate(0, 0.5, 0); // base at y=0, apex at y=1
  const rows = [
    { n: Math.max(40, Math.round(extent * 0.22)), rad: extent + 7, rMin: 6, rMax: 10, hMin: 10, hMax: 20 },
    { n: Math.max(24, Math.round(extent * 0.14)), rad: extent + 18, rMin: 9, rMax: 14, hMin: 16, hMax: 30 },
  ];
  const total = rows[0].n + rows[1].n;
  const mesh = new THREE.InstancedMesh(unitCone, new THREE.MeshLambertMaterial({ color: 0xffffff }), total);
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();
  let idx = 0;
  rows.forEach((row, ri) => {
    for (let i = 0; i < row.n; i++) {
      const h = (k) => hash01(idx * 13.7 + k + ri * 991);
      const a = ((i + 0.5 * ri) / row.n) * Math.PI * 2 + (h(1) - 0.5) * 0.6 / row.n * Math.PI * 2;
      const rad = row.rad + (h(2) - 0.5) * 6;
      const rr = row.rMin + (row.rMax - row.rMin) * h(3);
      const hh = row.hMin + (row.hMax - row.hMin) * h(4);
      tmp.position.set(Math.cos(a) * rad, -0.5, Math.sin(a) * rad);
      tmp.rotation.set(0, h(5) * Math.PI, 0);
      tmp.scale.set(rr, hh, rr);
      tmp.updateMatrix();
      mesh.setMatrixAt(idx, tmp.matrix);
      // dark rock with a whisper of the biome's sky cast
      col.setHSL(0.05 + 0.05 * h(6) + pal.skyHue * 0.02, 0.16, 0.1 + 0.08 * h(7));
      mesh.setColorAt(idx, col);
      idx++;
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
}

// Distant mesas/hills outside the ring (unreachable): biome-tinted slabs and
// cones that give the horizon parallax depth.
function buildMesas(scene, extent, pal) {
  const nBox = 10;
  const nCone = 6;
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();

  const boxes = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    nBox,
  );
  for (let i = 0; i < nBox; i++) {
    const h = (k) => hash01(i * 71.3 + k);
    const a = (i / nBox) * Math.PI * 2 + h(1) * 0.5;
    const rad = extent * (1.35 + 0.3 * h(2));
    const w = 40 + 50 * h(3);
    const ht = 22 + 30 * h(4);
    tmp.position.set(Math.cos(a) * rad, ht / 2 - 1, Math.sin(a) * rad);
    tmp.rotation.set(0, h(5) * Math.PI, 0);
    tmp.scale.set(w, ht, 30 + 30 * h(6));
    tmp.updateMatrix();
    boxes.setMatrixAt(i, tmp.matrix);
    col.setHSL(pal.grassHue + 0.04 * h(7) - 0.02, Math.min(1, pal.grassSat * 0.6), 0.26 + 0.14 * h(8));
    boxes.setColorAt(i, col);
  }
  boxes.instanceMatrix.needsUpdate = true;
  if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
  scene.add(boxes);

  const unitCone = new THREE.ConeGeometry(1, 1, 8);
  unitCone.translate(0, 0.5, 0);
  const cones = new THREE.InstancedMesh(
    unitCone,
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    nCone,
  );
  for (let i = 0; i < nCone; i++) {
    const h = (k) => hash01(i * 37.9 + k + 500);
    const a = ((i + 0.5) / nCone) * Math.PI * 2 + h(1) * 0.6;
    const rad = extent * (1.4 + 0.25 * h(2));
    const rr = 26 + 26 * h(3);
    const ht = 30 + 26 * h(4);
    tmp.position.set(Math.cos(a) * rad, -1, Math.sin(a) * rad);
    tmp.rotation.set(0, 0, 0);
    tmp.scale.set(rr, ht, rr);
    tmp.updateMatrix();
    cones.setMatrixAt(i, tmp.matrix);
    col.setHSL(pal.grassHue + 0.05 * h(5), Math.min(1, pal.grassSat * 0.5), 0.3 + 0.12 * h(6));
    cones.setColorAt(i, col);
  }
  cones.instanceMatrix.needsUpdate = true;
  if (cones.instanceColor) cones.instanceColor.needsUpdate = true;
  scene.add(cones);
}

// POI structures, one per field.pois entry, by kind. All variation hashes off
// the POI index, so the same (seed, spec) always builds the same ruins.
function buildPois(scene, pois) {
  const campFires = [];
  const stoneMats = [
    new THREE.MeshLambertMaterial({ color: 0x958d7c }),
    new THREE.MeshLambertMaterial({ color: 0x847e72 }),
    new THREE.MeshLambertMaterial({ color: 0xa39a86 }),
  ];
  const obeliskMat = new THREE.MeshLambertMaterial({ color: 0x3c4250 });
  const tentMats = [
    new THREE.MeshLambertMaterial({ color: 0xc09a62 }),
    new THREE.MeshLambertMaterial({ color: 0xa8814f }),
  ];
  const pillarGeo = new THREE.BoxGeometry(1, 1, 1);
  const tentGeo = new THREE.ConeGeometry(1, 1, 6);
  tentGeo.translate(0, 0.5, 0);

  pois.forEach((poi, i) => {
    const h = (k) => hash01(i * 17.3 + k);
    const g = new THREE.Group();
    g.position.set(poi.x, 0, poi.y);

    if (poi.kind === 'ruin') {
      // broken pillar cluster: 3-5 tilted stumps of varying height
      const n = 3 + Math.floor(h(1) * 3);
      for (let k = 0; k < n; k++) {
        const hp = (j) => hash01(i * 17.3 + k * 7.7 + j + 40);
        const w = 0.55 + 0.35 * poi.size * 0.18 + 0.3 * hp(1);
        const ph = poi.size * (0.45 + 0.75 * hp(2));
        const m = new THREE.Mesh(pillarGeo, stoneMats[Math.floor(hp(3) * 3) % 3]);
        const a = (k / n) * Math.PI * 2 + hp(4);
        const rad = poi.size * 0.42;
        m.position.set(Math.cos(a) * rad, ph / 2, Math.sin(a) * rad);
        m.scale.set(w, ph, w);
        m.rotation.set((hp(5) - 0.5) * 0.5, hp(6) * Math.PI, (hp(7) - 0.5) * 0.5);
        g.add(m);
      }
    } else if (poi.kind === 'obelisk') {
      // tall thin monolith with a uniquely colored emissive tip: LANDMARK
      const H = 8 + poi.size * 1.4;
      const shaft = new THREE.Mesh(pillarGeo, obeliskMat);
      shaft.position.y = H / 2;
      shaft.scale.set(1.3, H, 1.3);
      shaft.rotation.y = h(2) * Math.PI;
      g.add(shaft);
      const tip = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.05, 0),
        new THREE.MeshBasicMaterial({ color: LANDMARK_COLORS[i % LANDMARK_COLORS.length] }),
      );
      tip.position.y = H + 0.9;
      g.add(tip);
    } else {
      // camp: tent cones around a flickering fire
      const n = 2 + (h(1) > 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const hp = (j) => hash01(i * 17.3 + k * 5.1 + j + 80);
        const tent = new THREE.Mesh(tentGeo, tentMats[k % 2]);
        const a = (k / n) * Math.PI * 2 + h(3);
        tent.position.set(Math.cos(a) * poi.size * 0.6, 0, Math.sin(a) * poi.size * 0.6);
        const tr = 2.0 + 0.8 * hp(1);
        tent.scale.set(tr, 3.0 + 1.0 * hp(2), tr);
        g.add(tent);
      }
      const fireMat = new THREE.MeshBasicMaterial({ color: 0xff7a26 });
      const fire = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 6), fireMat);
      fire.position.y = 0.85;
      g.add(fire);
      campFires.push({ mesh: fire, mat: fireMat, phase: i * 2.13 });
    }
    scene.add(g);
  });
  return campFires;
}

// Relics: a stone pedestal (stays forever — a "visited" marker), a floating
// emissive gem, and a soft vertical light beam readable from across the map.
// The current objective's beam mesh is a separate brighter/taller cylinder so
// no materials are swapped at runtime (dispose() stays trivially correct).
function buildRelics(scene, relics) {
  const rigs = [];
  const pedestalGeo = new THREE.CylinderGeometry(1.25, 1.6, 0.5, 8);
  const pedestalMat = new THREE.MeshLambertMaterial({ color: 0x7d7668 });
  const gemGeo = new THREE.OctahedronGeometry(0.95, 0);
  const gemMat = new THREE.MeshBasicMaterial({ color: GEM_COLOR });
  const beamGeo = new THREE.CylinderGeometry(0.6, 0.6, 44, 9, 1, true);
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xff8df5,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beamTargetGeo = new THREE.CylinderGeometry(1.0, 1.0, 62, 9, 1, true);
  const beamTargetMat = new THREE.MeshBasicMaterial({
    color: 0xffc2fa,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  for (const rl of relics) {
    const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
    pedestal.position.set(rl.x, 0.25, rl.y);
    scene.add(pedestal);

    const gem = new THREE.Mesh(gemGeo, gemMat);
    gem.position.set(rl.x, 2.1, rl.y);
    scene.add(gem);

    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(rl.x, 22.5, rl.y);
    scene.add(beam);

    const beamTarget = new THREE.Mesh(beamTargetGeo, beamTargetMat);
    beamTarget.position.set(rl.x, 31.5, rl.y);
    beamTarget.visible = false;
    scene.add(beamTarget);

    rigs.push({ gem, beam, beamTarget });
  }
  return rigs;
}

// Scattered low flora (biome shrubs): purely decorative and deliberately
// short — the sim doesn't collide with them, so they must read as brush the
// car can plow through, not solid trees. Seeded from a world.rng fork taken
// at build time (fork() doesn't advance the parent stream, so sim playback
// is untouched).
function buildFlora(scene, world, pal, extent, field) {
  const rng = world.rng.fork('adv-flora');
  const count = Math.floor(40 * pal.scatterDensity);
  const kind = pal.treeKind;
  const spots = [];
  for (let tries = 0; tries < count * 5 && spots.length < count; tries++) {
    const a = rng.range(0, Math.PI * 2);
    const r = extent * (0.06 + 0.9 * Math.sqrt(rng.next()));
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (Math.hypot(x, y) < 16) continue; // spawn area stays clear
    let ok = true;
    for (const poi of field.pois) {
      if (Math.hypot(x - poi.x, y - poi.y) < poi.size * 0.6 + 6) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (const rl of world.relics) {
      if (Math.hypot(x - rl.x, y - rl.y) < 8) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    spots.push({ x, y, s: rng.range(0.7, 1.4), hue: rng.next(), rot: rng.range(0, Math.PI * 2) });
  }
  if (spots.length === 0) return;

  const geo =
    kind === 'cactus'
      ? new THREE.CylinderGeometry(0.35, 0.42, 1.6, 6)
      : kind === 'rockspire'
        ? new THREE.ConeGeometry(0.8, 1.8, 5)
        : new THREE.ConeGeometry(0.9, 1.6, 6);
  const baseY = kind === 'cactus' ? 0.8 : 0.85;
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), spots.length);
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();
  spots.forEach((t, i) => {
    tmp.position.set(t.x, baseY * t.s, t.y);
    tmp.rotation.set(0, t.rot, 0);
    tmp.scale.setScalar(t.s);
    tmp.updateMatrix();
    mesh.setMatrixAt(i, tmp.matrix);
    if (kind === 'cactus') col.setHSL(0.33 + 0.06 * t.hue, 0.45, 0.3 + 0.1 * t.hue);
    else if (kind === 'rockspire') col.setHSL(0.02 + 0.04 * t.hue, 0.25, 0.18 + 0.14 * t.hue);
    else col.setHSL(0.29 + 0.1 * t.hue, 0.5, 0.28 + 0.12 * t.hue);
    mesh.setColorAt(i, col);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
}
