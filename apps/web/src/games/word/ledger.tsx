import { useEffect, useRef } from 'react'
import { cn } from '../../lib/cn'
import { MARKER_CUE, playCue } from './sounds'

const SHAPE = ['dash', 'ring', 'dot'] as const
const LABEL = ['not in the word', 'in the word, wrong spot', 'right spot'] as const
const TONE = ['text-neutral', 'text-warn', 'text-good'] as const
/** Marker colour on top of its own tile: white on the green tile, the pale amber on the amber tile, the grey ink on the grey tile. */
const ON_TILE = ['text-neutral-ink', 'text-warn-soft', 'text-white'] as const
const TILE = ['bg-surface-2 text-muted', 'bg-warn text-white', 'bg-good text-white'] as const

/** Shape plus colour: filled dot for the right spot, ring for elsewhere in the word, dash for absent. */
export function Marker({ kind, small = false, onTile = false }: { kind: number; small?: boolean; onTile?: boolean }) {
  return (
    <span data-marker data-shape={SHAPE[kind]} role="img" aria-label={LABEL[kind]} className={cn('inline-flex items-center justify-center', small ? 'size-3.5' : 'size-5', onTile ? ON_TILE[kind] : TONE[kind])}>
      <svg viewBox="0 0 20 20" width={small ? 12 : 18} height={small ? 12 : 18} aria-hidden="true" focusable="false">
        {kind === 2 ? <circle cx="10" cy="10" r="7" fill="currentColor" /> : null}
        {kind === 1 ? <circle cx="10" cy="10" r="5.5" fill="none" stroke="currentColor" strokeWidth="2.5" /> : null}
        {kind === 0 ? <line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /> : null}
      </svg>
    </span>
  )
}

const FLIP_MS = 90
const WORD_LENGTH = 5

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** The most letters one row has in the right spot, and whether any row solved the word. */
export function raceProgress(rows: number[][]): { placed: number; solved: boolean } {
  let placed = 0
  for (const r of rows) placed = Math.max(placed, r.filter((k) => k === 2).length)
  return { placed, solved: placed === WORD_LENGTH }
}

/** One of your guesses: five tiles whose fill says right spot, in the word, or not in it, each with its shape so colour is never the only cue. */
function MyRow({ word, markers, animate }: { word: string; markers: number[]; animate: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!animate) return
    markers.forEach((k, i) => playCue(MARKER_CUE[k]!, i * FLIP_MS + 180))
    if (prefersReducedMotion() || !ref.current) return
    ref.current.querySelectorAll<HTMLElement>('[data-letter-cell]').forEach((el, i) => {
      el.animate?.([{ transform: 'rotateX(90deg)', opacity: 0 }, { transform: 'rotateX(0deg)', opacity: 1 }], { duration: 260, delay: i * FLIP_MS, easing: 'ease-out', fill: 'backwards' })
    })
    ref.current.querySelectorAll<HTMLElement>('[data-marker]').forEach((el, i) => {
      el.animate?.([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.25)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], { duration: 280, delay: i * FLIP_MS + 180, easing: 'ease-out', fill: 'backwards' })
    })
    // Runs once when the row appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div ref={ref} className="grid h-11 grid-cols-5 gap-1" data-testid="guess-row">
      {markers.map((k, i) => (
        <span key={i} data-letter-cell data-tile className={cn('relative grid min-w-0 place-items-center rounded-control font-mono text-lg font-semibold uppercase leading-none', TILE[k])}>
          {word[i]}
          <span className="absolute right-0.5 top-0.5">
            <Marker kind={k} small onTile />
          </span>
        </span>
      ))}
    </div>
  )
}

