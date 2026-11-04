import { useEffect, useMemo, useState } from 'react'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { cn } from '../lib/cn'
import { axisMax, learnCopy, learnHeading, pointsFor, THIN_UNDER, type Point } from '../lib/learn-copy'
import { LEVELS } from '../lib/level-info'
import { personaFor } from '../personas'
import { shortDate } from './charts/format'
import type { LearnView } from '../server/learn-fns'

const W = 640
const H = 280
const M = { l: 44, r: 20, t: 20, b: 36 }

interface Marker {
  version: string
  x: number
}

/** Human win rate against one level, by week. Solid points have 30 or more matches; thin weeks are hollow and dashed. Promotions are vertical dashed lines. */
export function LearnChart({ points, markers, label, caption }: { points: Point[]; markers: Array<{ version: string; at: number }>; label: string; caption: string }) {
  const top = axisMax(points)
  const n = points.length
  const t0 = Date.parse(points[0]?.start ?? '')
  const t1 = Date.parse(points[n - 1]?.start ?? '') + 7 * 86_400_000
  const x = (i: number) => M.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - M.l - M.r))
  const y = (pct: number) => M.t + (1 - pct / top) * (H - M.t - M.b)
  const ticks = Array.from({ length: Math.floor(top / 15) + 1 }, (_, i) => i * 15)
  const placed: Marker[] = markers
    .filter((m) => m.at >= t0 && m.at <= t1)
    .map((m) => ({ version: m.version, x: M.l + ((m.at - t0) / (t1 - t0)) * (W - M.l - M.r) }))
  const have = points.map((p, i) => ({ p, i })).filter(({ p }) => p.rate !== null)
  const first = have[0]
  const last = have[have.length - 1]
  const segs: Array<{ from: (typeof have)[number]; to: (typeof have)[number] }> = []
  for (let k = 1; k < have.length; k++) segs.push({ from: have[k - 1]!, to: have[k]! })
  return (
    <figure className="grid gap-1" data-testid="learn-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={caption} className="h-auto w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={M.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)" fontFamily="var(--font-mono)">{t}%</text>
          </g>
        ))}
        {points.map((p, i) => (i % 1 === 0 && (n <= 8 || i % 2 === 0 || i === n - 1) ? (
          <text key={p.start} x={x(i)} y={H - 12} textAnchor="middle" fontSize={11} fill="var(--muted)" fontFamily="var(--font-mono)">{shortDate(p.start)}</text>
        ) : null))}
        {placed.map((m) => (
          <g key={m.version}>
            <line x1={m.x} x2={m.x} y1={M.t} y2={H - M.b} stroke="var(--good)" strokeDasharray="3 3" />
            <text x={m.x + 5} y={M.t + 12} fontSize={11} fill="var(--good-ink)" fontFamily="var(--font-mono)">{m.version} promoted</text>
          </g>
        ))}
        {segs.map(({ from, to }) => (
          <line
            key={from.i}
            x1={x(from.i)}
            y1={y(from.p.rate! * 100)}
            x2={x(to.i)}
            y2={y(to.p.rate! * 100)}
            stroke="var(--action)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={from.p.thin || to.p.thin ? '5 5' : undefined}
          />
        ))}
        {have.map(({ p, i }) => (
          <circle key={p.start} cx={x(i)} cy={y(p.rate! * 100)} r={5} fill={p.thin ? 'var(--surface)' : 'var(--action)'} stroke="var(--action)" strokeWidth={2} data-testid={`learn-point-${i}`} data-thin={p.thin ? 'true' : undefined}>
            <title>{`Week of ${shortDate(p.start)}: ${Math.round(p.rate! * 100)}% (${p.wins} of ${p.n} matches)${p.thin ? ', too few matches to trust' : ''}`}</title>
          </circle>
        ))}
        {first ? <text x={x(first.i)} y={y(first.p.rate! * 100) - 12} textAnchor="middle" fontSize={12} fill="var(--ink)" fontFamily="var(--font-mono)">{Math.round(first.p.rate! * 100)}%</text> : null}
        {last && last !== first ? <text x={x(last.i)} y={y(last.p.rate! * 100) + 22} textAnchor="middle" fontSize={12} fill="var(--ink)" fontFamily="var(--font-mono)">{Math.round(last.p.rate! * 100)}%</text> : null}
      </svg>
      <figcaption className="flex flex-wrap justify-between gap-x-4 text-xs text-muted">
        <span>{label}</span>
        <span>solid: {THIN_UNDER} or more matches. Dashed and hollow: too few matches to trust.</span>
      </figcaption>
    </figure>
  )
}

