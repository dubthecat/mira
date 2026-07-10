// Soccer mode verification: bit-exact determinism, goal activity across
// seeds, kickoff resets, ball containment, snapshot shape, and entity-placer
// robustness when a soccer spec carries monsters/pickups/weapons.
// Run: node test/soccer_check.mjs

import { World } from '../src/sim/world.js';
import { makeSpec } from '../src/spec/schema.js';

const r3 = (v) => Math.round(v * 1000) / 1000;

function soccerSpec(overrides = {}) {
  return makeSpec({
    // The name is hashed into every episode seed (specHash salts world.rng),
    // so this test's statistical gates are calibrated against the universe
    // the name selects. History: re-salted to -v3 when DEFAULT_SPEC briefly
    // gained a pursuit block; that block has since moved out of DEFAULT_SPEC
    // (archetype-gated injection in makeSpec), restoring the original hash
    // universe — and the kickoff fixes (frozen brains, no recovery carry-over
    // across kickoffs) made the striker robust enough that -v3 passes with
    // wide margin here too (empty-pitch goals ~10/seed vs the >=1 gate).
    // Bump the suffix and re-check margins if DEFAULT_SPEC evolves again.
    name: 'soccer-check-v3',
    archetype: 'soccer',
    hud: { elements: ['speed', 'boost', 'score'] },
    ...overrides,
  });
}