/** One of the opponent's rows: five circles, never letters (until the match is over, when the page passes them). */
function TheirRow({ word, markers, animate }: { word?: string; markers: number[]; animate: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!animate || prefersReducedMotion() || !ref.current) return
    ref.current.querySelectorAll<HTMLElement>('[data-marker]').forEach((el, i) => {
      el.animate?.([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.2)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], { duration: 280, delay: i * FLIP_MS + 180, easing: 'ease-out', fill: 'backwards' })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (word) {
    return (
      <div className="grid h-11 grid-cols-5 gap-1" data-testid="guess-row-ai">
        {markers.map((k, i) => (
          <span key={i} data-letter-cell data-tile className={cn('relative grid min-w-0 place-items-center rounded-control font-mono text-lg font-semibold uppercase leading-none', TILE[k])}>
            {word[i]}
            <span className="absolute right-0.5 top-0.5">
              <Marker kind={k} small onTile />
            </span>
          </span>
        ))}
      </div>
    )
  }
  return (
    <div ref={ref} className="grid h-11 grid-cols-5 items-center justify-items-center gap-1" data-testid="guess-row-ai">
      {markers.map((k, i) => (
        <span
          key={i}
          data-marker
          data-shape={['hollow', 'ring', 'dot'][k]}
          role="img"
          aria-label={LABEL[k]}
          className={cn('size-5 rounded-full', k === 2 ? 'bg-current text-good' : k === 1 ? 'border-[3px] border-current text-warn' : 'border-2 border-current text-muted')}
        />
      ))}
    </div>
  )
}

/** The round you are typing: a dashed row that fills as you type. Not a letter cell, so no cells exist before the first guess is sent. */
function DraftRow({ draft }: { draft: string }) {
  return (
    <div className="grid h-11 grid-cols-5 gap-1" data-testid="draft-row" aria-hidden="true">
      {Array.from({ length: WORD_LENGTH }, (_, i) => (
        <span key={i} data-draft-cell className={cn('grid min-w-0 place-items-center rounded-control border-2 border-dashed transition-none font-mono text-lg font-semibold uppercase leading-none', draft[i] ? 'border-action bg-action-soft text-ink' : 'border-action/50')}>
          {draft[i] ?? ''}
        </span>
      ))}
    </div>
  )
}

export interface WordLedgerProps {
  you: { words: string[]; rows: number[][] }
  opponentName: string
  /** The opponent's marker rows; its letters are passed only once the match is over. */
  opponent: { rows: number[][]; words?: string[] }
  maxGuesses: number
  /** What is typed in the box right now, shown in the current round's dashed row. */
  draft: string
  over: boolean
}

/**
 * The round ledger: one card, one row per round. Your tiles on the left, the opponent's marks on the right (circles only, same word),
 * a round number between them. The current round is a dashed row that fills as you type.
 */
export function WordLedger({ you, opponentName, opponent, maxGuesses, draft, over }: WordLedgerProps) {
  const played = Math.max(you.rows.length, opponent.rows.length)
  const live = !over && you.rows.length < maxGuesses
  const rounds = Math.max(played, you.rows.length + (live ? 1 : 0))
  return (
    <section data-testid="word-ledger" aria-label="Round ledger" data-paper="" className="lane-paper grid gap-2 rounded-card border p-3 sm:p-4">
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,1fr)] items-baseline gap-x-2 text-base font-semibold text-muted sm:gap-x-3" aria-hidden="true" data-testid="ledger-header">
        <span />
        <b className="text-base font-bold text-ink">You</b>
        <span data-testid="ledger-opponent">{opponentName}, same word</span>
      </div>
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-2 sm:gap-x-3">
        <ol className="grid auto-rows-[2.75rem] content-start gap-y-1.5" aria-hidden="true">
          {Array.from({ length: rounds }, (_, i) => (
            <li key={i} className="grid place-items-center font-mono text-base font-semibold text-muted tabular">{i + 1}</li>
          ))}
        </ol>
        <div data-testid="lane-you" role="group" aria-label={`You, ${you.rows.length} of ${maxGuesses} guesses`} className="grid auto-rows-[2.75rem] content-start gap-y-1.5">
          {you.rows.map((m, i) => (
            <MyRow key={i} word={you.words[i] ?? ''} markers={m} animate={i === you.rows.length - 1} />
          ))}
          {live ? <DraftRow draft={draft} /> : null}
        </div>
        <div data-testid="lane-ai" role="group" aria-label={`${opponentName}, ${opponent.rows.length} of ${maxGuesses} guesses, markers only`} className="grid auto-rows-[2.75rem] content-start gap-y-1.5">
          {opponent.rows.map((m, i) => (
            <TheirRow key={i} word={opponent.words?.[i]} markers={m} animate={i === opponent.rows.length - 1} />
          ))}
        </div>
      </div>
      {played === 0 ? <p className="text-base text-muted" data-testid="ledger-empty">Type a word below. Your tiles land on the left, {opponentName}'s marks on the right, without letters.</p> : null}
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-base font-medium text-muted" data-testid="marker-key" aria-label="What the marks mean">
        {[[2, 'Right spot'], [1, 'Wrong spot'], [0, 'Not in the word']].map(([kind, label]) => (
          <li key={kind} className="inline-flex items-center gap-1"><Marker kind={kind as number} />{label}</li>
        ))}
      </ul>
    </section>
  )
}

