import { LearnChart } from '../components/LearnGraph'
import { pointsFor } from '../lib/learn-copy'

/** Dev-only: the learn chart with made-up weekly numbers, so the dashed and hollow weeks and the version markers can be looked at. Never shown in production. */
export default function LearnView() {
  const start = Date.parse('2026-09-07T00:00:00Z')
  const weekly = [36, 40, 42, 44, 40, 36, 31, 28].map((rate, i) => {
    const games = i === 0 ? 12 : i === 6 ? 18 : 60
    return { start: new Date(start + i * 7 * 86_400_000).toISOString(), levels: { medium: { games, wins: Math.round((games * rate) / 100) } } }
  })
  return (
    <div className="mx-auto max-w-2xl py-6">
      <LearnChart points={pointsFor(weekly, 'medium')} markers={[{ version: 'v1', at: start + 8 * 86_400_000 }, { version: 'v2', at: start + 40 * 86_400_000 }]} label="Sample numbers." caption="Sample chart" />
    </div>
  )
}
