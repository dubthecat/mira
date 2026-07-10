// Accounting-invariant battle-test: run bot-driven episodes across specs and
// seeds, capture per-frame state (direct world fields + stepFrame's returned
// frameEvents) and assert the engine's bookkeeping *identities* hold at every
// frame — exact ledgers, not statistical gates. Every frame-over-frame delta
// of ammo/health/score/lap/boost must be fully explained by that frame's
// events, and event timing (fire cooldown, contact invuln, respawn freeze)
// must match the substep arithmetic in src/sim/world.js exactly.
// Run: node test/invariants_check.mjs [--frames 2000] [--seeds 3]

import { World, FPS, SUBSTEPS, DT } from '../src/sim/world.js';
import { makeSpec, WEAPON_KINDS, MONSTER_TYPES } from '../src/spec/schema.js';
import { CAR } from '../src/sim/car.js';

const args = process.argv.slice(2);
const FRAMES = parseInt(args[args.indexOf('--frames') + 1] || '2000', 10) || 2000;
const NSEEDS = parseInt(args[args.indexOf('--seeds') + 1] || '3', 10) || 3;
const SEEDS = Array.from({ length: NSEEDS }, (_, i) => 100 + i);
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Specs under test: heavy combat (all monster types + blaster), spread-shotgun
// horde, and classic racing (no combat — asserts *absence* of combat state).
// combat-heavy lowers healthMax so deaths actually happen and the
// destroy/freeze/respawn accounting is exercised, not vacuously passed.
const SPECS = [
  {
    key: 'combat-heavy',
    classic: false,
    spec: makeSpec({
      name: 'inv-combat-heavy',
      world: { biome: 'lava' },
      entities: {
        monsters: [
          { type: 'chaser', count: 10 },
          { type: 'patroller', count: 6 },
          { type: 'turret', count: 6 },
        ],
        pickups: [
          { kind: 'health', count: 3 },
          { kind: 'ammo', count: 6 },
        ],
      },
      weapon: { enabled: true, kind: 'blaster' },
      rules: { healthMax: 60 }, // 3 hits to die: exercises destroy/respawn
      hud: { elements: ['speed', 'boost', 'health', 'ammo', 'score', 'lap', 'minimap'] },
    }),
  },
  {
    key: 'horde-spread',
    classic: false,
    spec: makeSpec({
      name: 'inv-horde-spread',
      world: { biome: 'desert' },
      entities: {
        monsters: [{ type: 'chaser', count: 14 }],
        pickups: [
          { kind: 'health', count: 6 },
          { kind: 'ammo', count: 8 },
        ],
      },
      weapon: { enabled: true, kind: 'spread' },
    }),
  },
  {
    key: 'classic-racing',
    classic: true,
    spec: makeSpec({ name: 'inv-classic-racing' }),
  },
];

const INVARIANTS = ['AMMO', 'HEALTH', 'SCORE', 'FIRE_RATE', 'BOOST', 'LAPS', 'INVULN', 'RESPAWN'];

// events that must never appear in a combat-free spec
const COMBAT_EVENTS = new Set([
  'Fired', 'TurretFired', 'MonsterContact', 'MonsterHit', 'MonsterKilled',
  'CarShot', 'CarDamaged', 'CarDestroyed', 'CarRespawned', 'HealthPickup', 'AmmoPickup',
]);

const STAT_NAMES = [
  'Fired', 'AmmoPickup', 'CarDamaged', 'HealthPickup', 'MonsterKilled',
  'LapCompleted', 'BoostPickup', 'CarDestroyed', 'CarRespawned',
];

// can `target` be written as a sum of a sub-multiset of vals? (used to check
// a CarDamaged delta against the frame's contact/shot damage pool)
function subsetSumExists(vals, target) {
  if (target === 0) return true;
  let sums = new Set([0]);
  for (const v of vals) {
    const add = [];
    for (const s of sums) {
      const t = s + v;
      if (t === target) return true;
      if (t < target) add.push(t);
    }
    for (const t of add) sums.add(t);
  }
  return false;
}

