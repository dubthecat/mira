// Play spaces for non-circuit archetypes. A "space" answers one physics
// question — where can a body be? — through constrain(), and gives modes
// seeded geometry (walls, pillars, goals, POIs) that the renderer draws and
// the bots reason about. The circuit archetype keeps its centerline-track
// logic in car.js/track.js; these spaces are for arenas and open terrain.

import { clamp } from './rng.js';

// Rounded-rectangle walled arena (soccer pitch, shooter pit). Goals are gaps
// in the two short walls (soccer only).
export function buildArena(rng, { halfW, halfH, cornerR, goalHalfWidth = 0, pillars = 0 }) {
  const obstacles = [];
  for (let i = 0; i < pillars; i++) {
    // keep pillars off the centre and away from walls (spawn + goal lanes)
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0.35, 0.75);
    obstacles.push({
      x: Math.cos(a) * halfW * r,
      y: Math.sin(a) * halfH * r,
      radius: rng.range(1.8, 3.4),
      height: rng.range(2.5, 5),
    });
  }

  function constrain(x, y, radius) {
    let nx = 0;
    let ny = 0;
    let hit = false;

    // rounded-rect wall: SDF push-back (goals handled by the mode BEFORE
    // calling constrain — a body inside a goal mouth is exempt)
    const qx = Math.abs(x) - (halfW - cornerR);
    const qy = Math.abs(y) - (halfH - cornerR);
    const ax = Math.max(qx, 0);
    const ay = Math.max(qy, 0);
    const dist = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - cornerR;
    const limit = -radius; // signed distance must stay below -radius
    if (dist > limit) {
      // gradient of the SDF ~ outward normal
      const eps = 0.01;
      const d2 = (xx, yy) => {
        const qx2 = Math.abs(xx) - (halfW - cornerR);
        const qy2 = Math.abs(yy) - (halfH - cornerR);
        return (
          Math.hypot(Math.max(qx2, 0), Math.max(qy2, 0)) +
          Math.min(Math.max(qx2, qy2), 0) -
          cornerR
        );
      };
      let gx = (d2(x + eps, y) - dist) / eps;
      let gy = (d2(x, y + eps) - dist) / eps;
      const gl = Math.hypot(gx, gy) || 1;
      gx /= gl;
      gy /= gl;
      const push = dist - limit;
      x -= gx * push;
      y -= gy * push;
      nx = -gx;
      ny = -gy;
      hit = true;
    }

    // pillars: circle push-out
    for (const o of obstacles) {
      const dx = x - o.x;
      const dy = y - o.y;
      const d = Math.hypot(dx, dy);
      const min = o.radius + radius;
      if (d < min) {
        const inv = d > 1e-6 ? 1 / d : 0;
        const px = d > 1e-6 ? dx * inv : 1;
        const py = d > 1e-6 ? dy * inv : 0;
        x = o.x + px * min;
        y = o.y + py * min;
        nx = px;
        ny = py;
        hit = true;
      }
    }
    return { x, y, nx, ny, hit };
  }

  return {
    kind: 'arena',
    halfW,
    halfH,
    cornerR,
    goalHalfWidth,
    obstacles,
    constrain,
    randomPoint(rng2, margin = 4) {
      return {
        x: rng2.range(-(halfW - margin), halfW - margin),
        y: rng2.range(-(halfH - margin), halfH - margin),
      };
    },
  };
}

// Open terrain with a soft circular boundary (cliff ring). POIs are seeded
// structures the adventure mode hangs relics/monsters on.
export function buildOpenField(rng, { extent, pois = 8 }) {
  const poiList = [];
  for (let i = 0; i < pois; i++) {
    const a = ((i + rng.range(-0.3, 0.3)) / pois) * Math.PI * 2;
    const r = extent * rng.range(0.25, 0.85);
    poiList.push({
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      kind: rng.pick(['ruin', 'obelisk', 'camp']),
      size: rng.range(3, 7),
    });
  }

  function constrain(x, y, radius) {
    const d = Math.hypot(x, y);
    const limit = extent - radius;
    if (d > limit) {
      const inv = 1 / (d || 1);
      return { x: x * inv * limit, y: y * inv * limit, nx: -x * inv, ny: -y * inv, hit: true };
    }
    // POI structures are solid
    for (const p of poiList) {
      const dx = x - p.x;
      const dy = y - p.y;
      const dd = Math.hypot(dx, dy);
      const min = p.size * 0.6 + radius;
      if (dd < min) {
        const inv = dd > 1e-6 ? 1 / dd : 0;
        const px = dd > 1e-6 ? dx * inv : 1;
        const py = dd > 1e-6 ? dy * inv : 0;
        return { x: p.x + px * min, y: p.y + py * min, nx: px, ny: py, hit: true };
      }
    }
    return { x, y, nx: 0, ny: 0, hit: false };
  }

  return {
    kind: 'openfield',
    extent,
    pois: poiList,
    constrain,
    randomPoint(rng2, margin = 8) {
      const a = rng2.range(0, Math.PI * 2);
      const r = rng2.range(0, extent - margin);
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    },
  };
}

// Shared wall-response for arena/openfield bodies (mirrors the circuit's
// restitution feel): reflect the normal component, damp the tangential one.
export function bounce(body, res, restitution = 0.25, tangentKeep = 0.88) {
  if (!res.hit) return 0;
  body.x = res.x;
  body.y = res.y;
  const vn = body.vx * res.nx + body.vy * res.ny;
  if (vn < 0) {
    body.vx -= res.nx * vn * (1 + restitution);
    body.vy -= res.ny * vn * (1 + restitution);
    body.vx *= tangentKeep;
    body.vy *= tangentKeep;
    return -vn;
  }
  return 0;
}

export function clampMag(vx, vy, max) {
  const m = Math.hypot(vx, vy);
  if (m <= max) return [vx, vy];
  const s = max / m;
  return [vx * s, vy * s];
}

export { clamp };
