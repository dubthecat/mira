// Shooter mode scene: a walled pillar arena and a low-poly runner avatar.
// Same design rules as the circuit scene — deterministic per-vertex noise for
// optical flow everywhere, unique emissive corner braziers as landmarks so
// the world model can re-localize, and every action key visually observable
// (leg swing for W/S, brake panel for S, sprint flame for LShift, muzzle
// flash for F).

import * as THREE from 'three';

const WALL_H = 2.4;
const BRAZIER_COLORS = [0xff6a3d, 0x3dc8ff, 0xffd23d, 0xc86aff];

// closed loop of points along a rounded-rect perimeter (sim x/y plane)
function roundedRectLoop(halfW, halfH, r, perEdge = 10, perArc = 7) {
  const pts = [];
  const cw = halfW - r;
  const ch = halfH - r;
  const edge = (x0, y0, x1, y1) => {
    for (let i = 0; i < perEdge; i++) {
      const t = i / perEdge;
      pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
    }
  };
  const arc = (cx, cy, a0) => {
    for (let i = 0; i < perArc; i++) {
      const a = a0 + (i / perArc) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  };
  edge(-cw, -halfH, cw, -halfH);
  arc(cw, -ch, -Math.PI / 2);
  edge(halfW, -ch, halfW, ch);
  arc(cw, ch, 0);
  edge(cw, halfH, -cw, halfH);
  arc(-cw, ch, Math.PI / 2);
  edge(-halfW, ch, -halfW, -ch);
  arc(-cw, -ch, Math.PI);
  return pts;
}

export function buildShooterScene(scene, world, pal, shared) {
  const { hash01, grass } = shared;
  const space = world.space;
  const { halfW, halfH, cornerR } = space;

  // --- surrounding ground: mottled grass plane (motion parallax outside)
  {
    const ext = Math.max(halfW, halfH) * 2 * 1.6 + 200;
    const geo = new THREE.PlaneGeometry(ext, ext, 48, 48);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.copy(grass).multiplyScalar(0.9 + 0.2 * hash01(i));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.position.y = -0.05;
    scene.add(mesh);
  }

  // --- arena floor: stone slab with dense per-vertex noise (optical flow —
  // a ShapeGeometry has no interior tessellation, so use a segmented plane;
  // the square corners poking past the rounded wall hide behind it/fog)
  {
    const geo = new THREE.PlaneGeometry((halfW + 1) * 2, (halfH + 1) * 2, 44, 44);
    geo.rotateX(-Math.PI / 2);
    const stone = new THREE.Color().setHSL(0.08, 0.1, pal.asphaltLight + 0.08);
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.copy(stone).multiplyScalar(0.82 + 0.36 * hash01(i + 900));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));
  }

  // --- wall ring, biome-tinted with alternating panels (like circuit walls)
  const loop = roundedRectLoop(halfW, halfH, cornerR);
  {
    const N = loop.length;
    const base = new THREE.Color().setHSL(pal.skyHue, 0.14, Math.max(0.22, pal.skyLight * 0.95));
    const tint = base.clone().offsetHSL(0.02, 0.06, -0.09);
    const positions = new Float32Array(N * 2 * 3);
    const colors = new Float32Array(N * 2 * 3);
    const idx = [];
    for (let i = 0; i < N; i++) {
      const p = loop[i];
      positions[i * 6 + 0] = p.x;
      positions[i * 6 + 1] = 0;
      positions[i * 6 + 2] = p.y;
      positions[i * 6 + 3] = p.x;
      positions[i * 6 + 4] = WALL_H;
      positions[i * 6 + 5] = p.y;
      const col = Math.floor(i / 3) % 2 === 0 ? base : tint;
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

    // top accent strip in the biome edge color (emissive look on night/lava)
    const strip = new Float32Array(N * 2 * 3);
    for (let i = 0; i < N; i++) {
      const p = loop[i];
      const inx = -p.x / Math.max(Math.hypot(p.x, p.y), 1e-6);
      const iny = -p.y / Math.max(Math.hypot(p.x, p.y), 1e-6);
      strip[i * 6 + 0] = p.x;
      strip[i * 6 + 1] = WALL_H;
      strip[i * 6 + 2] = p.y;
      strip[i * 6 + 3] = p.x + inx * 0.5;
      strip[i * 6 + 4] = WALL_H;
      strip[i * 6 + 5] = p.y + iny * 0.5;
    }
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(strip, 3));
    sGeo.setIndex(idx.slice());
    scene.add(
      new THREE.Mesh(
        sGeo,
        new THREE.MeshBasicMaterial({ color: pal.edgeColor, side: THREE.DoubleSide }),
      ),
    );
  }

  // --- pillars from the space's obstacles: tapered cylinder + top ring
  space.obstacles.forEach((o, i) => {
    const c = new THREE.Color().setHSL(0.07 + 0.04 * hash01(i + 40), 0.18, 0.3 + 0.12 * hash01(i + 47));
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(o.radius * 0.8, o.radius, o.height, 10),
      new THREE.MeshLambertMaterial({ color: c }),
    );
    body.position.set(o.x, o.height / 2, o.y);
    scene.add(body);
    const ringGeo = new THREE.TorusGeometry(o.radius * 0.82, 0.13, 6, 14);
    ringGeo.rotateX(Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: pal.edgeColor }));
    ring.position.set(o.x, o.height + 0.02, o.y);
    scene.add(ring);
  });

  // --- corner braziers: unique emissive colors => global landmarks
  const flames = [];
  [
    [halfW - 7, halfH - 7],
    [-(halfW - 7), halfH - 7],
    [-(halfW - 7), -(halfH - 7)],
    [halfW - 7, -(halfH - 7)],
  ].forEach(([x, y], i) => {
    const g = new THREE.Group();
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 2.4, 1.1),
      new THREE.MeshLambertMaterial({ color: 0x2c3038 }),
    );
    post.position.y = 1.2;
    g.add(post);
    const bowl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 0.6, 0.5, 8),
      new THREE.MeshLambertMaterial({ color: 0x43474f }),
    );
    bowl.position.y = 2.6;
    g.add(bowl);
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.6, 1.5, 8),
      new THREE.MeshBasicMaterial({ color: BRAZIER_COLORS[i] }),
    );
    flame.position.y = 3.5;
    g.add(flame);
    flames.push(flame);
    g.position.set(x, 0, y);
    scene.add(g);
  });

  // --- scattered dark floor plates/grates: extra optical-flow texture
  {
    const mat = new THREE.MeshLambertMaterial({ color: 0x23262c });
    for (let i = 0; i < 26; i++) {
      const s = 1.4 + 1.9 * hash01(i * 4 + 3);
      const geo = new THREE.PlaneGeometry(s, s * (0.6 + 0.8 * hash01(i * 4 + 4)));
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(
        (hash01(i * 4 + 1) * 2 - 1) * (halfW - 9),
        0.02,
        (hash01(i * 4 + 2) * 2 - 1) * (halfH - 9),
      );
      m.rotation.y = hash01(i * 4 + 5) * Math.PI;
      scene.add(m);
    }
  }

  // --- runner avatar (returned via buildAvatar; animated in update below)
  let rig = null;

  function buildAvatar(scn, spec) {
    const paintColor = spec.vehicle.color;
    const paint = new THREE.MeshLambertMaterial({ color: paintColor });
    const dark = new THREE.MeshLambertMaterial({ color: 0x1c1e24 });

    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);

    // torso + head (paint: flashes white on damage via the shared update)
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.8, 10), paint);
    torso.position.y = 1.15;
    body.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), paint);
    head.position.y = 1.72;
    body.add(head);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.3), dark);
    visor.position.set(0.18, 1.74, 0);
    body.add(visor);

    // backpack + brake panel (S feedback) + sprint flame (LShift feedback)
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.52, 0.42), dark);
    pack.position.set(-0.36, 1.2, 0);
    body.add(pack);
    const brakeMat = new THREE.MeshBasicMaterial({ color: 0x5a0f0f });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.26, 0.3), brakeMat);
    panel.position.set(-0.54, 1.12, 0);
    body.add(panel);
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.95, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb31a }),
    );
    flame.rotation.z = Math.PI / 2; // cone +Y -> -X (backwards)
    flame.position.set(-0.85, 1.32, 0);
    flame.visible = false;
    group.add(flame);

    // right arm locked forward holding the gun; muzzle flash at the tip
    const armR = new THREE.Group();
    armR.position.set(0, 1.48, -0.42);
    const armRMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.55, 0.13), dark);
    armRMesh.position.y = -0.27;
    armR.add(armRMesh);
    armR.rotation.z = 1.15;
    body.add(armR);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.14, 0.14), dark);
    gun.position.set(0.62, 1.22, -0.42);
    body.add(gun);
    const flashMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xfff3a0 }),
    );
    flashMesh.position.set(1.12, 1.22, -0.42);
    flashMesh.visible = false;
    body.add(flashMesh);

    // left arm + legs swing with the deterministic walk cycle
    const armL = new THREE.Group();
    armL.position.set(0, 1.48, 0.42);
    const armLMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.55, 0.13), dark);
    armLMesh.position.y = -0.27;
    armL.add(armLMesh);
    body.add(armL);

    const mkLeg = (z) => {
      const hip = new THREE.Group();
      hip.position.set(0, 0.74, z);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.74, 0.17), paint);
      leg.position.y = -0.37;
      hip.add(leg);
      body.add(hip);
      return hip;
    };
    const legL = mkLeg(0.17);
    const legR = mkLeg(-0.17);

    // blob shadow
    const shadowGeo = new THREE.CircleGeometry(0.85, 14);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadow = new THREE.Mesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }),
    );
    shadow.position.y = 0.015;
    group.add(shadow);

    scn.add(group);
    rig = { body, legL, legR, armL };
    return {
      group,
      body,
      wheels: [],
      frontPivots: [],
      brakeMat,
      flame,
      flashMesh,
      paintMat: paint,
      paintColor,
    };
  }

  function update(w) {
    // brazier flicker (deterministic: frame clock only)
    for (let i = 0; i < flames.length; i++) {
      const s = 1 + 0.18 * Math.sin(w.frame * 0.9 + i * 1.9);
      flames[i].scale.set(s, 1 + 0.12 * Math.sin(w.frame * 1.3 + i * 2.6), s);
    }
    if (!rig) return;
    // walk cycle: swing amplitude tracks speed, phase tracks the frame clock
    const u = w.car.u;
    const amp = 0.62 * Math.min(Math.abs(u) / 9, 1.35);
    const swing = Math.sin(w.frame * 0.55) * amp;
    rig.legL.rotation.z = swing;
    rig.legR.rotation.z = -swing;
    rig.armL.rotation.z = -swing * 0.7;
    // slight forward lean with speed (scene.js owns rotation.x, not .z)
    rig.body.rotation.z = -0.12 * Math.max(-1, Math.min(1, u / 9));
  }

  return { update, buildAvatar };
}
