// Pursuit mode verification: bit-exact determinism, evasion competence across
// seeds (survives, gets caught sometimes, wrecks hunters), containment, event
// bookkeeping and finite state. Run: node test/pursuit_check.mjs

import { World } from '../src/sim/world.js';
import { makeSpec } from '../src/spec/schema.js';

const r3 = (v) => Math.round(v * 1000) / 1000;

function pursuitSpec(overrides = {}) {
  return makeSpec({
    name: 'pursuit-check',
    archetype: 'pursuit',
    pursuit: { hunters: 3 },
    weapon: { enabled: true },
    entities: {
      pickups: [
        { kind: 'health', count: 3 },
        { kind: 'ammo', count: 4 },
      ],
    },
    hud: { elements: ['speed', 'boost', 'health', 'score'] },
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
  const extent = w.space.extent;
  const traj = [];
  const counts = {};
  let firstDeath = -1;
  let contained = true;
  let finite = true;
  let heatOk = true;
  let heatFrames = 0;
  for (let f = 0; f < frames; f++) {
    const { frameEvents } = w.stepFrame();
    for (const e of frameEvents) counts[e.name] = (counts[e.name] || 0) + 1;
    if (firstDeath < 0 && frameEvents.some((e) => e.name === 'CarDestroyed')) firstDeath = f;

    let vals = w.car.x + w.car.y + w.car.vx + w.car.vy + w.health + w.score + w.progress;
    for (const h of w.mode.hunters) vals += h.car.x + h.car.y + h.car.vx + h.car.vy;
    if (!Number.isFinite(vals)) finite = false;
    for (const m of w.entities.monsters) if (!Number.isFinite(m.x + m.y)) finite = false;

    if (Math.hypot(w.car.x, w.car.y) > extent + 2) contained = false;
    for (const h of w.mode.hunters) {
      if (Math.hypot(h.car.x, h.car.y) > extent + 2) contained = false;
    }
    // heat surface: nearest live hunter distance, refreshed while alive.
    // Skipped on the respawn-teleport frame itself: respawnSub can hit zero
    // on a frame's LAST substep, moving the car after the frame's final
    // postStep already ran (the freeze keeps the surface stale by design).
    const respawnedNow = frameEvents.some((e) => e.name === 'CarRespawned');
    if (w.respawnSub <= 0 && !respawnedNow && w.pursuit.alive > 0) {
      let nearest = Infinity;
      for (const h of w.mode.hunters) {
        if (h.wreckedUntil >= 0) continue;
        nearest = Math.min(nearest, Math.hypot(h.car.x - w.car.x, h.car.y - w.car.y));
      }
      if (Math.abs(nearest - w.pursuit.heat) > 0.01) heatOk = false; // refreshed per substep
      if (w.pursuit.heat < 60) heatFrames++;
    }
    traj.push([
      r3(w.car.x), r3(w.car.y), w.score, w.health,
      ...w.mode.hunters.map((h) => [r3(h.car.x), r3(h.car.y), h.wreckedUntil >= 0 ? 1 : 0]).flat(),
    ]);
  }
  return {
    w,
    counts,
    firstDeath,
    survived: firstDeath < 0 ? frames : firstDeath,
    contained,
    finite,
    heatOk,
    heatFrames,
    hash: fnv(JSON.stringify(traj) + JSON.stringify(w.events)),
  };
}

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `  <-- ${detail}`}`);
  if (!cond) failures++;
};

// --- 1. determinism: same (seed, spec) twice => identical trajectory + events
{
  const spec = pursuitSpec();
  const A = run(spec, 11, 900);
  const B = run(spec, 11, 900);
  check('determinism (trajectory+event hash)', A.hash === B.hash, `${A.hash} != ${B.hash}`);
}

// --- 2. snapshot shape: physics.jsonl line carries the pursuit block
{
  const w = new World(3, pursuitSpec());
  for (let f = 0; f < 50; f++) w.stepFrame();
  const s = w.snapshot();
  const ok =
    s.pursuit &&
    Array.isArray(s.pursuit.hunters) &&
    s.pursuit.hunters.length === 3 &&
    s.pursuit.hunters.every((h) => h.length === 4 && (h[3] === 0 || h[3] === 1)) &&
    typeof s.pursuit.heat === 'number' &&
    Number.isFinite(s.pursuit.heat);
  check('snapshot.pursuit shape', ok, JSON.stringify(s.pursuit));
}

// --- 3. evasion battery: 6 seeds x 1600 frames (80 s each)
{
  const spec = pursuitSpec();
  const FRAMES = 1600;
  let totalSurvived = 0;
  let totalDamaged = 0;
  let totalWrecked = 0;
  let seedsDamaged = 0;
  let allContained = true;
  let allFinite = true;
  let allHeatOk = true;
  let ledgerOk = true;
  for (let seed = 1; seed <= 6; seed++) {
    const r = run(spec, seed, FRAMES);
    totalSurvived += r.survived;
    totalDamaged += r.counts.CarDamaged || 0;
    totalWrecked += r.counts.HunterWrecked || 0;
    if ((r.counts.CarDamaged || 0) >= 1) seedsDamaged++;
    allContained &&= r.contained;
    allFinite &&= r.finite;
    allHeatOk &&= r.heatOk;
    // cumulative wreck counter must match emitted events
    if (r.w.pursuit.wrecked !== (r.counts.HunterWrecked || 0)) ledgerOk = false;
    console.log(
      `  seed ${seed}: survived=${r.survived}f damaged=${r.counts.CarDamaged || 0} ` +
        `wrecked=${r.counts.HunterWrecked || 0} deaths=${r.counts.CarDestroyed || 0} ` +
        `score=${r.w.score} hot=${r.heatFrames}f driven=${r.w.progress.toFixed(0)}m`,
    );
  }
  const avgSurvived = totalSurvived / 6;
  check('player survives >= 600 frames on average', avgSurvived >= 600, `avg ${avgSurvived.toFixed(0)}`);
  check('hunters catch the player sometimes (CarDamaged fires)', totalDamaged >= 3 && seedsDamaged >= 3, `${totalDamaged} total in ${seedsDamaged}/6 seeds`);
  check('HunterWrecked fires across seeds', totalWrecked >= 1, `${totalWrecked} wrecks`);
  check('everyone stays inside the field', allContained);
  check('no NaN/Inf state', allFinite);
  check('world.pursuit.heat tracks the nearest live hunter', allHeatOk);
  check('world.pursuit.wrecked matches HunterWrecked events', ledgerOk);
}

// --- 4. spec-space robustness: hunter counts, heat, world scale, unarmed
{
  for (const hunters of [1, 5]) {
    const r = run(pursuitSpec({ pursuit: { hunters } }), 7, 400);
    check(`hunters=${hunters} runs clean`, r.finite && r.contained, 'NaN or escaped the field');
  }
  for (const heat of [0.5, 1.5]) {
    const r = run(pursuitSpec({ pursuit: { hunters: 3, heat } }), 8, 400);
    check(`heat=${heat} runs clean`, r.finite && r.contained, 'NaN or escaped the field');
  }
  {
    const r = run(pursuitSpec({ pursuit: { hunters: 3, worldScale: 0.6 } }), 9, 400);
    check('worldScale=0.6 runs clean', r.finite && r.contained, 'NaN or escaped the field');
  }
  {
    // unarmed spec: no weapon, no pickups — the ram/wreck loop must not
    // depend on projectiles or the F key existing
    const r = run(
      pursuitSpec({ weapon: { enabled: false }, entities: { pickups: [] } }),
      10,
      600,
    );
    check('unarmed pursuit runs clean', r.finite && r.contained, 'NaN or escaped the field');
  }
  {
    // the engine allows monsters in any archetype: the placer must hold up
    const r = run(
      pursuitSpec({
        entities: {
          monsters: [
            { type: 'chaser', count: 3 },
            { type: 'turret', count: 2 },
            { type: 'bomber', count: 2 },
          ],
          pickups: [{ kind: 'health', count: 3 }],
        },
      }),
      12,
      500,
    );
    check('pursuit spec with monsters runs clean', r.finite && r.contained, 'NaN or escaped the field');
  }
}

console.log(failures === 0 ? '\nALL PURSUIT CHECKS PASS' : `\n${failures} PURSUIT CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
