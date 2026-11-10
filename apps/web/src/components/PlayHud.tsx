import { useEffect, useState } from 'react'
import { LEVEL_LABEL } from '../lib/level-info'
import { Avatar } from '../personas/Avatar'
import { useOpponent } from '../personas/context'
import { personaFor } from '../personas'
import { cn } from '../lib/cn'

/** m:ss for a count of whole seconds. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Whole seconds since mount (or since `resetKey` changed); frozen once `running` is false. */
export function useElapsed(running: boolean, resetKey?: unknown): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    setSeconds(0)
  }, [resetKey])
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [running, resetKey])
  return seconds
}

export interface PlayHudProps {
  turn: 'you' | 'ai' | 'over'
  /** Label for the human seat, e.g. "You, White". */
  youLabel?: string
  /** Changes when a new match starts, so the clock restarts. */
  matchKey?: unknown
  /** Background class for the human seat dot; pass the colour the game's own legend uses for the player. The ring (3:1 against the page in both themes) comes from the HUD. */
  swatch?: string
  /** A friend game: the second player's name, in place of the AI opponent's persona. */
  opponentLabel?: string
  /** A friend game: background class for the second player's dot, like `swatch`. */
  opponentSwatch?: string
  className?: string
}

/**
 * The strip above every board: you and your opponent (persona and level), whose turn it is, and the
 * match clock. The clock is elapsed time only; no game here is timed by it.
 */
export function PlayHud({ turn, youLabel = 'You', matchKey, swatch = 'bg-action', opponentLabel, opponentSwatch, className }: PlayHudProps) {
  const { level } = useOpponent()
  const elapsed = useElapsed(turn !== 'over', matchKey)
  const persona = level ? personaFor(level) : null
  return (
    <div className={cn('play-hud', className)} data-testid="play-hud" data-turn={turn}>
      <span className="play-hud-seat text-sm font-semibold" data-testid="play-hud-you" data-active={turn === 'you' ? '' : undefined}>
        <span data-swatch="you" className={cn('grid size-[22px] place-items-center rounded-full border-2 border-muted text-xs', swatch)} aria-hidden="true" />
        <span>{youLabel}</span>
      </span>
      <span className="play-hud-seat text-sm font-semibold" data-testid="play-hud-ai" data-active={turn === 'ai' ? '' : undefined}>
        {opponentSwatch ? <span data-swatch="them" className={cn('grid size-[22px] shrink-0 place-items-center rounded-full border-2 border-muted text-xs', opponentSwatch)} aria-hidden="true" /> : level ? <Avatar level={level} size={22} decorative /> : null}
        <span className="truncate">{opponentLabel ?? (persona && level ? `${persona.name}, ${LEVEL_LABEL[level]}` : 'Opponent')}</span>
      </span>
      <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-sm text-muted" data-testid="play-hud-clock" data-volatile>
        <span aria-hidden="true" className="size-2 rounded-full bg-current opacity-60" />
        <span className="sr-only">Match time </span>
        <span className="play-hud-clock">{formatClock(elapsed)}</span>
      </span>
    </div>
  )
}
