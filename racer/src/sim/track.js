// Procedural closed-circuit track, fully determined by an Rng stream.
//
// Construction: K control points on a jittered annulus (angles kept sorted, so
// the polygon is star-shaped and cannot self-intersect), smoothed with a closed
// Catmull-Rom spline and resampled to uniform arc length (ds ~ 1 m). Each dense
// sample carries position, tangent angle, curvature and half-width; everything
// downstream (physics walls, bot racing line, mesh generation, minimap) reads
// from these samples.

import { Rng, wrapAngle, clamp } from './rng.js';

const DS = 1.0; // metres between dense samples

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

export function buildTrack(seedRng, opts = {}) {
  // Candidate tracks that violate geometric sanity (hairpins tighter than the
  // road is wide, or two sections of road overlapping in space) are rejected
  // and regenerated from a deterministically derived stream — same seed, same
  // final track, always.
  for (let attempt = 0; ; attempt++) {
    const rng = seedRng.fork(attempt === 0 ? 'track' : `track-retry${attempt}`);
    const track = generateCandidate(rng, opts);
    if (track !== null) return track;
    // Cap high: wide tracks reject often, and unlucky (seed, spec) pairs have
    // needed 77+ attempts. Raising this is replay-safe — attempts keep their
    // fork tags, so every previously-converging pair yields the same track.
    if (attempt > 300) throw new Error('track generation failed to converge');
  }
}

