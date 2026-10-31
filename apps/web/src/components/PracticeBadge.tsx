import { cn } from '../lib/cn'
import { PRACTICE_BADGE } from '../lib/practice'

/** Shown for the length of a Practice match (header) so nobody mistakes it for a rated one. Not the "Practice" label of an untested opponent level. */
export function PracticeBadge({ className, label = PRACTICE_BADGE }: { className?: string; label?: string }) {
  return (
    <span
      className={cn('inline-flex h-6 items-center rounded-full bg-action-soft px-2.5 text-xs font-semibold text-ink', className)}
      title="This match does not change your rating, your path or the leaderboard"
      data-testid="practice-badge"
    >
      {label}
    </span>
  )
}
