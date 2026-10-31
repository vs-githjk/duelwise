import { useEffect, useRef, useState } from 'react'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type { Lens, OwnerViewBody, Range } from '../../server/telemetry-stats'
import { revealOwnerEmails } from '../../server/telemetry-fns'
import { cn } from '../../lib/cn'
import { LEVEL_NAME } from '../charts/format'
import { personaFor } from '../../personas'
import { ago, recentCsv, utcTime } from './format'
import { DevicesPanel, DriftPanel, KpiRow, LengthPanel, PerGamePanel, WinsPanel } from './Panels'
import { RecentPanel, WhoPlayedPanel } from './Tables'
import { AdminSection } from './Admin'
import { Card } from './Card'
import { ActiveCards } from './ActiveUsers'

export interface OwnerFilters {
  range: Range
  game: GameId | undefined
  level: Level | undefined
  page: number
  /** Which traffic the detailed panels below the headline numbers draw from. The headline numbers always show every class. */
  who: Lens
}

const RANGES: Array<{ id: Range; label: string }> = [
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
]
const STALE_MS = 5 * 60_000
const REFRESH_MS = 60_000
const control = 'inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-3 text-base text-ink'

export function OwnerDashboard({ v, filters, onFilters, onRefresh }: { v: OwnerViewBody; filters: OwnerFilters; onFilters: (f: Partial<OwnerFilters>) => void; onRefresh: () => void }) {
  const [emails, setEmails] = useState<Record<string, string> | null>(null)
  const [asking, setAsking] = useState(false)
  const [revealError, setRevealError] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const [clockNow, setClockNow] = useState<number | null>(null)
  const [adminRefs, setAdminRefs] = useState<string[]>([])

  // The page refreshes itself every minute; if a refresh stops arriving, say so instead of showing old numbers as current.
  useEffect(() => {
    setClockNow(Date.now())
    const tick = setInterval(() => setClockNow(Date.now()), 15_000)
    const refresh = setInterval(onRefresh, REFRESH_MS)
    return () => {
      clearInterval(tick)
      clearInterval(refresh)
    }
  }, [onRefresh])
  const behindMin = clockNow !== null ? Math.round((clockNow - new Date(v.generatedAt).getTime()) / 60_000) : 0
  const stale = clockNow !== null && clockNow - new Date(v.generatedAt).getTime() > STALE_MS

  const shownRefs = [...new Set([...v.recent.rows.filter((r) => r.playerKind === 'user').map((r) => r.player), ...v.whoPlayed.filter((p) => p.playerKind === 'user').map((p) => p.player), ...adminRefs])].slice(0, 100)
  const missing = emails === null ? [] : shownRefs.filter((r) => !(r in emails))
  const missingKey = missing.join(',')
  useEffect(() => {
    if (emails === null || missing.length === 0) return
    let live = true
    revealOwnerEmails({ data: { refs: missing } })
      .then((got) => live && setEmails((cur) => ({ ...(cur ?? {}), ...Object.fromEntries(missing.map((r) => [r, got[r] ?? ''])), ...got })))
      .catch(() => live && setRevealError(true))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey, emails === null])

  function toggleReveal() {
    if (emails !== null) {
      setEmails(null)
      return
    }
    setAsking(true)
    dialog.current?.showModal()
  }
  async function confirmReveal() {
    dialog.current?.close()
    setAsking(false)
    setRevealError(false)
    try {
      const got = await revealOwnerEmails({ data: { refs: shownRefs } })
      setEmails({ ...Object.fromEntries(shownRefs.map((r) => [r, ''])), ...got })
    } catch {
      setRevealError(true)
    }
  }
  function cancelReveal() {
    dialog.current?.close()
    setAsking(false)
  }
  function downloadCsv() {
    const url = URL.createObjectURL(new Blob([recentCsv(v.recent.rows)], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'owner-recent-matches.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="grid gap-4 pb-8" data-testid="owner-page">
      <nav className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-x-4 border-b border-line bg-canvas/95 px-4 backdrop-blur md:-mx-10 md:px-10" aria-label="On this page" data-testid="owner-jump">
        <ul className="flex items-center">
          {[
            ['stats', 'Stats'],
            ['people', 'People'],
            ['activity', 'Activity'],
          ].map(([id, label], i) => (
            <li key={id} className="flex items-center">
              {i > 0 ? <span aria-hidden className="text-muted">·</span> : null}
              <a href={`#${id}`} className="inline-flex min-h-11 items-center px-3 font-semibold hover:underline" data-testid={`jump-${id}`}>{label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <header id="stats" className="flex scroll-mt-20 flex-wrap pt-4 items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-display-md">Observability</h1>
          <span className="inline-flex h-7 items-center rounded-full border border-line px-3 text-sm text-muted">owner only</span>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
          <div className="inline-flex overflow-hidden rounded-control border border-line" role="group" aria-label="Period">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={filters.range === r.id}
                className={cn('inline-flex min-h-11 items-center px-3 text-base', filters.range === r.id ? 'bg-ink text-canvas' : 'bg-surface text-ink')}
                onClick={() => onFilters({ range: r.id, page: 0 })}
              >
                {r.label}
              </button>
            ))}
          </div>
          <select aria-label="Game" className={control} value={filters.game ?? ''} onChange={(e) => onFilters({ game: (e.target.value || undefined) as GameId | undefined, page: 0 })}>
            <option value="">All games</option>
            {(Object.keys(PRODUCT.games) as GameId[]).map((g) => (
              <option key={g} value={g}>{PRODUCT.games[g].displayName}</option>
            ))}
          </select>
          <select aria-label="Level" className={control} value={filters.level ?? ''} onChange={(e) => onFilters({ level: (e.target.value || undefined) as Level | undefined, page: 0 })}>
            <option value="">All levels</option>
            {(['easy', 'medium', 'hard', 'champion'] as Level[]).map((l) => (
              <option key={l} value={l}>{personaFor(l).name}, {LEVEL_NAME[l]}</option>
            ))}
          </select>
        </div>
      </header>

      {stale ? (
        <div role="status" className="rounded-control bg-warn-soft p-3 text-sm text-warn-ink" data-testid="owner-stale">
          <strong>This page is {behindMin} minutes behind.</strong> The last refresh was at {utcTime(v.generatedAt)} UTC. It retries every minute; reload if it stays behind.
        </div>
      ) : null}

      <p className="text-sm text-muted" data-testid="owner-counted">
        Every number shows the human figure first, then Owner (your own games) and Test (our automated runs). Counts add up: Human + Owner + Test = Total. Rates and medians do not add, so each group has its own and the last figure is over all matches together. AI training games run on your own machine and never write to this database.
      </p>
      <p className="text-sm text-muted" data-testid="owner-last-event">
        {v.lastEventAt ? `Last event ${ago(v.lastEventAt, v.generatedAt)}, at ${utcTime(v.lastEventAt)} UTC.` : 'No event has been recorded yet.'} Times are UTC. Numbers come from server events only; nothing is sent to a third party.
      </p>

      {v.empty ? (
        <Card title={filters.who === 'all' ? 'No matches yet' : `No ${filters.who} matches yet`} testId="owner-empty">
          <p className="max-w-prose text-muted">Numbers appear after the first match in this period (the headline numbers above show every class). Share the link and come back; this page refreshes itself every minute.</p>
        </Card>
      ) : null}

      <ActiveCards />
      <KpiRow v={v} />
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Traffic shown in the panels below" data-testid="owner-lens">
        <span className="text-sm text-muted">Panels below show</span>
        <div className="inline-flex overflow-hidden rounded-control border border-line">
          {(['human', 'owner', 'test', 'all'] as const).map((w) => (
            <button key={w} type="button" aria-pressed={filters.who === w} className={cn('inline-flex min-h-11 items-center px-3 text-base capitalize', filters.who === w ? 'bg-ink text-canvas' : 'bg-surface text-ink')} onClick={() => onFilters({ who: w, page: 0 })} data-testid={`lens-${w}`}>
              {w}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <DriftPanel v={v} />
        <WinsPanel v={v} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <PerGamePanel v={v} />
        <LengthPanel v={v} />
        <DevicesPanel v={v} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface p-3" data-testid="owner-reveal">
        <p className="text-sm text-muted">
          {emails === null ? 'Players are shown by id. Emails stay hidden unless you reveal them; each reveal is logged.' : 'Emails are showing for this session. Each one shown was logged with your account and the time.'}
          {revealError ? ' The reveal failed; try again.' : ''}
        </p>
        <button type="button" role="switch" aria-checked={emails !== null} className={cn(control, 'gap-2 font-semibold')} onClick={toggleReveal} data-testid="owner-reveal-toggle">
          Reveal emails
          <span aria-hidden className={cn('inline-block h-5 w-9 rounded-full p-0.5', emails !== null ? 'bg-action' : 'bg-line')}>
            <span className={cn('block size-4 rounded-full bg-surface transition-transform', emails !== null ? 'translate-x-4' : '')} />
          </span>
        </button>
      </div>

      <AdminSection emails={emails} onRefs={setAdminRefs} />

      <RecentPanel v={v} emails={emails} onPage={(page) => onFilters({ page })} onCsv={downloadCsv} />
      <WhoPlayedPanel v={v} emails={emails} />

      <dialog ref={dialog} onClose={() => setAsking(false)} className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-5 text-ink shadow-card backdrop:bg-black/40" aria-labelledby="reveal-title" data-testid="owner-reveal-dialog" data-open={asking}>
        <h2 id="reveal-title" className="font-display text-display-sm">Reveal player emails?</h2>
        <p className="mt-2 text-muted">Emails will show in the tables for this session only. This reveal is logged with your account and the time. Use player ids where you can.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="inline-flex min-h-11 items-center rounded-control bg-action px-4 font-semibold text-canvas" onClick={confirmReveal} data-testid="owner-reveal-confirm">
            Reveal for this session
          </button>
          <button type="button" className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold" onClick={cancelReveal}>
            Keep hidden
          </button>
        </div>
      </dialog>
    </div>
  )
}