/** The graph and its honest words for one game. `initial` skips the fetch when the page already loaded the view. */
export function LearnGraph({ game, initial, defaultLevel, compact = false }: { game: GameId; initial?: LearnView; defaultLevel?: Level | null; compact?: boolean }) {
  const [view, setView] = useState<LearnView | null>(initial ?? null)
  const [level, setLevel] = useState<Level>(defaultLevel ?? 'medium')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (initial) return
    let alive = true
    const timer = setTimeout(
      () =>
        void import('../server/learn-fns')
          .then(({ getLearnView }) => getLearnView({ data: { game } }))
          .then((v) => alive && setView(v))
          .catch(() => alive && setFailed(true)),
      450,
    )
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [game, initial])
  useEffect(() => {
    if (defaultLevel) setLevel(defaultLevel)
  }, [defaultLevel])
  const name = PRODUCT.games[game].displayName
  const points = useMemo(() => (view ? pointsFor(view.weekly, level) : []), [view, level])
  if (failed) return null
  const copy = view ? learnCopy({ game, learns: view.learns, champion: view.champion, sinceCount: view.sinceCount, sinceEligible: view.sinceEligible }) : null
  const markers = (view?.versions ?? []).filter((v) => v.parent && v.promotedAt).map((v) => ({ version: v.version, at: Date.parse(v.promotedAt!) }))
  const anyData = points.some((p) => p.rate !== null)
  return (
    <section className="grid gap-4 rounded-card border border-line bg-surface p-4 shadow-card md:p-5" aria-labelledby={`learn-h-${game}`} data-testid="learn-graph" data-learns={view ? String(view.learns) : undefined}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 id={`learn-h-${game}`} className="font-display text-display-sm">{learnHeading(game)}</h2>
        <div role="radiogroup" aria-label="Opponent level for the graph" className="flex gap-1 rounded-full bg-surface-2 p-1">
          {LEVELS.map((l) => (
            <label key={l} className={cn('inline-flex min-h-8 cursor-pointer items-center rounded-full px-3 text-xs font-semibold focus-within:outline-2 focus-within:outline-action', l === level ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink')}>
              <input type="radio" name={`learn-level-${game}`} className="sr-only" checked={l === level} onChange={() => setLevel(l)} />
              {personaFor(l).name}
            </label>
          ))}
        </div>
      </header>
      <div className={cn('grid gap-4', compact ? '' : 'lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]')}>
        <div className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold" data-testid="learn-chart-title">Human win rate vs {personaFor(level).name}, by week</h3>
          {!view ? (
            <div className="h-48 rounded-control bg-surface-2" aria-hidden="true" />
          ) : anyData ? (
            <LearnChart points={points} markers={markers} label={`Each point is a week of finished human matches against ${personaFor(level).name}.`} caption={`${name}: human win rate against ${personaFor(level).name}, weekly`} />
          ) : (
            <p className="rounded-control bg-surface-2 p-4 text-sm text-muted" data-testid="learn-empty">No finished matches against {personaFor(level).name} in the last eight weeks yet, so there is nothing to draw. The first ones land here.</p>
          )}
        </div>
        {copy ? (
          <div className="grid content-start gap-3">
            <div className={cn('rounded-control border-l-4 bg-surface-2 p-3.5', view?.learns ? 'border-good' : 'border-peach')} data-testid="learn-copy">
              <b className="block text-sm">{copy.title}</b>
              <p className="mt-1 text-sm text-muted">{copy.body}</p>
            </div>
            {!compact && view && view.versions.length > 0 ? (
              <ol className="grid gap-2 text-sm" aria-label="Versions" data-testid="learn-versions">
                {view.versions.map((v) => (
                  <li key={v.version} className="grid gap-0.5 border-l-2 border-line pl-3">
                    <span><b className="font-mono">{v.version}</b>{v.isChampion ? ', champion' : ''} <span className="font-mono text-xs text-muted">{v.promotedAt ? shortDate(v.promotedAt) : ''}</span></span>
                    <span className="text-muted">{v.rule ? `${v.rule.replace(/\.$/, '')}.` : v.parent ? `From ${v.parent}.` : 'First version.'} {v.humanMatchesUsed > 0 ? `${v.humanMatchesUsed.toLocaleString('en-US')} human matches used.` : 'No human matches used.'}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
