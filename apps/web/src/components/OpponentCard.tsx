import type { GameId, Level } from '@duelwise/core/src/product'
import { cn } from '../lib/cn'
import { LEVEL_LABEL } from '../lib/level-info'
import { Avatar } from '../personas/Avatar'
import { bioFor, personaFor, styleLine } from '../personas'

export interface OpponentCardProps {
  level: Level
  game?: GameId
  /** Measured strength string from the registry, when the level is published. */
  strength?: string
  dim?: boolean
  className?: string
}

/** Who you are about to play: portrait, name, one-line bio and, when the game is known, how this persona plays it. */
export function OpponentCard({ level, game, strength, dim, className }: OpponentCardProps) {
  const p = personaFor(level)
  return (
    <section className={cn('persona-card grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-card border border-line bg-surface-2 p-3.5', className)} aria-label="Your opponent" data-testid="opponent-card" data-level={level}>
      <Avatar level={level} size={56} decorative dim={dim} />
      <div className="grid gap-1">
        <p className="text-base font-semibold text-ink" data-testid="opponent-name">
          {`${p.name} (${LEVEL_LABEL[level]})`}
        </p>
        <p className="text-sm text-muted">{bioFor(level, game)}</p>
        {game ? <p className="text-sm text-ink" data-testid="opponent-style">{styleLine(level, game)}</p> : null}
        {strength ? <p className="font-mono text-xs text-muted tabular">{strength}</p> : null}
      </div>
    </section>
  )
}
