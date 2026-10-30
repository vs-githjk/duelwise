import { useEffect, useId, useState } from 'react'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { cn } from '../lib/cn'
import { checkName, NAME_MAX } from '../lib/display-name'
import { LEVELS } from '../lib/level-info'
import { PROGRESS_EVENT, readName, useCall, writeName, type PathMap } from '../lib/progress'
import { personaFor } from '../personas'

/**
 * The one rule for saving a name, shared by Settings and the first-visit welcome: the same filter, remembered in this browser at once,
 * then the server. `saved` is true once the server has it; offline the name stays here and goes up with the next visit.
 */
export async function saveNameChecked(raw: string): Promise<{ ok: true; name: string; saved: boolean } | { ok: false; error: string }> {
  const checked = checkName(raw)
  if (!checked.ok) return checked
  writeName(checked.name)
  try {
    const { saveMyName } = await import('../server/identity-fns')
    const r = await saveMyName({ data: { name: checked.name } })
    if (!r.ok) return { ok: false, error: r.error }
    return { ok: true, name: checked.name, saved: true }
  } catch {
    return { ok: true, name: checked.name, saved: false }
  }
}

/** The one optional field: a name for the board. Remembered in this browser at once; the server keeps it when you leave the box. */
export function NameField() {
  const id = useId()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setValue(readName())
    const sync = () => setValue(readName())
    window.addEventListener(PROGRESS_EVENT, sync)
    // A signed-in player's name from another device fills the box when this browser has none.
    let alive = true
    const fetchName = (attempt: number) =>
      void import('../server/identity-fns')
        .then(({ getMyIdentity }) => getMyIdentity())
        .then((i) => {
          if (alive && i.name && !readName()) {
            writeName(i.name)
            setValue(i.name)
          }
        })
        // One more try a moment later: a request the dev server drops must not leave the box empty for good.
        .catch(() => {
          if (alive && attempt < 2) timers.push(setTimeout(() => fetchName(attempt + 1), 1500))
        })
    const timers: Array<ReturnType<typeof setTimeout>> = []
    if (!readName()) timers.push(setTimeout(() => fetchName(1), 350))
    return () => {
      alive = false
      window.removeEventListener(PROGRESS_EVENT, sync)
      for (const t of timers) clearTimeout(t)
    }
  }, [])
  const commit = async () => {
    setSaved(false)
    if (value.trim() === '') {
      setError(null)
      if (readName()) writeName(null)
      return
    }
    const r = await saveNameChecked(value)
    if (!r.ok) return setError(r.error)
    setError(null)
    setValue(r.name)
    setSaved(r.saved)
  }
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">Your name <span className="font-normal text-muted">(optional)</span></label>
      <input
        id={id}
        value={value}
        maxLength={NAME_MAX + 8}
        autoComplete="nickname"
        placeholder="Add a name for the board"
        onChange={(e) => {
          setValue(e.target.value)
          setSaved(false)
          if (error) setError(null)
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
        className="min-h-11 rounded-control border border-line bg-canvas px-3 text-base"
        data-testid="name-field"
      />
      <p id={`${id}-help`} className={cn('text-xs', error ? 'text-bad-ink' : 'text-muted')} role={error ? 'alert' : undefined} data-testid="name-help">
        {error ?? (saved ? 'Saved for the board.' : 'Remembered in this browser. Keep it on other devices from Settings, never required.')}
      </p>
    </div>
  )
}

/** "How far do you think you get?" Four choices, one per opponent. The pick is a prediction; the result sheet compares it with what happened. */
export function CallPicker({ game, path }: { game: GameId; path: PathMap }) {
  const label = useId()
  const [call, setCall] = useCall(game, path)
  return (
    <div className="grid gap-1.5" role="radiogroup" aria-labelledby={label} data-testid="call-picker">
      <span id={label} className="text-sm font-semibold">How far do you think you get?</span>
      <div className="grid grid-cols-2 gap-1 rounded-control bg-surface-2 p-1 sm:grid-cols-4">
        {LEVELS.map((level: Level) => {
          const on = call === level
          return (
            <label key={level} className={cn('inline-flex min-h-11 cursor-pointer items-center justify-center rounded-control px-2 text-sm font-semibold focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-action', on ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink')}>
              <input type="radio" name={`call-${game}`} value={level} checked={on} onChange={() => setCall(level)} className="sr-only" />
              {personaFor(level).name}
            </label>
          )
        })}
      </div>
      <p className="text-xs text-muted">Called before you play. Your {PRODUCT.games[game].displayName} result is compared with it afterwards.</p>
    </div>
  )
}
