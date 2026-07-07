// Sim verification: bit-exact determinism, bot competence across many seeds,
// and action-space coverage (a dataset where a key never appears is useless
// for learning that key's dynamics). Run: node test/sim_check.mjs
import { World, ACTION_KEYS } from '../src/sim/world.js';

function runEpisode(seed, frames) {
  const w = new World(seed);
  const traj = [];
  const keyCounts = Object.fromEntries(ACTION_KEYS.map((k) => [k, 0]));
  let wallHits = 0;
  for (let f = 0; f < frames; f++) {
    const { keys, frameEvents } = w.stepFrame();
    for (const k of ACTION_KEYS) if (keys[k]) keyCounts[k]++;
    for (const e of frameEvents) if (e.name === 'WallHit') wallHits++;
    traj.push([w.car.x, w.car.y, w.car.heading, w.car.u]);
  }
  return { w, traj, keyCounts, wallHits };
}

// --- 1. determinism: same seed twice => identical trajectory
{
  const a = runEpisode(1234, 600);
  const b = runEpisode(1234, 600);
  const same = JSON.stringify(a.traj) === JSON.stringify(b.traj);
  console.log(same ? 'PASS determinism' : 'FAIL determinism');
  if (!same) process.exit(1);
}

// --- 2. bot competence + diversity across seeds
const FRAMES = 2400; // 120 s
let fails = 0;
const allCounts = Object.fromEntries(ACTION_KEYS.map((k) => [k, 0]));
for (let seed = 1; seed <= 20; seed++) {
  const { w, keyCounts, wallHits } = runEpisode(seed, FRAMES);
  const dist = w.progress;
  const laps = w.lap;
  const meanSpeed = dist / (FRAMES / 20);
  for (const k of ACTION_KEYS) allCounts[k] += keyCounts[k];
  const ok = dist > 800 && laps >= 1;
  if (!ok) fails++;
  console.log(
    `seed ${String(seed).padStart(2)}: track=${w.track.length.toFixed(0)}m ` +
      `dist=${dist.toFixed(0)}m laps=${laps} meanSpeed=${meanSpeed.toFixed(1)}m/s ` +
      `wallHits=${wallHits} ${ok ? '' : '  <-- WEAK'}`,
  );
}
console.log('key usage over 20 episodes (fraction of frames):');
for (const k of ACTION_KEYS) {
  console.log(`  ${k.padEnd(10)} ${(allCounts[k] / (20 * FRAMES)).toFixed(3)}`);
}
console.log(fails <= 2 ? `PASS bot competence (${fails}/20 weak)` : `FAIL bot competence (${fails}/20 weak)`);
process.exit(fails <= 2 ? 0 : 1);