function RoundRow({ testId, name, rows, maxGuesses, fill }: { testId: string; name: string; rows: number[][]; maxGuesses: number; fill: string }) {
  const { placed, solved } = raceProgress(rows)
  return (
    <div data-testid={testId} data-guesses={rows.length} data-placed={placed} data-solved={String(solved)} aria-label={`${rows.length} of ${maxGuesses} guesses`} className="grid min-w-0 content-start gap-1">
      <b className="truncate text-base font-bold">{name}</b>
      <span className="font-display text-xl font-bold leading-tight tabular" data-testid={`${testId}-score`}>
        {solved ? 'Solved' : `${placed} of ${WORD_LENGTH} placed`}
      </span>
      <div className="race-track" role="meter" aria-label={`${name}: best row has ${placed} of ${WORD_LENGTH} letters in the right spot`} aria-valuemin={0} aria-valuemax={WORD_LENGTH} aria-valuenow={placed}>
        <div className={cn('race-fill', fill)} style={{ width: `${(placed / WORD_LENGTH) * 100}%` }} />
      </div>
    </div>
  )
}

/** "Round 3 of 6" and how close each side is, from the markers both sides can see. On a phone it stays pinned to the top of the screen while you type. */
export function RoundCard({ you, opponentName, opponent, maxGuesses, over }: { you: number[][]; opponentName: string; opponent: number[][]; maxGuesses: number; over: boolean }) {
  const round = Math.min(maxGuesses, Math.max(you.length + (over ? 0 : 1), 1))
  return (
    <section data-testid="race-bar" data-over={over ? 'true' : undefined} aria-label="Round" className="word-score grid gap-2 rounded-card border border-line bg-surface px-4 py-3">
      <h2 className="font-display text-display-sm" data-testid="round-title">{over ? 'Match over' : `Round ${round} of ${maxGuesses}`}</h2>
      <div className="grid grid-cols-2 gap-4">
        <RoundRow testId="race-bar-you" name="You" rows={you} maxGuesses={maxGuesses} fill="bg-game-word" />
        <RoundRow testId="race-bar-ai" name={opponentName} rows={opponent} maxGuesses={maxGuesses} fill="bg-neutral" />
      </div>
    </section>
  )
}

/** The final score for the result panel: how each side finished. */
export function ResultScore({ you, opponentName, opponent }: { you: number[][]; opponentName: string; opponent: number[][] }) {
  const line = (rows: number[][]) => { const p = raceProgress(rows); return p.solved ? `Solved in ${rows.length}` : `${p.placed} of ${WORD_LENGTH} placed` }
  return (
    <dl className="grid grid-cols-2 gap-3 rounded-control bg-surface-2 px-3 py-2" data-testid="word-result-score">
      <div className="grid min-w-0"><dt className="truncate text-base font-semibold text-muted">You</dt><dd className="font-display text-xl font-bold tabular">{line(you)}</dd></div>
      <div className="grid min-w-0"><dt className="truncate text-base font-semibold text-muted">{opponentName}</dt><dd className="font-display text-xl font-bold tabular">{line(opponent)}</dd></div>
    </dl>
  )
}
