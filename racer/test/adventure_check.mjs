// Adventure mode verification: bit-exact determinism, relic-collection
// competence across seeds, objective/event invariants, containment, and
// finite state. Run: node test/adventure_check.mjs
import { World } from '../src/sim/world.js';
import { makeSpec } from '../src/spec/schema.js';

const OVERRIDES = {
  archetype: 'adventure',
  weapon: { enabled: true },
  adventure: { relics: 5 },
  entities: {
    monsters: [
      { type: 'chaser', count: 6 },
      { type: 'turret', count: 3 },
    ],
    pickups: [
      { kind: 'health', count: 4 },
      { kind: 'ammo', count: 4 },
    ],
  },
};

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`FAIL ${msg}`);
};

function runEpisode(seed, frames, checkInvariants = true) {
  const w = new World(seed, makeSpec(OVERRIDES));
  const extent = w.space.extent;
  const traj = [];
  let lastCollectedCount = 0;
  const relicEvents = [];
  let completeEvents = 0;

  for (let f = 0; f < frames; f++) {
    const { frameEvents } = w.stepFrame();
    traj.push([w.car.x, w.car.y, w.car.heading, w.car.u, w.score, w.health]);

    for (const e of frameEvents) {
      if (e.name === 'RelicCollected') relicEvents.push(e.data);
      if (e.name === 'AdventureComplete') completeEvents++;
    }

    if (!checkInvariants) continue;

    // no NaN anywhere in the live state
    if (!Number.isFinite(w.car.x + w.car.y + w.car.vx + w.car.vy + w.health + w.score + w.progress)) {
      fail(`seed ${seed}: NaN/Inf avatar state at frame ${f}`);
      break;
    }
    for (const m of w.entities.monsters) {
      if (!Number.isFinite(m.x + m.y)) {
        fail(`seed ${seed}: NaN monster ${m.id} at frame ${f}`);
        break;
      }
    }

    // containment: the cliff ring is a hard boundary
    if (Math.hypot(w.car.x, w.car.y) > extent + 2) {
      fail(`seed ${seed}: avatar escaped the field at frame ${f} (r=${Math.hypot(w.car.x, w.car.y).toFixed(1)})`);
      break;
    }

    // objective always points at an uncollected relic (until all collected)
    const o = w.objective;
    if (o.collected < o.total) {
      const rl = w.relics[o.targetIdx];
      if (!rl || rl.collected || rl.x !== o.targetX || rl.y !== o.targetY) {
        fail(`seed ${seed}: objective target invalid at frame ${f}`);
        break;
      }
    }
    if (o.collected < lastCollectedCount) {
      fail(`seed ${seed}: collected count went backwards at frame ${f}`);
      break;
    }
    lastCollectedCount = o.collected;

    // snapshot surface stays well-formed
    if (f % 400 === 0) {
      const snap = w.snapshot();
      if (
        !snap.adventure ||
        snap.adventure.total !== o.total ||
        snap.adventure.collected !== o.collected ||
        snap.adventure.target.length !== 2
      ) {
        fail(`seed ${seed}: bad snapshot.adventure at frame ${f}`);
        break;
      }
    }
  }
  return { w, traj, relicEvents, completeEvents };
}

// --- 1. determinism: same (seed, spec) twice => identical trajectory + events
{
  const a = runEpisode(7, 600, false);
  const b = runEpisode(7, 600, false);
  const same =
    JSON.stringify(a.traj) === JSON.stringify(b.traj) &&
    JSON.stringify(a.w.events) === JSON.stringify(b.w.events);
  console.log(same ? 'PASS determinism' : 'FAIL determinism');
  if (!same) process.exit(1);
}

// --- 2. six seeds, 2400 frames: collection competence + invariants
const FRAMES = 2400;
let seedsWith1 = 0;
let seedsWith2 = 0;
for (let seed = 1; seed <= 6; seed++) {
  const { w, relicEvents, completeEvents } = runEpisode(seed, FRAMES);
  const collected = w.objective.collected;

  // RelicCollected data.collected must increment 1, 2, 3, ... with valid index
  for (let i = 0; i < relicEvents.length; i++) {
    if (relicEvents[i].collected !== i + 1) {
      fail(`seed ${seed}: RelicCollected count ${relicEvents[i].collected} at event ${i} (want ${i + 1})`);
    }
    if (!(relicEvents[i].index >= 0 && relicEvents[i].index < w.objective.total)) {
      fail(`seed ${seed}: RelicCollected index out of range: ${relicEvents[i].index}`);
    }
  }
  if (relicEvents.length !== collected) {
    fail(`seed ${seed}: ${relicEvents.length} RelicCollected events but objective.collected=${collected}`);
  }
  if (collected >= w.objective.total && completeEvents !== 1) {
    fail(`seed ${seed}: all relics collected but ${completeEvents} AdventureComplete events`);
  }
  if (collected < w.objective.total && completeEvents !== 0) {
    fail(`seed ${seed}: AdventureComplete fired early`);
  }

  if (collected >= 1) seedsWith1++;
  if (collected >= 2) seedsWith2++;
  const kills = w.events.filter((e) => e.name === 'MonsterKilled').length;
  const deaths = w.events.filter((e) => e.name === 'CarDestroyed').length;
  console.log(
    `seed ${seed}: relics=${collected}/${w.objective.total} score=${w.score} ` +
      `dist=${w.progress.toFixed(0)}m kills=${kills} deaths=${deaths} ` +
      `events=${w.events.length}${completeEvents ? ' COMPLETE' : ''}`,
  );
}
if (seedsWith1 < 6) fail(`only ${seedsWith1}/6 seeds collected >=1 relic`);
if (seedsWith2 < 4) fail(`only ${seedsWith2}/6 seeds collected >=2 relics (want most)`);
console.log(`relic competence: ${seedsWith1}/6 seeds >=1, ${seedsWith2}/6 seeds >=2`);

// --- 3. onFoot variant stays sane (slower cap, no NaN, still collects state)
{
  const spec = makeSpec({ ...OVERRIDES, adventure: { relics: 5, onFoot: true } });
  const w = new World(3, spec);
  let maxU = 0;
  for (let f = 0; f < 400; f++) {
    w.stepFrame();
    maxU = Math.max(maxU, Math.abs(w.car.u));
    if (!Number.isFinite(w.car.x + w.car.y)) {
      fail('onFoot: NaN state');
      break;
    }
  }
  if (maxU > 17) fail(`onFoot: too fast (maxU=${maxU.toFixed(1)}, cap should be ~13-16)`);
  else console.log(`PASS onFoot (maxU=${maxU.toFixed(1)} m/s)`);
}

console.log(failures === 0 ? '\nADVENTURE PASS' : `\nADVENTURE FAIL (${failures} problems)`);
process.exit(failures === 0 ? 0 : 1);
