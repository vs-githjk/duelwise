import type { Series } from './types'
import { layoutLabels } from './chart-labels'

const W = 640
const H = 240
const PAD = { l: 36, r: 14, t: 20, b: 26 }

/**
 * "How the game went": the evaluation after every half-move from the player's side, up is better for
 * the player. Hand-rolled SVG; the best, worst and turning moves carry a marker and a label.
 */
export function EvalChart({ series, viewer = 'owner' }: { series: Series; viewer?: 'owner' | 'public' }) {
  const owner = viewer === 'owner'
  const pts = series.points
  const n = pts.length
  if (n < 2) return null
  const peak = Math.max(2, Math.ceil(Math.max(...pts.map(Math.abs))))
  const x = (i: number) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + ((peak - v) / (2 * peak)) * (H - PAD.t - PAD.b)
  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const zero = y(0)
  const area = `${line} L${x(n - 1).toFixed(1)} ${zero.toFixed(1)} L${x(0).toFixed(1)} ${zero.toFixed(1)} Z`
  const ticks = [peak, 0, -peak]
  const placed = layoutLabels(series.marks.map((m) => ({ x: x(m.at), y: y(pts[m.at]!), text: m.label, up: pts[m.at]! >= 0 })), { w: W, h: H, top: PAD.t - 4, bottom: H - PAD.b - 4 })
  const final = pts[n - 1]!
  const summary = `${series.label}. It ends ${final >= 0 ? (owner ? 'in your favour' : 'in the player\'s favour') : owner ? 'against you' : 'against the player'}. ${series.marks.map((m) => m.label).join(', ')}.`
  return (
    <figure className="grid gap-2" data-testid="eval-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="h-auto w-full">
        <defs>
          <clipPath id="eval-above"><rect x="0" y="0" width={W} height={zero} /></clipPath>
          <clipPath id="eval-below"><rect x="0" y={zero} width={W} height={H - zero} /></clipPath>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeDasharray={t === 0 ? '4 4' : undefined} />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{t > 0 ? `+${t}` : t}</text>
          </g>
        ))}
        <path d={area} fill="var(--good-soft)" clipPath="url(#eval-above)" />
        <path d={area} fill="var(--bad-soft)" clipPath="url(#eval-below)" />
        <path d={line} fill="none" stroke="var(--ink)" strokeWidth="1.75" strokeLinejoin="round" />
        {series.marks.map((m) => (
          <circle key={m.label} cx={x(m.at)} cy={y(pts[m.at]!)} r="5" fill="var(--surface)" stroke={m.kind === 'worst' ? 'var(--bad)' : m.kind === 'best' ? 'var(--good)' : 'var(--ink)'} strokeWidth="2" />
        ))}
        {placed.map((l) => (
          <text key={l.text} x={l.x} y={l.y} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--ink)" stroke="var(--surface)" strokeWidth="3" paintOrder="stroke" data-testid="chart-label">{l.text}</text>
        ))}
        <text x={PAD.l} y={H - 6} fontSize="11" fill="var(--muted)">move 1</text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="11" fill="var(--muted)">move {Math.ceil(n / 2)}</text>
      </svg>
      <figcaption className="text-sm text-muted">{series.label}. {owner ? 'Above the line you are ahead' : 'Above the line the player is ahead'}, below it the AI is. Scale: {series.unit}.</figcaption>
    </figure>
  )
}
