import type { ReactNode } from 'react'
import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { PRODUCT, gameCountWord, type GameId, type Level } from '@duelwise/core/src/product'
import { gameBySlug } from '../../games/registry'
import { getAgentsView, type AgentsView, type OverviewRow } from '../../server/stats-fns'
import type { Funnel, JobRow } from '../../server/stats'
import { LineChart } from '../../components/charts/LineChart'
import { LevelTable } from '../../components/charts/LevelTable'
import { LEVEL_NAME, compactCount, deltaPoints, pct, rate, shortDate, signed } from '../../components/charts/format'
import { cn } from '../../lib/cn'
import { jobLine } from '../../lib/copy'
import { funnelNotes, learnsNote, trainingStripLabel } from '../../lib/honest-copy'
import { EloExplainer } from '../../components/SiteElo'
import { LearnGraph } from '../../components/LearnGraph'
import { getLearnView, type LearnView } from '../../server/learn-fns'

export const Route = createFileRoute('/agents/$game')({
  beforeLoad: ({ params }) => {
    if (!gameBySlug(params.game)) throw notFound()
  },
  loader: async ({ params }) => {
    const game = gameBySlug(params.game)!
    const [view, learn] = await Promise.all([getAgentsView({ data: { game } }), getLearnView({ data: { game } })])
    return { ...view, learn }
  },
  head: ({ params }) => {
    const id = gameBySlug(params.game)
    return { meta: [{ title: `${id ? PRODUCT.games[id].displayName + ' AI' : 'The AI'} | ${PRODUCT.name}` }] }
  },
  component: AgentStats,
})

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
const GAME_IDS = Object.keys(PRODUCT.games) as GameId[]
const LEVEL_COLOR: Record<Level, string> = { easy: '#007e75', medium: '#b14c36', hard: '#7355b5', champion: '#a06a00' }

function Card({ title, note, children, testId, className }: { title: string; note?: string; children: ReactNode; testId?: string; className?: string }) {
  return (
    <section className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 rounded-card border border-line bg-surface p-4 shadow-card md:p-5', className)} data-testid={testId}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-display text-display-sm">{title}</h3>
        {note ? <p className="text-sm text-muted">{note}</p> : null}
      </header>
      {children}
    </section>
  )
}

function GameDot({ game }: { game: GameId }) {
  return <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: `var(--game-${game})` }} />
}

function Delta({ pt }: { pt: number | null }) {
  if (pt === null) return <span className="text-sm text-muted">no earlier version to compare</span>
  return (
    <span className={cn('inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold tabular', pt < 0 ? 'bg-bad-soft text-bad-ink' : pt > 0 ? 'bg-good-soft text-good-ink' : 'bg-neutral-soft text-neutral-ink')}>
      {signed(pt)} pt
    </span>
  )
}

function Pips({ published }: { published: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="inline-flex gap-1">
        {LEVELS.map((l, i) => (
          <span key={l} className="h-1 w-3.5 rounded-full" style={{ background: i < published ? 'var(--action)' : 'var(--line)' }} />
        ))}
      </span>
      <span className="text-sm text-muted">{published === LEVELS.length ? 'all four' : published === 0 ? 'In training' : `${published} of ${LEVELS.length} measured`}</span>
    </span>
  )
}

