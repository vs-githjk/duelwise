import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'
import { cn } from '../lib/cn'
import { LEVELS, LEVEL_LABEL, type LevelInfo } from '../lib/level-info'
import { Avatar } from '../personas/Avatar'
import { useOpponent } from '../personas/context'
import { personaFor } from '../personas'
import { provisionalNote, resultSentence } from '../lib/copy'
import type { Upload } from '../lib/match-recorder'
import { calledFor, keepCall, noteCleared, readPath, usePath } from '../lib/progress'
import { sayLine } from '../lib/says'
import { marginOf, type ShareFacts } from '../lib/share'
import { Ladder, ShareBlock, SaysBox } from './ResultExtras'
import { cancelSpeech, readVoicePref, speakLine, speechSupported, voiceActive, writeVoicePref } from '../lib/speech'
import { isMuted } from '../lib/audio'
import { PRACTICE_RESULT } from '../lib/practice'

/** Games whose opponent moves the server re-runs before a rated match counts (server/agent-check.ts SERVER_CHECKED); a guest's check finishes after the answer. */
const SERVER_CHECKED_GAMES: readonly string[] = ['chess', 'four', 'holdem']

export type Outcome = 'win' | 'loss' | 'draw'

/** Whether a result may clear a stop on the path: a played-out, rated win, and only after the server has accepted it (counted, or a queued match now synced). */
export function mayClear(i: { left: boolean; practice: boolean; outcome: Outcome; status: string | undefined }): boolean {
  return !i.left && !i.practice && i.outcome === 'win' && (i.status === 'counted' || i.status === 'synced')
}

export function outcomeFor(result: Result, humanSeat: Seat): Outcome {
  if (result.winner === null) return 'draw'
  return result.winner === humanSeat ? 'win' : 'loss'
}

const TONE: Record<Outcome, string> = { win: 'text-good-ink', loss: 'text-bad-ink', draw: 'text-neutral-ink' }

export interface ResultPanelProps {
  result: Result
  humanSeat: Seat
  onRematch: () => void
  onChangeLevel?: () => void
  /** Rating change from the server; omitted for guests and before upload. */
  elo?: { before: number; after: number }
  /** True when the rating was earned against a level that has no measured strength yet. */
  provisional?: boolean
  /** What happened to the upload of this match (see useMatchRecorder). */
  upload?: Upload
  /** Why this match is not counted, when it is not (fixed test seed, server unreachable). */
  unratedReason?: string | null
  /** Whether replaying the record reproduced this result; shown only when false. */
  recordOk?: boolean
  /** The honest line about what happens to this match (T21 fills the training notice). */
  note?: ReactNode
  /** A game's own reveal at the end (Word Duel's hidden word), shown right under the outcome. */
  reveal?: ReactNode
  /** Extra content between the note and the actions (a game's replay highlights). */
  extra?: ReactNode
  /** Starts a match at another level (the next stop on the path). Without it the panel offers "Change level" instead. */
  onPlayLevel?: (level: Level) => void
  /** Registry facts per level, so a level that cannot be played yet is never offered as the next stop. */
  levels?: Partial<Record<Level, LevelInfo>>
  /** The human's own moves in the record (guesses, moves), for the margin and the close-loss line. */
  moves?: number
  /** False for a game whose matches never reach a leaderboard (the real-time games): the panel then offers no leaderboard link. Default true. */
  leaderboard?: boolean
  /** Hands played when the player left the table early. The match is unrated and clears nothing, so the panel leads with that instead of a verdict. */
  leftAfter?: number | null
  className?: string
}

/**
 * End-of-match panel: outcome in the display face, the game's own reason, an optional rating change,
 * and rematch and change-level actions. A dialog-like region that takes focus when it appears.
 */
