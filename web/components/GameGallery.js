'use client';

// Pre-built games: the engine's battle-tested genre battery, one click to
// play. Cards are generated from the same specs the datasets were recorded
// with, so what you play is byte-for-byte the game the world model trains on.
//
// Client component: the archetype tabs filter cards in place. Tabs and chips
// are derived from spec.archetype — new archetypes/entries in the battery
// show up here with zero edits.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { compileBattery } from '../../racer/src/spec/battery.js';
import { ARCHETYPES } from '../../racer/src/spec/schema.js';
import { blurbFor, archetypeLabel } from '../lib/genres.js';

function summarize(spec) {
  const bits = [spec.world.biome];
  const monsters = spec.entities.monsters.reduce((n, g) => n + g.count, 0);
  if (monsters > 0) bits.push(`${monsters} monsters`);
  if (spec.weapon.enabled) bits.push(spec.weapon.kind);
  bits.push(spec.weapon.enabled ? '7 keys' : '6 keys');
  return bits;
}

export default function GameGallery() {
  const games = useMemo(() => compileBattery(), []);
  const [tab, setTab] = useState('all');

  // tabs: only archetypes present in the battery, in schema order; anything
  // the schema list doesn't know yet is appended in order of appearance
  const tabs = useMemo(() => {
    const present = [...new Set(games.map((g) => g.spec.archetype))];
    return [
      ...ARCHETYPES.filter((a) => present.includes(a)),
      ...present.filter((a) => !ARCHETYPES.includes(a)),
    ];
  }, [games]);

  const shown = tab === 'all' ? games : games.filter((g) => g.spec.archetype === tab);

  return (
    <div>
      <div className="gallery-tabs" role="tablist" aria-label="Filter games by archetype">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={tab === 'all' ? 'gallery-tab active' : 'gallery-tab'}
          onClick={() => setTab('all')}
        >
          All <span className="gallery-tab-count">{games.length}</span>
        </button>
        {tabs.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={tab === a}
            className={tab === a ? 'gallery-tab active' : 'gallery-tab'}
            onClick={() => setTab(a)}
          >
            {archetypeLabel(a)}{' '}
            <span className="gallery-tab-count">
              {games.filter((g) => g.spec.archetype === a).length}
            </span>
          </button>
        ))}
      </div>

      <div className="gallery-grid">
        {shown.map(({ key, spec }) => (
          <Link key={key} href={`/play?genre=${encodeURIComponent(key)}`} className="gallery-card">
            <span className="gallery-thumb">
              {/* dark fallback panel shows through when the frame isn't recorded yet */}
              <span className="gallery-thumb-fallback" aria-hidden="true">
                no frame yet
              </span>
              {/* thumbnails are real recorded frames from this exact spec;
                  a missing file hides the img and the fallback shows through.
                  The ref covers 404s that resolve before hydration (onError
                  would have already fired with nobody listening). */}
              <img
                src={`/genres/${key}.png`}
                alt={`${key} gameplay frame`}
                width={512}
                height={288}
                loading="lazy"
                ref={(el) => {
                  if (el && el.complete && el.naturalWidth === 0) el.style.display = 'none';
                }}
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
              <span className="gallery-chip">{spec.archetype}</span>
            </span>
            <span className="gallery-meta">
              <span className="gallery-name">{key}</span>
              <span className="gallery-blurb">{blurbFor(key, spec)}</span>
              <span className="gallery-tags">
                {summarize(spec).map((t) => (
                  <em key={t}>{t}</em>
                ))}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