function Strip({ rows, current }: { rows: OverviewRow[]; current: GameId }) {
  return (
    <ul className="hidden lg:grid lg:gap-0 lg:overflow-hidden lg:rounded-card lg:border lg:border-line lg:bg-surface lg:shadow-card" data-testid="agent-strip" aria-label={`All ${gameCountWord().toLowerCase()} agents`}>
      <li className="hidden grid-cols-[1.4fr_0.8fr_1.4fr_1.6fr_1.5fr_1.6fr] gap-4 border-b border-line px-5 py-3 text-sm text-muted lg:grid" aria-hidden>
        <span>Agent</span>
        <span>Version</span>
        <span>Humans win vs Hard, 7 days</span>
        <span>Levels published</span>
        <span>Learns from humans</span>
        <span>Latest challenger</span>
      </li>
      {rows.map((r) => {
        const hard = rate(r.vsHard.last7)
        return (
          <li key={r.game} className="rounded-full border border-line lg:rounded-none lg:border-0 lg:border-b lg:last:border-b-0" data-testid={`strip-${r.game}`}>
            <Link
              to="/agents/$game"
              params={{ game: PRODUCT.games[r.game].slug }}
              aria-current={r.game === current ? 'page' : undefined}
              className={cn('grid min-h-11 items-center gap-x-4 gap-y-2 rounded-full px-4 py-2 hover:bg-surface-2 lg:rounded-none lg:py-3 lg:grid-cols-[1.4fr_0.8fr_1.4fr_1.6fr_1.5fr_1.6fr] lg:px-5', r.game === current && 'bg-action-soft')}
            >
              <span className="inline-flex items-center gap-2 font-semibold">
                <GameDot game={r.game} />
                {PRODUCT.games[r.game].displayName}
              </span>
              <span className="hidden font-mono text-sm tabular lg:block" data-testid={`strip-version-${r.game}`}>
                <span className="text-muted lg:hidden">Version </span>
                {r.version ?? 'none'}
              </span>
              <span className="hidden flex-wrap items-center gap-2 lg:inline-flex" data-testid={`strip-hard-${r.game}`}>
                <span className="text-muted lg:hidden">Humans win vs Hard, 7 days</span>
                {hard === null ? <span className="text-sm text-muted">no matches yet</span> : <span className="font-mono tabular">{pct(hard, 0)}</span>}
                {hard === null ? null : <Delta pt={deltaPoints(r.vsHard.last7, r.vsHard.previous7)} />}
              </span>
              <span className="hidden lg:block" data-testid={`strip-levels-${r.game}`}>
                <Pips published={r.publishedCount} />
              </span>
              <span className="hidden lg:block">
                <span className="inline-flex h-6 items-center rounded-full bg-neutral-soft px-2.5 text-xs font-semibold text-neutral-ink" data-testid={`strip-learns-${r.game}`}>
                  {trainingStripLabel(r.learns, r.game)}
                </span>
              </span>
              <span className="hidden text-sm text-muted lg:block">{r.lastRun ? `${r.lastRun.challenger}, ${r.lastRun.promoted ? 'promoted' : 'not promoted'}` : 'none yet'}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function Tile({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId: string }) {
  return (
    <div className="grid content-start gap-1.5 rounded-card border border-line bg-surface p-4 shadow-card md:p-5" data-testid={testId}>
      <p className="text-sm text-muted">{label}</p>
      <p className="font-display text-display-md tabular">{value}</p>
      {sub ? <p className="text-sm text-muted">{sub}</p> : null}
    </div>
  )
}

function Funnelbars({ f, name, game }: { f: Funnel; name: string; game: GameId }) {
  const notes = funnelNotes(game)
  const rows: Array<[string, number, string]> = [
    ['Played', f.played, 'funnel-played'],
    ['Finished', f.finished, 'funnel-finished'],
    ['Passed every filter', f.passedFilters, 'funnel-passed'],
    ['Allowed for training', f.allowed, 'funnel-allowed'],
    ['Used for training', f.used, 'funnel-used'],
  ]
  const top = Math.max(1, f.played)
  const reasons = Object.entries(f.reasons)
  return (
    <div className="grid gap-4">
      <ul className="grid gap-2.5" aria-label={`Where ${name} human matches go`}>
        {rows.map(([label, n, id]) => (
          <li key={id} className="grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-3 text-sm">
            <span>{label}</span>
            <span aria-hidden className="h-2.5 overflow-hidden rounded-full bg-surface-2">
              <span className="block h-full rounded-full" style={{ width: `${Math.min(100, (n / top) * 100)}%`, background: 'var(--action)' }} />
            </span>
            <span className="text-right font-mono tabular" data-testid={id}>{n}</span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted" data-testid="funnel-note">
        {f.used === 0 ? `${notes.nothingUsed} ` : ''}
        <span data-testid="funnel-optout">{f.optedOut}</span> opted-out {f.optedOut === 1 ? 'match never leaves' : 'matches never leave'} the database.
        {f.notLearning > 0 ? (
          <>
            {' '}
            <span data-testid="funnel-notlearning">{f.notLearning}</span> {notes.notLearning}
          </>
        ) : null}
      </p>
      {reasons.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Why matches dropped out">
          {reasons.map(([why, n]) => (
            <li key={why} className="inline-flex h-6 items-center rounded-full bg-neutral-soft px-2.5 text-xs font-semibold text-neutral-ink" data-testid={`reason-${why}`}>
              {n} {why}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Jobs({ jobs }: { jobs: JobRow[] | null }) {
  if (jobs === null) return <p className="text-sm text-muted" data-testid="jobs-unavailable">Training status is only readable where training runs, so it is not shown here.</p>
  if (jobs.length === 0) return <p className="text-sm text-muted" data-testid="jobs-empty">Nothing is training right now.</p>
  return (
    <ul className="grid divide-y divide-line">
      {jobs.map((j) => (
        <li key={j.name} className="grid gap-0.5 py-2.5 first:pt-0 last:pb-0" data-testid={`job-${j.name}`} data-state={j.state}>
          <span className="inline-flex items-center gap-2 font-semibold">
            {j.game ? <GameDot game={j.game} /> : null}
            {j.name}
          </span>
          <p className="text-sm text-muted" data-testid={`job-state-${j.name}`}>
            {jobLine(j)}
          </p>
        </li>
      ))}
    </ul>
  )
}

function Detail({ view }: { view: AgentsView & { learn: LearnView } }) {
  const id = view.game
  const name = PRODUCT.games[id].displayName
  const realtime = PRODUCT.games[id].kind === 'realtime'
  const { stats, registry } = view
  const hard = rate(stats.vsHard.last7)
  const champion = registry.levels.find((l) => l.level === 'champion')!
  const weekLabels = stats.weekly.map((w) => shortDate(w.start))
  const series = LEVELS.map((l) => ({
    key: l,
    label: LEVEL_NAME[l],
    color: LEVEL_COLOR[l],
    counts: stats.weekly.map((w) => w.levels[l]?.games ?? 0),
    values: stats.weekly.map((w) => {
      const t = w.levels[l]
      return t && t.games > 0 ? t.wins / t.games : null
    }),
  }))
  const anyWeekly = series.some((s) => s.values.some((v) => v !== null))
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5" data-testid="agent-detail" data-game={id}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="font-display text-display-md">{name} agent</h2>
        <p className="text-sm text-muted" data-testid="learns-note">
          {learnsNote({
            learns: view.learns,
            hasLearned: view.hasLearned,
            pretraining: view.pretraining,
            selfPlay: (view.registry.history.find((h) => h.version === view.registry.version)?.trainedSteps ?? 0) > 0,
            game: id,
          })}
        </p>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[repeat(2,minmax(0,1fr))] lg:grid-cols-[repeat(4,minmax(0,1fr))]">
        <Tile
          testId="tile-hard"
          label="Humans win vs Hard, last 7 days"
          value={hard === null ? <span className="text-muted">no matches</span> : pct(hard, 0)}
          sub={hard === null ? 'No counted Hard matches this week.' : `${stats.vsHard.last7.wins} of ${stats.vsHard.last7.games} counted matches`}
        />
        <Tile
          testId="tile-version"
          label="Current version"
          value={registry.version ?? <span className="text-muted">none</span>}
          sub={registry.promotedAt ? `promoted ${shortDate(registry.promotedAt)}` : registry.version ? 'not promoted' : 'no registry yet'}
        />
        <Tile
          testId="tile-matches"
          label="Matches vs humans"
          value={stats.counted}
          sub={`${stats.funnel.passedFilters} passed the filters`}
        />
        {realtime ? (
          <Tile
            testId="tile-champion"
            label="Champion reaction"
            value={champion.reactionFrames === undefined ? <span className="text-muted">In training</span> : `${Math.round(champion.reactionFrames * 1000 / 60)} ms (${champion.reactionFrames} frames)`}
            sub={champion.state === 'measured' ? champion.plain : champion.reason}
          />
        ) : (
          <Tile
            testId="tile-champion"
            label="Champion strength"
            value={champion.state === 'measured' ? Math.round(champion.siteElo!) : <span className="text-muted">In training</span>}
            sub={champion.state === 'measured' ? 'site Elo, measured' : champion.reason}
          />
        )}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[repeat(2,minmax(0,1fr))]">
        <Card title="Human win rate by level" note="weekly, last eight weeks, counted matches only" testId="card-winrate">
          {anyWeekly ? (
            <LineChart series={series} xLabels={weekLabels} formatY={(v) => pct(v, 0)} caption={`${name}: human win rate by level, weekly`} testId="winrate-chart" />
          ) : (
            <p className="text-sm text-muted" data-testid="winrate-empty">No counted matches in the last eight weeks, so there is nothing to chart.</p>
          )}
          <LevelTable levels={registry.levels} realtime={realtime} />
        </Card>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
          <Card title="Head to head" note="stronger level's score against the level below, with its confidence interval" testId="card-pairs">
            {registry.pairs.length === 0 ? (
              <p className="text-sm text-muted" data-testid="pairs-empty">Head-to-head results are recorded when the levels are measured. None yet.</p>
            ) : (
              <ul className="grid divide-y divide-line">
                {registry.pairs.map((p) => (
                  <li key={`${p.lower}-${p.upper}`} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-2.5 first:pt-0" data-testid={`pair-${p.upper}-${p.lower}`}>
                    <span className="font-semibold">{LEVEL_NAME[p.upper]} vs {LEVEL_NAME[p.lower]}</span>
                    <span className="font-mono tabular" data-testid={`pair-rate-${p.upper}`}>{pct(p.score)}</span>
                    <span className="text-sm text-muted">stronger wins, {p.n} games</span>
                    <span className="text-sm text-muted tabular" data-testid={`pair-ci-${p.upper}`}>{pct(p.ci95[0])} to {pct(p.ci95[1])}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Version history" testId="card-history">
            {registry.history.length === 0 ? (
              <p className="text-sm text-muted" data-testid="history-empty">No versions recorded yet.</p>
            ) : (
              <ol className="grid divide-y divide-line">
                {registry.history.map((h) => (
                  <li key={h.version} className="grid grid-cols-[4rem_1fr_auto] gap-x-3 py-2.5 first:pt-0 last:pb-0" data-testid={`version-${h.version}`}>
                    <span className="font-mono text-sm font-semibold">{h.version}</span>
                    <span className="text-sm">
                      <span className="font-semibold">{h.version === registry.version ? (registry.levels.filter((l) => l.state === 'measured').length === 4 ? 'All levels measured. ' : registry.levels.some((l) => l.state === 'measured') ? `${registry.levels.filter((l) => l.state === 'measured').length} of 4 levels measured. ` : 'In training. ') : h.status === 'retired' ? 'Retired. ' : 'Earlier version. '}</span>
                      <span className="text-muted">
                        {h.parent ? `From ${h.parent}. ` : 'First version. '}

                        <span data-testid={`version-humans-${h.version}`}>{h.humanMatchesUsed > 0 ? `${h.humanMatchesUsed} human matches used.` : view.pretraining ? 'No site matches used.' : h.trainedSteps > 0 ? 'Self-play only.' : 'No human matches used.'}</span>{' '}
                      </span>
                    </span>
                    <span className="font-mono text-xs text-muted">{shortDate(h.promotedAt ?? h.createdAt)}</span>
                  </li>
                ))}
              </ol>
            )}
            {stats.runs.some((r) => !r.promoted) ? (
              <ul className="grid gap-1 border-t border-line pt-3 text-sm text-muted" aria-label="Challengers that were not promoted">
                {stats.runs.filter((r) => !r.promoted).map((r) => (
                  <li key={r.id} data-testid={`rejected-${r.challenger}`}>
                    <span className="font-mono font-semibold text-ink">{r.challenger}</span> was not promoted over {r.champion}, {shortDate(r.createdAt)}.
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>
      </div>

      <div className={cn('grid grid-cols-[minmax(0,1fr)] gap-4', view.owner ? 'lg:grid-cols-[repeat(3,minmax(0,1fr))]' : 'lg:grid-cols-[repeat(2,minmax(0,1fr))]')}>
        {view.owner ? (
          <Card title="Training" testId="card-jobs">
            <Jobs jobs={view.jobs} />
          </Card>
        ) : null}
        <Card title={`Human matches, ${name}`} note="where they go" testId="card-funnel">
          <Funnelbars f={stats.funnel} name={name} game={view.game} />
        </Card>
        <Card title={registry.changes ? `What changed in ${registry.changes.version}` : 'What changed'} note="measured, not described" testId="card-changes">
          {registry.changes ? (
            <ul className="grid divide-y divide-line">
              {registry.changes.items.map((c) => (
                <li key={c.label} className="grid grid-cols-[4.5rem_1fr] gap-x-3 py-2.5 first:pt-0 last:pb-0" data-testid={`change-${c.label}`}>
                  <span className="font-mono tabular">{c.delta > 0 ? `+${c.delta}` : c.delta}</span>
                  <span className="text-sm">
                    <span className="font-semibold">{c.label}</span>
                    {c.note ? <span className="text-muted"> {c.note}</span> : null}
                    <span className="text-muted"> ({c.unit})</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted" data-testid="changes-empty">No measured change is recorded for this version.</p>
          )}
        </Card>
      </div>
    </div>
  )
}

function AgentStats() {
  const view = Route.useLoaderData()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 py-8" data-testid="agent-stats">
      <header className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="grid max-w-3xl gap-2">
          <h1 className="font-display text-display-md md:text-display-lg">The AI, measured</h1>
          <p className="text-muted">
            One opponent per game. Strength numbers come from tests or counted matches; an unmeasured level is in training.
          </p>
        </div>
        <nav aria-label="Pick a game" className="flex flex-wrap gap-2">
          {GAME_IDS.map((g) => (
            <Link
              key={g}
              to="/agents/$game"
              params={{ game: PRODUCT.games[g].slug }}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-sm hover:bg-surface-2"
              activeProps={{ className: 'border-ink font-semibold' }}
              data-testid={`tab-${g}`}
            >
              <GameDot game={g} />
              {PRODUCT.games[g].displayName}
            </Link>
          ))}
        </nav>
      </header>
      <LearnGraph game={view.game} initial={view.learn} />
      {PRODUCT.games[view.game].kind === 'realtime' ? null : <EloExplainer />}
      <Strip rows={view.overview} current={view.game} />
      <Detail view={view} />
    </div>
  )
}
