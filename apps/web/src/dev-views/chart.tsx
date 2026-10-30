import { LineChart } from '../components/charts/LineChart'
import { LEVEL_NAME, pct, shortDate } from '../components/charts/format'

// Dev-only view of the stats win-rate chart with eight weeks of fixture results, in the same card width as
// /agents/<game>. A fresh e2e database has at most one week of matches, which the page shows as an empty state,
// so the label size and overlap check (demo-walk.spec.ts) draws the chart here.
const WEEKS = 8
const DAY = 86_400_000
const labels = Array.from({ length: WEEKS }, (_, i) => shortDate(new Date(Date.UTC(2026, 9, 29) - (WEEKS - i) * 7 * DAY).toISOString()))
const series = [
  { key: 'easy', label: LEVEL_NAME.easy, color: '#007e75', values: [0.8, 0.75, 0.9, 0.7, 0.85, 0.8, 0.9, 0.75] },
  { key: 'medium', label: LEVEL_NAME.medium, color: '#b14c36', values: [0.5, 0.6, 0.45, 0.55, 0.5, 0.4, 0.6, 0.5] },
  { key: 'hard', label: LEVEL_NAME.hard, color: '#7355b5', values: [0.3, null, 0.35, 0.25, 0.3, 0.4, 0.2, 0.3] },
  { key: 'champion', label: LEVEL_NAME.champion, color: '#a06a00', values: [0.1, 0.15, 0.05, null, 0.1, 0.2, 0.1, 0.15] },
].map((s) => ({ ...s, counts: s.values.map((v) => (v === null ? 0 : 12)) }))

export default function ChartView() {
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 rounded-card border border-line bg-surface p-4 shadow-card md:p-5">
      <h3 className="font-display text-display-sm">Human win rate by level</h3>
      <LineChart series={series} xLabels={labels} formatY={(v) => pct(v, 0)} caption="Fixture: human win rate by level, weekly" testId="winrate-chart" />
    </section>
  )
}
