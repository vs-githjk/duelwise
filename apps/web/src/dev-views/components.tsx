import { useState } from 'react'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import type { Result } from '@duelwise/core/src/types'
import { GameShell } from '../components/GameShell'
import { LevelPicker } from '../components/LevelPicker'
import { ResultPanel } from '../components/ResultPanel'
import { inTrainingCopy, type LevelInfo } from '../lib/level-info'

const SAMPLE_LEVELS: Partial<Record<Level, LevelInfo>> = {
  easy: { preview: false, strength: 'site Elo 1000' },
  medium: { preview: true },
  hard: { preview: true, inTraining: inTrainingCopy('hard') },
  champion: { preview: true },
}

const RESULTS: Array<{ key: string; result: Result }> = [
  { key: 'win', result: { winner: 0, score: [1, 0], reason: 'Four in a row' } },
  { key: 'loss', result: { winner: 1, score: [0, 1], reason: 'Opponent connected four' } },
  { key: 'draw', result: { winner: null, score: [0, 0], reason: 'Board full' } },
]

/** Dev-only gallery of the shared play-page components, used by the shell spec and for design work. */
export default function ComponentsView() {
  const [level, setLevel] = useState<Level>('easy')
  const [thinking, setThinking] = useState(false)
  const [rematches, setRematches] = useState(0)
  return (
    <div className="grid gap-8 py-4">
      <GameShell
        game="four"
        level={level}
        preview
        thinking={thinking}
        actions={
          <button type="button" className="min-h-11 rounded-control border border-line px-3" onClick={() => setThinking((t) => !t)}>
            Toggle thinking
          </button>
        }
        aside={<LevelPicker value={level} onChange={setLevel} levels={SAMPLE_LEVELS} statsSlug={PRODUCT.games.four.slug} />}
      >
        <div className="grid min-h-40 place-items-center rounded-card border border-line bg-surface-2 text-muted">Board area</div>
      </GameShell>

      <div className="grid gap-4 md:grid-cols-3">
        {RESULTS.map((r) => (
          <ResultPanel
            key={r.key}
            result={r.result}
            humanSeat={0}
            elo={r.key === 'win' ? { before: 1000, after: 1012 } : undefined}
            recordOk={r.key !== 'draw'}
            onRematch={() => setRematches((n) => n + 1)}
            onChangeLevel={() => {}}
          />
        ))}
      </div>
      <p data-testid="rematches">{rematches}</p>

      <GameShell game="fighter">
        <div data-testid="fighter-stage">Stage</div>
      </GameShell>
    </div>
  )
}
