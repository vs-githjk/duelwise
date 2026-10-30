import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type { ReactNode } from 'react'
import type { DriftAlert, DriftRow, Kpis, OwnerView, OwnerViewBody } from '../../server/telemetry-stats'
import { Avatar } from '../../personas/Avatar'
import { LineChart } from '../charts/LineChart'
import { LEVEL_NAME, pct, signed } from '../charts/format'
import { cn } from '../../lib/cn'
import { Card, Sparkline } from './Card'
import { DEVICE_NAME, clock } from './format'

const LEVEL_COLOR: Record<Level, string> = { easy: 'var(--level-1)', medium: 'var(--level-2)', hard: 'var(--level-3)', champion: 'var(--level-4)' }
const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']

function Tile({ label, value, sub, subTone, series, testId, small, parts }: { label: string; value: string; sub: string; subTone?: 'bad' | 'good'; series: Array<number | null>; testId: string; small?: boolean; parts?: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1 rounded-card border border-line bg-surface p-4 shadow-card" data-testid={testId}>
      <p className="text-sm text-muted">{label}</p>
      <p className={cn('font-display tabular', small ? 'text-display-sm' : 'text-display-md')}>{value}<span className="ml-2 font-sans text-sm font-semibold text-muted">Human</span></p>
      <p className={cn('text-sm', subTone === 'bad' ? 'text-bad-ink' : subTone === 'good' ? 'text-good-ink' : 'text-muted')}>{sub}</p>
      {parts ? <p className="text-xs text-muted" data-testid={`${testId}-parts`}>{parts}</p> : null}
      <Sparkline values={series} />
    </div>
  )
}

/** The headline row: every tile is the human number, with the owner, test and total beside it (they are never mixed into the headline). */
export function KpiRow({ v }: { v: OwnerViewBody }) {
  const k = v.kpisBy.human
  const by = v.kpisBy
  const parts = (f: (k: Kpis) => string): ReactNode => (
    <>Owner <b className="font-semibold text-ink">{f(by.owner)}</b> · Test <b className="font-semibold text-ink">{f(by.test)}</b> · Total <b className="font-semibold text-ink">{f(by.total)}</b></>
  )
  const rate = (r: number | null) => (r === null ? '-' : pct(r, 0))
  const delta = k.matches.previous > 0 ? Math.round(((k.matches.value - k.matches.previous) / k.matches.previous) * 100) : null
  const abandonDelta = k.ending.abandon !== null && k.ending.abandonPrevious !== null ? Math.round((k.ending.abandon - k.ending.abandonPrevious) * 100) : null
  const games = k.medianMs.byGame.slice(0, 2).map((g) => `${PRODUCT.games[g.game].displayName} ${clock(g.medianMs)}`).join(', ')
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="owner-kpis">
      <Tile testId="kpi-players" label="Players" parts={parts((x) => String(x.players.value))} value={String(k.players.value)} sub={`${k.players.newCount} new, ${k.players.returning} returning`} series={k.players.series} />
      <Tile
        testId="kpi-matches"
        label="Matches"
        parts={parts((x) => String(x.matches.value))}
        value={String(k.matches.value)}
        sub={delta === null ? 'no earlier period to compare' : `${signed(delta)}% vs the period before`}
        subTone={delta !== null && delta > 0 ? 'good' : undefined}
        series={k.matches.series}
      />
      <Tile
        testId="kpi-ai-win"
        label="AI win rate"
        parts={parts((x) => `${rate(x.aiWin.rate)} of ${x.aiWin.rated}`)}
        value={k.aiWin.rate === null ? '-' : pct(k.aiWin.rate, 0)}
        sub={k.aiWin.humans === null ? 'no rated results' : `humans ${pct(k.aiWin.humans, 0)}, draws ${pct(k.aiWin.draws ?? 0, 0)}`}
        series={k.aiWin.series}
      />
      <Tile testId="kpi-median" label="Median match" parts={parts((x) => clock(x.medianMs.value))} value={clock(k.medianMs.value)} sub={games || 'no finished matches'} series={k.medianMs.series} />
      <Tile
        testId="kpi-ending"
        small
        label="Abandon / resign"
        parts={parts((x) => (x.ending.abandon === null ? '-' : `${pct(x.ending.abandon, 0)}/${pct(x.ending.resign ?? 0, 0)}`))}
        value={k.ending.abandon === null ? '-' : `${pct(k.ending.abandon, 1)} / ${pct(k.ending.resign ?? 0, 1)}`}
        sub={abandonDelta === null ? 'no earlier period to compare' : `abandon ${signed(abandonDelta)} pts`}
        subTone={abandonDelta !== null && abandonDelta > 0 ? 'bad' : undefined}
        series={k.ending.series}
      />
      <Tile
        testId="kpi-optout"
        label="Training opt-out"
        parts={parts((x) => (x.optOut.players === 0 ? '-' : pct(x.optOut.optedOut / x.optOut.players, 0)))}
        value={k.optOut.players === 0 ? '-' : pct(k.optOut.optedOut / k.optOut.players, 1)}
        sub={`${k.optOut.optedOut} of ${k.optOut.players} players`}
        series={k.optOut.series}
      />
    </div>
  )
}

