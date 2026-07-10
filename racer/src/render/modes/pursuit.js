// Pursuit mode scene: open terrain inside a cliff ring with POI cover
// structures and distant mesas (compact, pursuit-owned builders — the
// adventure scene is a sibling, not an import), plus the hunters: muscle-body
// cars in black-and-white livery with a rotating red roof beacon. Wrecked
// hunters tilt ~15 degrees and dim until their rim respawn; on the night
// biome every hunter carries two small emissive headlight quads.
//
// Visual design notes (for the world model, not just looks):
// - the beacon is a rotating emissive box keyed to world.frame => a hunter is
//   identifiable (and its threat state readable) from any distance/angle.
// - obelisk tips carry unique bright colors => global landmarks for
//   re-localization on an otherwise open field.
// - the cliff ring is the visible boundary the sim enforces, so rim bounces
//   always co-occur with rock pixels.

import * as THREE from 'three';

const LANDMARK_COLORS = [0x37e0ff, 0xffd11a, 0xff5aa0, 0x7dff6a, 0xb37dff, 0xff8a3d];
const HUNTER_PAINT = 0xf2f2f4; // white base of the black-and-white livery
const HUNTER_DIM = 0x4a4a4e; // wreck paint

function hash01(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function buildPursuitScene(scene, world, pal, shared) {
  const field = world.space;
  const extent = field.extent;
  const grass = shared.grass;

  buildTerrain(scene, extent, grass);
  buildCliffRing(scene, extent, pal);
  buildMesas(scene, extent, pal);
  buildPois(scene, field.pois);

  const night = world.spec.world.biome === 'night';
  const hunterRigs = world.mode.hunters.map(() => buildHunterRig(scene, shared, night));

  function update(world, dt) {
    const frame = world.frame;
    for (let i = 0; i < hunterRigs.length; i++) {
      const rig = hunterRigs[i];
      const h = world.mode.hunters[i];
      const c = h.car;
      const wrecked = h.wreckedUntil >= 0;

      rig.car.group.position.set(c.x, 0, c.y);
      rig.car.group.rotation.y = -c.heading;
      // wreck posture: ~15 degree nose-up tilt, dimmed paint, beacon dark
      rig.car.body.rotation.z = wrecked ? 0.26 : 0;
      rig.car.body.rotation.x = wrecked
        ? 0.08
        : THREE.MathUtils.clamp(-c.slip * 0.012, -0.09, 0.09);
      rig.car.paintMat.color.setHex(wrecked ? HUNTER_DIM : HUNTER_PAINT);

      // beacon: rotating emissive box with a deterministic two-tone strobe
      rig.beacon.visible = !wrecked;
      if (!wrecked) {
        rig.beacon.rotation.y = frame * 0.45 + i * 1.7;
        rig.beaconMat.color.setHex(frame % 6 < 3 ? 0xff2626 : 0x8d1010);
      }
      for (const q of rig.lights) q.visible = !wrecked;

      // mirror the main rig's action feedback (wheels/steer/brake/boost)
      const spin = (c.u * dt) / 0.38;
      for (const w of rig.car.wheels) w.rotation.z -= spin;
      for (const p of rig.car.frontPivots) p.rotation.y = c.steer * 0.9;
      rig.car.brakeMat.color.setHex(h.keys && h.keys.S ? 0xff2020 : 0x5a0f0f);
      rig.car.flame.visible = c.boosting;
      if (c.boosting) {
        const s = 1 + 0.25 * Math.sin(frame * 2.1 + i * 1.7);
        rig.car.flame.scale.set(s, 1, 1);
      }
    }
  }

  return { update };
}

// ---------------------------------------------------------------------------

// A hunter: the shared muscle silhouette in white, wrapped with black livery
// panels, a roof beacon, and (at night) two emissive headlight quads.
function buildHunterRig(scene, shared, night) {
  const car = shared.buildCar(scene, HUNTER_PAINT, 'muscle');
  const black = new THREE.MeshLambertMaterial({ color: 0x141519 });

  // black-and-white livery: hood band + tail band across the white chassis
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.92, 2.16), black);
  hood.position.set(1.0, 0.7, 0);
  car.body.add(hood);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.92, 2.16), black);
  tail.position.set(-1.7, 0.7, 0);
  car.body.add(tail);

  // rotating red beacon on the cabin roof (muscle cabin top ~1.65)
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2626 });
  const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.26, 0.26), beaconMat);
  beacon.position.set(-0.7, 1.82, 0);
  car.body.add(beacon);

  // headlight quads (night only): small emissive planes on the nose face
  const lights = [];
  if (night) {
    const lm = new THREE.MeshBasicMaterial({ color: 0xfff2b8 });
    for (const z of [-0.62, 0.62]) {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.22), lm);
      q.position.set(3.02, 0.62, z);
      q.rotation.y = Math.PI / 2; // face forward (+x)
      car.body.add(q);
      lights.push(q);
    }
  }
  return { car, beacon, beaconMat, lights };
}

