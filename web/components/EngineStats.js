// "Battle-tested engine" figures: a row of stat tiles + one calm horizontal
// bar row. Server components, no client JS.
//
// Tiles are derived from the engine's own battery where possible (genre and
// archetype counts track compileBattery() automatically); the rest are
// engine constants.
//
// Chart notes (single series, so no legend): every bar carries a direct
// label and value in text tokens; the mark alone wears the data color.
// The six pilot datasets are the same size on purpose — the row reads as
// breadth of coverage, not variance.

import { compileBattery } from '../../racer/src/spec/battery.js';

const battery = compileBattery();
const GENRE_COUNT = battery.length;
const ARCHETYPE_COUNT = new Set(battery.map((b) => b.spec.archetype)).size;

const TILES = [
  { value: String(GENRE_COUNT), label: 'genres in the battery' },
  { value: String(ARCHETYPE_COUNT), label: 'game archetypes' },
  { value: '5', label: 'biomes' },
  { value: '3', label: 'vehicle bodies' },
  { value: '7', label: 'action keys' },
  { value: '20', label: 'frames / second' },
  { value: '512×288', label: 'native resolution' },
  { value: 'bit-exact', label: 'replay from (seed, spec)' },
];

export function StatTiles() {
  return (
    <div className="tiles">
      {TILES.map((t) => (
        <div className="tile" key={t.label}>
          <div className="tile-value">{t.value}</div>
          <div className="tile-label">{t.label}</div>
        </div>
      ))}
    </div>
  );
}

const GENRES = [
  'classic-gp',
  'desert-blaster',
  'night-neon-drift',
  'lava-gauntlet',
  'snow-patrol',
  'mixed-mayhem',
];
const FRAMES = 14400;

const LABEL_W = 168; // label column
const BAR_MAX = 620; // full-scale bar length
const BAR_H = 16; // <= 24px, thin marks
const ROW_H = 30;
const PAD_T = 6;
const CHART_W = LABEL_W + BAR_MAX + 84;
const CHART_H = PAD_T + GENRES.length * ROW_H + 8;

// bar path: square at the baseline (left), 4px rounded data-end (right)
function barPath(x0, y0, len, h, r = 4) {
  const x1 = x0 + len;
  return `M ${x0} ${y0} H ${x1 - r} Q ${x1} ${y0} ${x1} ${y0 + r} V ${y0 + h - r} Q ${x1} ${y0 + h} ${x1 - r} ${y0 + h} H ${x0} Z`;
}

export function FramesChart() {
  return (
    <div>
      <div className="chart-title">Frames per pilot dataset, by genre</div>
      <div className="chart-sub">
        The pilot batch: {GENRES.length} specs recorded at 14,400 frames each — a fixed budget per
        genre, so the row reads as breadth of coverage, not variance. The rest of the battery
        queues up as recording continues.
      </div>
      <div className="diagram-scroll">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          width={CHART_W}
          height={CHART_H}
          role="img"
          aria-label={`Bar chart: the ${GENRES.length} pilot datasets (${GENRES.join(', ')}) with 14,400 frames each.`}
          style={{ maxWidth: '100%', height: 'auto', minWidth: '640px' }}
        >
          {/* hairline baseline */}
          <line x1={LABEL_W} y1={PAD_T} x2={LABEL_W} y2={CHART_H - 8} stroke="var(--border)" strokeWidth="1" />
          {GENRES.map((g, i) => {
            const y = PAD_T + i * ROW_H + (ROW_H - BAR_H) / 2;
            const len = BAR_MAX; // FRAMES / FRAMES * BAR_MAX — all equal by design
            return (
              <g key={g}>
                <title>{`${g} — ${FRAMES.toLocaleString('en-US')} frames`}</title>
                <text x={LABEL_W - 10} y={y + BAR_H / 2 + 4} fontSize="12.5" fill="var(--text-2)" textAnchor="end" fontFamily="var(--font-mono)">
                  {g}
                </text>
                <path d={barPath(LABEL_W, y, len, BAR_H)} fill="var(--blue)" />
                <text x={LABEL_W + len + 10} y={y + BAR_H / 2 + 4} fontSize="12" fill="var(--text-2)" fontFamily="var(--font-mono)">
                  {FRAMES.toLocaleString('en-US')}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