function DriftTrack({ d }: { d: DriftRow }) {
  if (d.rate === null || d.low === null || d.high === null) return <div className="h-5 rounded-full bg-neutral-soft" aria-hidden />
  const at = (x: number) => `${(Math.min(1, Math.max(0, x)) * 100).toFixed(2)}%`
  return (
    <div className="relative h-5" aria-hidden>
      <div className="absolute inset-x-0 top-1/2 h-px bg-line" />
      <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-action-soft" style={{ left: at(d.low), width: `calc(${at(d.high)} - ${at(d.low)})` }} />
      {d.target !== null ? <div className="absolute top-0 h-5 w-0.5 bg-muted" style={{ left: at(d.target) }} /> : null}
      <div className="absolute top-0.5 h-4 w-1 rounded-sm bg-ink" style={{ left: at(d.rate) }} />
    </div>
  )
}

const STATE_LABEL: Record<DriftRow['state'], string> = { ok: 'ok', 'ai-above': 'above', 'ai-below': 'below', few: 'few games', 'no-target': 'no target' }

export function DriftPanel({ v }: { v: OwnerView }) {
  return (
    <Card title="AI win rate by level vs its target" note="people only; draws count half; resignations and abandons count as AI wins" testId="owner-drift">
      <ul className="grid gap-3">
        {v.drift.map((d) => (
          <li key={d.level} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[12rem_minmax(0,1fr)_auto]" data-testid={`drift-${d.level}`} data-state={d.state}>
            <span className="inline-flex min-w-0 items-center gap-2">
              <Avatar level={d.level} size={28} decorative />
              <span className="font-semibold">{d.persona}</span>
              <span className="text-sm text-muted">{LEVEL_NAME[d.level]}</span>
            </span>
            <span className="order-last col-span-2 sm:order-none sm:col-span-1">
              <DriftTrack d={d} />
            </span>
            <span className="inline-flex items-center gap-2 text-sm tabular">
              {d.rate === null ? <span className="text-muted">no target yet</span> : <span>{pct(d.rate, 0)} of {d.n}</span>}
              <span
                className={cn(
                  'inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold',
                  d.state === 'ok' ? 'bg-good-soft text-good-ink' : d.state === 'ai-above' || d.state === 'ai-below' ? 'bg-warn-soft text-warn-ink' : 'bg-neutral-soft text-neutral-ink',
                )}
              >
                {STATE_LABEL[d.state]}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted">The bar is the 95 percent interval, the dark mark is this period, the grey tick is the target from the measured site Elo.</p>
      {v.alerts.map((a) => (
        <DriftAlertBox key={a.level} a={a} />
      ))}
    </Card>
  )
}

function DriftAlertBox({ a }: { a: DriftAlert }) {
  return (
    <div role="alert" className="rounded-control bg-warn-soft p-3 text-sm text-warn-ink" data-testid={`drift-alert-${a.level}`}>
      <strong>
        {a.persona} is {a.direction === 'above' ? 'beating people more than' : 'losing to people more than'} its target:
      </strong>{' '}
      {pct(a.rate, 0)} against a {pct(a.target, 0)} target over {a.n} matches, and the interval ({pct(a.low, 0)} to {pct(a.high, 0)}) excludes the target.{' '}
      {a.direction === 'above' ? 'People who pick this level lose more than designed. ' : 'People who pick this level win more than designed. '}Check this level's slip rate and reaction limits before the next publish.
    </div>
  )
}

export function WinsPanel({ v }: { v: OwnerView }) {
  return (
    <Card title="Who wins, per day" note="share of rated results (resignations and abandons count as AI wins)" testId="owner-wins">
      <LineChart
        caption="Share of rated results won by the AI, by humans and drawn, per period"
        xLabels={v.bucketLabels}
        formatY={(x) => pct(x, 0)}
        series={[
          { key: 'ai', label: 'AI', color: 'var(--ink)', values: v.wins.ai },
          { key: 'human', label: 'Humans', color: 'var(--action)', values: v.wins.human },
          { key: 'draw', label: 'Draws', color: 'var(--muted)', values: v.wins.draw },
        ]}
      />
    </Card>
  )
}

export function PerGamePanel({ v }: { v: OwnerView }) {
  const max = Math.max(1, ...v.perGameLevel.map((g) => g.total))
  return (
    <Card title="Matches per game and level" testId="owner-per-game">
      <div className="grid grid-cols-3 items-end gap-3 sm:grid-cols-6" style={{ minHeight: 200 }}>
        {v.perGameLevel.map((g) => (
          <div key={g.game} className="grid content-end justify-items-center gap-1" data-testid={`bar-${g.game}`} data-total={g.total}>
            <span className="text-sm font-semibold tabular">{g.total}</span>
            <div className="flex w-full max-w-14 flex-col-reverse overflow-hidden rounded-t" style={{ height: `${Math.round((g.total / max) * 150)}px` }}>
              {LEVELS.map((l) => (g.levels[l] > 0 ? <div key={l} style={{ flexGrow: g.levels[l], background: LEVEL_COLOR[l] }} title={`${LEVEL_NAME[l]} ${g.levels[l]}`} /> : null))}
            </div>
            <span className="text-center text-xs text-muted">{PRODUCT.games[g.game as GameId].displayName}</span>
          </div>
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted" aria-label="Legend">
        {LEVELS.map((l) => (
          <li key={l} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: LEVEL_COLOR[l] }} />
            {LEVEL_NAME[l]}
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function LengthPanel({ v }: { v: OwnerView }) {
  return (
    <Card title="Match length" note="median per game" testId="owner-length">
      <ul className="grid gap-2">
        {v.length.map((l) => {
          const top = Math.max(1, ...l.bins)
          const tall = l.bins.indexOf(Math.max(...l.bins))
          return (
            <li key={l.game} className="grid grid-cols-[minmax(0,1fr)_auto_3.5rem] items-center gap-3 text-sm">
              <span className="truncate">{PRODUCT.games[l.game].displayName}</span>
              <span aria-hidden className="flex h-6 items-end gap-px">
                {l.bins.map((b, i) => (
                  <span key={i} className="w-2 rounded-t-sm" style={{ height: `${Math.max(2, Math.round((b / top) * 24))}px`, background: b > 0 && i === tall ? 'var(--action)' : 'var(--line)' }} />
                ))}
              </span>
              <span className="text-right tabular">{clock(l.medianMs)}</span>
            </li>
          )
        })}
      </ul>
      <p className="text-sm text-muted">Bars: 0 to 16 minutes in 2 minute bins; the tallest bin is marked.</p>
    </Card>
  )
}

function BarRow({ label, share, count, tone }: { label: string; share: number; count: number; tone: string }) {
  return (
    <li className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-3 text-sm">
      <span>{label}</span>
      <span className="h-2 rounded-full bg-neutral-soft" aria-hidden>
        <span className="block h-2 rounded-full" style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100).toFixed(1)}%`, background: tone }} />
      </span>
      <span className="text-right tabular">{pct(share, 1)} <span className="text-muted">({count})</span></span>
    </li>
  )
}

export function DevicesPanel({ v }: { v: OwnerView }) {
  const e = v.ending
  const frac = (n: number) => (e.total > 0 ? n / e.total : 0)
  return (
    <Card title="Devices and endings" testId="owner-devices">
      <div className="grid gap-2">
        <h3 className="font-semibold">Devices</h3>
        <ul className="grid gap-2" data-testid="owner-device-list">
          {v.devices.filter((d) => (d.device !== 'unknown' && d.device !== 'headless') || d.count > 0).map((d) => (
            <BarRow key={d.device} label={DEVICE_NAME[d.device] ?? d.device} share={d.share} count={d.count} tone="var(--action)" />
          ))}
        </ul>
      </div>
      <div className="grid gap-2">
        <h3 className="font-semibold">Why matches end</h3>
        <ul className="grid gap-2" data-testid="owner-ending-list">
          <BarRow label="Finished" share={frac(e.finished)} count={e.finished} tone="var(--action)" />
          <BarRow label="Abandoned" share={frac(e.abandoned)} count={e.abandoned} tone="var(--bad)" />
          <BarRow label="Resigned" share={frac(e.resigned)} count={e.resigned} tone="var(--warn)" />
        </ul>
      </div>
    </Card>
  )
}
