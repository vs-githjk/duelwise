import { useEffect, useRef, useState } from 'react'
import { shownLabelIndexes } from './ticks'

export interface ChartSeries {
  key: string
  label: string
  /** A CSS colour token such as var(--level-2). */
  color: string
  /** One value per x label; null leaves a gap. */
  values: Array<number | null>
  counts?: number[]
}

export interface LineChartProps {
  series: ChartSeries[]
  xLabels: string[]
  /** Top of the y axis. */
  yMax?: number
  formatY: (v: number) => string
  /** Accessible name; the sr-only table below carries the numbers. */
  caption: string
  testId?: string
}

// The SVG is drawn in real pixels (viewBox equals the measured width), so a label's font size is its on-screen size at
// every width. Scaling a fixed viewBox made 16-unit labels 24 px tall at 1440 and overlap.
const H = 220
const M = { l: 44, r: 24, t: 12, b: 30 }
const FONT = 12
const LABEL_GAP = 56
const TICKS = [0, 0.25, 0.5, 0.75, 1]

/** Hand-rolled SVG line chart in pixel units, with x labels thinned to fit the measured width. */
export function LineChart({ series, xLabels, yMax = 1, formatY, caption, testId }: LineChartProps) {
  const n = xLabels.length
  const box = useRef<HTMLElement>(null)
  const [W, setW] = useState(360)
  const hasPoints = series.some((s) => s.values.filter((v) => v !== null).length >= 2)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setW(Math.max(240, Math.round(el.getBoundingClientRect().width)))
    read()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [hasPoints])
  if (!hasPoints) return <p className="text-sm text-muted" data-testid={testId ? `${testId}-empty` : undefined}>Not enough weekly results to chart yet.</p>
  const shown = new Set(shownLabelIndexes(n, W - M.l - M.r, LABEL_GAP))
  const x = (i: number) => M.l + (n <= 1 ? (W - M.l - M.r) / 2 : (i * (W - M.l - M.r)) / (n - 1))
  const y = (v: number) => M.t + (1 - Math.min(v, yMax) / yMax) * (H - M.t - M.b)
  return (
    <figure ref={box} className="relative grid min-w-0 gap-3" data-testid={testId}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={caption} className="block max-w-full">
        {TICKS.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={y(t * yMax)} y2={y(t * yMax)} stroke="var(--line)" strokeWidth={1} />
            <text x={M.l - 8} y={y(t * yMax) + 4} data-axis="y" textAnchor="end" fontSize={FONT} fill="var(--muted)">
              {formatY(t * yMax)}
            </text>
          </g>
        ))}
        {xLabels.map((l, i) =>
          shown.has(i) ? (
            <text key={`${l}-${i}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize={FONT} fill="var(--muted)" data-axis="x">
              {l}
            </text>
          ) : null,
        )}
        {series.map((s, seriesIndex) => {
          const segs: string[] = []
          let cur = ''
          s.values.forEach((v, i) => {
            if (v === null) {
              if (cur) segs.push(cur)
              cur = ''
            } else cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`
          })
          if (cur) segs.push(cur)
          return (
            <g key={s.key} data-series={s.key}>
              {segs.map((d) => (
                <path key={d} d={d} fill="none" stroke={s.color} strokeWidth={2.5} strokeDasharray={['', '7 3', '2 3', '9 3 2 3'][seriesIndex % 4]} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {s.values.map((v, i) => (v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={3.5} fill={s.color} />))}
            </g>
          )
        })}
      </svg>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted" aria-label="Legend">
        {series.map((s, seriesIndex) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block w-6 border-t-2" style={{ borderColor: s.color, borderTopStyle: seriesIndex % 4 === 0 ? 'solid' : 'dashed' }} />
            {s.label}
          </li>
        ))}
      </ul>
      {series.some((s) => s.counts) ? <div className="overflow-x-auto"><table className="w-full min-w-max text-left text-xs"><caption className="sr-only">Match counts by week and level</caption><thead><tr><th scope="col" className="pr-4">Matches</th>{xLabels.map((label, i) => <th scope="col" className="px-2 font-normal" key={i}>{label}</th>)}</tr></thead><tbody>{series.map((s) => <tr key={s.key}><th scope="row" className="pr-4 font-semibold">{s.label}</th>{xLabels.map((_, i) => <td key={i} className="px-2 font-mono">n={s.counts?.[i] ?? 0}</td>)}</tr>)}</tbody></table></div> : null}
      <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Series</th>
            {xLabels.map((l, i) => (
              <th scope="col" key={`${l}-${i}`}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.key}>
              <th scope="row">{s.label}</th>
              {s.values.map((v, i) => (
                <td key={i}>{v === null ? 'no matches' : `${formatY(v)}${s.counts ? `, n=${s.counts[i] ?? 0}` : ''}`}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  )
}