function generateCandidate(rng, { radiusScale = 1, widthScale = 1, boostPads = true } = {}) {
  // --- control polygon: sorted angles + bounded radius jitter => simple polygon
  const K = rng.int(9, 13);
  // wide corridors need proportionally larger geometry: the overlap rejection
  // threshold below scales with widthScale, so without this the annulus stays
  // fixed and wide specs (widthScale up to the schema-legal 1.8) reject nearly
  // every candidate and fail to converge. widthScale <= 1 multiplies by
  // exactly 1, keeping every existing narrow/default track bit-identical.
  const widthGrow = 1 + Math.max(0, widthScale - 1) * 0.9;
  const baseR = rng.range(85, 140) * radiusScale * widthGrow;
  const ctrl = [];
  // half the tracks run clockwise (mirror), so left/right turns are balanced
  // across the dataset
  const mirror = rng.bool() ? -1 : 1;
  for (let i = 0; i < K; i++) {
    const ang = ((i + 0.7 * (rng.next() - 0.5)) / K) * 2 * Math.PI;
    const r = baseR * rng.range(0.62, 1.38);
    ctrl.push({ x: r * Math.cos(ang), y: mirror * r * Math.sin(ang) });
  }

  // --- fine polyline along the closed spline
  const fine = [];
  const SUB = 40;
  for (let i = 0; i < K; i++) {
    const p0 = ctrl[(i - 1 + K) % K];
    const p1 = ctrl[i];
    const p2 = ctrl[(i + 1) % K];
    const p3 = ctrl[(i + 2) % K];
    for (let j = 0; j < SUB; j++) {
      fine.push(catmullRom(p0, p1, p2, p3, j / SUB));
    }
  }

  // cumulative length of the fine polyline (closed)
  const cum = [0];
  for (let i = 1; i <= fine.length; i++) {
    const a = fine[i - 1];
    const b = fine[i % fine.length];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cum[fine.length];

  // --- uniform arc-length resample
  const N = Math.max(64, Math.round(total / DS));
  const ds = total / N;
  const xs = new Float64Array(N);
  const ys = new Float64Array(N);
  {
    let seg = 0;
    for (let i = 0; i < N; i++) {
      const target = i * ds;
      while (cum[seg + 1] < target && seg < fine.length - 1) seg++;
      const t = (target - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
      const a = fine[seg];
      const b = fine[(seg + 1) % fine.length];
      xs[i] = a.x + (b.x - a.x) * t;
      ys[i] = a.y + (b.y - a.y) * t;
    }
  }

  // --- tangent angle and smoothed curvature
  const theta = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N;
    const b = (i + 1) % N;
    theta[i] = Math.atan2(ys[b] - ys[a], xs[b] - xs[a]);
  }
  const kappaRaw = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N;
    const b = (i + 1) % N;
    kappaRaw[i] = wrapAngle(theta[b] - theta[a]) / (2 * ds);
  }
  const kappa = new Float64Array(N);
  const W = 4; // +/- samples of box smoothing
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let j = -W; j <= W; j++) acc += kappaRaw[(i + j + N) % N];
    kappa[i] = acc / (2 * W + 1);
  }

  // reject candidates with hairpins too tight for a drivable corridor
  let kAbsMax = 0;
  for (let i = 0; i < N; i++) kAbsMax = Math.max(kAbsMax, Math.abs(kappa[i]));
  if (kAbsMax > 1 / 5.2) return null;

  // --- half-width: gentle seeded modulation along s, then clamped against
  // local curvature so the inner edge never folds (needs hw < 1/|kappa|)
  const hw0 = rng.range(6.5, 9.0) * widthScale;
  const hwPhase = rng.range(0, 2 * Math.PI);
  const hwLobes = rng.int(2, 4);
  const halfWidth = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = i * ds;
    halfWidth[i] = Math.max(
      5.5,
      hw0 * (1 + 0.12 * Math.sin((2 * Math.PI * hwLobes * s) / total + hwPhase)),
    );
  }
  for (let i = 0; i < N; i++) {
    // clamp against the tightest curvature in a window (the fold hazard is
    // local geometry, not just the exact sample)
    let kWin = 0;
    for (let j = -4; j <= 4; j++) kWin = Math.max(kWin, Math.abs(kappa[(i + j + N) % N]));
    halfWidth[i] = Math.min(halfWidth[i], Math.max(4.0, 0.78 / Math.max(kWin, 1e-6)));
  }
  // re-smooth so clamping doesn't leave steps, then re-apply the hard fold guard
  {
    const sm = new Float64Array(N);
    const HW_W = 5;
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let j = -HW_W; j <= HW_W; j++) acc += halfWidth[(i + j + N) % N];
      sm[i] = acc / (2 * HW_W + 1);
    }
    for (let i = 0; i < N; i++) {
      halfWidth[i] = Math.min(sm[i], 0.88 / Math.max(Math.abs(kappa[i]), 1e-6));
    }
  }

  // reject candidates where two far-apart sections of road come too close
  // (overlapping corridors: double walls, ambiguous nearest-centerline)
  {
    // metres of arc separation before clearance applies. Must scale with the
    // corridor width: euclidean distance can never exceed arc distance, so a
    // fixed window smaller than the clearance 'need' (up to ~2*hw+3, i.e.
    // ~39 m at widthScale 1.8) makes every wide sample "overlap" its own
    // road continuation just past the window and rejects 100% of candidates.
    // widthScale <= 1 multiplies by exactly 1: existing tracks bit-identical.
    const MIN_ARC = 25 * widthGrow;
    const arcSamples = Math.ceil(MIN_ARC / ds);
    for (let i = 0; i < N; i += 2) {
      for (let j = i + arcSamples; j < N; j += 2) {
        const wrapSep = Math.min(j - i, N - (j - i));
        if (wrapSep < arcSamples) continue;
        const dx = xs[i] - xs[j];
        const dy = ys[i] - ys[j];
        const need = halfWidth[i] + halfWidth[j] + 3.0;
        if (dx * dx + dy * dy < need * need) return null;
      }
    }
  }

  // --- boost pads along the track at seeded intervals/lateral offsets
  // (rng draws happen even when pads are disabled, so toggling boostPads
  // does not shift every downstream stream)
  const pads = [];
  let sPad = rng.range(40, 80);
  while (sPad < total - 40) {
    const idx = Math.round(sPad / ds) % N;
    const lat = rng.range(-1, 1) * Math.max(0, halfWidth[idx] - 2.8);
    const nx = -Math.sin(theta[idx]);
    const ny = Math.cos(theta[idx]);
    if (boostPads) {
      pads.push({
        s: idx * ds,
        idx,
        lateral: lat,
        x: xs[idx] + nx * lat,
        y: ys[idx] + ny * lat,
      });
    }
    sPad += rng.range(85, 130);
  }

  // --- scenery (deterministic attributes computed here so rendering is a pure fn)
  const scenery = buildScenery(rng, xs, ys, halfWidth, N, baseR);

  // bounding box (for minimap / camera far plane)
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    minX = Math.min(minX, xs[i]);
    maxX = Math.max(maxX, xs[i]);
    minY = Math.min(minY, ys[i]);
    maxY = Math.max(maxY, ys[i]);
  }

  const track = {
    n: N,
    ds,
    length: total,
    xs,
    ys,
    theta,
    kappa,
    halfWidth,
    pads,
    scenery,
    bounds: { minX, maxX, minY, maxY },
    nearest, // (p, hintIdx) => projection info
    sampleAt, // (s) => interpolated centerline point
  };

  function sampleAt(s) {
    let u = ((s % total) + total) % total;
    const f = u / ds;
    const i = Math.floor(f) % N;
    const j = (i + 1) % N;
    const t = f - Math.floor(f);
    return {
      x: xs[i] + (xs[j] - xs[i]) * t,
      y: ys[i] + (ys[j] - ys[i]) * t,
      theta: theta[i] + wrapAngle(theta[j] - theta[i]) * t,
      kappa: kappa[i] + (kappa[j] - kappa[i]) * t,
      halfWidth: halfWidth[i] + (halfWidth[j] - halfWidth[i]) * t,
    };
  }

  // Nearest point on the centerline. With a hint index this is a local search
  // (the car moves < 1 sample per substep); without, a global coarse scan.
  function nearest(px, py, hintIdx = -1) {
    let best = -1;
    let bestD2 = Infinity;
    if (hintIdx >= 0) {
      // s-continuity: the car moves < 1 sample per query, so penalize
      // candidates by their arc distance from the hint — otherwise the
      // euclidean minimum can snap to the opposite leg of a hairpin and
      // corrupt s/lateral/progress
      const WIN = 45;
      const PEN = 0.35 * ds;
      let bestScore = Infinity;
      for (let j = -WIN; j <= WIN; j++) {
        const i = (hintIdx + j + N) % N;
        const dx = px - xs[i];
        const dy = py - ys[i];
        const pen = PEN * j;
        const score = dx * dx + dy * dy + pen * pen;
        if (score < bestScore) {
          bestScore = score;
          bestD2 = dx * dx + dy * dy;
          best = i;
        }
      }
      // hint window too small (teleport/reset): fall through to global scan
      if (Math.sqrt(bestD2) > 60) best = -1;
    }
    if (best < 0) {
      bestD2 = Infinity;
      for (let i = 0; i < N; i += 4) {
        const dx = px - xs[i];
        const dy = py - ys[i];
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
      for (let j = -4; j <= 4; j++) {
        const i = (best + j + N) % N;
        const dx = px - xs[i];
        const dy = py - ys[i];
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
    }
    // project onto the two adjacent segments for sub-sample accuracy
    let bi = best;
    let bt = 0;
    let bd2 = bestD2;
    for (const i0 of [(best - 1 + N) % N, best]) {
      const i1 = (i0 + 1) % N;
      const ax = xs[i0];
      const ay = ys[i0];
      const bx = xs[i1] - ax;
      const by = ys[i1] - ay;
      const len2 = bx * bx + by * by;
      const t = clamp(((px - ax) * bx + (py - ay) * by) / Math.max(1e-9, len2), 0, 1);
      const qx = ax + bx * t;
      const qy = ay + by * t;
      const dx = px - qx;
      const dy = py - qy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd2) {
        bd2 = d2;
        bi = i0;
        bt = t;
      }
    }
    const i1 = (bi + 1) % N;
    const th = theta[bi] + wrapAngle(theta[i1] - theta[bi]) * bt;
    const hw = halfWidth[bi] + (halfWidth[i1] - halfWidth[bi]) * bt;
    const cx = xs[bi] + (xs[i1] - xs[bi]) * bt;
    const cy = ys[bi] + (ys[i1] - ys[bi]) * bt;
    // signed lateral offset: positive to the left of travel direction
    const lat = -(px - cx) * Math.sin(th) + (py - cy) * Math.cos(th);
    return {
      idx: bi,
      s: (bi + bt) * ds,
      lateral: lat,
      theta: th,
      halfWidth: hw,
      kappa: kappa[bi],
      cx,
      cy,
    };
  }

  return track;
}

