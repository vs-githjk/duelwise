import { siteEloExplainer } from '../lib/honest-copy'
import { cn } from '../lib/cn'

/** A closed-by-default explanation of "site Elo", placed next to every spot that shows the number. */
export function EloExplainer({ className }: { className?: string }) {
  return (
    <details className={cn('text-sm text-muted', className)} data-testid="elo-explainer">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-action underline">What is site Elo?</summary>
      <p className="max-w-prose pb-1">{siteEloExplainer()}</p>
    </details>
  )
}

/** The strength line on an opponent side card: the number from the registry, with the explanation beside it. */
export function StrengthLine({ siteElo }: { siteElo: number | undefined }) {
  if (siteElo === undefined) return <p className="text-sm text-muted">No measured strength yet.</p>
  return (
    <>
      <p className="text-sm text-muted">
        Measured at <span className="font-mono tabular text-ink">site Elo {Math.round(siteElo)}</span>.
      </p>
      <EloExplainer />
    </>
  )
}
