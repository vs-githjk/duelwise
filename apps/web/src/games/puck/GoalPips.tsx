import type { CSSProperties } from 'react'
import type { Level } from '@duelwise/core/src/product'
import type { GoalPip } from '../../report/puck'
import { OPPONENT_MALLET } from './render'

/**
 * The goals of the match as a compact row, in order: a pip in your colour for each of yours, one in the opponent's persona colour for
 * each of theirs, and a ring on the goal the turning point line names (when it names one). The whole row is one labelled image whose
 * label is the same sentence the report prints, so a screen reader hears the goals, not a row of dots.
 */
export function GoalPips({ pips, label, opponent, level }: { pips: GoalPip[]; label: string; opponent: string; level: Level }) {
  if (pips.length === 0) return null
  const hasTurning = pips.some((p) => p.turning)
  return (
    <div className="grid gap-1.5 text-xs text-muted" data-testid="puck-goal-pips" style={{ '--opp': OPPONENT_MALLET[level].deep } as CSSProperties}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-ink">Goals</span>
        <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="inline-block size-2.5 rounded-full bg-action" />You</span>
        <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="inline-block size-2.5 rounded-full" style={{ background: 'var(--opp)' }} />{opponent}</span>
        {hasTurning ? <span className="inline-flex items-center gap-1"><i aria-hidden="true" className="inline-block size-2.5 rounded-full ring-2 ring-ink ring-offset-1 ring-offset-surface" />Turning point</span> : null}
      </div>
      <div role="img" aria-label={label} className="flex flex-wrap items-center gap-1.5">
        {pips.map((p, i) => (
          <i
            key={i}
            aria-hidden="true"
            data-pip={p.mine ? 'you' : 'them'}
            data-turning={p.turning ? 'true' : undefined}
            className={p.turning ? 'inline-block size-4 rounded-full ring-2 ring-ink ring-offset-2 ring-offset-surface' : 'inline-block size-4 rounded-full'}
            style={{ background: p.mine ? 'var(--action)' : 'var(--opp)' }}
          />
        ))}
      </div>
    </div>
  )
}
