import { useState } from 'react'
import type { GameId, Level } from '@duelwise/core/src/product'
import type { Result } from '@duelwise/core/src/types'
import { OpponentContext } from '../personas/context'
import { ResultPanel } from '../components/ResultPanel'
import { takeCall, writeCall } from '../lib/progress'

/** Dev-only: the Sunroom result panel for one game, level, call and outcome, chosen in the query (?game=word&level=medium&call=hard&outcome=win). For screenshots and design work. */
export default function ResultView() {
  const q = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  const game = (q.get('game') ?? 'word') as GameId
  const level = (q.get('level') ?? 'medium') as Level
  const call = (q.get('call') ?? 'hard') as Level
  const outcome = q.get('outcome') ?? 'win'
  const [n, setN] = useState(0)
  if (typeof window !== 'undefined') {
    writeCall(game, call)
    takeCall(game)
  }
  const winner = outcome === 'win' ? 0 : outcome === 'loss' ? 1 : null
  const result: Result = { winner, score: [winner === 0 ? 1 : 0, winner === 1 ? 1 : 0], reason: 'solved first' }
  return (
    <OpponentContext.Provider value={{ game, level }}>
      <div className="mx-auto max-w-lg py-6">
        <ResultPanel result={result} humanSeat={0} moves={4} onRematch={() => setN((x) => x + 1)} onPlayLevel={() => setN((x) => x + 1)} onChangeLevel={() => {}} upload={{ status: 'counted', matchId: 'dev' }} />
        <p data-testid="dev-clicks" hidden>{n}</p>
      </div>
    </OpponentContext.Provider>
  )
}
