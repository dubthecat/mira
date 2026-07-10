// Archetype modes. A mode owns everything archetype-specific about a world:
// the play space, the avatar's parameters and collision response, the bot
// policy, the objective system, and extra snapshot fields. Everything else —
// weapons, monsters, pickups, health/score rules, the recorder contract —
// is shared engine.
//
// Interface (all hooks required; use no-ops where unneeded):
//   build(world)                 constructor-time: create space/track, car,
//                                objective state, world.botPolicy
//   decide(world) -> keys|null   bot action for this frame (null = no bot)
//   stepAvatar(world, keys, dt)  one physics substep for the avatar
//   postStep(world, keys, dt, frameEvents)  objectives + mode bodies
//   respawnPose(world) -> {x, y, heading}   where the avatar revives
//   placer(world) -> entity placer (see entities.js): spawnMonster,
//                    spawnPickup, patrolEndpoints, projectileDead
//   snapshot(world, snap)        extend the physics.jsonl record
//
// Determinism: modes may only draw randomness from world.rng (or forks made
// in build()) in a call order that is a pure function of (seed, spec).

import { CircuitMode } from './circuit.js';
import { SoccerMode } from './soccer.js';
import { ShooterMode } from './shooter.js';
import { AdventureMode } from './adventure.js';

const REGISTRY = {
  circuit: CircuitMode,
  soccer: SoccerMode,
  shooter: ShooterMode,
  adventure: AdventureMode,
};

export function createMode(spec) {
  const Mode = REGISTRY[spec.archetype];
  if (!Mode) throw new Error(`no mode for archetype '${spec.archetype}'`);
  return new Mode(spec);
}
