import type { Kpis, OwnerViewBody } from '../server/telemetry-stats'
import { GamesPlayedPanel } from '../components/owner/Panels'

/** Local-only look at the owner "Games played" panel with made-up numbers. Not bundled in production. */
const matches = (value: number, previous: number, series: number[]) => ({ matches: { value, previous, series } }) as unknown as Kpis
const v = {
  kpisBy: {
    human: matches(14, 180, [6, 1, 1, 1, 2, 1, 2]),
    owner: matches(29, 40, [0, 0, 0, 0, 0, 0, 0]),
    test: matches(0, 0, [0, 0, 0, 0, 0, 0, 0]),
    total: matches(43, 220, [0, 0, 0, 0, 0, 0, 0]),
  },
  friends: { value: 37, previous: 22, series: [4, 9, 6, 3, 5, 4, 6], byGame: [{ game: 'chess', count: 21 }, { game: 'four', count: 11 }, { game: 'holdem', count: 5 }] },
} as unknown as OwnerViewBody

export default function OwnerGamesView() {
  return (
    <div className="grid gap-8 py-8">
      <GamesPlayedPanel v={v} level={undefined} />
      <GamesPlayedPanel v={v} level="hard" />
    </div>
  )
}