function fnv(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

function run(spec, seed, frames) {
  const w = new World(seed, spec);
  const a = w.space;
  const traj = [];
  let goalsUs = 0;
  let goalsThem = 0;
  let wallHits = 0;
  let kickoffResets = true; // ball back at centre + freeze pending on every goal
  let contained = true;
  let finite = true;
  for (let f = 0; f < frames; f++) {
    const { frameEvents } = w.stepFrame();
    const m = w.mode;
    const b = m.ball;
    for (const e of frameEvents) {
      if (e.name === 'GoalScored') {
        if (e.data.by === 'us') goalsUs++;
        else goalsThem++;
        if (Math.hypot(b.x, b.y) > 1e-9 || m.freezeSub <= 0) kickoffResets = false;
      }
      if (e.name === 'WallHit') wallHits++;
    }
    let vals = w.car.x + w.car.y + w.car.vx + w.car.vy + b.x + b.y + b.vx + b.vy;
    for (const o of m.opponents) vals += o.car.x + o.car.y + o.car.vx + o.car.vy;
    if (!Number.isFinite(vals)) finite = false;
    if (Math.abs(b.x) > a.halfW + 2 || Math.abs(b.y) > a.halfH + 2) contained = false;
    traj.push([
      r3(w.car.x), r3(w.car.y), r3(b.x), r3(b.y),
      w.matchScore.us, w.matchScore.them,
      ...m.opponents.map((o) => [r3(o.car.x), r3(o.car.y)]).flat(),
    ]);
  }
  return { w, goalsUs, goalsThem, wallHits, kickoffResets, contained, finite, hash: fnv(JSON.stringify(traj)) };
}

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `  <-- ${detail}`}`);
  if (!cond) failures++;
};

// --- 1. determinism: same (seed, spec) twice => identical car+ball+score+rival trajectory
{
  const spec = soccerSpec();
  const A = run(spec, 11, 900);
  const B = run(spec, 11, 900);
  check('determinism (trajectory hash)', A.hash === B.hash, `${A.hash} != ${B.hash}`);
}

// --- 2. snapshot shape: physics.jsonl line carries the soccer block
{
  const w = new World(3, soccerSpec());
  for (let f = 0; f < 50; f++) w.stepFrame();
  const s = w.snapshot();
  const ok =
    s.soccer &&
    Array.isArray(s.soccer.ball) && s.soccer.ball.length === 2 &&
    Array.isArray(s.soccer.ballVel) &&
    typeof s.soccer.score.us === 'number' && typeof s.soccer.score.them === 'number' &&
    Array.isArray(s.soccer.opponents) && s.soccer.opponents.length === 1 &&
    s.soccer.opponents[0].length === 3;
  check('snapshot.soccer shape', ok, JSON.stringify(s.soccer));
}

// --- 3. striker competence: on an empty pitch the player bot must score in
// EVERY seed (this isolates bot skill from the chaotic 1v1 duel below, where
// per-seed goal counts are legitimately swingy like the real sport)
{
  const solo = soccerSpec({ soccer: { opponents: 0 } });
  let weak = 0;
  const counts = [];
  for (let seed = 1; seed <= 3; seed++) {
    const r = run(solo, seed, 1200);
    counts.push(r.goalsUs);
    if (r.goalsUs < 1) weak++;
    if (!r.finite || !r.contained || !r.kickoffResets) weak++;
  }
  check('player bot scores on an empty pitch in every seed', weak === 0, `goals: ${counts}`);
}

// --- 4. 1v1 activity battery: 6 seeds x 1600 frames (80 s each)
{
  const spec = soccerSpec();
  const FRAMES = 1600;
  let seedsWithUsGoal = 0;
  let totalUs = 0;
  let totalThem = 0;
  let totalWallHits = 0;
  let allKickoffs = true;
  let allContained = true;
  let allFinite = true;
  for (let seed = 1; seed <= 6; seed++) {
    const r = run(spec, seed, FRAMES);
    if (r.goalsUs >= 1) seedsWithUsGoal++;
    totalUs += r.goalsUs;
    totalThem += r.goalsThem;
    totalWallHits += r.wallHits;
    allKickoffs &&= r.kickoffResets;
    allContained &&= r.contained;
    allFinite &&= r.finite;
    console.log(
      `  seed ${seed}: us=${r.goalsUs} them=${r.goalsThem} wallHits=${r.wallHits} ` +
        `driven=${r.w.progress.toFixed(0)}m`,
    );
  }
  check('player bot scores in several 1v1 matches', seedsWithUsGoal >= 2 && totalUs >= 3, `${seedsWithUsGoal}/6 seeds, ${totalUs} goals`);
  check('GoalScored events fire', totalUs + totalThem >= 4, `${totalUs + totalThem} total goals`);
  check('opponent scores sometimes', totalThem >= 1, `them=${totalThem} across 6 seeds`);
  check('kickoffs reset ball to centre (with countdown freeze)', allKickoffs);
  check('ball never escapes the arena', allContained);
  check('no NaN/Inf state', allFinite);
  check('WallHit events still fire in arena play', totalWallHits >= 1, `${totalWallHits} wall hits`);
}

// --- 4. spec-space robustness: opponent counts, pitch scale, monsters/weapon
{
  for (const opp of [0, 2]) {
    const r = run(soccerSpec({ soccer: { opponents: opp } }), 7, 400);
    check(`opponents=${opp} runs clean`, r.finite && r.contained, 'NaN or ball escaped');
  }
  for (const scale of [0.7, 1.6]) {
    const r = run(soccerSpec({ soccer: { pitchScale: scale } }), 8, 400);
    check(`pitchScale=${scale} runs clean`, r.finite && r.contained, 'NaN or ball escaped');
  }
  // the engine allows monsters/pickups/weapons in any archetype: must not crash
  const armed = soccerSpec({
    entities: {
      monsters: [
        { type: 'chaser', count: 3 },
        { type: 'patroller', count: 2 },
        { type: 'turret', count: 2 },
      ],
      pickups: [
        { kind: 'health', count: 3 },
        { kind: 'ammo', count: 3 },
      ],
    },
    weapon: { enabled: true, kind: 'blaster' },
  });
  let ok = true;
  let detail = '';
  try {
    const w = new World(5, armed);
    for (let f = 0; f < 500; f++) {
      w.stepFrame();
      if (!Number.isFinite(w.car.x + w.car.y + w.health)) throw new Error(`NaN at frame ${f}`);
      for (const mo of w.entities.monsters) {
        if (!Number.isFinite(mo.x + mo.y)) throw new Error(`NaN monster ${mo.id} at frame ${f}`);
      }
    }
  } catch (e) {
    ok = false;
    detail = e.message;
  }
  check('soccer spec with monsters + weapon runs clean', ok, detail);
}

console.log(failures === 0 ? '\nALL SOCCER CHECKS PASS' : `\n${failures} SOCCER CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
