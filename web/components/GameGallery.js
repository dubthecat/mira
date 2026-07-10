// Pre-built games: the engine's battle-tested genre battery, one click to
// play. Cards are generated at build time from the same specs the datasets
// were recorded with, so what you play is byte-for-byte the game the world
// model trains on.

import Link from 'next/link';
import { compileBattery } from '../../racer/src/spec/battery.js';

const BLURBS = {
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
};

function summarize(spec) {
  const bits = [spec.world.biome];
  const monsters = spec.entities.monsters.reduce((n, g) => n + g.count, 0);
  if (monsters > 0) bits.push(`${monsters} monsters`);
  if (spec.weapon.enabled) bits.push(spec.weapon.kind);
  bits.push(spec.weapon.enabled ? '7 keys' : '6 keys');
  return bits;
}

export default function GameGallery() {
  const games = compileBattery();
  return (
    <div className="gallery-grid">
      {games.map(({ key, spec }) => (
        <Link key={key} href={`/play?genre=${encodeURIComponent(key)}`} className="gallery-card">
          {/* thumbnails are real recorded frames from this exact spec */}
          <img src={`/genres/${key}.png`} alt={`${key} gameplay frame`} width={512} height={288} />
          <div className="gallery-meta">
            <span className="gallery-name">{key}</span>
            <span className="gallery-blurb">{BLURBS[key] || spec.prompt}</span>
            <span className="gallery-tags">
              {summarize(spec).map((t) => (
                <em key={t}>{t}</em>
              ))}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
