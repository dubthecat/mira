// Pipeline diagram: prompt -> playable neural game, as inline SVG.
// Server component, no client JS. Stage boxes are neutral panels; the accent
// appears only as a thin top border (green = runs now, amber = GPU training
// loop), always paired with a text label — color never carries meaning alone.

const BOX_W = 150;
const BOX_H = 84;
const GAP = 34;
const X0 = 10;
const Y0 = 48;

const STAGES = [
  { title: 'Prompt', sub: ['natural language'], phase: 'now' },
  { title: 'GameSpec', sub: ['deterministic', 'compile'], phase: 'now' },
  { title: 'Procedural game', sub: ['Three.js · 20 fps', '512×288'], phase: 'now' },
  { title: 'Dataset', sub: ['frames + actions', '+ state'], phase: 'train' },
  { title: 'RAE codec', sub: ['DINOv3 latent', 'space'], phase: 'train' },
  { title: 'Diffusion model', sub: ['latent DiT,', 'action-conditioned'], phase: 'train' },
  { title: 'Neural game', sub: ['playable, no engine', 'underneath'], phase: 'train' },
];

const N = STAGES.length;
const WIDTH = X0 * 2 + N * BOX_W + (N - 1) * GAP;
const HEIGHT = 152;
// divider sits mid-gap between the last "now" stage (idx 2) and first "train" one
const DIVIDER_X = X0 + 3 * (BOX_W + GAP) - GAP / 2;

function stageX(i) {
  return X0 + i * (BOX_W + GAP);
}

export default function PipelineDiagram() {
  return (
    <div className="diagram-scroll">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        role="img"
        aria-label="Pipeline: prompt to GameSpec to procedural game (runs now, in your browser), then dataset, RAE codec, diffusion world model, playable neural game (GPU training loop)."
        style={{ maxWidth: '100%', height: 'auto', minWidth: '900px' }}
      >
        {/* phase labels: dot + text, above each region */}
        <circle cx={X0 + 5} cy={20} r={4} fill="var(--green)" />
        <text x={X0 + 16} y={24} fontSize="12.5" fill="var(--text-2)" fontFamily="var(--font-mono)">
          runs now, in your browser
        </text>
        <circle cx={stageX(3) + 5} cy={20} r={4} fill="var(--amber)" />
        <text x={stageX(3) + 16} y={24} fontSize="12.5" fill="var(--text-2)" fontFamily="var(--font-mono)">
          GPU training loop
        </text>

        {/* subtle phase divider */}
        <line x1={DIVIDER_X} y1={10} x2={DIVIDER_X} y2={HEIGHT - 8} stroke="var(--border)" strokeWidth="1" strokeDasharray="3 4" />

        {STAGES.map((s, i) => {
          const x = stageX(i);
          const accent = s.phase === 'now' ? 'var(--green)' : 'var(--amber)';
          return (
            <g key={s.title}>
              <rect x={x} y={Y0} width={BOX_W} height={BOX_H} rx="6" fill="var(--panel)" stroke="var(--border)" strokeWidth="1" />
              {/* thin accent top border */}
              <path d={`M ${x + 6} ${Y0 + 0.5} H ${x + BOX_W - 6}`} stroke={accent} strokeWidth="2.5" strokeLinecap="round" />
              <text x={x + BOX_W / 2} y={Y0 + 26} fontSize="13.5" fontWeight="600" fill="var(--text)" textAnchor="middle" fontFamily="var(--font-sans)">
                {s.title}
              </text>
              {s.sub.map((line, j) => (
                <text key={j} x={x + BOX_W / 2} y={Y0 + 46 + j * 16} fontSize="12" fill="var(--text-2)" textAnchor="middle" fontFamily="var(--font-mono)">
                  {line}
                </text>
              ))}
              {/* arrow to next stage */}
              {i < N - 1 && (
                <g stroke="#5a5952" strokeWidth="2" fill="none">
                  <line x1={x + BOX_W + 5} y1={Y0 + BOX_H / 2} x2={x + BOX_W + GAP - 11} y2={Y0 + BOX_H / 2} />
                  <path
                    d={`M ${x + BOX_W + GAP - 16} ${Y0 + BOX_H / 2 - 5} L ${x + BOX_W + GAP - 9} ${Y0 + BOX_H / 2} L ${x + BOX_W + GAP - 16} ${Y0 + BOX_H / 2 + 5}`}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
