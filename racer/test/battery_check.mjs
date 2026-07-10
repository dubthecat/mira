// Genre battery battle-test: run every battery spec sim-only (no rendering,
// fast) across multiple seeds and assert per-genre quality gates plus
// engine-wide invariants (finite state, determinism, action coverage).
// Run: node test/battery_check.mjs [--frames 2400] [--seeds 3]

import { World } from '../src/sim/world.js';
import { compileBattery } from '../src/spec/battery.js';

const args = process.argv.slice(2);
const FRAMES = parseInt(args[args.indexOf('--frames') + 1] || '2400', 10) || 2400;
const SEEDS = parseInt(args[args.indexOf('--seeds') + 1] || '3', 10) || 3;

function runEpisode(spec, seed, frames) {
  const w = new World(seed, spec);
  const counts = {};
  const keyFrames = Object.fromEntries(w.actionKeys.map((k) => [k, 0]));
  let stall = 0;
  let maxStall = 0;
  let prevProgress = 0;
  let prevX = w.car.x;
  let prevY = w.car.y;
  // the shooter archetype has no odometer (world.progress stays 0), so its
  // stall detector watches raw avatar displacement instead
  const stallByMotion = spec.archetype === 'shooter';
  const sig = [];
  for (let f = 0; f < frames; f++) {
    const { keys } = w.stepFrame();
    for (const k of w.actionKeys) if (keys[k]) keyFrames[k]++;
    if (!Number.isFinite(w.car.x + w.car.y + w.car.vx + w.car.vy + w.health + w.progress)) {
      throw new Error(`NaN/Inf state at frame ${f} (seed ${seed}, spec ${spec.name})`);
    }
    for (const m of w.entities.monsters) {
      if (!Number.isFinite(m.x + m.y)) {
        throw new Error(`NaN monster ${m.id} at frame ${f} (seed ${seed}, spec ${spec.name})`);
      }
    }
    const moved = stallByMotion
      ? Math.hypot(w.car.x - prevX, w.car.y - prevY)
      : w.progress - prevProgress;
    if (moved < 0.05 && w.respawnSub <= 0) stall++;
    else stall = 0;
    maxStall = Math.max(maxStall, stall);
    prevProgress = w.progress;
    prevX = w.car.x;
    prevY = w.car.y;
    if (f % 100 === 0) sig.push([w.car.x.toFixed(6), w.car.y.toFixed(6), w.score, w.health]);
  }
  for (const e of w.events) counts[e.name] = (counts[e.name] || 0) + 1;
  return {
    w,
    counts,
    keyFrames,
    maxStall,
    meanSpeed: w.progress / (frames / 20),
    signature: JSON.stringify(sig),
  };
}

const battery = compileBattery();
let failures = 0;
const summaries = [];

