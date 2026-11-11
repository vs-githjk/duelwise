import { cn } from '../lib/cn'
import type { NearMiss } from '../report/near-miss'

/**
 * The near-miss strip: after a close loss, how near it got and where it turned, then two to four counts. Everything in it comes from the
 * replayed record (report/moments.ts), so it is drawn only when the game said the match was close. After a narrow win it is the quiet
 * version: the one sentence, no counts. Used on the result panel and on the report page.
 */
export function NearMissStrip({ nearMiss, outcome, className, testId = 'near-miss' }: { nearMiss: NearMiss; outcome: 'win' | 'loss' | 'draw'; className?: string; testId?: string }) {
  const win = outcome === 'win'
  const lead = nearMiss.line ?? nearMiss.turning
  const rest = nearMiss.line ? nearMiss.turning : null
  return (
    <section aria-label={win ? 'How it turned' : 'How close it was'} data-testid={testId} data-outcome={outcome} className={cn('grid gap-2 rounded-control bg-surface-2 px-3.5 py-3', className)}>
      {lead ? <p className={cn('text-ink', win ? 'text-sm font-semibold' : 'font-display text-base font-bold leading-snug')} data-testid={`${testId}-line`}>{lead}</p> : null}
      {rest ? <p className="text-sm text-ink" data-testid={`${testId}-turning`}>{rest}</p> : null}
      {!win && nearMiss.stats.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-2.5 sm:grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))]" data-testid={`${testId}-stats`}>
          {nearMiss.stats.map((s) => (
            <div key={s.label} className="grid min-w-0 gap-0.5">
              <dd className="font-display text-xl leading-none tabular">{s.value}</dd>
              <dt className="text-xs leading-snug text-muted">{s.label}</dt>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  )
}
