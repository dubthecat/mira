// Shared genre metadata for the web surface. The list of genres itself comes
// from the engine (compileBattery) — this module only decorates it: hand-written
// one-line blurbs and display labels for archetypes. Anything not listed here
// falls back to data from the spec, so new battery entries/archetypes flow
// through without edits.

export const BLURBS = {
  'classic-gp': 'Clean grand prix on a long, fast circuit.',
  'desert-blaster': 'Outrun chasers and blast turrets between dunes.',
  'night-neon-drift': 'Low grip, neon edges, dark sky.',
  'lava-gauntlet': 'Narrow road through turret crossfire.',
  'snow-patrol': 'Beetles sweep the road; time your gaps.',
  'horde-survival': 'Fourteen chasers, one shotgun.',
  'meadow-cruise': 'No HUD, no enemies, just the road.',
  'ice-drift-gp': 'Full-speed racing on ice.',
  'canyon-sprint': 'Tight desert canyon, grippy setup.',
  'twilight-turrets': 'Dodge tracer fire at night.',
  'beetle-gauntlet-armed': 'Wide road, armed, guards everywhere.',
  'mixed-mayhem': 'Everything hostile at once, on lava.',
  'car-soccer-derby': 'Rocket-car soccer, one rival, first to the ball wins.',
  'arena-doom': 'On-foot arena survival against waves of chasers.',
  'relic-quest': 'Open-world relic hunt past guards and turrets.',
  'meadow-kickabout': 'Empty pitch, just you and the ball.',
};

// blurb for a battery entry: hand-written line, else the spec's own prompt
export function blurbFor(key, spec) {
  return BLURBS[key] || (spec && spec.prompt) || '';
}

const ARCHETYPE_LABELS = {
  circuit: 'Racing',
};

// display label for an archetype key ('circuit' reads as 'Racing'; unknown
// future archetypes just get capitalized)
export function archetypeLabel(archetype) {
  return ARCHETYPE_LABELS[archetype] || archetype.charAt(0).toUpperCase() + archetype.slice(1);
}