for (const entry of battery) {
  const { spec, gates, key } = entry;
  const problems = [];
  let agg = null;

  for (let s = 0; s < SEEDS; s++) {
    const seed = 100 + s;
    let r;
    try {
      r = runEpisode(spec, seed, FRAMES);
    } catch (e) {
      problems.push(String(e.message));
      break;
    }
    // determinism spot check on the first seed
    if (s === 0) {
      const r2 = runEpisode(spec, seed, Math.min(FRAMES, 600));
      const sigA = JSON.parse(r.signature).slice(0, Math.floor(Math.min(FRAMES, 600) / 100));
      const sigB = JSON.parse(r2.signature).slice(0, sigA.length);
      if (JSON.stringify(sigA) !== JSON.stringify(sigB)) {
        problems.push('DETERMINISM MISMATCH');
      }
    }
    if (!agg) {
      agg = { counts: {}, keyFrames: {}, meanSpeed: 0, maxStall: 0, laps: 0, frames: FRAMES * SEEDS };
    }
    for (const [k, v] of Object.entries(r.counts)) agg.counts[k] = (agg.counts[k] || 0) + v;
    for (const [k, v] of Object.entries(r.keyFrames)) agg.keyFrames[k] = (agg.keyFrames[k] || 0) + v;
    agg.meanSpeed += r.meanSpeed / SEEDS;
    agg.maxStall = Math.max(agg.maxStall, r.maxStall);
    agg.laps += r.w.lap || 0; // trackless archetypes have no lap counter
  }

  if (agg && problems.length === 0) {
    const c = agg.counts;
    const check = (cond, msg) => {
      if (!cond) problems.push(msg);
    };
    // count gates are calibrated as totals over SEEDS x 2400-frame episodes;
    // scale for shorter runs (same pattern for laps, goals, waves, relics).
    // Demands grow linearly in FRAMES but must never exceed what the spec can
    // actually supply (waves are capped by monsters/waveSize and the wave
    // clock, relics never respawn), and rate gates whose scaled demand rounds
    // to zero are skipped rather than floored to 1 — a 30 s episode cannot be
    // required to finish a full lap.
    const scaledRaw = (base) => Math.floor(base * SEEDS * (FRAMES / 2400));
    const scaled = (base) => Math.max(1, scaledRaw(base));
    if (gates.minMeanSpeed) check(agg.meanSpeed >= gates.minMeanSpeed, `meanSpeed ${agg.meanSpeed.toFixed(1)} < ${gates.minMeanSpeed}`);
    if (gates.minLaps && scaledRaw(gates.minLaps) >= 1) {
      const want = scaledRaw(gates.minLaps);
      check(agg.laps >= want, `laps ${agg.laps} < ${want}`);
    }
    if (gates.minGoalsTotal && scaledRaw(gates.minGoalsTotal) >= 1) {
      const want = scaledRaw(gates.minGoalsTotal);
      check((c.GoalScored || 0) >= want, `GoalScored ${c.GoalScored || 0} < ${want}`);
    }
    if (gates.minWaves) {
      // supply cap: ceil(monsters/waveSize) waves exist per episode, and only
      // floor(FRAMES/waveEveryFrames)+1 wave boundaries fit inside the run
      const totalMonsters = spec.entities.monsters.reduce((a, m) => a + m.count, 0);
      const supply =
        SEEDS *
        Math.min(
          Math.ceil(totalMonsters / spec.shooter.waveSize),
          Math.floor(FRAMES / spec.shooter.waveEveryFrames) + 1,
        );
      const want = Math.min(scaled(gates.minWaves), supply);
      check((c.WaveStarted || 0) >= want, `WaveStarted ${c.WaveStarted || 0} < ${want}`);
    }
    if (gates.minRelics) {
      // supply cap: relics never respawn — spec.adventure.relics per episode
      const want = Math.min(scaled(gates.minRelics), SEEDS * spec.adventure.relics);
      check((c.RelicCollected || 0) >= want, `RelicCollected ${c.RelicCollected || 0} < ${want}`);
    }
    if (gates.minBomberBoom) {
      const want = scaled(gates.minBomberBoom);
      check((c.BomberExploded || 0) >= want, `BomberExploded ${c.BomberExploded || 0} < ${want}`);
    }
    if (gates.minWrecked) {
      const want = scaled(gates.minWrecked);
      check((c.HunterWrecked || 0) >= want, `HunterWrecked ${c.HunterWrecked || 0} < ${want}`);
    }
    if (gates.minFired) check((c.Fired || 0) >= gates.minFired, `Fired ${c.Fired || 0} < ${gates.minFired}`);
    if (gates.minKills) check((c.MonsterKilled || 0) >= gates.minKills, `kills ${c.MonsterKilled || 0} < ${gates.minKills}`);
    if (gates.minTurretFired) check((c.TurretFired || 0) >= gates.minTurretFired, `TurretFired ${c.TurretFired || 0} < ${gates.minTurretFired}`);
    if (gates.minCarDamaged) check((c.CarDamaged || 0) >= gates.minCarDamaged, `CarDamaged ${c.CarDamaged || 0} < ${gates.minCarDamaged}`);
    if (gates.minContacts) check((c.MonsterContact || 0) >= gates.minContacts, `contacts ${c.MonsterContact || 0} < ${gates.minContacts}`);
    if (gates.maxEvents) {
      const total = Object.values(c).reduce((a, b) => a + b, 0);
      check(total <= gates.maxEvents, `events ${total} > ${gates.maxEvents}`);
    }
    for (const k of gates.wantsKeys || []) {
      check((agg.keyFrames[k] || 0) > 0, `key ${k} never pressed`);
    }
    // engine-wide: bot must not be stuck > 15 s anywhere
    check(agg.maxStall < 300, `stalled ${agg.maxStall} frames`);
  }

  const status = problems.length === 0 ? 'PASS' : 'FAIL';
  if (problems.length > 0) failures++;
  const evSummary = agg
    ? Object.entries(agg.counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' ')
    : '';
  summaries.push(
    `${status} ${key.padEnd(22)} keys=${spec.weapon.enabled ? 7 : 6} biome=${spec.world.biome.padEnd(6)} ` +
      `v=${agg ? agg.meanSpeed.toFixed(1) : '-'} laps=${agg ? agg.laps : '-'} | ${evSummary}` +
      (problems.length ? `\n     ^-- ${problems.join('; ')}` : ''),
  );
}

console.log(summaries.join('\n'));
console.log(failures === 0 ? `\nALL ${battery.length} GENRES PASS` : `\n${failures}/${battery.length} GENRES FAIL`);
process.exit(failures === 0 ? 0 : 1);
