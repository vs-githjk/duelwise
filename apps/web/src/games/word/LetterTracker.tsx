import { Marker } from './ledger'
import { letterStates } from './letters'

/**
 * A compact record of what your guesses have settled: letters in the word (right spot first, then wrong
 * spot) and letters ruled out, alphabetical. It lists only letters you have tried, so it is a memory aid
 * and never a keyboard: nothing in it is a button.
 */
export function LetterTracker({ words, marks }: { words: string[]; marks: number[][] }) {
  const s = letterStates(words, marks)
  if (s.placed.length + s.elsewhere.length + s.out.length === 0) return null
  const group = (label: string, letters: string[], kind: number, state: string) =>
    letters.length === 0 ? null : (
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1" data-group={state}>
        <span className="text-xs font-semibold text-muted">{label}</span>
        {letters.map((c) => (
          <span key={c} data-letter={c} data-state={state} className="inline-flex items-center gap-0.5 rounded-control border border-line bg-surface px-1.5 font-mono text-sm font-semibold uppercase leading-6 text-ink">
            {c}
            <Marker kind={kind} />
          </span>
        ))}
      </div>
    )
  return (
    <section data-testid="letter-tracker" aria-label="Letters so far" className="grid gap-1.5 rounded-card border border-line bg-surface-2 px-3 py-2">
      {group('Right spot', s.placed, 2, 'placed')}
      {group('In the word', s.elsewhere, 1, 'elsewhere')}
      {group('Not in the word', s.out, 0, 'out')}
    </section>
  )
}
