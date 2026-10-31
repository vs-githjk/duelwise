import { cn } from '../lib/cn'
import { setPractice, usePractice } from '../lib/practice'

export interface PlayModeToggleProps {
  practice: boolean
  onChange: (practice: boolean) => void
  disabled?: boolean
  /** One more calm line under the Practice option, for what is specific to the game. */
  practiceHint?: string
  className?: string
}

const OPTIONS = [
  { id: 'rated', label: 'Rated', hint: 'Counts toward your rating, your path and the leaderboard.' },
  { id: 'practice', label: 'Practice', hint: 'The same game, unrated. Nothing on your record changes.' },
] as const

/**
 * The Rated or Practice pick on a game's setup screen. A native radio group in the same row style as the match length and the opponent
 * picker, so keyboard and screen readers work, with rows at least 56 px tall. Rated is the default.
 */
export function PlayModeToggle({ practice, onChange, disabled = false, practiceHint, className }: PlayModeToggleProps) {
  return (
    <fieldset className={cn('grid gap-2', className)} disabled={disabled} data-testid="play-mode" data-mode={practice ? 'practice' : 'rated'}>
      <legend className="mb-1 text-sm font-semibold text-ink">How do you want to play?</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {OPTIONS.map((o) => {
          const on = (o.id === 'practice') === practice
          return (
            <label
              key={o.id}
              data-mode-option={o.id}
              data-selected={on}
              className={cn(
                'grid min-h-14 cursor-pointer content-center gap-px rounded-control border border-line bg-surface px-3 py-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-action',
                on && 'border-action shadow-[inset_0_0_0_1px_var(--action)]',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input type="radio" name="play-mode" value={o.id} checked={on} disabled={disabled} onChange={() => onChange(o.id === 'practice')} className="sr-only" />
              <b className="text-base font-semibold text-ink">{o.label}</b>
              <span className="text-xs text-muted">{o.id === 'practice' && practiceHint ? `${o.hint} ${practiceHint}` : o.hint}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** The toggle wired to the site-wide flag the match recorder reads when a match starts. */
export function PlayMode({ disabled, practiceHint }: { disabled?: boolean; practiceHint?: string }) {
  const practice = usePractice()
  return <PlayModeToggle practice={practice} onChange={setPractice} disabled={disabled} practiceHint={practiceHint} />
}