function buildScenery(rng, xs, ys, halfWidth, N, baseR) {
  const srng = rng.fork('scenery');
  const trees = [];
  const rocks = [];
  const extent = baseR * 1.9 + 60;

  const clearOf = (x, y, margin) => {
    let bestD2 = Infinity;
    let bestI = 0;
    for (let i = 0; i < N; i += 6) {
      const dx = x - xs[i];
      const dy = y - ys[i];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestI = i;
      }
    }
    return Math.sqrt(bestD2) > halfWidth[bestI] + margin;
  };

  for (let i = 0; i < 170; i++) {
    const x = srng.range(-extent, extent);
    const y = srng.range(-extent, extent);
    if (!clearOf(x, y, 7)) continue;
    if (srng.bool(0.78)) {
      trees.push({
        x,
        y,
        scale: srng.range(0.7, 1.7),
        hue: srng.range(0, 1),
        rot: srng.range(0, Math.PI * 2),
      });
    } else {
      rocks.push({ x, y, scale: srng.range(0.6, 2.2), rot: srng.range(0, Math.PI * 2) });
    }
  }

  // Distinct colored towers: unique spatial anchors so the world model can
  // localize itself on the circuit from any viewpoint.
  const TOWER_COLORS = [0xe23b3b, 0x2f6fe4, 0xf2c230, 0x8a3be2, 0xff7a1a, 0x21b573];
  const towers = [];
  const nTowers = 5;
  for (let i = 0; i < nTowers; i++) {
    const ang = ((i + srng.range(-0.25, 0.25)) / nTowers) * 2 * Math.PI;
    const r = baseR * srng.range(1.45, 1.8);
    towers.push({
      x: r * Math.cos(ang),
      y: r * Math.sin(ang),
      color: TOWER_COLORS[i % TOWER_COLORS.length],
      height: srng.range(18, 32),
      width: srng.range(4, 7),
    });
  }

  // per-seed palette jitter (kept subtle: same "world", varied lighting/biome)
  const palette = {
    grassHue: 0.31 + srng.range(-0.045, 0.045),
    grassLight: srng.range(0.32, 0.42),
    skyHue: 0.58 + srng.range(-0.05, 0.05),
    asphaltLight: srng.range(0.16, 0.24),
  };

  return { trees, rocks, towers, palette };
}
