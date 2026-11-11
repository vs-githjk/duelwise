import { useState } from 'react'
import type { GameId, Level } from '@duelwise/core/src/product'
import type { Result } from '@duelwise/core/src/types'
import { OpponentContext } from '../personas/context'
import { ResultPanel } from '../components/ResultPanel'
import { takeCall, writeCall } from '../lib/progress'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { personaFor } from '../personas'
import { nearMissFor } from '../report/moments'
import { playHoldemTo, playRandom, playRealtime } from '../report/testing'

/** A fixture match played on the real core: ?rec=fighter:9:1 is game:seed:humanSeat. Real-time games are random-input matches, Hold'em a passive one, the rest random legal play (report/testing.ts). */
function fixture(spec: string | null): MatchRecordV1 | null {
  const [game, seed, seat] = (spec ?? '').split(':')
  if (!game || !seed) return null
  const s = Number(seed)
  const humanSeat = seat === '1' ? 1 : 0
  if (game === 'fighter' || game === 'arena') return playRealtime(game, s, humanSeat)
  if (game === 'holdem') return playHoldemTo(s, humanSeat, 5, 'medium', true, true)
  return playRandom(game as MatchRecordV1['game'], s, humanSeat)
}

/**
 * Dev-only: the Sunroom result panel for one game, level, call and outcome, chosen in the query (?game=word&level=medium&call=hard&outcome=win). For screenshots and design work.
 * With ?rec=<game>:<seed>:<seat> the panel shows the verdict, the score and the near-miss strip of a match replayed from that fixture record, the way a live result would.
 */
export default function ResultView() {
  const q = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  const rec = fixture(q.get('rec'))
  const game = (rec?.game ?? q.get('game') ?? 'word') as GameId
  const level = (q.get('level') ?? 'medium') as Level
  const call = (q.get('call') ?? 'hard') as Level
  const outcome = rec ? (rec.result.winner === null ? 'draw' : rec.result.winner === rec.humanSeat ? 'win' : 'loss') : (q.get('outcome') ?? 'win')
  const [n, setN] = useState(0)
  if (typeof window !== 'undefined') {
    writeCall(game, call)
    takeCall(game)
  }
  const winner = outcome === 'win' ? 0 : outcome === 'loss' ? 1 : null
  const result: Result = rec ? rec.result : { winner, score: [winner === 0 ? 1 : 0, winner === 1 ? 1 : 0], reason: 'solved first' }
  const nearMiss = rec ? nearMissFor(rec, personaFor(level).name, { surface: 'result' }) : null
  return (
    <OpponentContext.Provider value={{ game, level }}>
      <div className="mx-auto max-w-lg py-6">
        <ResultPanel result={result} humanSeat={rec?.humanSeat ?? 0} moves={4} nearMiss={nearMiss} onRematch={() => setN((x) => x + 1)} onPlayLevel={() => setN((x) => x + 1)} onChangeLevel={() => {}} upload={{ status: 'counted', matchId: 'dev' }} />
        <p data-testid="dev-clicks" hidden>{n}</p>
      </div>
    </OpponentContext.Provider>
  )
}
