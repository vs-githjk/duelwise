import type { Split } from '../../server/traffic-sql'
import type { Traffic } from '../../server/traffic'
import { cn } from '../../lib/cn'

export const CLASS_LABEL: Record<Traffic, string> = { human: 'Human', owner: 'Owner', test: 'Test' }
export const CLASS_COLOR: Record<Traffic, string> = { human: 'var(--action)', owner: 'var(--level-3)', test: 'var(--level-1)' }
const TAG_TONE: Record<Traffic, string> = { human: 'bg-good-soft text-good-ink', owner: 'bg-neutral-soft text-neutral-ink', test: 'bg-warn-soft text-warn-ink' }

/** A small tag saying whose traffic a player or match is. */
export function TrafficTag({ t }: { t: Traffic }) {
  return (
    <span className={cn('inline-flex h-6 items-center whitespace-nowrap rounded-full px-2 text-xs font-semibold', TAG_TONE[t])} data-testid="traffic-tag" data-traffic={t} title={t === 'human' ? 'A real player' : t === 'owner' ? 'The site owner' : 'An automated test run'}>
      {CLASS_LABEL[t]}
    </span>
  )
}

/** "Owner 3 · Test 5 · Total 20": the other classes and the total beside a headline human number. */
export function Parts({ s, className }: { s: Split; className?: string }) {
  return (
    <p className={cn('text-xs text-muted', className)} data-testid="parts" data-human={s.human} data-owner={s.owner} data-test={s.test} data-total={s.total}>
      Owner <b className="font-semibold text-ink tabular">{s.owner}</b> · Test <b className="font-semibold text-ink tabular">{s.test}</b> · Total <b className="font-semibold text-ink tabular">{s.total}</b>
    </p>
  )
}

/** A stat with the human number big and first, then the owner, test and total parts. */
export function SplitTile({ label, s, hint, testId }: { label: string; s: Split; hint?: string; testId: string }) {
  return (
    <div className="grid content-start gap-1 rounded-control border border-line p-3" data-testid={testId} data-value={s.human} data-human={s.human} data-owner={s.owner} data-test={s.test} data-total={s.total}>
      <p className="text-sm text-muted">{label}{hint ? <span className="text-xs"> · {hint}</span> : null}</p>
      <p className="flex items-baseline gap-2"><span className="font-display text-display-lg leading-none tabular">{s.human}</span><span className="text-sm font-semibold text-muted">Human</span></p>
      <Parts s={s} />
    </div>
  )
}

/** One day bar split into the three classes, human at the bottom. */
export function StackBar({ d, max, h = 80 }: { d: { human: number; owner: number; test: number; total: number }; max: number; h?: number }) {
  const px = (n: number) => (n > 0 ? Math.max(3, Math.round((n / max) * h)) : 0)
  const parts = (['human', 'owner', 'test'] as const).filter((c) => d[c] > 0)
  if (parts.length === 0) return <div className="w-full rounded-t-sm" style={{ height: 2, background: 'var(--line)' }} />
  return (
    <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm">
      {parts.map((c) => (
        <div key={c} style={{ height: px(d[c]), background: CLASS_COLOR[c] }} />
      ))}
    </div>
  )
}

export function Legend({ className }: { className?: string }) {
  return (
    <p className={cn('flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted', className)} aria-hidden>
      {(['human', 'owner', 'test'] as const).map((c) => (
        <span key={c} className="inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm" style={{ background: CLASS_COLOR[c] }} />{CLASS_LABEL[c]}</span>
      ))}
    </p>
  )
}
