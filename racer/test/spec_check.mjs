// Spec compiler verification: determinism, prompt->spec keyword table,
// override precedence, and validity over random prompt/seed combos.
// Run: node racer/test/spec_check.mjs (any cwd — imports are file-relative)
import { compileSpec, KEYWORDS } from '../src/spec/compile.js';
import { validateSpec, DEFAULT_SPEC } from '../src/spec/schema.js';
import { Rng } from '../src/sim/rng.js';

let fails = 0;
function report(ok, label, detail = '') {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const j = JSON.stringify;

// --- 1. determinism: same (prompt, seed, variety) twice => deep-equal specs
{
  const args = [
    ['desert racing with 8 chasing monsters and a shotgun', { seed: 5 }],
    ['night neon drift race with turrets and a minimap', { seed: 42, variety: 0.8 }],
    ['a race', { seed: 7, variety: 1 }],
  ];
  for (const [prompt, opts] of args) {
    const a = compileSpec(prompt, opts);
    const b = compileSpec(prompt, opts);
    report(deepEq(a, b), `determinism "${prompt}" ${j(opts)}`);
  }
}

// --- 2. keyword table: expected biome / monsters / weapon / hud / scales
const CASES = [
  {
    prompt: 'desert racing with 8 chasing monsters and a shotgun',
    expect: { biome: 'desert', monsters: { chaser: 8 }, weapon: 'spread',
              hud: ['speed', 'boost', 'health', 'ammo', 'score', 'lap'],
              pickups: { health: 3, ammo: 4 } },
  },
  {
    prompt: 'night neon drift race with turrets and a minimap',
    expect: { biome: 'night', monsters: { turret: 5 }, weapon: null, grip: 0.65,
              hud: ['speed', 'boost', 'health', 'score', 'lap', 'minimap'],
              pickups: { health: 3 } },
  },
  {
    prompt: 'peaceful forest cruise no hud',
    expect: { biome: 'meadow', monsters: {}, weapon: null, topSpeed: 0.8, hud: [] },
  },
  {
    prompt: 'slippery snow run',
    expect: { biome: 'snow', monsters: {}, weapon: null, grip: 0.65, hud: ['speed', 'boost'] },
  },
  {
    prompt: 'volcano hell run with many zombies and a laser',
    expect: { biome: 'lava', monsters: { chaser: 10 }, weapon: 'blaster',
              hud: ['speed', 'boost', 'health', 'ammo', 'score'], pickups: { health: 3, ammo: 4 } },
  },
  {
    prompt: 'wide track fast race',
    expect: { biome: 'meadow', width: 1.4, topSpeed: 1.25, hud: ['speed', 'boost', 'lap'] },
  },
  {
    prompt: 'narrow tight circuit with a few patrolling guards',
    expect: { width: 0.75, track: 0.75, monsters: { patroller: 3 },
              hud: ['speed', 'boost', 'health', 'score'] },
  },
  {
    prompt: 'alien horde on the dunes',
    expect: { biome: 'desert', monsters: { chaser: 10 } },
  },
  {
    prompt: 'grippy rails racer with a blaster',
    expect: { grip: 1.4, weapon: 'blaster', monsters: {},
              hud: ['speed', 'boost', 'ammo', 'lap'], pickups: { ammo: 4 } },
  },
  {
    prompt: 'zombie beetle patrol in the dark forest',
    expect: { biome: 'night', monsters: { chaser: 3, patroller: 2 },
              hud: ['speed', 'boost', 'health', 'score'] },
  },
  {
    prompt: 'big long track, clean, slow cruise',
    expect: { track: 1.4, topSpeed: 0.8, hud: [] },
  },
  {
    prompt: 'just vibes',
    expect: { biome: 'meadow', monsters: {}, weapon: null, hud: ['speed', 'boost'] },
  },
];

for (const { prompt, expect } of CASES) {
  const spec = compileSpec(prompt, { seed: 1 });
  const errs = [];
  if (expect.biome && spec.world.biome !== expect.biome) {
    errs.push(`biome ${spec.world.biome} != ${expect.biome}`);
  }
  if (expect.monsters) {
    const got = Object.fromEntries(spec.entities.monsters.map((m) => [m.type, m.count]));
    if (!deepEq(got, expect.monsters)) errs.push(`monsters ${j(got)} != ${j(expect.monsters)}`);
  }
  if ('weapon' in expect) {
    const got = spec.weapon.enabled ? spec.weapon.kind : null;
    if (got !== expect.weapon) errs.push(`weapon ${got} != ${expect.weapon}`);
  }
  if (expect.hud && !deepEq(spec.hud.elements, expect.hud)) {
    errs.push(`hud ${j(spec.hud.elements)} != ${j(expect.hud)}`);
  }
  if (expect.pickups) {
    for (const [kind, count] of Object.entries(expect.pickups)) {
      const p = spec.entities.pickups.find((x) => x.kind === kind);
      if (!p || p.count !== count) errs.push(`pickup ${kind} ${j(p)} != count ${count}`);
    }
  }
  if (expect.grip && spec.vehicle.gripScale !== expect.grip) {
    errs.push(`gripScale ${spec.vehicle.gripScale} != ${expect.grip}`);
  }
  if (expect.topSpeed && spec.vehicle.topSpeedScale !== expect.topSpeed) {
    errs.push(`topSpeedScale ${spec.vehicle.topSpeedScale} != ${expect.topSpeed}`);
  }
  if (expect.width && spec.world.widthScale !== expect.width) {
    errs.push(`widthScale ${spec.world.widthScale} != ${expect.width}`);
  }
  if (expect.track && spec.world.trackScale !== expect.track) {
    errs.push(`trackScale ${spec.world.trackScale} != ${expect.track}`);
  }
  report(errs.length === 0, `keywords "${prompt}"`, errs.join('; '));
}

// name/prompt metadata
{
  const spec = compileSpec('desert racing with 8 chasing monsters and a shotgun', { seed: 7 });
  report(spec.name === 'desert-racing-chasing-monsters-s7', 'name slug', `got ${spec.name}`);
  report(spec.prompt === 'desert racing with 8 chasing monsters and a shotgun', 'prompt stored');
}

// --- 3. overrides win over prompt keywords (CLI is last)
{
  const spec = compileSpec('fast desert race with monsters', {
    seed: 3,
    overrides: { world: { biome: 'lava' }, vehicle: { topSpeedScale: 0.9 }, hud: { elements: ['speed'] } },
  });
  const ok = spec.world.biome === 'lava' && spec.vehicle.topSpeedScale === 0.9
    && deepEq(spec.hud.elements, ['speed']);
  report(ok, 'overrides win over prompt', j({ biome: spec.world.biome, top: spec.vehicle.topSpeedScale, hud: spec.hud.elements }));
}

// --- 4. variety fills only unspecified dims, stays deterministic
{
  let keeps = true;
  const biomes = new Set();
  for (let seed = 1; seed <= 8; seed++) {
    if (compileSpec('desert race', { seed, variety: 1 }).world.biome !== 'desert') keeps = false;
    biomes.add(compileSpec('a race', { seed, variety: 1 }).world.biome);
  }
  report(keeps, 'variety keeps prompt-named biome');
  report(biomes.size >= 2, 'variety diversifies unnamed biome', `saw ${[...biomes].join(',')}`);
  const grip = compileSpec('drift race', { seed: 4, variety: 1 }).vehicle.gripScale;
  report(grip === 0.65, 'variety keeps prompt-set gripScale', `got ${grip}`);
}

// --- 5. validateSpec passes for 50 random prompt-fragment x seed combos
{
  const pool = [];
  for (const ws of Object.values(KEYWORDS.biome)) pool.push(...ws);
  pool.push(...KEYWORDS.monsterEnable);
  for (const table of [KEYWORDS.monsterType, KEYWORDS.weapon, KEYWORDS.handling, KEYWORDS.track, KEYWORDS.hud, KEYWORDS.count]) {
    for (const ws of Object.values(table)) pool.push(...ws);
  }
  pool.push('no hud', 'a few', '8 monsters', '12 turrets', 'race');

  const rng = new Rng(20260707);
  let bad = 0;
  for (let i = 0; i < 50; i++) {
    const n = rng.int(2, 6);
    const prompt = Array.from({ length: n }, () => rng.pick(pool)).join(' ');
    const seed = rng.int(1, 9999);
    const variety = rng.pick([0, 0.3, 0.5, 1]);
    try {
      const spec = compileSpec(prompt, { seed, variety });
      validateSpec(spec);
      if (!deepEq(spec, compileSpec(prompt, { seed, variety }))) throw new Error('non-deterministic');
    } catch (e) {
      bad++;
      console.log(`  combo FAIL "${prompt}" seed=${seed} variety=${variety}: ${e.message}`);
    }
  }
  report(bad === 0, `50 random combos validate (${50 - bad}/50)`);
}

// DEFAULT_SPEC must survive compilation untouched (merge shares subtrees)
{
  const fresh = JSON.stringify(DEFAULT_SPEC);
  compileSpec('lava horde shotgun drift', { seed: 9, variety: 1 });
  report(JSON.stringify(DEFAULT_SPEC) === fresh, 'DEFAULT_SPEC not mutated');
}

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
