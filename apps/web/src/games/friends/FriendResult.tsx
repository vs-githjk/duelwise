import { useEffect, useRef, type ReactNode } from 'react'
import type { Result } from '@duelwise/core/src/types'

/** A result reason as a sentence about two named people. Reasons the table does not know are only capitalised and ended. */
export function friendReason(result: Result, names: [string, string]): string {
  const reason = result.reason.trim()
  const loser = result.winner === null ? null : names[1 - result.winner]
  switch (reason) {
    case 'checkmate':
      return 'Checkmate.'
    case 'four in a row':
      return 'Four in a row.'
    case 'board full':
      return 'The board is full, so it is a draw.'
    case 'resigned':
      return loser ? `${loser} resigned.` : 'Resigned.'
    default:
      return reason ? `${reason[0]!.toUpperCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? '' : '.'}` : ''
  }
}

export interface FriendResultProps {
  result: Result
  /** Display names by game seat. */
  names: [string, string]
  /** The score of this sitting, by person: [player one, player two, draws]. */
  tally: { one: number; two: number; draws: number }
  nameOne: string
  nameTwo: string
  onRematch: () => void
  onDone: () => void
  /** What the game reveals at the end: the answer word, the two fleets. Sits between the verdict and the score. */
  reveal?: ReactNode
}

/**
 * The end of a friend game. Two people, so there is no "you won" or "you lost": the headline names the winner. The score is the score of
 * this sitting and goes away with it (nothing is saved). Rematch swaps sides.
 */
export function FriendResult({ result, names, tally, nameOne, nameTwo, onRematch, onDone, reveal }: FriendResultProps) {
  const headline = useRef<HTMLHeadingElement>(null)
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    headline.current?.focus({ preventScroll: true })
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (window.innerWidth >= 1024) return
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => root.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })))
    return () => cancelAnimationFrame(raf)
  }, [])
  const title = result.winner === null ? 'A draw' : `${names[result.winner]} wins`
  const games = tally.one + tally.two + tally.draws
  return (
    <section ref={root} className="grid gap-4 rounded-card border border-line bg-surface p-5 shadow-card" data-testid="friend-result" data-winner={String(result.winner)} aria-labelledby="friend-result-title">
      <div className="grid gap-1">
        <h2 id="friend-result-title" ref={headline} tabIndex={-1} className="font-display text-display-md text-ink outline-none" data-testid="friend-result-title">
          {title}
        </h2>
        <p className="text-muted" data-testid="friend-result-reason">
          {friendReason(result, names)}
        </p>
      </div>
      {reveal}
      <dl className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-control bg-surface-2 px-4 py-3" data-testid="friend-tally" aria-label={`Score so far: ${nameOne} ${tally.one}, ${nameTwo} ${tally.two}${tally.draws ? `, ${tally.draws} drawn` : ''}`}>
        <div className="min-w-0">
          <dt className="truncate text-sm text-muted">{nameOne}</dt>
          <dd className="font-display text-display-sm tabular">{tally.one}</dd>
        </div>
        <span className="text-sm text-muted" aria-hidden="true">
          {games === 1 ? '1 game' : `${games} games`}
        </span>
        <div className="min-w-0 text-right">
          <dt className="truncate text-sm text-muted">{nameTwo}</dt>
          <dd className="font-display text-display-sm tabular">{tally.two}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onRematch} className="min-h-12 rounded-control bg-action px-5 font-semibold text-action-ink" data-testid="friend-rematch">
          Rematch, swap sides
        </button>
        <button type="button" onClick={onDone} className="min-h-12 rounded-control border border-line bg-surface px-5 font-semibold" data-testid="friend-done">
          Done
        </button>
      </div>
    </section>
  )
}