export function ResultPanel({ result, humanSeat, onRematch, onChangeLevel, elo: eloProp, provisional: provProp, upload, unratedReason, recordOk = true, note, reveal, extra, onPlayLevel, levels, moves = 0, leaderboard = true, leftAfter = null, className }: ResultPanelProps) {
  const left = leftAfter !== null
  const outcome = outcomeFor(result, humanSeat)
  const { level, game, practice = false } = useOpponent()
  const persona = level ? personaFor(level) : null
  const ref = useRef<HTMLElement>(null)
  const headline = useRef<HTMLHeadingElement>(null)
  // On match end the verdict slides into view and a screen reader lands on it. The panel is the page's first thing on a phone (above the
  // board) and sits beside the board on a wide screen, so both the scroll and the focus go to the same place.
  useEffect(() => {
    headline.current?.focus({ preventScroll: true })
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const block = window.innerWidth < 1024 ? 'start' : 'nearest'
    // The panel's arrival changes the page height above and below the board, and WebKit cancels a smooth scroll that starts in the same frame.
    // So the scroll waits two frames, and a late check puts the verdict on screen if anything moved it since.
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block }))
    })
    const check = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect()
      if (r && (r.top < 0 || r.top > window.innerHeight * 0.6)) ref.current?.scrollIntoView({ behavior: 'auto', block })
    }, 1000)
    // The correction is for a page that moved on its own; the moment the player scrolls, types or taps it is theirs to keep.
    const giveUp = () => { cancelAnimationFrame(raf); clearTimeout(check) }
    const events = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const
    for (const e of events) window.addEventListener(e, giveUp, { passive: true, once: true })
    return () => { giveUp(); for (const e of events) window.removeEventListener(e, giveUp) }
  }, [])
  const opp = persona?.name ?? 'The AI'
  const called = game && !left ? calledFor(game) : null
  const pathState = usePath(game)
  // Whether this stop was already cleared before this match, read once, so "unlocked" is only said for a new clear.
  const [firstClear] = useState(() => !left && !practice && outcome === 'win' && game !== undefined && level !== undefined && !readPath(game)[level])
  // A clear is recorded, and announced, only once the server has accepted the result: not for a practice win, a left match, a fixed-seed or
  // otherwise unrated win, nor one the server rejects. A queued offline win waits here and settles when its final status arrives.
  const clearable = !left && !practice && outcome === 'win' && game !== undefined && level !== undefined
  const accepted = upload?.status === 'counted' || upload?.status === 'synced'
  const checking = clearable && (upload?.status === 'uploading' || upload?.status === 'queued')
  useEffect(() => {
    if (mayClear({ left, practice, outcome, status: upload?.status }) && game && level) noteCleared(game, level)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearable, accepted])
  // Only the Champion's loss line quotes its record against people, so only that loss asks the server for it. 'wait' lasts until the answer or a short timeout, so the spoken line and the written one match.
  const wantsRecord = outcome === 'loss' && level === 'champion'
  const [oppRecord, setOppRecord] = useState<{ wins: number; losses: number } | null>(null)
  const [recordWait, setRecordWait] = useState(wantsRecord)
  useEffect(() => {
    if (!wantsRecord) return
    let alive = true
    const timer = setTimeout(() => alive && setRecordWait(false), 1500)
    void import('../server/landing-fns')
      .then(({ getOpponentRecordsView }) => getOpponentRecordsView())
      .then((all) => {
        const r = all.find((x) => x.level === level)
        if (alive && r) setOppRecord({ wins: r.wins, losses: r.losses })
      })
      .catch(() => {})
      .finally(() => alive && setRecordWait(false))
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [wantsRecord, level])
  const says = useMemo(() => (game && level && !left ? sayLine({ game, level, result, humanSeat, call: called, humanMoves: moves, record: oppRecord }) : null), [game, level, left, result, humanSeat, called, moves, oppRecord])
  const spoke = useRef(false)
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [voiceOn, setVoiceOn] = useState(false)
  useEffect(() => {
    setVoiceSupported(speechSupported())
    setVoiceOn(voiceActive())
    return () => cancelSpeech()
  }, [])
  useEffect(() => {
    // Once per match, even when React runs this effect twice in development; after the record answer when the line quotes it.
    if (says && !recordWait && !spoke.current) {
      spoke.current = true
      speakLine(says.text)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordWait])
  const toggleVoice = () => {
    const next = readVoicePref() === 'on' ? 'off' : 'on'
    writeVoicePref(next)
    setVoiceOn(next === 'on' && !isMuted())
    if (next === 'on' && says) speakLine(says.text, { force: true })
    else cancelSpeech()
  }
  // The player's place at this level, once the server has counted the win. Practice levels are never ranked.
  const [rank, setRank] = useState<{ place: number; of: number } | null>(null)
  const counted = upload?.status === 'counted' || upload?.status === 'synced'
  useEffect(() => {
    if (practice || !counted || outcome !== 'win' || !game || !level) return
    let alive = true
    void import('../server/identity-fns')
      .then(({ getLevelBoardView }) => getLevelBoardView({ data: { game } }))
      .then((b) => {
        const col = b.columns.find((c) => c.level === level)
        if (alive && col && !col.practice && col.me?.rank) setRank({ place: col.me.rank, of: col.rows.length + col.more })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [counted, outcome, game, level])
  const facts: ShareFacts | null = game && level && !left ? { game, level, call: called, result, humanSeat, humanMoves: moves, rank } : null
  const margin = facts ? marginOf(facts) : null
  const next = !left && outcome === 'win' && level ? LEVELS[LEVELS.indexOf(level) + 1] : undefined
  const nextPlayable = !practice && (!firstClear || accepted) && next !== undefined && !(levels?.[next]?.inTraining && !levels?.[next]?.practice) && onPlayLevel !== undefined
  const elo = eloProp ?? (upload?.status === 'counted' ? upload.elo : undefined)
  const provisional = provProp ?? (upload?.status === 'counted' ? upload.provisional : undefined)
  const delta = elo ? elo.after - elo.before : null
  const [animatedDelta, setAnimatedDelta] = useState<number | null>(delta)
  useEffect(() => {
    setAnimatedDelta(delta)
    if (delta === null || delta === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !ref.current?.animate) return
    const animation = ref.current.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 650 })
    let frame = 0
    const tick = () => {
      const progress = Math.min(1, Number(animation.currentTime ?? 0) / 650)
      setAnimatedDelta(Math.round(delta * (1 - (1 - progress) ** 3)))
      if (progress < 1 && animation.playState !== 'finished') frame = requestAnimationFrame(tick)
      else setAnimatedDelta(delta)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); animation.cancel() }
  }, [delta])
  const resultFacts = (
    <>
      <p className="text-sm text-ink" data-testid="result-reason">
        {resultSentence(result, humanSeat, persona?.name ?? 'The AI')}
      </p>
      {reveal}
      {elo && delta !== null ? (
        <p className="font-mono text-base tabular" data-testid="result-elo">
          Rating {elo.before} to {elo.after} ({delta >= 0 ? '+' : ''}
          <span aria-hidden="true">{typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? delta : animatedDelta ?? delta}</span><span className="sr-only">{delta}</span>)
          {provisional ? <span className="ml-2 font-sans text-sm text-muted" data-testid="result-elo-provisional">{provisionalNote(game)}</span> : null}
        </p>
      ) : null}
    </>
  )
  const warn = 'rounded-control bg-warn-soft px-3 py-2 text-sm text-warn-ink'
  const uploadLine =
    practice && (upload?.status === 'uploading' || upload?.status === 'counted' || upload?.status === 'synced' || upload?.status === 'queued') ? <p className="text-xs text-muted" role="status" data-testid="result-upload">{upload.status === 'uploading' ? 'Saving this practice match' : 'Saved to your history. It changes no rating, path or leaderboard.'}</p>
    : upload?.status === 'uploading' ? <p className="text-xs text-muted" role="status" data-testid="result-upload">{game && SERVER_CHECKED_GAMES.includes(game) ? 'Saving and checking this match. Rating pending for signed-in players.' : 'Saving this match'}</p>
    : upload?.status === 'counted' && !elo ? <p className="text-xs text-muted" data-testid="result-upload">{game && PRODUCT.games[game].kind === 'realtime' ? 'Saved for your report. Real-time matches do not change a rating or appear on a leaderboard yet.' : 'Saved. Sign in to get a rating.'}</p>
    : upload?.status === 'queued' ? <p className="text-xs text-muted" role="status" data-testid="result-upload">Saved on this device. It will be sent and counted when you are back online.</p>
    : upload?.status === 'synced' ? <p className="text-xs text-muted" role="status" data-testid="result-upload">Sent. This match now counts.</p>
    : upload?.status === 'not-counted' ? <p className={warn} role="status" data-testid="result-upload">This offline match could not be counted: {upload.reason}.</p>
    : upload?.status === 'rejected' ? <p className={warn} data-testid="result-upload">This match could not be verified, so it was not counted.</p>
    : upload?.status === 'failed' ? <p className={warn} data-testid="result-upload">{upload.kind === 'resign' ? 'We could not tell the server you resigned. The match will still be scored as a loss.' : 'This match could not be saved yet. It will be sent the next time you open a game. If it never arrives, it counts as a loss once the game time limit has passed.'}</p>
    : null
  const primary = 'inline-flex min-h-12 items-center justify-center rounded-full bg-action px-6 font-semibold text-action-ink'
  const outline = 'inline-flex min-h-12 items-center justify-center rounded-full border border-line bg-surface px-5 font-semibold text-ink'
  const textLink = 'inline-flex min-h-11 items-center rounded-control px-2 text-sm font-semibold text-muted underline-offset-4 hover:text-ink hover:underline'
  const hasReport = (upload?.status === 'counted' || upload?.status === 'uploading' || upload?.status === 'synced') && upload.matchId
  return (
    <section
      ref={ref}
      role="region"
      aria-label="Match result"
      data-testid="result-panel"
      data-outcome={left ? 'draw' : outcome}
      className={cn('result-rise result-panel relative grid gap-3 rounded-card border border-line bg-surface p-4 shadow-card sm:p-5', className)}
    >
      {outcome === 'win' && !left ? <span className="result-chips" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => <i key={i} style={{ '--chip-index': i } as CSSProperties} />)}</span> : null}
      <div className="result-stripe" data-result-stripe aria-hidden="true" />
      <div className="result-verdict grid content-start gap-2">
        <span className={cn('inline-flex w-fit items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold', outcome === 'win' ? 'bg-good-soft text-good-ink' : outcome === 'loss' ? 'bg-bad-soft text-bad-ink' : 'bg-neutral-soft text-neutral-ink')} data-testid="result-chip">
          <span className="size-2 rounded-full bg-current" aria-hidden="true" />
          {left ? 'Left early' : outcome === 'win' ? `Win${margin ? ` in ${margin}` : ''}` : outcome === 'loss' ? 'Loss' : 'Draw'}
        </span>
        {practice ? <span className="inline-flex w-fit items-center rounded-full bg-action-soft px-3 py-1 text-xs font-semibold text-ink" data-testid="result-practice">{PRACTICE_RESULT}</span> : null}
        <h2 ref={headline} tabIndex={-1} className="result-headline font-display text-display-md leading-tight outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-action" data-testid="result-headline">
          {called ? <span className="block text-sm font-semibold text-muted" data-testid="result-call">You called {personaFor(called).name}.</span> : null}
          {left ? (
            <span className="block text-neutral-ink" data-testid="holdem-left-note">Unrated, you left after {leftAfter} {leftAfter === 1 ? 'hand' : 'hands'}</span>
          ) : null}
          {left ? null : <span className={cn('block', TONE[outcome])}>{outcome === 'win' ? `You beat ${opp}.` : outcome === 'loss' ? `${opp} took it.` : `A draw with ${opp}.`}</span>}
        </h2>
        {level && persona ? <span className="sr-only" data-testid="result-persona">{`You played ${persona.name} (${LEVEL_LABEL[level]}).`}</span> : null}
        <div className="grid gap-1.5">{resultFacts}</div>
      </div>
      <div className="result-main grid content-start gap-3">
        <div className="flex flex-wrap items-center gap-2" data-testid="result-actions">
          {nextPlayable && next ? (
            <button type="button" onClick={() => onPlayLevel!(next)} className={primary} data-testid="play-next">
              Play {personaFor(next).name} now
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              if (game) keepCall(game)
              onRematch()
            }}
            className={nextPlayable ? outline : primary}
            data-testid="rematch"
          >
            Rematch {opp}
          </button>
          {onChangeLevel ? (
            <button type="button" onClick={onChangeLevel} className={outline}>
              Change level
            </button>
          ) : null}
          {game ? <a href="/play" className={cn(textLink, 'gap-1.5 focus-visible:outline-2 focus-visible:outline-action')} data-testid="result-back"><span aria-hidden="true">←</span> All games</a> : null}
        </div>
        {says && level ? <SaysBox level={level} text={says.text} sub={firstClear && next ? (accepted ? `${personaFor(next).name} is unlocked.` : checking ? 'Checking your result...' : null) : null} voice={{ supported: voiceSupported, on: voiceOn, toggle: toggleVoice }} /> : null}
        {game && level && !practice ? <Ladder path={pathState.path} call={called} played={level} won={clearable && accepted} levels={levels} /> : null}
        {extra}
        {(game && leaderboard && !practice) || hasReport ? (
          <div className="flex flex-wrap items-center gap-x-2" aria-label="More">
            {game && leaderboard && !practice ? <a href={`/leaderboard/${PRODUCT.games[game].slug}`} className={textLink} data-testid="result-leaderboard-link">View leaderboard</a> : null}
            {hasReport ? <a href={`/report/${upload!.matchId}`} className={textLink} data-testid="result-report-link">View match report</a> : null}
          </div>
        ) : null}
        {facts && game && !practice ? <ShareBlock facts={facts} game={game} /> : null}
        <div className="grid gap-1.5">
          {uploadLine}
          {unratedReason ? <p className="text-xs text-muted" data-testid="result-unrated">{unratedReason}</p> : null}
          {!recordOk && upload?.status !== 'rejected' ? <p className={warn}>This match could not be verified, so it will not be counted.</p> : null}
          {note ? <div className="text-xs text-muted">{note}</div> : null}
        </div>
      </div>
    </section>
  )
}
