// Prompt -> GameSpec compiler.
//
// Deterministic pipeline: keyword extraction (a pure function of the prompt
// string) -> optional `variety` fill of UNSPECIFIED dimensions (Rng seeded
// from seed ^ specHash(keyword-only spec), so the same (prompt, seed, variety)
// always compiles to the same spec) -> CLI `overrides` deep-merged last ->
// makeSpec (validates). Never touches Math.random.

import { DEFAULT_SPEC, BIOMES, MONSTER_TYPES, makeSpec, merge, specHash } from './schema.js';
import { Rng, clamp } from '../sim/rng.js';

// Keyword tables. Matching is per-token: the prompt is lowercased and split on
// non-alphanumerics, so 'shooter' never triggers 'shoot' by substring.
export const KEYWORDS = {
  biome: {
    desert: ['desert', 'sand', 'sands', 'sandy', 'dune', 'dunes'],
    snow: ['snow', 'snowy', 'ice', 'icy', 'winter'],
    night: ['night', 'dark', 'neon'],
    lava: ['lava', 'volcano', 'volcanic', 'hell'],
    meadow: ['forest', 'meadow', 'grass', 'grassy'],
  },
  monsterEnable: ['monster', 'monsters', 'creature', 'creatures', 'enemy', 'enemies', 'zombie', 'zombies', 'alien', 'aliens'],
  monsterType: {
    chaser: ['chase', 'chaser', 'chasers', 'chasing', 'wolf', 'wolves', 'zombie', 'zombies'],
    patroller: ['patrol', 'patrols', 'patrolling', 'patroller', 'patrollers', 'guard', 'guards', 'beetle', 'beetles'],
    turret: ['turret', 'turrets', 'tower', 'towers', 'cannon', 'cannons', 'shooter', 'shooters'],
  },
  weapon: {
    blaster: ['gun', 'guns', 'blaster', 'blasters', 'laser', 'lasers', 'shoot', 'shoots', 'shooting', 'weapon', 'weapons', 'cannon', 'cannons'],
    spread: ['shotgun', 'shotguns', 'spread'],
  },
  handling: {
    drifty: ['drift', 'drifty', 'drifting', 'slippery', 'ice', 'icy'],
    grippy: ['grippy', 'rails'],
    fast: ['fast', 'speed', 'speedy'],
    slow: ['slow', 'cruise', 'cruising'],
  },
  track: {
    wide: ['wide'],
    narrow: ['narrow'],
    big: ['big', 'long'],
    small: ['small', 'short', 'tight'],
  },
  hud: {
    minimap: ['minimap', 'map'],
    clean: ['clean'], // plus the phrase 'no hud'
    race: ['race', 'races', 'racing', 'racer', 'lap', 'laps'],
  },
  count: {
    few: ['few'],
    many: ['many', 'lots', 'horde', 'hordes'],
  },
};

// canonical hud element order so extraction order never leaks into the spec
const HUD_ORDER = ['speed', 'boost', 'health', 'ammo', 'score', 'lap', 'minimap'];
const CAR_COLORS = [0xff6a00, 0x2a7fff, 0xff2a5f, 0x27c95e, 0xffd11a, 0xb44cff, 0x00e5d0];
const STOPWORDS = new Set([
  'a', 'an', 'the', 'with', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'no', 'not', 'some', 'my', 'it', 'is', 'are', 'by', 'into', 'over',
]);

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

// first ~4 significant words, kebab-case (numbers and stopwords dropped)
function slugify(prompt) {
  const words = (prompt.toLowerCase().match(/[a-z]+/g) || []).filter((w) => !STOPWORDS.has(w));
  return words.slice(0, 4).join('-') || 'game';
}

