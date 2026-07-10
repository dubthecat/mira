// Shooter mode verification: bit-exact determinism, wave scheduling, kiting
// bot competence (kills + survival), arena containment and finite state.
// Run: node test/shooter_check.mjs
import { World } from '../src/sim/world.js';
import { makeSpec } from '../src/spec/schema.js';

const SPEC = makeSpec({
  name: 'shooter-check',
  archetype: 'shooter',
  weapon: { enabled: true },
  entities: {
    monsters: [{ type: 'chaser', count: 12 }],
    pickups: [
      { kind: 'ammo', count: 5 },
      { kind: 'health', count: 4 },
    ],
  },
  shooter: { waveSize: 4, waveEveryFrames: 300 },
});

const HALF = 42 * SPEC.shooter.arenaScale;
const CORNER = 14;

// rounded-rect SDF (mirrors spaces.js buildArena)
function arenaSdf(x, y) {
  const qx = Math.abs(x) - (HALF - CORNER);
  const qy = Math.abs(y) - (HALF - CORNER);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - CORNER;
}

function runEpisode(seed, frames) {
  const w = new World(seed, SPEC);
  const traj = [];
  const counts = {};
  const keyFrames = Object.fromEntries(w.actionKeys.map((k) => [k, 0]));
  let aliveFrames = 0;
  let stretch = 0;
  let maxStretch = 0;
  let maxAlive = 0;
  let worstSdf = -Infinity;
  for (let f = 0; f < frames; f++) {
    const { keys, frameEvents } = w.stepFrame();
    for (const k of w.actionKeys) if (keys[k]) keyFrames[k]++;
    for (const e of frameEvents) {
      counts[e.name] = (counts[e.name] || 0) + 1;
    }
    if (w.respawnSub > 0) {
      stretch = 0;
    } else {
      aliveFrames++;
      stretch++;
      if (stretch > maxStretch) maxStretch = stretch;
    }
    const c = w.car;
    if (!Number.isFinite(c.x + c.y + c.vx + c.vy + c.heading + c.u + w.health + w.score)) {
      throw new Error(`NaN/Inf avatar state at frame ${f} (seed ${seed})`);
    }
    for (const m of w.entities.monsters) {
      if (!Number.isFinite(m.x + m.y)) throw new Error(`NaN monster ${m.id} at frame ${f} (seed ${seed})`);
    }
    worstSdf = Math.max(worstSdf, arenaSdf(c.x, c.y));
    let alive = 0;
    for (const m of w.entities.monsters) if (m.alive) alive++;
    maxAlive = Math.max(maxAlive, alive);
    traj.push([c.x, c.y, c.heading, c.u, w.score]);
  }
  // snapshot contract: mode extends the physics record with shooter state
  const snap = w.snapshot();
  if (!snap.shooter || typeof snap.shooter.wave !== 'number' || typeof snap.shooter.alive !== 'number') {
    throw new Error(`snapshot missing shooter block (seed ${seed}): ${JSON.stringify(snap.shooter)}`);
  }
  return { w, traj, counts, keyFrames, aliveFrames, maxStretch, maxAlive, worstSdf };
}

// --- 1. determinism: same (seed, spec) twice => identical trajectory + events
{
  const a = runEpisode(1234, 600);
  const b = runEpisode(1234, 600);
  const same =
    JSON.stringify(a.traj) === JSON.stringify(b.traj) &&
    JSON.stringify(a.w.events) === JSON.stringify(b.w.events);
  console.log(same ? 'PASS determinism' : 'FAIL determinism');
  if (!same) process.exit(1);
}

// --- 2. waves, competence, containment across seeds
const FRAMES = 1600; // 80 s
let hardFails = 0;
let killsOk = 0;
let surviveOk = 0;
const allKeys = {};
for (let seed = 1; seed <= 6; seed++) {
  const r = runEpisode(seed, FRAMES);
  const c = r.counts;
  const waves = c.WaveStarted || 0;
  const kills = c.MonsterKilled || 0;
  const deaths = c.CarDestroyed || 0;
  for (const [k, v] of Object.entries(r.keyFrames)) allKeys[k] = (allKeys[k] || 0) + v;

  const problems = [];
  if (waves < 3) problems.push(`WaveStarted ${waves} < 3`);
  if (r.worstSdf > -0.4) problems.push(`avatar left arena (worst SDF ${r.worstSdf.toFixed(2)})`);
  if (r.maxAlive > 12) problems.push(`alive count ${r.maxAlive} exceeds spawn total`);
  if ((c.Fired || 0) < 5) problems.push(`Fired ${c.Fired || 0} < 5`);
  if (problems.length) hardFails++;
  if (kills >= 2) killsOk++;
  if (r.aliveFrames >= 800) surviveOk++; // deaths allowed; uptime must hold

  console.log(
    `seed ${seed}: waves=${waves} kills=${kills} deaths=${deaths} ` +
      `alive=${r.aliveFrames}/${FRAMES}f maxStretch=${r.maxStretch}f score=${r.w.score} ` +
      `fired=${c.Fired || 0} wallHits=${c.WallHit || 0} maxAlive=${r.maxAlive} ` +
      `worstSdf=${r.worstSdf.toFixed(2)}` +
      (problems.length ? `  <-- ${problems.join('; ')}` : ''),
  );
}
console.log('key usage over 6 episodes (fraction of frames):');
for (const [k, v] of Object.entries(allKeys)) {
  console.log(`  ${k.padEnd(10)} ${(v / (6 * FRAMES)).toFixed(3)}`);
}

const unusedKeys = Object.entries(allKeys).filter(([, v]) => v === 0).map(([k]) => k);
let fail = hardFails > 0;
if (unusedKeys.length) {
  console.log(`FAIL action coverage: never pressed ${unusedKeys.join(', ')}`);
  fail = true;
}
console.log(killsOk >= 4 ? `PASS kills (${killsOk}/6 seeds >= 2 kills)` : `FAIL kills (${killsOk}/6 seeds >= 2 kills)`);
console.log(surviveOk >= 4 ? `PASS survival (${surviveOk}/6 seeds alive >= 800 frames)` : `FAIL survival (${surviveOk}/6 seeds alive >= 800 frames)`);
if (killsOk < 4 || surviveOk < 4) fail = true;
console.log(hardFails === 0 ? 'PASS invariants (waves/containment/finite)' : `FAIL invariants (${hardFails}/6 seeds)`);
process.exit(fail ? 1 : 0);
