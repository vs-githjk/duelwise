import { useEffect, useState } from 'react'
import { STACK } from '@duelwise/core/src/games/holdem/match'
import type { HoldemAction, HoldemObservation } from '@duelwise/core/src/games/holdem/core'
import { cn } from '../../lib/cn'
import { HUMAN } from './seats'

export interface Preset {
  id: 'min' | 'half' | 'pot' | 'allin'
  label: string
  to: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * The quick bet sizes for the current spot, each a raise-to amount inside the legal range. A fraction of the
 * pot is measured after calling, the usual way to size a bet. Sizes that land on the same amount are shown once,
 * and the largest is always "All in".
 */
export function presetsFor(obs: HoldemObservation): Preset[] {
  const me = HUMAN
  const lo = obs.minRaiseTo
  const hi = obs.maxRaiseTo
  if (hi <= 0) return []
  const toCall = Math.max(obs.bet[0], obs.bet[1]) - obs.bet[me]
  const potAfterCall = obs.total[0] + obs.total[1] + toCall
  const base = obs.bet[me] + toCall
  const raw: Preset[] = [
    { id: 'min', label: 'Min', to: lo },
    { id: 'half', label: '1/2 pot', to: clamp(base + Math.round(potAfterCall / 2), lo, hi) },
    { id: 'pot', label: 'Pot', to: clamp(base + potAfterCall, lo, hi) },
    { id: 'allin', label: 'All in', to: hi },
  ]
  const out: Preset[] = []
  for (const p of raw) {
    const same = out.findIndex((q) => q.to === p.to)
    if (same === -1) out.push(p)
    else if (p.id === 'allin') out[same] = p
  }
  return out
}

export interface BetControlsProps {
  obs: HoldemObservation
  disabled: boolean
  onAction: (a: HoldemAction) => void
}

/**
 * Fold, check or call, and a raise with preset sizes plus a one-chip slider. Every control is at least 44
 * px tall. Nothing here decides whether an action is legal beyond the range the core reports: the core
 * rejects anything else.
 */
export function BetControls({ obs, disabled, onAction }: BetControlsProps) {
  const me = HUMAN
  const toCall = Math.max(obs.bet[0], obs.bet[1]) - obs.bet[me]
  const callAmount = Math.min(toCall, STACK - obs.total[me])
  const canRaise = obs.maxRaiseTo > 0
  const lo = obs.minRaiseTo
  const hi = obs.maxRaiseTo
  const [amount, setAmount] = useState(lo)
  // A new spot (new street, new bet, new hand) starts at the smallest legal raise.
  useEffect(() => setAmount(lo), [lo, hi, obs.hand, obs.street, obs.bet[0], obs.bet[1]])
  const value = clamp(amount, lo, hi)
  const presets = presetsFor(obs)
  const word = Math.max(obs.bet[0], obs.bet[1]) === 0 ? 'Bet' : 'Raise'
  const allIn = canRaise && value === hi
  const btn = 'min-h-12 rounded-control px-2 text-sm font-semibold disabled:opacity-50'

  return (
    <div className="grid gap-2" data-testid="bet-controls" role="group" aria-label="Your action">
      <div className={cn('grid gap-2', canRaise ? 'grid-cols-3' : 'grid-cols-2')}>
        <button
          type="button"
          data-testid="bet-fold"
          disabled={disabled || toCall === 0}
          onClick={() => onAction({ type: 'fold' })}
          className={cn(btn, 'border border-line bg-surface')}
        >
          Fold
        </button>
        <button
          type="button"
          data-testid="bet-call"
          disabled={disabled}
          onClick={() => onAction({ type: 'call' })}
          className={cn(btn, canRaise ? 'border border-line bg-surface' : 'bg-action text-action-ink')}
        >
          {toCall === 0 ? 'Check' : `Call ${callAmount}`}
        </button>
        {canRaise ? (
          <button
            type="button"
            data-testid="bet-raise"
            data-to={value}
            disabled={disabled}
            onClick={() => onAction({ type: 'raise', to: value })}
            className={cn(btn, 'bg-action text-action-ink')}
          >
            {allIn ? `All in, ${value}` : `${word} to ${value}`}
          </button>
        ) : null}
      </div>
      {canRaise ? (
        <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-3">
          <div className="flex gap-2" role="group" aria-label="Bet sizes">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                data-testid={`preset-${p.id}`}
                data-to={p.to}
                disabled={disabled}
                aria-pressed={value === p.to}
                onClick={() => setAmount(p.to)}
                className={cn('min-h-11 flex-1 rounded-control border border-line bg-surface px-2 text-sm font-semibold disabled:opacity-50 sm:flex-none sm:px-4', value === p.to && 'border-action bg-surface-2')}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-3">
            <input
              type="range"
              data-testid="bet-slider"
              min={lo}
              max={hi}
              step={1}
              value={value}
              disabled={disabled || lo === hi}
              onChange={(e) => setAmount(Number(e.target.value))}
              aria-label={`${word} to, one chip at a time`}
              className="h-11 min-w-0 flex-1 accent-[var(--action)]"
            />
            <output className="w-10 text-right font-mono tabular text-base font-semibold text-ink" data-testid="bet-amount">
              {value}
            </output>
          </label>
        </div>
      ) : null}
    </div>
  )
}