// keyword extraction -> { kw: partial spec overrides, flags: which dimensions
// the prompt pinned (variety must not touch those) }
function extract(prompt) {
  const toks = prompt.toLowerCase().match(/[a-z0-9]+/g) || [];
  const text = ` ${toks.join(' ')} `;
  const has = (w) => toks.includes(w);
  const hasAny = (ws) => ws.some(has);

  const kw = { world: {}, vehicle: {}, entities: {}, weapon: {}, hud: {} };
  const flags = { biome: false, grip: false, topSpeed: false, width: false, track: false };

  // biome: first-mentioned biome word wins ('dark forest' -> night)
  outer: for (const t of toks) {
    for (const [biome, words] of Object.entries(KEYWORDS.biome)) {
      if (words.includes(t)) {
        kw.world.biome = biome;
        flags.biome = true;
        break outer;
      }
    }
  }

  // monsters: type words in first-mention order; any type or enable word arms them
  const types = [];
  for (const t of toks) {
    for (const [type, words] of Object.entries(KEYWORDS.monsterType)) {
      if (words.includes(t) && !types.includes(type)) types.push(type);
    }
  }
  const monstersOn = types.length > 0 || hasAny(KEYWORDS.monsterEnable);
  const isMonsterWord = (t) =>
    KEYWORDS.monsterEnable.includes(t) || Object.values(KEYWORDS.monsterType).some((ws) => ws.includes(t));

  // total count: explicit digit within 2 tokens of a monster word beats
  // few/many words beats the default of 5
  let total = 5;
  if (hasAny(KEYWORDS.count.many)) total = 10;
  else if (hasAny(KEYWORDS.count.few)) total = 3;
  for (let i = 0; i < toks.length; i++) {
    if (/^\d+$/.test(toks[i]) && (isMonsterWord(toks[i + 1]) || isMonsterWord(toks[i + 2]))) {
      total = clamp(parseInt(toks[i], 10), 1, 40);
      break;
    }
  }

  if (monstersOn) {
    const list = types.length ? types : ['chaser'];
    const base = Math.floor(total / list.length);
    let rem = total % list.length;
    kw.entities.monsters = list
      .map((type) => ({ type, count: base + (rem-- > 0 ? 1 : 0) }))
      .filter((m) => m.count > 0);
  }

  // weapon: spread words are more specific, so they win over blaster words
  const wantSpread = hasAny(KEYWORDS.weapon.spread);
  const weaponOn = wantSpread || hasAny(KEYWORDS.weapon.blaster);
  if (weaponOn) kw.weapon = { enabled: true, kind: wantSpread ? 'spread' : 'blaster' };

  // handling
  if (hasAny(KEYWORDS.handling.drifty)) {
    kw.vehicle.gripScale = 0.65;
    flags.grip = true;
  } else if (hasAny(KEYWORDS.handling.grippy)) {
    kw.vehicle.gripScale = 1.4;
    flags.grip = true;
  }
  if (hasAny(KEYWORDS.handling.fast)) {
    kw.vehicle.topSpeedScale = 1.25;
    flags.topSpeed = true;
  } else if (hasAny(KEYWORDS.handling.slow)) {
    kw.vehicle.topSpeedScale = 0.8;
    flags.topSpeed = true;
  }

  // track geometry
  if (hasAny(KEYWORDS.track.wide)) {
    kw.world.widthScale = 1.4;
    flags.width = true;
  } else if (hasAny(KEYWORDS.track.narrow)) {
    kw.world.widthScale = 0.75;
    flags.width = true;
  }
  if (hasAny(KEYWORDS.track.big)) {
    kw.world.trackScale = 1.4;
    flags.track = true;
  } else if (hasAny(KEYWORDS.track.small)) {
    kw.world.trackScale = 0.75;
    flags.track = true;
  }

  // hud + auto pickups: armed weapons need ammo readout/refills, monsters need
  // health/score; an explicit 'no hud'/'clean' still keeps the world pickups
  const wants = new Set(DEFAULT_SPEC.hud.elements);
  const pickups = [];
  if (monstersOn) {
    wants.add('health').add('score');
    pickups.push({ kind: 'health', count: 3 });
  }
  if (weaponOn) {
    wants.add('ammo');
    pickups.push({ kind: 'ammo', count: 4 });
  }
  if (hasAny(KEYWORDS.hud.race)) wants.add('lap');
  if (hasAny(KEYWORDS.hud.minimap)) wants.add('minimap');
  if (pickups.length) kw.entities.pickups = pickups;
  const clean = hasAny(KEYWORDS.hud.clean) || text.includes(' no hud ');
  kw.hud.elements = clean ? [] : HUD_ORDER.filter((el) => wants.has(el));

  return { kw, flags };
}

// jitter/fill dimensions the prompt left unspecified; draw order is fixed so
// results depend only on (rng seed, variety, flags)
function applyVariety(spec, flags, rng, variety) {
  if (!flags.biome && rng.bool(variety)) spec.world.biome = rng.pick(Object.keys(BIOMES));

  const jit = Math.round(3 * variety);
  for (const m of spec.entities.monsters) m.count = clamp(m.count + rng.int(-jit, jit), 1, 40);
  if (spec.entities.monsters.length && rng.bool(variety * 0.25)) {
    const unused = Object.keys(MONSTER_TYPES).filter((t) => !spec.entities.monsters.some((m) => m.type === t));
    if (unused.length) spec.entities.monsters.push({ type: rng.pick(unused), count: rng.int(2, 4) });
  }

  const amp = 0.15 * Math.min(1, variety * 2); // 'within ±0.15'
  for (const k of ['topSpeedScale', 'accelScale', 'gripScale', 'boostScale']) {
    if ((k === 'gripScale' && flags.grip) || (k === 'topSpeedScale' && flags.topSpeed)) continue;
    spec.vehicle[k] = round3(clamp(spec.vehicle[k] + rng.range(-amp, amp), 0.4, 2.2));
  }

  if (!flags.track) spec.world.trackScale = round3(clamp(spec.world.trackScale + variety * rng.range(-0.3, 0.3), 0.5, 2));
  if (!flags.width) spec.world.widthScale = round3(clamp(spec.world.widthScale + variety * rng.range(-0.2, 0.2), 0.6, 1.8));
  if (rng.bool(variety * 0.5)) spec.world.boostPads = rng.bool(0.6);
  if (rng.bool(variety)) spec.vehicle.color = rng.pick(CAR_COLORS);
}

export function compileSpec(prompt, { seed = 1, overrides = {}, variety = 0 } = {}) {
  const p = String(prompt ?? '');
  const { kw, flags } = extract(p);

  // clone: merge() shares untouched subtrees with DEFAULT_SPEC and variety
  // mutates in place — never corrupt the module-level default
  const spec = JSON.parse(JSON.stringify(merge(DEFAULT_SPEC, kw)));
  spec.prompt = p;

  const v = clamp(Number(variety) || 0, 0, 1);
  if (v > 0) {
    // seed the fill from the keyword-only spec so distinct prompts diverge
    // even under the same seed
    applyVariety(spec, flags, new Rng(((seed >>> 0) ^ specHash(spec)) >>> 0), v);
  }

  spec.name = `${slugify(p)}-s${seed}`;
  return makeSpec(merge(spec, overrides)); // CLI overrides win; validates
}
