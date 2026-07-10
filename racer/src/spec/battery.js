// The genre battery: named game families used to battle-test the engine and
// to generate multi-game datasets. Each entry is (prompt, overrides, gates):
// the prompt exercises the compiler exactly like a user would, overrides pin
// what the genre needs precisely, and gates are per-genre quality thresholds
// the sim battery (test/battery_check.mjs) asserts over bot-driven episodes.

import { compileSpec } from './compile.js';

export const BATTERY = [
  {
    key: 'classic-gp',
    prompt: 'grand prix racing, long fast track',
    overrides: {},
    gates: { minMeanSpeed: 18, minLaps: 1 },
  },
  {
    key: 'desert-blaster',
    prompt: 'desert race with 8 chasing monsters and a blaster, minimap',
    overrides: {},
    gates: { minMeanSpeed: 12, minFired: 10, minKills: 1, wantsKeys: ['F'] },
  },
  {
    key: 'night-neon-drift',
    prompt: 'night neon drift race, slippery, with a minimap',
    overrides: { vehicle: { gripScale: 0.6 } },
    gates: { minMeanSpeed: 10, minSpaceFrac: 0.0, minLaps: 1 },
  },
  {
    key: 'lava-gauntlet',
    prompt: 'lava gauntlet with 6 turrets and a shotgun, narrow track',
    overrides: {},
    gates: { minMeanSpeed: 10, minTurretFired: 8, minCarDamaged: 1, wantsKeys: ['F'] },
  },
  {
    key: 'snow-patrol',
    prompt: 'snow race with 8 patrolling beetles, wide track',
    overrides: {},
    gates: { minMeanSpeed: 12, minContacts: 1 },
  },
  {
    key: 'horde-survival',
    prompt: 'monster horde survival with a spread shotgun',
    overrides: {
      entities: {
        monsters: [{ type: 'chaser', count: 14 }],
        pickups: [
          { kind: 'health', count: 6 },
          { kind: 'ammo', count: 6 },
        ],
      },
    },
    gates: { minFired: 10, minCarDamaged: 2, minKills: 1 },
  },
  {
    key: 'meadow-cruise',
    prompt: 'peaceful forest cruise, no hud, slow',
    overrides: {},
    gates: { minMeanSpeed: 8, maxEvents: 400 },
  },
  {
    key: 'ice-drift-gp',
    prompt: 'winter ice drift racing, fast',
    overrides: { vehicle: { gripScale: 0.55, topSpeedScale: 1.1 } },
    gates: { minMeanSpeed: 10, minLaps: 1 },
  },
  {
    key: 'canyon-sprint',
    prompt: 'desert canyon sprint, narrow tight track, grippy',
    overrides: {},
    gates: { minMeanSpeed: 10, minLaps: 1 },
  },
  {
    key: 'twilight-turrets',
    prompt: 'night race dodging turret towers, minimap, fast',
    overrides: { entities: { monsters: [{ type: 'turret', count: 8 }] } },
    gates: { minMeanSpeed: 14, minTurretFired: 10 },
  },
  {
    key: 'beetle-gauntlet-armed',
    prompt: 'race through patrolling guards with a blaster, wide track',
    overrides: {},
    gates: { minFired: 6, minMeanSpeed: 11 },
  },
  {
    key: 'mixed-mayhem',
    prompt: 'lava race, monsters everywhere, shotgun, minimap, drift',
    overrides: {
      entities: {
        monsters: [
          { type: 'chaser', count: 6 },
          { type: 'patroller', count: 4 },
          { type: 'turret', count: 4 },
        ],
      },
    },
    gates: { minFired: 8, minCarDamaged: 2, minMeanSpeed: 8 },
  },
  {
    key: 'bomber-rush',
    prompt: 'desert race with 8 kamikaze bombers and a blaster',
    overrides: {},
    gates: { minFired: 8, minKills: 1, minBomberBoom: 2, wantsKeys: ['F'] },
  },
  // --- non-circuit archetypes ------------------------------------------------
  {
    key: 'car-soccer-derby',
    prompt: 'car soccer derby, 1 opponent',
    overrides: {},
    gates: { minGoalsTotal: 1 },
  },
  {
    key: 'arena-doom',
    prompt: 'doom arena shooter with waves of 4 and a spread shotgun',
    // 16 chasers / waveSize 4 = 4 waves; extra pickups keep the wave fight fed
    overrides: {
      entities: {
        monsters: [{ type: 'chaser', count: 16 }],
        pickups: [
          { kind: 'health', count: 4 },
          { kind: 'ammo', count: 6 },
        ],
      },
    },
    gates: { minFired: 10, minKills: 1, minWaves: 3, wantsKeys: ['F'] },
  },
  {
    key: 'relic-quest',
    prompt: 'open world relic quest with 5 relics, chasers and turrets, blaster',
    overrides: {},
    gates: { minRelics: 2, minFired: 6, wantsKeys: ['F'] },
  },
  {
    key: 'meadow-kickabout',
    prompt: 'meadow soccer kickabout, empty pitch',
    overrides: { soccer: { opponents: 0 } },
    gates: { minGoalsTotal: 2 }, // striker gate: nobody to blame on an empty pitch
  },
  {
    key: 'heat-chase',
    // the compiler has no pursuit keywords yet, so the archetype is pinned by
    // override; the prompt still exercises the biome table ('night')
    prompt: 'midnight escape from the heat at night',
    overrides: {
      archetype: 'pursuit',
      pursuit: { hunters: 3 },
      hud: { elements: ['speed', 'boost', 'health', 'score'] },
    },
    gates: { minCarDamaged: 1, minWrecked: 1 },
  },
];

// Compile the whole battery deterministically (seed fixed per entry).
export function compileBattery() {
  return BATTERY.map((b) => ({
    ...b,
    spec: compileSpec(b.prompt, { seed: 1, overrides: b.overrides }),
  }));
}