// ---------------------------------------------------------------------------
// One episode: step the world frame by frame, replay every frame's events
// against ledgers seeded from the previous frame's directly-read fields, and
// report any unexplained delta or mistimed event via V(invariant, message).
function runEpisode(spec, classic, seed, frames, V) {
  const world = new World(seed, spec);
  const rules = spec.rules;
  const armed = spec.weapon.enabled;
  const wk = armed ? WEAPON_KINDS[spec.weapon.kind] : null;
  // world.js: fireCooldownSub = Math.round(FPS*SUBSTEPS / fireRate), one
  // decrement per substep => consecutive Fired frames >= ceil(cooldownSub/3)
  const cooldownSub = armed ? Math.round((FPS * SUBSTEPS) / wk.fireRate) : 0;
  const minFireGap = armed ? Math.ceil(cooldownSub / SUBSTEPS) : 0;
  const L = world.track.length;
  const regen = CAR.boostRegen * DT;
  const maxDrain = CAR.boostDrain * DT * SUBSTEPS;
  const shotDamage = MONSTER_TYPES.turret.damage; // only turrets fire hostile shots

  const capture = () => ({
    health: world.health,
    ammo: world.ammo,
    score: world.score,
    lap: world.lap,
    boost: world.car.boost,
    x: world.car.x,
    y: world.car.y,
    progress: world.progress,
    respawnSub: world.respawnSub,
  });

  let pre = capture();
  let lastFired = -1;
  let lastDamaged = -1;
  let inFreeze = false;
  let freeze = null; // { frame, x, y } — position captured at end of death frame
  const stats = Object.fromEntries(STAT_NAMES.map((n) => [n, 0]));

  for (let f = 0; f < frames; f++) {
    const { keys, frameEvents: ev } = world.stepFrame();
    const post = capture();
    const at = `seed ${seed} frame ${f}`;

    for (const e of ev) if (stats[e.name] !== undefined) stats[e.name]++;
    const nKills = ev.filter((e) => e.name === 'MonsterKilled').length;
    const nPads = ev.filter((e) => e.name === 'BoostPickup').length;
    const hasDestroy = ev.some((e) => e.name === 'CarDestroyed');
    const hasRespawn = ev.some((e) => e.name === 'CarRespawned');

    // -- INV8: fully-frozen frames (dead at frame start, not yet respawned):
    // car position is untouched and boost cannot change (car.step never runs)
    if (inFreeze && !hasRespawn && freeze && freeze.x !== null) {
      if (post.x !== freeze.x || post.y !== freeze.y) {
        V('RESPAWN', `${at}: car moved during death freeze ` +
          `(${freeze.x.toFixed(4)},${freeze.y.toFixed(4)}) -> (${post.x.toFixed(4)},${post.y.toFixed(4)})`);
      }
      if (post.boost !== pre.boost) {
        V('BOOST', `${at}: boost changed during death freeze ${pre.boost} -> ${post.boost}`);
      }
    }

    // -- ordered event replay: ledgers for ammo/health/lap + freeze-window bans
    let aLedger = pre.ammo;
    let hLedger = pre.health;
    let lapLedger = pre.lap;
    let damagedToZero = 0;
    let destroyedCount = 0;
    const dmgPool = [];
    for (const e of ev) {
      if (e.name === 'MonsterContact') dmgPool.push(MONSTER_TYPES[e.data.type].damage);
      else if (e.name === 'CarShot') dmgPool.push(shotDamage);
    }

    for (const e of ev) {
      switch (e.name) {
        case 'Fired': {
          if (inFreeze) V('FIRE_RATE', `${at}: Fired during respawn freeze`);
          if (!armed) {
            V('AMMO', `${at}: Fired in weaponless spec`);
            break;
          }
          if (aLedger < wk.ammoPerShot) {
            V('FIRE_RATE', `${at}: Fired with ammo ${aLedger} < ammoPerShot ${wk.ammoPerShot}`);
          }
          aLedger -= wk.ammoPerShot;
          if (e.data.ammo !== aLedger) {
            V('AMMO', `${at}: Fired should leave ammo ${aLedger}, event says ${e.data.ammo}`);
            aLedger = e.data.ammo; // resync to avoid cascades
          }
          if (lastFired >= 0 && f - lastFired < minFireGap) {
            V('FIRE_RATE', `${at}: fire gap ${f - lastFired} frames < min ${minFireGap} (prev Fired frame ${lastFired})`);
          }
          lastFired = f;
          break;
        }
        case 'AmmoPickup': {
          if (inFreeze) V('RESPAWN', `${at}: AmmoPickup during respawn freeze`);
          const nA = e.data.ammo;
          // engine collects +8 per pickup, capped; >1 pickup can land in one
          // substep (single event), so accept +8*n capped at ammoMax
          const ok = nA > aLedger && nA <= spec.weapon.ammoMax &&
            (nA === spec.weapon.ammoMax || (nA - aLedger) % 8 === 0);
          if (!ok) {
            V('AMMO', `${at}: AmmoPickup ${aLedger} -> ${nA} is not +8*n capped at ${spec.weapon.ammoMax}`);
          }
          aLedger = nA;
          break;
        }
        case 'CarDamaged': {
          if (inFreeze) V('HEALTH', `${at}: CarDamaged during death freeze`);
          const nH = e.data.health;
          if (!(nH < hLedger)) {
            V('HEALTH', `${at}: CarDamaged did not decrease health (${hLedger} -> ${nH})`);
          }
          const delta = hLedger - nH;
          if (nH === 0) {
            damagedToZero++;
            const total = dmgPool.reduce((a, b) => a + b, 0);
            if (!(delta > 0 && total >= delta)) {
              V('HEALTH', `${at}: fatal damage ${delta} exceeds frame damage pool [${dmgPool}]`);
            }
          } else if (!subsetSumExists(dmgPool, delta)) {
            V('HEALTH', `${at}: damage ${delta} is not a sum of this frame's contact/shot damages [${dmgPool}]`);
          }
          if (lastDamaged >= 0 && f - lastDamaged < rules.contactInvulnFrames) {
            V('INVULN', `${at}: CarDamaged gap ${f - lastDamaged} frames < contactInvulnFrames ${rules.contactInvulnFrames} (prev frame ${lastDamaged})`);
          }
          lastDamaged = f;
          hLedger = nH;
          break;
        }
        case 'HealthPickup': {
          if (inFreeze) V('RESPAWN', `${at}: HealthPickup during respawn freeze`);
          const nH = e.data.health;
          const ok = nH > hLedger && nH <= rules.healthMax &&
            (nH === rules.healthMax || (nH - hLedger) % 30 === 0);
          if (!ok) {
            V('HEALTH', `${at}: HealthPickup ${hLedger} -> ${nH} is not +30*n capped at ${rules.healthMax}`);
          }
          hLedger = nH;
          break;
        }
        case 'CarDestroyed': {
          destroyedCount++;
          if (hLedger !== 0) V('HEALTH', `${at}: CarDestroyed with health ${hLedger} != 0`);
          if (inFreeze) V('RESPAWN', `${at}: CarDestroyed while already destroyed`);
          inFreeze = true;
          freeze = { frame: f, x: null, y: null }; // position pinned at frame end
          break;
        }
        case 'CarRespawned': {
          if (!inFreeze) {
            V('RESPAWN', `${at}: CarRespawned without a preceding CarDestroyed`);
          } else if (f - freeze.frame !== rules.respawnFrames) {
            V('RESPAWN', `${at}: respawned ${f - freeze.frame} frames after destroy, expected exactly ${rules.respawnFrames}`);
          }
          inFreeze = false;
          freeze = null;
          hLedger = rules.healthMax;
          break;
        }
        case 'BoostPickup': {
          if (inFreeze) V('RESPAWN', `${at}: BoostPickup during respawn freeze`);
          break;
        }
        case 'LapCompleted': {
          if (inFreeze) V('RESPAWN', `${at}: LapCompleted during respawn freeze`);
          lapLedger++;
          if (e.data.lap !== lapLedger) {
            V('LAPS', `${at}: LapCompleted lap ${e.data.lap} != expected ${lapLedger}`);
          }
          break;
        }
      }
    }
    if (inFreeze && freeze && freeze.x === null) {
      freeze.x = post.x;
      freeze.y = post.y;
    }

    // -- INV2: CarDestroyed fires exactly when health reaches 0
    if (damagedToZero !== destroyedCount) {
      V('HEALTH', `${at}: ${damagedToZero} CarDamaged-to-zero vs ${destroyedCount} CarDestroyed`);
    }

    // -- INV1: ammo bounds + frame delta fully explained by events
    if (post.ammo < 0 || post.ammo > spec.weapon.ammoMax) {
      V('AMMO', `${at}: ammo ${post.ammo} out of [0, ${spec.weapon.ammoMax}]`);
    }
    if (aLedger !== post.ammo) {
      V('AMMO', `${at}: ammo ${pre.ammo} -> ${post.ammo} unexplained by events (ledger says ${aLedger})`);
    }

    // -- INV2: health bounds + frame delta fully explained by events
    if (post.health < 0 || post.health > rules.healthMax) {
      V('HEALTH', `${at}: health ${post.health} out of [0, ${rules.healthMax}]`);
    }
    if (hLedger !== post.health) {
      V('HEALTH', `${at}: health ${pre.health} -> ${post.health} unexplained by events (ledger says ${hLedger})`);
    }

    // -- INV3: score moves exactly scorePerKill per MonsterKilled
    if (post.score - pre.score !== nKills * rules.scorePerKill) {
      V('SCORE', `${at}: score ${pre.score} -> ${post.score} with ${nKills} kills (expected +${nKills * rules.scorePerKill})`);
    }

    // -- INV6: lap counter matches LapCompleted events; progress ~ lap * L
    if (post.lap < pre.lap) V('LAPS', `${at}: lap decreased ${pre.lap} -> ${post.lap}`);
    if (post.lap !== lapLedger) {
      V('LAPS', `${at}: lap ${pre.lap} -> ${post.lap} but ${lapLedger - pre.lap} LapCompleted event(s)`);
    }
    if (lapLedger !== pre.lap && Math.abs(post.progress - post.lap * L) > 5) {
      V('LAPS', `${at}: at LapCompleted, progress ${post.progress.toFixed(2)} vs lap*L ${(post.lap * L).toFixed(2)} (> 5 m apart)`);
    }

    // -- INV5: boost meter bounds + per-frame delta envelope
    if (post.boost < -EPS || post.boost > 100 + EPS) {
      V('BOOST', `${at}: boost ${post.boost} out of [0, 100]`);
    }
    const lower = Math.max(0, pre.boost - maxDrain) - EPS;
    const upper = Math.min(100, pre.boost + SUBSTEPS * regen + 30 * nPads) + EPS;
    if (post.boost < lower || post.boost > upper) {
      V('BOOST', `${at}: boost ${pre.boost.toFixed(4)} -> ${post.boost.toFixed(4)} outside [${lower.toFixed(4)}, ${upper.toFixed(4)}] (pads=${nPads})`);
    }
    // exact passive regen when nothing else can touch the meter this frame
    if (!keys.LShiftKey && nPads === 0 && pre.respawnSub === 0 && !hasDestroy && !hasRespawn) {
      const expected = Math.min(100, pre.boost + SUBSTEPS * regen);
      if (Math.abs(post.boost - expected) > EPS) {
        V('BOOST', `${at}: passive regen expected ${expected.toFixed(6)}, got ${post.boost.toFixed(6)}`);
      }
    }

    // -- classic spec: combat state must be entirely absent
    if (classic) {
      const bad = ev.find((e) => COMBAT_EVENTS.has(e.name));
      if (bad) V('NO_COMBAT', `${at}: unexpected ${bad.name} in combat-free spec`);
      if (post.ammo !== 0) V('NO_COMBAT', `${at}: ammo ${post.ammo} != 0`);
      if (post.health !== rules.healthMax) V('NO_COMBAT', `${at}: health ${post.health} != ${rules.healthMax}`);
      if (post.score !== 0) V('NO_COMBAT', `${at}: score ${post.score} != 0`);
    }

    pre = post;
  }
  return stats;
}

