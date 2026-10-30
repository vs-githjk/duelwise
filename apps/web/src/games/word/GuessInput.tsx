import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { cn } from '../../lib/cn'
import { playCue } from './sounds'

export interface GuessInputProps {
  /** Returns a message when the word is refused, otherwise null. */
  onSubmit: (word: string) => Promise<string | null>
  disabled?: boolean
  /** Called with the text in the box as it changes, so the ledger can show the round being typed. */
  onDraft?: (draft: string) => void
  className?: string
}

/**
 * The one place a player types: a native text input (so the phone's own keyboard, autofill-free and
 * with correction off) and a Guess button. There is deliberately no on-screen keyboard.
 */
export function GuessInput({ onSubmit, disabled = false, onDraft, className }: GuessInputProps) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const rowRef = useRef<HTMLDivElement>(null)
  /** Bumped on every refused word so the row shakes again even for the same message. */
  const [shake, setShake] = useState(0)

  useEffect(() => {
    if (!disabled) ref.current?.focus()
  }, [disabled])

  // A refused word shakes the row once; reduced motion skips the movement (the message still shows).
  useEffect(() => {
    if (shake === 0 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    rowRef.current?.animate?.(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(7px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
      { duration: 340, easing: 'ease-out' },
    )
  }, [shake])

  // With a phone keyboard open the visible area shrinks: keep the row you type in on screen.
  useEffect(() => {
    const vv = window.visualViewport
    const keep = () => rowRef.current?.scrollIntoView?.({ block: 'nearest' })
    vv?.addEventListener('resize', keep)
    return () => vv?.removeEventListener('resize', keep)
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (disabled) return
    const refused = await onSubmit(value)
    setError(refused)
    if (refused) {
      setShake((n) => n + 1)
      playCue('reject')
      return
    }
    setValue('')
    onDraft?.('')
    ref.current?.focus()
  }

  return (
    <form onSubmit={submit} className={cn('grid grid-cols-[minmax(0,1fr)] gap-1.5', className)} noValidate>
      <div ref={rowRef} className="flex gap-2" data-testid="guess-row-input" data-refused={shake > 0 ? String(shake) : undefined}>
        <label className="sr-only" htmlFor={`${errorId}-in`}>
          Your guess, five letters
        </label>
        <input
          id={`${errorId}-in`}
          ref={ref}
          data-testid="word-input"
          type="text"
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={5}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          onFocus={() => rowRef.current?.scrollIntoView?.({ block: 'nearest' })}
          onChange={(e) => {
            const next = e.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 5)
            setValue(next)
            onDraft?.(next)
            if (error) setError(null)
          }}
          placeholder="Type a word"
          className="min-h-12 min-w-0 flex-1 rounded-control border border-line bg-surface px-3.5 font-mono text-lg uppercase tracking-[0.3em] text-ink placeholder:normal-case placeholder:tracking-normal placeholder:text-muted"
        />
        <button type="submit" disabled={disabled} className="min-h-12 rounded-control bg-action px-6 font-semibold text-action-ink disabled:opacity-60">
          Guess
        </button>
      </div>
      <p id={errorId} role="alert" data-testid="guess-error" className="min-h-5 text-sm text-bad-ink">
        {error}
      </p>
    </form>
  )
}
