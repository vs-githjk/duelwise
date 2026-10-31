import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { cn } from '../lib/cn'
import { LEVELS, LEVEL_LABEL } from '../lib/level-info'
import type { PathState } from '../lib/progress'
import { Avatar } from '../personas/Avatar'
import { personaFor } from '../personas'

/**
 * The adventure path for one game: four stops, Pip to Sable. Clear a stop (win at that level once) to unlock the next.
 * State is never colour only: a cleared stop carries a check, the current one says "You are here", a locked one says "Locked".
 * `practice` levels still clear (they are only unranked on the board).
 */
export function PathCard({ game, state, practice, className }: { game: GameId; state: PathState; practice: ReadonlySet<Level>; className?: string }) {
  const { path, current, open } = state
  return (
    <section className={cn('grid gap-3 rounded-card border border-line bg-surface p-4 shadow-card md:p-5', className)} aria-label={`Your path at ${PRODUCT.games[game].displayName}`} data-testid="path-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-display text-display-sm">Your path</h2>
        <p className="text-sm text-muted">Clear Pip to unlock Marlow, then Vesper, then Sable.</p>
      </div>
      <ol className="relative grid grid-cols-4 gap-2" data-testid="path-stops">
        <span className="pointer-events-none absolute left-[12.5%] right-[12.5%] top-[38px] z-0 h-0.5 bg-line max-sm:top-[30px]" aria-hidden="true" />
        {LEVELS.map((level) => {
          const cleared = path[level]
          const isCurrent = current === level
          const locked = !open && !cleared && !isCurrent
          const name = personaFor(level).name
          const prev = personaFor(LEVELS[LEVELS.indexOf(level) - 1] ?? 'easy').name
          return (
            <li key={level} className="relative z-10 grid justify-items-center gap-1 text-center" data-testid={`path-stop-${level}`} data-state={cleared ? 'cleared' : isCurrent ? 'current' : 'locked'}>
              <span className="relative inline-grid p-1.5" data-testid={`path-ring-${level}`}>
                <span
                  className={cn(
                    'grid rounded-full bg-surface',
                    cleared ? 'shadow-[0_0_0_3px_var(--surface),0_0_0_6px_var(--good)]' : isCurrent ? 'shadow-[0_0_0_3px_var(--surface),0_0_0_6px_var(--action)]' : 'shadow-[0_0_0_2px_var(--line)]',
                  )}
                >
                  <Avatar level={level} size={64} decorative className={cn('max-sm:!size-12 overflow-hidden rounded-full', locked && 'path-locked')} />
                </span>
                {cleared ? (
                  <span className="absolute -bottom-1 -right-1 grid size-6 place-items-center rounded-full bg-good text-xs font-bold text-white" aria-hidden="true">
                    &#10003;
                  </span>
                ) : null}
              </span>
              <b className={cn('text-sm', isCurrent ? 'text-ink' : 'font-semibold', locked && 'text-muted')}>{name}</b>
              <span className={cn('text-xs', isCurrent ? 'font-semibold text-action' : 'text-muted')}>
                {cleared ? 'Cleared' : isCurrent ? 'You are here' : locked ? `Locked, beat ${prev}` : LEVEL_LABEL[level]}
                {practice.has(level) && !locked ? ', In training' : ''}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
