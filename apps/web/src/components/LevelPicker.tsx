import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { Level } from '@duelwise/core/src/product'
import { cn } from '../lib/cn'
import { LEVELS, LEVEL_LABEL, type LevelInfo } from '../lib/level-info'
import { Avatar } from '../personas/Avatar'
import { useOpponent } from '../personas/context'
import { personaFor, styleLine } from '../personas'
import { showsPreviewBadge } from '../lib/honest-copy'
import { EloExplainer } from './SiteElo'
import { usePath } from '../lib/progress'
import { usePractice } from '../lib/practice'
import { CallPicker } from './IdentityCard'
import { PathCard } from './PathCard'
import { LearnGraph } from './LearnGraph'
import { PreviewBadge } from './PreviewBadge'
import { ResignedNotice } from './ResignedNotice'

const BLURB: Record<Level, string> = {
  easy: 'Relaxed play with human-like slips.',
  medium: 'A steady opponent that punishes obvious mistakes.',
  hard: 'Sharp and consistent.',
  champion: 'The strongest version, with no handicap.',
}

export interface LevelPickerProps {
  value: Level
  onChange: (level: Level) => void
  /** Per-level registry facts; omit to show every level as a preview. */
  levels?: Partial<Record<Level, LevelInfo>>
  disabled?: boolean
  /** URL slug of the game, so a level that is in training can link to its stats page. */
  statsSlug?: string
  className?: string
  descriptions?: Partial<Record<Level, string>>
  /** The page's own Start button (and its failure message). It sits under the name and the call, in the side column on a wide screen. */
  action?: ReactNode
  /** The page sets its own setup block beside the picker, so the picker has less width: one column of level cards and no side column at any width, with the Start button stuck to the bottom of the screen. */
  beside?: boolean
  /** The page says why the last match ended itself, where a player will see it, so the picker's own notice stays away. */
  ownResignNotice?: boolean
}

/**
 * Native radio group so keyboard and screen readers work without extra code. A level that failed its
 * gate is shown "in training" with the reason and cannot be picked. Strength strings come from the
 * registry through `levels`; this component never makes one up.
 */
