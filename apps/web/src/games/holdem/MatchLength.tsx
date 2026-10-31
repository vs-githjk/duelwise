import { cn } from '../../lib/cn'
import { LENGTH_CHOICES, type LengthChoice } from './length'

/** The "how long" pick before a match: a native radio group in the same row style as the opponent picker. */
export function MatchLength({ value, onChange, disabled = false }: { value: LengthChoice; onChange: (c: LengthChoice) => void; disabled?: boolean }) {
  return (
    <fieldset className="grid gap-2" disabled={disabled} data-testid="match-length">
      <legend className="mb-1 text-sm font-semibold text-ink">How long?</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {LENGTH_CHOICES.map((c) => {
          const on = c.id === value
          return (
            <label
              key={c.id}
              data-length={c.id}
              data-selected={on}
              className={cn(
                'grid min-h-14 cursor-pointer content-center gap-px rounded-control border border-line bg-surface px-3 py-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-action',
                on && 'border-action shadow-[inset_0_0_0_1px_var(--action)]',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input type="radio" name="holdem-length" value={c.id} checked={on} disabled={disabled} onChange={() => onChange(c.id)} className="sr-only" />
              <b className="text-base font-semibold text-ink">{c.label}</b>
              <span className="text-xs text-muted">{c.hint}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
