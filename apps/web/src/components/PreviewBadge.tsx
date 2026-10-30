import { cn } from '../lib/cn'

/** Shown while a game or level has no measured strength in its registry. */
export function PreviewBadge({ className, label = 'Preview' }: { className?: string; label?: string }) {
  return (
    <span
      className={cn('inline-flex h-6 items-center rounded-full bg-warn-soft px-2.5 text-xs font-semibold text-warn-ink', className)}
      title="This opponent has no measured strength yet"
      data-testid="preview-badge"
    >
      {label}
    </span>
  )
}
