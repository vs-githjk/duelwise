import { cn } from '../lib/cn'

/** Three pulsing dots while the agent picks a move. Announces itself politely; motion stops under reduced-motion. */
export function ThinkingIndicator({ active, label = 'Thinking', className }: { active: boolean; label?: string; className?: string }) {
  return (
    <span role="status" aria-live="polite" className={cn('inline-flex h-6 items-center gap-1.5 text-sm text-muted', className)} data-testid="thinking">
      {active && (
        <>
          <span>{label}</span>
          <span className="inline-flex gap-1" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <i key={i} className="thinking-dot size-1.5 rounded-full bg-muted" style={{ animationDelay: `${i * 160}ms` }} />
            ))}
          </span>
        </>
      )}
    </span>
  )
}
