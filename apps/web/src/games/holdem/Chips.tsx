import { cn } from '../../lib/cn'

// Chip colours by value; each is a plain disc with an edge pattern drawn in CSS.
const DENOMS: ReadonlyArray<{ value: number; cls: string }> = [
  { value: 25, cls: 'hd-chip-25' },
  { value: 5, cls: 'hd-chip-5' },
  { value: 1, cls: 'hd-chip-1' },
]
const MAX_PER_STACK = 8

/** Splits an amount into stacks of chips, largest value first. Pure, so it can be tested. */
export function chipStacks(amount: number): Array<{ value: number; cls: string; count: number }> {
  const out: Array<{ value: number; cls: string; count: number }> = []
  let rest = Math.max(0, Math.floor(amount))
  for (const d of DENOMS) {
    const count = Math.floor(rest / d.value)
    rest -= count * d.value
    if (count > 0) out.push({ ...d, count })
  }
  return out
}

export interface ChipStackProps {
  amount: number
  /** Text beside the chips, e.g. "Bet 6". Defaults to the amount. */
  label?: string
  testId?: string
  className?: string
  /** Makes the stack slide in when it mounts. */
  animate?: boolean
}

/** A stack of play chips with its amount in words and numbers. Renders nothing for zero. */
export function ChipStack({ amount, label, testId, className, animate = false }: ChipStackProps) {
  if (amount <= 0) return null
  const stacks = chipStacks(amount)
  return (
    <span
      className={cn('hd-chips', className)}
      data-testid={testId}
      data-amount={amount}
      style={animate ? { animation: 'hd-chip-in 280ms ease-out both' } : undefined}
    >
      <span className="hd-chip-cols" aria-hidden="true">
        {stacks.map((s) => (
          <span key={s.value} className="hd-chip-col">
            {Array.from({ length: Math.min(s.count, MAX_PER_STACK) }, (_, i) => (
              <i key={i} className={cn('hd-chip', s.cls)} style={{ bottom: i * 3 }} />
            ))}
          </span>
        ))}
      </span>
      <span className="hd-chip-label font-mono tabular text-sm font-semibold">{label ?? amount}</span>
    </span>
  )
}
