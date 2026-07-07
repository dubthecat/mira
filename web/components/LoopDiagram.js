// The interactive loop: player -> actions -> world model -> next frame ->
// player, as a small circular inline-SVG diagram. Server component.
// Neutral node panels; the world model node carries the amber "training loop"
// top border (paired with its label), arrows are thin 2px strokes.

const W = 660;
const H = 352;

function Node({ x, y, w = 152, h = 48, title, sub, accent = null }) {
  return (
    <g>
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx="6" fill="var(--panel)" stroke="var(--border)" strokeWidth="1" />
      {accent && <path d={`M ${x - w / 2 + 6} ${y - h / 2 + 0.5} H ${x + w / 2 - 6}`} stroke={accent} strokeWidth="2.5" strokeLinecap="round" />}
      <text x={x} y={y - (sub ? 3 : -4)} fontSize="13.5" fontWeight="600" fill="var(--text)" textAnchor="middle" fontFamily="var(--font-sans)">
        {title}
      </text>
      {sub && (
        <text x={x} y={y + 15} fontSize="12" fill="var(--text-2)" textAnchor="middle" fontFamily="var(--font-mono)">
          {sub}
        </text>
      )}
    </g>
  );
}

// quadratic arc with an arrowhead at the end, oriented along the curve
function Arc({ from, ctrl, to }) {
  const [x1, y1] = from;
  const [cx, cy] = ctrl;
  const [x2, y2] = to;
  // tangent direction at the endpoint of a quadratic Bezier is (to - ctrl)
  const dx = x2 - cx;
  const dy = y2 - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // arrowhead wings
  const bx = x2 - ux * 9;
  const by = y2 - uy * 9;
  const w1 = [bx - uy * 5, by + ux * 5];
  const w2 = [bx + uy * 5, by - ux * 5];
  return (
    <g stroke="#5a5952" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`} />
      <path d={`M ${w1[0]} ${w1[1]} L ${x2} ${y2} L ${w2[0]} ${w2[1]}`} />
    </g>
  );
}

export default function LoopDiagram() {
  return (
    <div className="diagram-scroll">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label="Interactive loop: player emits actions as a 7-key multi-hot vector, the world model renders the next frame with the HUD baked in, the frame returns to the player."
        style={{ maxWidth: '100%', height: 'auto', minWidth: '560px' }}
      >
        {/* clockwise: player (top) -> actions (right) -> world model (bottom) -> next frame (left) -> player */}
        <Node x={330} y={44} title="player" sub="sees frame, presses keys" w={210} />
        <Node x={528} y={176} title="actions" sub="7-key multi-hot · 20 Hz" w={190} />
        <Node x={330} y={308} title="world model" sub="latent diffusion" w={190} accent="var(--amber)" />
        <Node x={126} y={176} title="next frame" sub="HUD baked in" w={172} />

        <Arc from={[437, 58]} ctrl={[520, 84]} to={[537, 148]} />
        <Arc from={[520, 204]} ctrl={[500, 268]} to={[428, 296]} />
        <Arc from={[233, 296]} ctrl={[142, 268]} to={[121, 204]} />
        <Arc from={[121, 148]} ctrl={[142, 84]} to={[222, 58]} />
      </svg>
    </div>
  );
}
