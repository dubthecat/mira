// GameSpec: the single source of truth for a generated game family.
//
// A spec is plain JSON — compiled from a prompt (see compile.js), saved next
// to every dataset it generates, and consumed by sim, renderer, HUD, recorder
// and packer. (seed, spec) -> bit-identical episode. The world model trained
// on a spec's dataset *is* that game; new specs are new games.

// deep-merge b over a (arrays replace, objects merge)
export function merge(a, b) {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return b === undefined ? a : b;
  }
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
  return out;
}

export const BIOMES = {
  meadow: {
    grassHue: 0.31, grassSat: 0.45, grassLight: 0.37, skyHue: 0.58, skySat: 0.52, skyLight: 0.74,
    asphaltLight: 0.2, fogNear: 130, fogFar: 400, sunIntensity: 1.5, treeKind: 'pine',
    scatterDensity: 1.0, emissiveTrack: false, edgeColor: 0xe8e8ea,
  },
  desert: {
    grassHue: 0.1, grassSat: 0.45, grassLight: 0.55, skyHue: 0.09, skySat: 0.5, skyLight: 0.78,
    asphaltLight: 0.24, fogNear: 150, fogFar: 450, sunIntensity: 1.8, treeKind: 'cactus',
    scatterDensity: 0.55, emissiveTrack: false, edgeColor: 0xe8e8ea,
  },
  snow: {
    grassHue: 0.58, grassSat: 0.08, grassLight: 0.82, skyHue: 0.6, skySat: 0.25, skyLight: 0.8,
    asphaltLight: 0.28, fogNear: 100, fogFar: 320, sunIntensity: 1.3, treeKind: 'pine',
    scatterDensity: 0.8, emissiveTrack: false, edgeColor: 0xd8e5f2,
  },
  night: {
    grassHue: 0.35, grassSat: 0.25, grassLight: 0.1, skyHue: 0.66, skySat: 0.55, skyLight: 0.08,
    asphaltLight: 0.1, fogNear: 90, fogFar: 260, sunIntensity: 0.35, treeKind: 'pine',
    scatterDensity: 0.9, emissiveTrack: true, edgeColor: 0x35e2ff,
  },
  lava: {
    grassHue: 0.02, grassSat: 0.6, grassLight: 0.13, skyHue: 0.03, skySat: 0.65, skyLight: 0.2,
    asphaltLight: 0.14, fogNear: 90, fogFar: 300, sunIntensity: 0.8, treeKind: 'rockspire',
    scatterDensity: 0.7, emissiveTrack: true, edgeColor: 0xff8a3d,
  },
};

export const MONSTER_TYPES = {
  // ground chaser: seeks the car when close, wanders near its lair otherwise
  chaser: { speed: 14, size: 1.6, health: 2, damage: 18, aggroRadius: 45, color: 0x8a2be2 },
  // patrols across/along the track — a moving obstacle
  patroller: { speed: 8, size: 2.0, health: 3, damage: 12, aggroRadius: 0, color: 0x1fa34a },
  // static turret lobbing slow projectiles the car must dodge
  turret: { speed: 0, size: 2.2, health: 4, damage: 22, aggroRadius: 70, color: 0xb8443c,
            fireEvery: 2.0, projSpeed: 22 },
};

export const WEAPON_KINDS = {
  blaster: { fireRate: 4, projSpeed: 60, damage: 1, spread: 0, pellets: 1, ammoPerShot: 1, color: 0x37e0ff },
  spread: { fireRate: 2, projSpeed: 48, damage: 1, spread: 0.16, pellets: 3, ammoPerShot: 2, color: 0xffd11a },
};

export const BASE_KEYS = ['W', 'S', 'A', 'D', 'Space', 'LShiftKey'];

export const ARCHETYPES = ['circuit', 'soccer', 'shooter', 'adventure'];

export const DEFAULT_SPEC = {
  name: 'racing-classic',
  prompt: '',
  version: 2,
  // what KIND of game this is; each archetype is a mode module (src/sim/modes)
  // sharing the same avatar physics, entities, recorder and dataset contract
  archetype: 'circuit',
  // archetype-specific knobs (only the active archetype's block is read)
  soccer: {
    opponents: 1, // 0..2 rival cars chasing the ball
    pitchScale: 1.0,
  },
  shooter: {
    waveSize: 4, // monsters per wave
    waveEveryFrames: 360, // 18 s between waves
    arenaScale: 1.0,
  },
  adventure: {
    relics: 6,
    worldScale: 1.0, // multiplies the open-terrain extent
    onFoot: false, // true = runner avatar instead of the car
  },
  world: {
    biome: 'meadow',
    // multipliers over the procedural track generator's built-in ranges
    trackScale: 1.0, // control-polygon radius multiplier
    widthScale: 1.0, // half-width multiplier (clamps still apply)
    boostPads: true,
  },
  vehicle: {
    // multipliers over CAR defaults so handling presets stay stable if the
    // base tuning evolves
    topSpeedScale: 1.0,
    accelScale: 1.0,
    gripScale: 1.0, // <1 = slippery/drifty, >1 = on rails
    boostScale: 1.0,
    color: 0xff6a00,
    body: 'sport', // silhouette: 'sport' | 'muscle' | 'buggy' (visual only)
  },
  entities: {
    monsters: [], // [{type, count, scale?, speedScale?, color?}]
    pickups: [],  // [{kind: 'health'|'ammo', count}] (boost pads are world.boostPads)
  },
  weapon: {
    enabled: false,
    kind: 'blaster',
    ammoMax: 24,
    ammoStart: 12,
  },
  rules: {
    healthMax: 100,
    respawnFrames: 60,     // car respawn pause after death (frames)
    scorePerKill: 100,
    contactInvulnFrames: 20,
  },
  hud: {
    // each element renders only if listed; all read live engine variables
    elements: ['speed', 'boost'], // + 'health', 'ammo', 'score', 'lap', 'minimap'
    scale: 1.0,
  },
};

