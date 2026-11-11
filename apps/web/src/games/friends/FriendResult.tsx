import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import type { Result } from '@duelwise/core/src/types'
import { FRIEND_NOT_RATED, friendRatingLine, recordLine, yourRatingLine } from '../../lib/friend-copy'
import type { FriendRecord } from './friend-record'

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
    default: {
      // The core words a chip margin "ahead by N chips after M hands" (replays compare that text exactly, so it stays); the person reads the right plural.
      const chips = /^ahead by (\d+) chips after (\d+) hands$/.exec(reason)
      if (chips) return `Ahead by ${chips[1]} ${chips[1] === '1' ? 'chip' : 'chips'} after ${chips[2]} ${chips[2] === '1' ? 'hand' : 'hands'}.`
      return reason ? `${reason[0]!.toUpperCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? '' : '.'}` : ''
    }
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
  /** Two devices: where the rematch vote stands. `sent` is my yes waiting for them, `offered` is theirs waiting for me. Absent on one device. */
  rematch?: { state: 'idle' | 'sent' | 'offered'; them: string }
  /** The line under the score: one device says nothing is saved, two devices say the same about the room. */
  doneLabel?: string
  /** Two devices: the head-to-head record with this friend and the ratings both people already have against the AI. Absent on one device. */
  record?: FriendRecord
  /** The game, for the record's wording and the leaderboard link. Needed with `record`. */
  game?: GameId
}

/** The record with this friend (this game, and every game when more than one has been played) plus the ratings line. Keeps its height while it loads, so nothing jumps. */
function RecordBlock({ record, game, friend }: { record: FriendRecord; game: GameId | undefined; friend: string }) {
  if (record.status === 'off') return null
  const name = game ? PRODUCT.games[game].displayName : 'this game'
  if (record.status === 'loading') {
    return (
      <div className="grid min-h-[5.5rem] content-center gap-1 rounded-control border border-line px-4 py-3" data-testid="friend-record" data-state="loading" role="status">
        <p className="text-sm text-muted">Checking your record with {friend}</p>
      </div>
    )
  }
  const { card, ratings } = record
  const them = card.friend
  const youLine = yourRatingLine(ratings.you)
  const themLine = friendRatingLine(them, ratings.them)
  return (
    <>
      <div className="grid gap-1 rounded-control border border-line px-4 py-3" data-testid="friend-record" data-state="ready">
        <p className="text-sm text-muted">Your record against {them}, {name}</p>
        <p className="break-words font-display text-display-sm tabular" data-testid="friend-record-line">
          {recordLine(them, card.game)}
        </p>
        {card.gamesPlayed > 1 ? (
          <p className="text-sm text-muted" data-testid="friend-record-all">
            All games together: {recordLine(them, card.all)}
          </p>
        ) : null}
        <Link to="/friends" className="inline-flex min-h-11 items-center justify-self-start text-sm font-semibold text-action" data-testid="friend-record-link">
          All your friends
        </Link>
      </div>
      {youLine || themLine ? (
        <p className="text-sm text-muted" data-testid="friend-ratings">
          {[themLine, youLine].filter(Boolean).join(' ')}{' '}
          {game ? (
            <Link to="/leaderboard/$game" params={{ game: PRODUCT.games[game].slug }} className="font-semibold text-action" data-testid="friend-ratings-link">
              Leaderboard
            </Link>
          ) : null}
        </p>
      ) : null}
    </>
  )
}

/**
 * The end of a friend game. Two people, so there is no "you won" or "you lost": the headline names the winner. The score is the score of
 * this sitting and goes away with it (nothing is saved). Rematch swaps sides.
 */
export function FriendResult({ result, names, tally, nameOne, nameTwo, onRematch, onDone, reveal, rematch, doneLabel, record, game }: FriendResultProps) {
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
      {record ? <RecordBlock record={record} game={game} friend={nameTwo} /> : null}
      <p className="text-sm text-muted" data-testid="friend-not-rated">
        {FRIEND_NOT_RATED}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onRematch} disabled={rematch?.state === 'sent'} className="min-h-12 rounded-control bg-action px-5 font-semibold text-action-ink disabled:opacity-60" data-testid="friend-rematch" data-rematch={rematch?.state}>
          {rematch?.state === 'sent' ? `Waiting for ${rematch.them}` : rematch?.state === 'offered' ? `${rematch.them} wants a rematch. Accept, swap sides` : 'Rematch, swap sides'}
        </button>
        <button type="button" onClick={onDone} className="min-h-12 rounded-control border border-line bg-surface px-5 font-semibold" data-testid="friend-done">
          {doneLabel ?? 'Done'}
        </button>
      </div>
    </section>
  )
}