// Ground disc: per-vertex mottling everywhere (optical flow), flat inside the
// field, rolling bumps outside the cliff ring.
function buildTerrain(scene, extent, grass) {
  const size = extent * 3.2;
  const geo = new THREE.PlaneGeometry(size, size, 72, 72);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    const outsideT = Math.min(1, Math.max(0, (r - extent * 1.05) / (extent * 0.45)));
    pos.setY(i, outsideT * (1.5 + 4.5 * hash01(i * 3 + 11)));
    c.copy(grass).multiplyScalar((0.88 + 0.24 * hash01(i)) * (1 - 0.25 * outsideT));
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

// Ring of tall dark rock cones just outside the boundary — the visible wall
// the sim's rim constraint corresponds to.
function buildCliffRing(scene, extent, pal) {
  const unitCone = new THREE.ConeGeometry(1, 1, 7);
  unitCone.translate(0, 0.5, 0); // base at y=0
  const n = Math.max(44, Math.round(extent * 0.24));
  const mesh = new THREE.InstancedMesh(unitCone, new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const h = (k) => hash01(i * 13.7 + k);
    const a = ((i + (h(1) - 0.5) * 0.6) / n) * Math.PI * 2;
    const rad = extent + 8 + (h(2) - 0.5) * 6;
    const rr = 6 + 6 * h(3);
    const hh = 11 + 14 * h(4);
    tmp.position.set(Math.cos(a) * rad, -0.5, Math.sin(a) * rad);
    tmp.rotation.set(0, h(5) * Math.PI, 0);
    tmp.scale.set(rr, hh, rr);
    tmp.updateMatrix();
    mesh.setMatrixAt(i, tmp.matrix);
    col.setHSL(0.05 + 0.05 * h(6) + pal.skyHue * 0.02, 0.16, 0.1 + 0.08 * h(7));
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
}

// Distant biome-tinted mesas outside the ring: horizon parallax depth.
function buildMesas(scene, extent, pal) {
  const n = 9;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    n,
  );
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const h = (k) => hash01(i * 71.3 + k);
    const a = (i / n) * Math.PI * 2 + h(1) * 0.5;
    const rad = extent * (1.35 + 0.3 * h(2));
    const ht = 20 + 28 * h(4);
    tmp.position.set(Math.cos(a) * rad, ht / 2 - 1, Math.sin(a) * rad);
    tmp.rotation.set(0, h(5) * Math.PI, 0);
    tmp.scale.set(38 + 46 * h(3), ht, 28 + 30 * h(6));
    tmp.updateMatrix();
    mesh.setMatrixAt(i, tmp.matrix);
    col.setHSL(pal.grassHue + 0.04 * h(7) - 0.02, Math.min(1, pal.grassSat * 0.6), 0.26 + 0.14 * h(8));
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
}

// POI cover structures, one per field.pois entry, by kind. All variation
// hashes off the POI index — same (seed, spec), same rocks.
function buildPois(scene, pois) {
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
      const n = 3 + Math.floor(h(1) * 3);
      for (let k = 0; k < n; k++) {
        const hp = (j) => hash01(i * 17.3 + k * 7.7 + j + 40);
        const w = 0.55 + 0.35 * poi.size * 0.18 + 0.3 * hp(1);
        const ph = poi.size * (0.45 + 0.75 * hp(2));
        const m = new THREE.Mesh(pillarGeo, stoneMats[Math.floor(hp(3) * 3) % 3]);
        const a = (k / n) * Math.PI * 2 + hp(4);
        m.position.set(Math.cos(a) * poi.size * 0.42, ph / 2, Math.sin(a) * poi.size * 0.42);
        m.scale.set(w, ph, w);
        m.rotation.set((hp(5) - 0.5) * 0.5, hp(6) * Math.PI, (hp(7) - 0.5) * 0.5);
        g.add(m);
      }
    } else if (poi.kind === 'obelisk') {
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
      // camp: tents around an emissive fire (static — the chase never lingers)
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
      const fire = new THREE.Mesh(
        new THREE.SphereGeometry(0.75, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff7a26 }),
      );
      fire.position.y = 0.85;
      g.add(fire);
    }
    scene.add(g);
  });
}