export function LevelPicker({ value, onChange, levels = {}, disabled = false, statsSlug, className, descriptions, action, beside = false, ownResignNotice = false }: LevelPickerProps) {
  const name = useId()
  const { game } = useOpponent()
  const state = usePath(game)
  const { path, current, open } = state
  // A stop is locked until the one before it is cleared; `?any=1` opens them all. Outside a game page (no game in context) nothing is gated.
  // Practice opens every opponent: it never clears the path, so there is nothing to farm. Rated keeps the lock.
  const practiceMode = usePractice()
  const gated = game !== undefined && state.hydrated && !open && !practiceMode
  const pathLocked = (level: Level) => gated && !path[level] && current !== level
  const touched = useRef(false)
  useEffect(() => {
    if (!gated || !current) return
    // The player has not picked yet, or picked a stop that is locked: start on the current stop.
    if ((!touched.current && value !== current) || pathLocked(value)) onChange(current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gated, current, value])
  const practice = new Set(LEVELS.filter((l) => levels[l]?.practice || (levels[l]?.preview && !levels[l]?.inTraining)))
  return (
    <div className={cn('grid gap-4', game && (beside ? 'max-lg:contents' : 'max-lg:contents lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start'))} data-testid="setup-picker">
    <div className="grid min-w-0 gap-4">
    {game && !ownResignNotice ? <ResignedNotice game={game} /> : null}
    {game ? <PathCard game={game} state={state} practice={practice} practiceMode={practiceMode} /> : null}
    {/* With a game the page has a 340 px side column, so the cards get about 740 px at 1440: two columns left the text a 120 px sliver, one column gives it the whole row. */}
    <fieldset className={cn('grid gap-2', !beside && !game && 'lg:grid-cols-2', className)} disabled={disabled} data-testid="level-picker">
      <legend className="sr-only">Opponent level</legend>
      {LEVELS.map((level) => {
        const info = levels[level] ?? { preview: true }
        const practice = info.practice || (info.preview && !info.inTraining)
        // In Practice a level in training is playable when a model for it ships; with nothing to load it stays shut.
        const openInPractice = practiceMode && info.loadable === true
        const locked = Boolean(info.inTraining) && !practice && !openInPractice
        const byPath = pathLocked(level)
        const on = level === value
        return (
          <label
            key={level}
            data-persona={level}
            data-selected={on}
            className={cn(
              'persona-row grid min-h-16 cursor-pointer grid-cols-[auto_auto_1fr_auto] items-center gap-3 rounded-control border border-line bg-surface px-3.5 py-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-action',
              on && 'border-action shadow-[inset_0_0_0_1px_var(--action)]',
              locked ? 'cursor-not-allowed' : disabled && 'cursor-not-allowed opacity-60',
              byPath && 'cursor-not-allowed opacity-55',
            )}
            data-path-locked={byPath ? 'true' : undefined}
          >
            <input type="radio" name={name} value={level} checked={on} disabled={locked || byPath || disabled} onChange={() => { touched.current = true; onChange(level) }} className="sr-only" />
            <span className={cn('level-radio inline-flex size-5 items-center justify-center rounded-full border-2 border-line', on && 'border-action bg-action')} aria-hidden="true">
              {on && <span className="size-[7px] rounded-full bg-action-ink" />}
            </span>
            <Avatar level={level} size={40} decorative dim={locked} />
            {/* On a phone the description drops under the row and uses the full card width, instead of a narrow column beside the avatar. */}
            <span className="grid gap-px max-sm:contents">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <b className={cn('text-base font-semibold text-ink', locked && 'opacity-60')} data-testid={`persona-name-${level}`}>{personaFor(level).name}</b>
                <span className="text-sm text-muted">{LEVEL_LABEL[level]}</span>
              </span>
              <span className="text-sm text-muted max-sm:order-1 max-sm:col-span-4" data-testid={locked ? `in-training-${level}` : byPath ? `path-locked-${level}` : undefined}>
                {byPath ? (
                  `Locked. Beat ${personaFor(LEVELS[LEVELS.indexOf(level) - 1] ?? 'easy').name} to unlock ${personaFor(level).name}.`
                ) : locked ? (
                  <>
                    <span className="opacity-80">{practiceMode ? 'Still training.' : 'Not available yet.'} {info.inTraining}</span>
                    {statsSlug ? (
                      <>
                        {' '}
                        <Link to="/agents/$game" params={{ game: statsSlug }} className="text-action underline">
                          details
                        </Link>
                      </>
                    ) : null}
                  </>
                ) : (
                  (openInPractice && info.inTraining ? `Still training, so only playable as practice. ${info.inTraining}` : undefined) ?? descriptions?.[level] ?? (practice ? "Early version, not yet strength tested." : game ? styleLine(level, game) : BLURB[level])
                )}
              </span>
            </span>
            <span className="grid justify-items-end gap-1 text-right font-mono text-xs text-muted tabular">
              {practice ? <PreviewBadge label="In training" /> : showsPreviewBadge(info) ? <PreviewBadge /> : null}
              {info.strength}
            </span>
          </label>
        )
      })}
      {LEVELS.some((level) => levels[level]?.strength?.startsWith('site Elo ')) ? <div className={beside || game ? undefined : 'lg:col-span-2'}><EloExplainer /></div> : null}
    </fieldset>
    </div>
    {game ? (
      // Below lg this wrapper and the picker's own root disappear (display: contents), so the Start button is a child of the whole setup column and can stay stuck to the bottom of the screen from the first paint; on a wide screen it is the side column, or with `beside` it sits first in the one column, above the levels, so it covers none of them.
      <div className={beside ? 'contents' : 'contents lg:sticky lg:top-4 lg:grid lg:gap-4'}>
        <section className="grid gap-4 rounded-card border border-line bg-surface p-4 shadow-card md:p-5" aria-label="Before you play" data-testid="identity-card">
          <CallPicker game={game} path={path} />
        </section>
        {action ? <div className={beside ? 'contents lg:order-first lg:grid lg:gap-2' : 'contents lg:grid lg:gap-2'} data-testid="setup-action">{action}</div> : null}
      </div>
    ) : (
      action ?? null
    )}
    {game ? <div className={beside ? undefined : 'lg:col-span-2'}><LearnGraph game={game} compact defaultLevel={current} /></div> : null}
    </div>
  )
}