// fnv-1a of the canonical spec JSON — mixed into episode seeds so the same
// seed under different specs produces different worlds
export function specHash(spec) {
  const s = JSON.stringify(spec);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

// action vocabulary is derived, never stored: base driving keys + F if armed
export function actionKeysFor(spec) {
  return spec.weapon.enabled ? [...BASE_KEYS, 'F'] : [...BASE_KEYS];
}

export function makeSpec(overrides = {}) {
  const spec = merge(DEFAULT_SPEC, overrides);
  validateSpec(spec);
  return spec;
}

export function validateSpec(spec) {
  const fail = (msg) => {
    throw new Error(`invalid GameSpec: ${msg}`);
  };
  if (!ARCHETYPES.includes(spec.archetype)) {
    fail(`unknown archetype '${spec.archetype}' (have: ${ARCHETYPES})`);
  }
  if (!(spec.soccer.opponents >= 0 && spec.soccer.opponents <= 2)) fail('soccer.opponents out of [0, 2]');
  if (!(spec.soccer.pitchScale >= 0.7 && spec.soccer.pitchScale <= 1.6)) fail('soccer.pitchScale out of [0.7, 1.6]');
  if (!(spec.shooter.waveSize >= 1 && spec.shooter.waveSize <= 12)) fail('shooter.waveSize out of [1, 12]');
  if (!(spec.shooter.waveEveryFrames >= 100 && spec.shooter.waveEveryFrames <= 2400)) fail('shooter.waveEveryFrames out of [100, 2400]');
  if (!(spec.shooter.arenaScale >= 0.7 && spec.shooter.arenaScale <= 1.8)) fail('shooter.arenaScale out of [0.7, 1.8]');
  if (!(spec.adventure.relics >= 2 && spec.adventure.relics <= 14)) fail('adventure.relics out of [2, 14]');
  if (!(spec.adventure.worldScale >= 0.6 && spec.adventure.worldScale <= 2)) fail('adventure.worldScale out of [0.6, 2]');
  if (!BIOMES[spec.world.biome]) fail(`unknown biome '${spec.world.biome}' (have: ${Object.keys(BIOMES)})`);
  if (spec.weapon.enabled && !WEAPON_KINDS[spec.weapon.kind]) {
    fail(`unknown weapon kind '${spec.weapon.kind}' (have: ${Object.keys(WEAPON_KINDS)})`);
  }
  for (const m of spec.entities.monsters) {
    if (!MONSTER_TYPES[m.type]) fail(`unknown monster type '${m.type}' (have: ${Object.keys(MONSTER_TYPES)})`);
    if (!(m.count >= 0 && m.count <= 40)) fail(`monster count out of range: ${m.count}`);
    if (m.scale !== undefined && !(m.scale >= 0.4 && m.scale <= 3)) fail(`monster scale out of [0.4, 3]: ${m.scale}`);
    if (m.speedScale !== undefined && !(m.speedScale >= 0.3 && m.speedScale <= 3)) {
      fail(`monster speedScale out of [0.3, 3]: ${m.speedScale}`);
    }
  }
  for (const p of spec.entities.pickups) {
    if (!['health', 'ammo'].includes(p.kind)) fail(`unknown pickup kind '${p.kind}'`);
    if (!(p.count >= 0 && p.count <= 40)) fail(`pickup count out of range: ${p.count}`);
  }
  for (const el of spec.hud.elements) {
    if (!['speed', 'boost', 'health', 'ammo', 'score', 'lap', 'minimap'].includes(el)) {
      fail(`unknown hud element '${el}'`);
    }
  }
  if (!(spec.world.trackScale >= 0.5 && spec.world.trackScale <= 2)) fail('trackScale out of [0.5, 2]');
  if (!(spec.world.widthScale >= 0.6 && spec.world.widthScale <= 1.8)) fail('widthScale out of [0.6, 1.8]');
  for (const k of ['topSpeedScale', 'accelScale', 'gripScale', 'boostScale']) {
    if (!(spec.vehicle[k] >= 0.4 && spec.vehicle[k] <= 2.2)) fail(`vehicle.${k} out of [0.4, 2.2]`);
  }
  if (!['sport', 'muscle', 'buggy'].includes(spec.vehicle.body)) {
    fail(`unknown vehicle body '${spec.vehicle.body}'`);
  }
  return spec;
}
