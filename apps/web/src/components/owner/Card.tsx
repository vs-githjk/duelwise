import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function Card({ title, note, children, testId, className, id }: { title: string; note?: string; children: ReactNode; testId?: string; className?: string; id?: string }) {
  return (
    <section id={id} className={cn('scroll-mt-20 grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 rounded-card border border-line bg-surface p-4 shadow-card md:p-5', className)} data-testid={testId}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-display text-display-sm">{title}</h2>
        {note ? <p className="text-sm text-muted">{note}</p> : null}
      </header>
      {children}
    </section>
  )
}

/** A small trend line for a KPI tile. Gaps (null) break the line. */
export function Sparkline({ values }: { values: Array<number | null> }) {
  const pts = values.flatMap((v, i) => (v === null ? [] : [{ i, v }]))
  if (pts.length < 2) return <div aria-hidden className="h-8" />
  const max = Math.max(...pts.map((p) => p.v)) || 1
  const W = 120
  const H = 32
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * W
  const y = (v: number) => H - 3 - (v / max) * (H - 8)
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join('')
  const last = pts[pts.length - 1]!
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} className="h-8 w-full" preserveAspectRatio="none">
      <path d={d} fill="none" stroke="var(--action)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <circle cx={x(last.i)} cy={y(last.v)} r={2.5} fill="var(--ink)" />
    </svg>
  )
}
