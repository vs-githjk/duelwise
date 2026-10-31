import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { cn } from '../lib/cn'
import { LEVEL_LABEL } from '../lib/level-info'
import { Avatar } from '../personas/Avatar'
import { OpponentContext } from '../personas/context'
import { personaFor } from '../personas'
import { DesktopOnlyNotice } from './DesktopOnlyNotice'
import { PreviewBadge } from './PreviewBadge'
import { ThinkingIndicator } from './ThinkingIndicator'
import { TrainingNotice } from './TrainingNotice'
import { HowToPlay } from './HowToPlay'
import { hasSeenGuide, markGuideSeen } from './how-to-play-data'

const DESKTOP_QUERY = '(min-width: 900px) and (pointer: fine)'

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(DESKTOP_QUERY)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  )
}

export interface GameShellProps {
  game: GameId
  /** Opponent level, shown in the header when a match is on. */
  level?: Level
  /** True while the agent has no measured strength. */
  preview?: boolean
  /** The badge words when `preview` is on. Realtime games call an unpublished level Practice. */
  previewLabel?: string
  /** True while the agent is choosing a move. */
  thinking?: boolean
  /** Right of the board on desktop, below it on a phone: move list, level picker, controls. */
  aside?: ReactNode
  /** Match result, below the board on phones and in the aside on desktop. */
  result?: ReactNode
  /** Extra header content, such as a mute toggle. */
  actions?: ReactNode
  onOpenGuide?: () => void
  children: ReactNode
  className?: string
}

/**
 * The frame every play page uses: header with the game name, opponent level, preview badge and
 * thinking indicator; the board area; an aside that stacks under the board on a phone. Desktop-only
 * games show the notice on small or touch screens instead of mounting.
 */
export function GameShell({ game, level, preview, previewLabel, thinking = false, aside, result, actions, onOpenGuide, children, className }: GameShellProps) {
  const [guideOpen, setGuideOpen] = useState(false)
  useEffect(() => { if (!hasSeenGuide(game)) { markGuideSeen(game); setGuideOpen(true) } }, [game])
  const closeGuide = useCallback(() => setGuideOpen(false), [])
  const openGuide = () => { onOpenGuide?.(); setGuideOpen(true) }
  const cfg = PRODUCT.games[game]
  const isDesktop = useIsDesktop()
  const blocked = cfg.devices === 'desktop' && !isDesktop && game !== 'fighter' && game !== 'arena'
  return (
    <OpponentContext.Provider value={{ game, level }}>
    <div className={cn('mx-auto grid w-full max-w-[1100px] grid-cols-[minmax(0,1fr)] gap-4 py-4 [@media(max-height:700px)]:gap-2 [@media(max-height:700px)]:py-2', className)} data-testid="game-shell" data-game={game}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link to="/play" data-testid="game-back" className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-sm font-semibold text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          All games
        </Link>
        <h1 className="font-display text-display-md [@media(max-height:700px)]:text-2xl">{cfg.displayName}</h1>
        {level ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 py-0.5 pl-0.5 pr-2.5 text-xs font-semibold text-ink" data-testid="header-persona">
            <Avatar level={level} size={22} decorative />
            {`${personaFor(level).name} (${LEVEL_LABEL[level]})`}
          </span>
        ) : null}
        {preview ? <PreviewBadge label={previewLabel} /> : null}
        <ThinkingIndicator active={thinking} label={level ? `${personaFor(level).name} is thinking` : 'Thinking'} className="ml-1" />
        <div className="ml-auto flex items-center gap-2">
          {cfg.kind !== 'realtime' ? <Link to="/leaderboard/$game" params={{ game: cfg.slug }} className="inline-flex min-h-11 items-center px-2 text-sm text-muted hover:text-ink" data-testid="game-leaderboard-link">
            Leaderboard
          </Link> : null}
          <button type="button" onClick={openGuide} aria-label={level ? "How to play" : undefined} className="min-h-11 min-w-11 rounded-control border border-line bg-surface px-3 text-sm font-semibold">{level ? "?" : "How to play"}</button>
          {actions}
        </div>
      </header>
      {blocked ? null : <TrainingNotice game={game} compact={level !== undefined} />}
      {blocked ? (
        <DesktopOnlyNotice game={game} />
      ) : (
        <div className={cn('game-shell-content grid gap-4', Boolean(aside || result) && 'game-shell-content-with-aside')} data-has-result={result ? 'true' : undefined}>
          <div className="game-shell-main min-w-0">{children}</div>
          {result ? <div className="game-shell-result min-w-0">{result}</div> : null}
          {aside ? <aside className="game-shell-aside grid content-start gap-3">{aside}</aside> : null}
        </div>
      )}
    </div>
    {guideOpen ? <HowToPlay game={game} onClose={closeGuide} /> : null}
    </OpponentContext.Provider>
  )
}
