// Soccer mode scene: striped grass pitch with white markings inside a low
// walled arena whose two goal mouths are open, team-colored goals with post +
// crossbar + wireframe nets, a rolling black/white ball with a blob shadow,
// and rival cars mirroring the main rig. Everything is a pure function of
// world.mode state so the browser game and headless recorder look identical.
//
// Team colors: the player ("us") defends the blue goal at x = -halfW and
// shoots at the amber goal at x = +halfW.

import * as THREE from 'three';

const GOAL_US = 0x3987e5;
const GOAL_THEM = 0xc98500;
const OPP_COLORS = [0x2a7fff, 0x8f45e0];
const WALL_H = 1.2;

export function buildSoccerScene(scene, world, pal, shared) {
  const mode = world.mode;
  const arena = mode.arena;
  const { halfW, halfH, cornerR, goalHalfWidth: gHW } = arena;
  const ballR = mode.ball.radius;

  // --- ground far beyond the arena (mottled for motion parallax)
  {
    const ext = Math.max(halfW, halfH) * 2 * 1.6 + 200;
    const geo = new THREE.PlaneGeometry(ext, ext, 56, 56);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.copy(shared.grass).multiplyScalar(0.85 + 0.2 * shared.hash01(i));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.position.y = -0.02;
    scene.add(mesh);
  }

  // --- pitch: crisp mowing stripes (one mesh per stripe so the alternation
  // doesn't wash out through vertex interpolation), each with its own noise
  {
    const nStripes = 14;
    const stripeW = (halfW * 2) / nStripes;
    const c = new THREE.Color();
    for (let s = 0; s < nStripes; s++) {
      const geo = new THREE.PlaneGeometry(stripeW, halfH * 2, 2, 8);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.getAttribute('position');
      const colors = new Float32Array(pos.count * 3);
      const tone = s % 2 === 0 ? 1.09 : 0.91;
      for (let i = 0; i < pos.count; i++) {
        c.copy(shared.grass).multiplyScalar(tone * (0.95 + 0.1 * shared.hash01(s * 131 + i * 3.7)));
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
      mesh.position.set(-halfW + stripeW * (s + 0.5), 0.01, 0);
      scene.add(mesh);
    }
  }

  // --- white markings (unlit strips slightly above the pitch)
  {
    const white = new THREE.MeshBasicMaterial({ color: 0xf0f0f2 });
    const flat = (w, d, x, z) => {
      const g = new THREE.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, white);
      m.position.set(x, 0.04, z);
      scene.add(m);
    };
    flat(0.4, halfH * 2, 0, 0); // center line
    const ring = new THREE.Mesh(new THREE.RingGeometry(7.6, 8.05, 48), white);
    ring.rotateX(-Math.PI / 2);
    ring.position.y = 0.04;
    scene.add(ring);
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.6, 16), white);
    spot.rotateX(-Math.PI / 2);
    spot.position.y = 0.04;
    scene.add(spot);
    // goal boxes
    const boxHalf = gHW + 6;
    const depth = 11;
    for (const sx of [1, -1]) {
      flat(0.4, boxHalf * 2, sx * (halfW - depth), 0); // front line
      for (const sz of [1, -1]) flat(depth, 0.4, sx * (halfW - depth / 2), sz * boxHalf);
      const pen = new THREE.Mesh(new THREE.CircleGeometry(0.5, 12), white);
      pen.rotateX(-Math.PI / 2);
      pen.position.set(sx * (halfW - 13), 0.04, 0);
      scene.add(pen);
    }
  }

  // --- arena walls: rounded-rect perimeter with open goal mouths. A dark
  // base skirt fading to a light top edge makes the low wall read as a
  // standing barrier instead of a flat road band at 512x288.
  {
    const base = new THREE.Color().setHSL(pal.skyHue, 0.2, Math.max(0.24, pal.skyLight * 0.95));
    const tint = base.clone().offsetHSL(0.03, 0.12, -0.14);
    const skirt = base.clone().multiplyScalar(0.42);
    const iw = halfW - cornerR;
    const ih = halfH - cornerR;
    const arc = (cx, cy, a0, a1, n) => {
      const pts = [];
      for (let i = 1; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        pts.push([cx + Math.cos(a) * cornerR, cy + Math.sin(a) * cornerR]);
      }
      return pts;
    };
    // one open polyline post-to-post around each long side
    const top = [
      [halfW, gHW],
      [halfW, ih],
      ...arc(iw, ih, 0, Math.PI / 2, 6),
      [-iw, halfH],
      ...arc(-iw, ih, Math.PI / 2, Math.PI, 6),
      [-halfW, gHW],
    ];
    const bottom = top.map(([x, y]) => [x, -y]);
    for (const line of [top, bottom]) {
      // densify straights so the alternating color bands stay ~4 m wide
      const pts = [];
      for (let i = 0; i < line.length - 1; i++) {
        const [x0, y0] = line[i];
        const [x1, y1] = line[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4));
        for (let k = 0; k < n; k++) pts.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
      }
      pts.push(line[line.length - 1]);
      const N = pts.length;
      const positions = new Float32Array(N * 2 * 3);
      const colors = new Float32Array(N * 2 * 3);
      const idx = [];
      for (let i = 0; i < N; i++) {
        const [x, z] = pts[i];
        positions[i * 6 + 0] = x;
        positions[i * 6 + 1] = 0;
        positions[i * 6 + 2] = z;
        positions[i * 6 + 3] = x;
        positions[i * 6 + 4] = WALL_H;
        positions[i * 6 + 5] = z;
        const col = Math.floor(i / 2) % 2 === 0 ? base : tint;
        // bottom vertex: dark skirt; top vertex: banded light tone
        colors[i * 6 + 0] = skirt.r;
        colors[i * 6 + 1] = skirt.g;
        colors[i * 6 + 2] = skirt.b;
        colors[i * 6 + 3] = col.r;
        colors[i * 6 + 4] = col.g;
        colors[i * 6 + 5] = col.b;
        if (i < N - 1) {
          const a = i * 2;
          const b = (i + 1) * 2;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
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

  // --- goals: team-colored posts + crossbar (unlit so the color pops and the
  // white goal flash is unmistakable), wireframe net box behind the line,
  // and a team-colored strip on the ground across the mouth
  function buildGoal(sx, color) {
    const frameMat = new THREE.MeshBasicMaterial({ color });
    const g = new THREE.Group();
    const postGeo = new THREE.CylinderGeometry(0.45, 0.45, 3.6, 10);
    for (const sz of [1, -1]) {
      const post = new THREE.Mesh(postGeo, frameMat);
      post.position.set(sx * halfW, 1.8, sz * (gHW - 0.35));
      g.add(post);
    }
    const barGeo = new THREE.CylinderGeometry(0.38, 0.38, (gHW - 0.35) * 2 + 0.9, 10);
    barGeo.rotateX(Math.PI / 2); // axis along z
    const bar = new THREE.Mesh(barGeo, frameMat);
    bar.position.set(sx * halfW, 3.6, 0);
    g.add(bar);
    const lineGeo = new THREE.PlaneGeometry(1.0, (gHW - 0.35) * 2);
    lineGeo.rotateX(-Math.PI / 2);
    const line = new THREE.Mesh(lineGeo, frameMat);
    line.position.set(sx * (halfW - 0.5), 0.045, 0);
    g.add(line);
    const net = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 3.4, (gHW - 0.35) * 2, 2, 3, 8),
      new THREE.MeshBasicMaterial({ color: 0xdfe4ea, wireframe: true }),
    );
    net.position.set(sx * (halfW + 1.7), 1.7, 0);
    g.add(net);
    scene.add(g);
    return { frameMat, baseColor: color };
  }
  const goalUs = buildGoal(-1, GOAL_US); // we defend this one
  const goalThem = buildGoal(1, GOAL_THEM); // we shoot at this one

  // --- ball: low-poly sphere with black/white face patches, rolls with velocity
  const ballRaw = new THREE.IcosahedronGeometry(ballR, 1);
  const ballGeo = ballRaw.index ? ballRaw.toNonIndexed() : ballRaw;
  {
    const pos = ballGeo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let f = 0; f < pos.count / 3; f++) {
      const dark = shared.hash01(f * 7.31) < 0.38;
      const v = (dark ? 0.08 : 0.96) * (0.93 + 0.12 * shared.hash01(f * 2.13));
      for (let k = 0; k < 3; k++) {
        colors[(f * 3 + k) * 3] = v;
        colors[(f * 3 + k) * 3 + 1] = v;
        colors[(f * 3 + k) * 3 + 2] = v;
      }
    }
    ballGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const ballMesh = new THREE.Mesh(ballGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ballMesh.position.set(0, ballR, 0);
  scene.add(ballMesh);
  const shadowGeo = new THREE.CircleGeometry(ballR * 0.95, 16);
  shadowGeo.rotateX(-Math.PI / 2);
  const ballShadow = new THREE.Mesh(
    shadowGeo,
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 }),
  );
  ballShadow.position.y = 0.02;
  scene.add(ballShadow);

  // --- kickoff countdown glow around the center circle
  const glow = new THREE.Mesh(
    new THREE.RingGeometry(8.3, 9.4, 48),
    new THREE.MeshBasicMaterial({ color: 0xaef1ff, transparent: true, opacity: 0.85 }),
  );
  glow.rotateX(-Math.PI / 2);
  glow.position.y = 0.05;
  glow.visible = false;
  scene.add(glow);

  // --- rival cars (one rig per opponent, distinct colors)
  const oppRigs = mode.opponents.map((o, i) =>
    shared.buildCar(scene, OPP_COLORS[i % OPP_COLORS.length], 'sport'),
  );

  const rollAxis = new THREE.Vector3();

  function update(world, dt) {
    const m = world.mode;
    const ball = m.ball;

    // ball transform + rolling rotation about the horizontal axis
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > 0.01 && dt > 0) {
      rollAxis.set(ball.vy / speed, 0, -ball.vx / speed);
      ballMesh.rotateOnWorldAxis(rollAxis, (speed * dt) / ballR);
    }
    const frozen = m.freezeSub > 0;
    const pulse = frozen ? 1 + 0.14 * Math.sin(world.frame * 0.55) : 1;
    ballMesh.scale.setScalar(pulse);
    ballMesh.position.set(ball.x, ballR * pulse, ball.y);
    ballShadow.position.set(ball.x, 0.02, ball.y);
    glow.visible = frozen;
    if (frozen) {
      const t = 0.55 + 0.45 * Math.sin(world.frame * 0.55);
      glow.material.opacity = 0.35 + 0.55 * t;
    }

    // goal flash: the goal that was scored INTO blinks white for ~10 frames
    const flashing = world.frame - m.lastGoal.frame < 10 && m.lastGoal.by !== null;
    goalThem.frameMat.color.setHex(
      flashing && m.lastGoal.by === 'us' ? 0xffffff : goalThem.baseColor,
    );
    goalUs.frameMat.color.setHex(
      flashing && m.lastGoal.by === 'them' ? 0xffffff : goalUs.baseColor,
    );

    // rival rigs mirror the main car rig's wheel/steer/brake/boost feedback
    for (let i = 0; i < oppRigs.length; i++) {
      const rig = oppRigs[i];
      const o = m.opponents[i];
      const c = o.car;
      rig.group.position.set(c.x, 0, c.y);
      rig.group.rotation.y = -c.heading;
      rig.body.rotation.x = THREE.MathUtils.clamp(-c.slip * 0.012, -0.09, 0.09);
      const spin = (c.u * dt) / 0.38;
      for (const w of rig.wheels) w.rotation.z -= spin;
      for (const p of rig.frontPivots) p.rotation.y = c.steer * 0.9;
      rig.brakeMat.color.setHex(o.keys && o.keys.S ? 0xff2020 : 0x5a0f0f);
      rig.flame.visible = c.boosting;
      if (c.boosting) {
        const s = 1 + 0.25 * Math.sin(world.frame * 2.1 + i * 1.7);
        rig.flame.scale.set(s, 1, 1);
      }
    }
  }

  return { update };
}