// ---------------------------------------------------------------------------
let anyFail = false;

for (const { key, spec, classic } of SPECS) {
  const viol = new Map(); // invariant -> { count, samples[] }
  const V = (inv, msg) => {
    const v = viol.get(inv) || { count: 0, samples: [] };
    v.count++;
    if (v.samples.length < 3) v.samples.push(msg);
    viol.set(inv, v);
  };

  const stats = Object.fromEntries(STAT_NAMES.map((n) => [n, 0]));
  for (const seed of SEEDS) {
    const s = runEpisode(spec, classic, seed, FRAMES, V);
    for (const n of STAT_NAMES) stats[n] += s[n];
  }

  const ctx = {
    AMMO: `${stats.Fired} Fired, ${stats.AmmoPickup} AmmoPickup`,
    HEALTH: `${stats.CarDamaged} CarDamaged, ${stats.HealthPickup} HealthPickup, ${stats.CarDestroyed} CarDestroyed`,
    SCORE: `${stats.MonsterKilled} MonsterKilled`,
    FIRE_RATE: `${stats.Fired} Fired`,
    BOOST: `${stats.BoostPickup} BoostPickup`,
    LAPS: `${stats.LapCompleted} LapCompleted`,
    INVULN: `${stats.CarDamaged} CarDamaged`,
    RESPAWN: `${stats.CarDestroyed} destroyed, ${stats.CarRespawned} respawned`,
    NO_COMBAT: `combat-free stream verified`,
  };

  console.log(`\n=== ${key} — ${SEEDS.length} seeds x ${FRAMES} frames ===`);
  const invs = classic ? [...INVARIANTS, 'NO_COMBAT'] : INVARIANTS;
  for (const inv of invs) {
    const v = viol.get(inv);
    if (!v) {
      console.log(`PASS ${key.padEnd(14)} ${inv.padEnd(9)} (${ctx[inv]})`);
    } else {
      anyFail = true;
      console.log(`FAIL ${key.padEnd(14)} ${inv.padEnd(9)} ${v.count} violation(s)`);
      for (const s of v.samples) console.log(`     ^-- ${s}`);
    }
  }
}

console.log(anyFail ? '\nINVARIANT FAILURES' : '\nALL INVARIANTS HOLD');
process.exit(anyFail ? 1 : 0);
