import { useCallback, useEffect, useRef, useState } from 'react'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type { AdminOverview, DaySplit, Split, FeedRow, HistoryRow, PeoplePage, PeopleSort, PersonRow, PlayerDetail } from '../../server/admin-owner'
import { getAdminOverview, getAdminPeople, getAdminPlayer } from '../../server/admin-fns'
import { Avatar } from '../../personas/Avatar'
import { personaFor } from '../../personas'
import { cn } from '../../lib/cn'
import { shortDate } from '../charts/format'
import { Card } from './Card'
import { CLASS_COLOR, Legend, Parts, StackBar, TrafficTag } from './Breakdown'
import { ago, utcTime } from './format'

const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
const GAMES = Object.keys(PRODUCT.games) as GameId[]
const gameName = (g: GameId) => PRODUCT.games[g].displayName
const REFRESH_MS = 60_000
const btn = 'inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold text-ink disabled:opacity-50'
const Chip = ({ tone, children }: { tone: string; children: string }) => <span className={cn('inline-flex h-6 items-center whitespace-nowrap rounded-full px-2 text-xs font-semibold', tone)}>{children}</span>
const Outline = ({ children, title }: { children: string; title?: string }) => (
  <span title={title} className="inline-flex h-6 items-center whitespace-nowrap rounded-full border border-line px-2 text-xs text-muted">{children}</span>
)
const RESULT_TONE: Record<string, string> = {
  won: 'bg-good-soft text-good-ink',
  lost: 'bg-bad-soft text-bad-ink',
  draw: 'bg-neutral-soft text-neutral-ink',
  resigned: 'bg-warn-soft text-warn-ink',
  abandoned: 'bg-warn-soft text-warn-ink',
  'in progress': 'bg-action text-action-ink',
  unknown: 'bg-neutral-soft text-neutral-ink',
}

/** The player's label: the name, or the revealed email when the owner has asked for it (accounts only). */
function Who({ name, kind, ref_, emails }: { name: string; kind: 'guest' | 'user'; ref_: string; emails: Record<string, string> | null }) {
  const email = emails?.[ref_]
  return (
    <span className="grid min-w-0 gap-0.5 text-left">
      <span className="truncate font-semibold" data-testid="admin-name">{name}</span>
      <span className="truncate font-mono text-xs text-muted" data-testid="admin-ref">
        {email ? email : `${kind === 'guest' ? 'guest' : 'account'} ${ref_}`}
      </span>
    </span>
  )
}

export function useLoad<T>(load: () => Promise<T | null>, deps: unknown[], every?: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    const run = () =>
      load()
        .then((d) => {
          if (!live) return
          setData(d)
          setError(d === null)
        })
        .catch(() => live && setError(true))
    void run()
    const t = every ? setInterval(run, every) : null
    return () => {
      live = false
      if (t) clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, retry: () => setTick((n) => n + 1) }
}

function Bars({ days, label, testId }: { days: DaySplit[]; label: string; testId: string }) {
  const max = Math.max(1, ...days.map((d) => d.total))
  const sum = days.reduce((a, d) => ({ human: a.human + d.human, owner: a.owner + d.owner, test: a.test + d.test, total: a.total + d.total }), { human: 0, owner: 0, test: 0, total: 0 })
  return (
    <div className="grid gap-2" data-testid={testId} data-total={sum.total} data-human={sum.human} data-owner={sum.owner} data-test={sum.test}>
      <div role="img" aria-label={`${label}, last ${days.length} days: ${sum.human} human, ${sum.owner} owner, ${sum.test} test, ${sum.total} in all. ${days.map((d) => `${shortDate(d.day)} ${d.human} human of ${d.total}`).join(', ')}`} className="flex h-28 items-end gap-1">
        {days.map((d) => (
          <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1" title={`${shortDate(d.day)}: ${d.human} human, ${d.owner} owner, ${d.test} test`}>
            <span className="text-center text-xs leading-none text-muted tabular">{d.total || ''}</span>
            <StackBar d={d} max={max} />
          </div>
        ))}
      </div>
      <p className="flex justify-between text-xs text-muted" aria-hidden>
        <span>{shortDate(days[0]!.day)}</span>
        <span>{shortDate(days[days.length - 1]!.day)}</span>
      </p>
      <Legend />
    </div>
  )
}

const sumDays = (d: DaySplit[]): Split => d.reduce((a, x) => ({ human: a.human + x.human, owner: a.owner + x.owner, test: a.test + x.test, total: a.total + x.total }), { human: 0, owner: 0, test: 0, total: 0 })

function Totals({ o }: { o: AdminOverview }) {
  const maxGame = Math.max(1, ...o.matchesPerGame.map((g) => g.total))
  const p = o.players
  const newS = sumDays(o.newPerDay)
  const matchS = sumDays(o.matchesPerDay)
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_minmax(0,1.2fr)]" data-testid="admin-totals">
      <Card title="Players" testId="admin-total-players">
        <p className="flex items-baseline gap-2" data-testid="admin-total-count" data-total={p.all.total} data-human={p.all.human}>
          <span className="font-display text-display-lg tabular">{p.all.human}</span><span className="text-sm font-semibold text-muted">Human</span>
        </p>
        <Parts s={p.all} />
        <p className="text-sm text-muted">
          Humans: {p.accounts.human} signed in, {p.guests.human} {p.guests.human === 1 ? 'guest' : 'guests'}. A guest who later signs in can be counted twice.
        </p>
      </Card>
      <Card title="New players per day" note={`Human ${newS.human} in 14 days`} testId="admin-new-per-day">
        <Bars days={o.newPerDay} label="New players per day" testId="admin-new-bars" />
        <Parts s={newS} />
      </Card>
      <Card title="Matches per day" note={`Human ${matchS.human} in 14 days`} testId="admin-matches-per-day">
        <Bars days={o.matchesPerDay} label="Matches per day" testId="admin-matches-bars" />
        <Parts s={matchS} />
      </Card>
      <Card title="Matches per game" note="all time, finished" testId="admin-matches-per-game">
        <ul className="grid gap-3">
          {o.matchesPerGame.map((g) => (
            <li key={g.game} className="grid gap-1 text-sm" data-testid={`admin-game-${g.game}`} data-count={g.human} data-human={g.human} data-owner={g.owner} data-test={g.test} data-total={g.total}>
              <span className="flex items-baseline justify-between gap-2"><span className="truncate">{gameName(g.game)}</span><span className="tabular"><b>{g.human}</b> <span className="text-xs text-muted">Human</span></span></span>
              <span aria-hidden className="flex h-2 overflow-hidden rounded-full bg-neutral-soft" style={{ width: `${Math.round((g.total / maxGame) * 100)}%` }}>
                {(['human', 'owner', 'test'] as const).map((c) => <span key={c} className="block h-2" style={{ width: `${g.total ? (g[c] / g.total) * 100 : 0}%`, background: CLASS_COLOR[c] }} />)}
              </span>
              <Parts s={g} />
            </li>
          ))}
        </ul>
        <Legend />
      </Card>
    </div>
  )
}

const SORTS: Array<{ id: PeopleSort; label: string }> = [
  { id: 'last', label: 'Last seen' },
  { id: 'joined', label: 'Joined' },
  { id: 'matches', label: 'Matches' },
]

interface PeopleState {
  sort: PeopleSort
  dir: 'asc' | 'desc'
  page: number
  q: string
}

function PerGameChips({ p }: { p: PersonRow }) {
  const played = GAMES.filter((g) => (p.perGame[g] ?? 0) > 0)
  if (!played.length) return <span className="text-muted">none</span>
  return (
    <span className="flex flex-wrap gap-1">
      {played.map((g) => (
        <Outline key={g}>{`${gameName(g)} ${p.perGame[g]}`}</Outline>
      ))}
    </span>
  )
}

function People({ emails, onRefs, onOpen }: { emails: Record<string, string> | null; onRefs: (refs: string[]) => void; onOpen: (p: PersonRow) => void }) {
  const [s, setS] = useState<PeopleState>({ sort: 'last', dir: 'desc', page: 0, q: '' })
  const [typed, setTyped] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setS((cur) => (cur.q === typed.trim() ? cur : { ...cur, q: typed.trim(), page: 0 })), 250)
    return () => clearTimeout(t)
  }, [typed])
  const { data, error, retry } = useLoad<PeoplePage>(() => getAdminPeople({ data: s }), [s.sort, s.dir, s.page, s.q], REFRESH_MS)
  const [at, setAt] = useState('')
  useEffect(() => {
    if (data) {
      setAt(new Date().toISOString())
      onRefs(data.rows.filter((r) => r.kind === 'user').map((r) => r.ref))
    }
  }, [data, onRefs])

  const sortBy = (id: PeopleSort) => setS((cur) => ({ ...cur, sort: id, dir: cur.sort === id && cur.dir === 'desc' ? 'asc' : 'desc', page: 0 }))
  const aria = (id: PeopleSort) => (s.sort === id ? (s.dir === 'desc' ? 'descending' : 'ascending') : 'none')
  const arrow = (id: PeopleSort) => (s.sort === id ? (s.dir === 'desc' ? ' ↓' : ' ↑') : '')
  const rows = data?.rows ?? []
  const from = (data?.page ?? 0) * (data?.pageSize ?? 20)
  const SortTh = ({ id, className }: { id: PeopleSort; className?: string }) => (
    <th scope="col" aria-sort={aria(id)} className={cn('px-2 py-2 font-medium', className)}>
      <button type="button" className={cn('inline-flex min-h-8 items-center font-medium underline-offset-2 hover:underline', s.sort === id ? 'text-ink' : 'text-muted')} onClick={() => sortBy(id)} data-testid={`sort-${id}`}>
        {SORTS.find((x) => x.id === id)!.label}
        {arrow(id)}
      </button>
    </th>
  )

  return (
    <Card title="People" note={data ? `${data.totalBy.human} human, ${data.totalBy.owner} owner, ${data.totalBy.test} test: ${data.total} in all${s.q ? ' match the search' : ''}` : 'loading'} testId="admin-people" id="people">
      <div className="flex flex-wrap items-center gap-2">
        <label className="grid flex-1 gap-1 text-sm text-muted sm:max-w-xs">
          <span className="sr-only">Search by name</span>
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search by name"
            maxLength={40}
            data-testid="people-search"
            className="min-h-11 rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-muted"
          />
        </label>
        <div className="flex items-center gap-2 md:hidden">
          <select aria-label="Sort people" className="min-h-11 rounded-control border border-line bg-surface px-3 text-base text-ink" value={s.sort} onChange={(e) => setS((cur) => ({ ...cur, sort: e.target.value as PeopleSort, dir: 'desc', page: 0 }))}>
            {SORTS.map((x) => (
              <option key={x.id} value={x.id}>{x.label}</option>
            ))}
          </select>
          <button type="button" className={btn} onClick={() => setS((cur) => ({ ...cur, dir: cur.dir === 'desc' ? 'asc' : 'desc', page: 0 }))} aria-label={s.dir === 'desc' ? 'Descending, switch to ascending' : 'Ascending, switch to descending'}>
            {s.dir === 'desc' ? '↓' : '↑'}
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded-control bg-warn-soft p-3 text-sm text-warn-ink">
          The people list did not load. <button type="button" className="font-semibold underline" onClick={retry}>Try again</button>
        </p>
      ) : null}

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[56rem] border-collapse text-left text-sm" data-testid="people-table">
          <thead className="text-muted">
            <tr>
              <th scope="col" className="px-2 py-2 font-medium">Player</th>
              <th scope="col" className="px-2 py-2 font-medium">Type</th>
              <SortTh id="joined" />
              <SortTh id="last" />
              <SortTh id="matches" className="text-right" />
              <th scope="col" className="px-2 py-2 font-medium">Per game</th>
              {LEVELS.map((l) => (
                <th key={l} scope="col" className="px-2 py-2 text-right font-medium" title={`Wins against ${personaFor(l).name}`}>
                  <span className="inline-flex items-center gap-1.5"><Avatar level={l} size={18} decorative />{personaFor(l).name}</span>
                </th>
              ))}
              <th scope="col" className="px-2 py-2 font-medium">Board</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.ref} className="cursor-pointer border-t border-line hover:bg-surface-2" data-testid="person-row" data-ref={p.ref} onClick={() => onOpen(p)}>
                <td className="max-w-[14rem] px-2 py-2">
                  <button type="button" className="block w-full min-w-0 rounded-control text-left" onClick={(e) => { e.stopPropagation(); onOpen(p) }} aria-label={`Open ${p.name}`}>
                    <Who name={p.name} kind={p.kind} ref_={p.ref} emails={emails} />
                  </button>
                </td>
                <td className="px-2 py-2"><span className="flex flex-wrap gap-1"><TrafficTag t={p.traffic} />{p.kind === 'guest' ? <Outline>guest</Outline> : <Chip tone="bg-action text-action-ink">signed in</Chip>}</span></td>
                <td className="whitespace-nowrap px-2 py-2">{shortDate(p.joinedAt)}</td>
                <td className="whitespace-nowrap px-2 py-2">{at ? ago(p.lastSeenAt, at) : ''}</td>
                <td className="px-2 py-2 text-right tabular">{p.matches}</td>
                <td className="px-2 py-2"><PerGameChips p={p} /></td>
                {LEVELS.map((l) => (
                  <td key={l} className={cn('px-2 py-2 text-right tabular', p.winsByLevel[l] === 0 && 'text-muted')} data-testid={`wins-${l}`}>{p.winsByLevel[l]}</td>
                ))}
                <td className="px-2 py-2">{p.hidden ? <Chip tone="bg-warn-soft text-warn-ink">hidden</Chip> : <span className="text-muted">shown</span>}</td>
              </tr>
            ))}
            {data && rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-2 py-6 text-center text-muted" data-testid="people-empty">{s.q ? 'No one has that name.' : 'No players yet.'}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <ul className="grid gap-2 md:hidden" aria-label="People">
        {rows.map((p) => (
          <li key={p.ref}>
            <button type="button" className="grid w-full gap-2 rounded-control border border-line bg-surface p-3 text-left" onClick={() => onOpen(p)} data-testid="person-card" aria-label={`Open ${p.name}`}>
              <span className="flex items-start justify-between gap-2">
                <Who name={p.name} kind={p.kind} ref_={p.ref} emails={emails} />
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  <TrafficTag t={p.traffic} />
                  {p.kind === 'guest' ? <Outline>guest</Outline> : <Chip tone="bg-action text-action-ink">signed in</Chip>}
                  {p.hidden ? <Chip tone="bg-warn-soft text-warn-ink">hidden</Chip> : null}
                </span>
              </span>
              <span className="grid grid-cols-3 gap-2 text-xs text-muted">
                <span>Joined<br /><b className="text-sm font-semibold text-ink">{shortDate(p.joinedAt)}</b></span>
                <span>Last seen<br /><b className="text-sm font-semibold text-ink">{at ? ago(p.lastSeenAt, at) : ''}</b></span>
                <span>Matches<br /><b className="text-sm font-semibold text-ink tabular">{p.matches}</b></span>
              </span>
              <PerGameChips p={p} />
              <span className="grid grid-cols-4 gap-2 text-xs text-muted">
                {LEVELS.map((l) => (
                  <span key={l} className="inline-flex items-center gap-1.5"><Avatar level={l} size={18} decorative />{personaFor(l).name}<b className="text-sm font-semibold text-ink tabular">{p.winsByLevel[l]}</b></span>
                ))}
              </span>
            </button>
          </li>
        ))}
        {data && rows.length === 0 ? <li className="py-4 text-center text-muted">{s.q ? 'No one has that name.' : 'No players yet.'}</li> : null}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
        <span data-testid="people-range">{data && data.total > 0 ? `Showing ${from + 1} to ${from + rows.length} of ${data.total}` : data ? 'Nothing to show' : 'Loading'}</span>
        <span className="inline-flex gap-2">
          <button type="button" className={btn} disabled={!data || data.page === 0} onClick={() => setS((cur) => ({ ...cur, page: cur.page - 1 }))} data-testid="people-prev">Previous</button>
          <button type="button" className={btn} disabled={!data || from + data.pageSize >= data.total} onClick={() => setS((cur) => ({ ...cur, page: cur.page + 1 }))} data-testid="people-next">Next</button>
        </span>
      </div>
    </Card>
  )
}

function Feed({ o, emails, onOpen }: { o: AdminOverview; emails: Record<string, string> | null; onOpen: (f: FeedRow) => void }) {
  return (
    <Card title="Recent activity" note={`last ${o.feed.length} finished matches, everyone`} testId="admin-feed" id="activity">
      {o.feed.length === 0 ? <p className="text-muted">No finished matches yet.</p> : null}
      <ul className="max-h-[34rem] divide-y divide-line overflow-y-auto" data-testid="admin-feed-list">
        {o.feed.map((f: FeedRow) => (
          <li key={f.matchId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2.5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_5rem_9rem]" data-testid="feed-row" data-result={f.result}>
            <button type="button" className="min-w-0 rounded-control text-left" onClick={() => onOpen(f)} aria-label={`Open ${f.name}`} data-testid="feed-open"><Who name={f.name} kind={f.kind} ref_={f.ref} emails={emails} /></button>
            <span className="justify-self-end sm:order-last sm:justify-self-end text-sm text-muted">{ago(f.at, o.generatedAt)}</span>
            <span className="text-sm">{gameName(f.game)}</span>
            <span className="inline-flex items-center gap-2 text-sm"><Avatar level={f.level} size={22} decorative />{personaFor(f.level).name}</span>
            <span className="flex flex-wrap items-center gap-1 justify-self-start"><Chip tone={RESULT_TONE[f.result]!}>{f.result}</Chip><TrafficTag t={f.traffic} /></span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function CountedChips({ m }: { m: HistoryRow }) {
  return (
    <span className="flex flex-wrap gap-1">
      {m.practice ? <Outline title="Practice levels never touch the board">practice</Outline> : null}
      {m.counted ? <Chip tone="bg-good-soft text-good-ink">counted</Chip> : <Outline>not counted</Outline>}
      {m.valid === true ? <Outline>valid</Outline> : m.valid === false ? <Chip tone="bg-bad-soft text-bad-ink">invalid</Chip> : <Outline>unchecked</Outline>}
    </span>
  )
}

function PlayerSheet({ p, emails, onClose }: { p: PersonRow | FeedRow | null; emails: Record<string, string> | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const ref = p?.ref ?? null
  const { data, error, retry } = useLoad<PlayerDetail>(() => (ref ? getAdminPlayer({ data: { ref } }) : Promise.resolve(null)), [ref])
  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (ref && !d.open) d.showModal()
    if (!ref && d.open) d.close()
  }, [ref])
  const detail = data && data.ref === ref ? data : null
  const email = ref ? emails?.[ref] : undefined
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && dialog.current?.close()}
      className="m-auto max-h-[92dvh] w-[min(64rem,calc(100vw-1rem))] overflow-y-auto rounded-card border border-line bg-surface p-0 text-ink shadow-card backdrop:bg-black/40"
      aria-labelledby="player-title"
      data-testid="player-sheet"
    >
      {ref ? (
        <div className="grid gap-4 p-4 md:p-6">
          <header className="flex items-start justify-between gap-3">
            <div className="grid gap-1">
              <h2 id="player-title" className="font-display text-display-md" data-testid="player-name">{detail?.name ?? p?.name}</h2>
              <p className="font-mono text-sm text-muted">{email ?? `${(detail?.kind ?? p?.kind) === 'guest' ? 'guest' : 'account'} ${ref}`}</p>
              {detail ? (
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  <TrafficTag t={detail.traffic} />
                  {detail.kind === 'guest' ? <Outline>guest</Outline> : <Chip tone="bg-action text-action-ink">signed in</Chip>}
                  {detail.hidden ? <Chip tone="bg-warn-soft text-warn-ink">hidden from the board</Chip> : <Outline>shown on the board</Outline>}
                  <span>Joined {shortDate(detail.joinedAt)}, last seen {shortDate(detail.lastSeenAt)} {utcTime(detail.lastSeenAt)} UTC</span>
                </p>
              ) : null}
            </div>
            <button type="button" className={btn} onClick={() => dialog.current?.close()} data-testid="player-close">Close</button>
          </header>

          {error ? (
            <p role="alert" className="rounded-control bg-warn-soft p-3 text-sm text-warn-ink">
              This player did not load. <button type="button" className="font-semibold underline" onClick={retry}>Try again</button>
            </p>
          ) : null}
          {!detail && !error ? <div aria-busy="true" className="h-40 rounded-card bg-neutral-soft" /> : null}

          {detail ? (
            <>
              <section aria-labelledby="path-title" data-testid="player-path">
                <h3 id="path-title" className="mb-2 font-display text-display-sm">Path progress</h3>
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {detail.path.map((row) => {
                    const done = LEVELS.filter((l) => row.cleared[l]).length
                    return (
                      <li key={row.game} className="grid gap-2 rounded-control border border-line p-3" data-testid={`path-${row.game}`} data-cleared={done}>
                        <span className="flex items-baseline justify-between gap-2 text-sm"><b>{gameName(row.game)}</b><span className="text-muted tabular">{done} of 4</span></span>
                        <span className="grid grid-cols-4 gap-2" role="img" aria-label={`${gameName(row.game)}: ${LEVELS.map((l) => `${personaFor(l).name} ${row.cleared[l] ? 'beaten' : 'not yet'}`).join(', ')}`}>
                          {LEVELS.map((l) => (
                            <span key={l} className="grid justify-items-center gap-1 text-xs text-muted" title={`${personaFor(l).name}: ${row.cleared[l] ? 'beaten' : 'not yet'}`}>
                              <Avatar level={l} size={28} decorative dim={!row.cleared[l]} />
                              <span className={cn('h-1.5 w-full rounded-full', row.cleared[l] ? 'bg-good' : 'bg-line')} />
                            </span>
                          ))}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </section>

              <section aria-labelledby="history-title" data-testid="player-history">
                <h3 id="history-title" className="mb-2 flex flex-wrap items-baseline justify-between gap-2 font-display text-display-sm">
                  Match history
                  <span className="font-sans text-sm font-normal text-muted">{detail.matchesTotal > detail.matches.length ? `newest ${detail.matches.length} of ${detail.matchesTotal}` : `${detail.playedTotal} played${detail.matchesTotal > detail.playedTotal ? `, ${detail.matchesTotal - detail.playedTotal} in progress` : ''}`}</span>
                </h3>
                {detail.matches.length === 0 ? <p className="text-muted">No matches yet.</p> : null}
                <div className="hidden overflow-x-auto md:block">
                  {detail.matches.length ? (
                    <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
                      <thead className="text-muted">
                        <tr>{['When', 'Game', 'Level', 'Result', 'Status', 'Why invalid', ''].map((h, i) => <th key={i} scope="col" className="px-2 py-2 font-medium">{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {detail.matches.map((m) => (
                          <tr key={m.matchId} className="border-t border-line" data-testid="history-row" data-result={m.result}>
                            <td className="whitespace-nowrap px-2 py-2 tabular">{shortDate(m.at)} {utcTime(m.at)}</td>
                            <td className="px-2 py-2">{gameName(m.game)}</td>
                            <td className="px-2 py-2"><span className="inline-flex items-center gap-2"><Avatar level={m.level} size={20} decorative />{personaFor(m.level).name}</span></td>
                            <td className="px-2 py-2"><Chip tone={RESULT_TONE[m.result]!}>{m.result}</Chip></td>
                            <td className="px-2 py-2"><CountedChips m={m} /></td>
                            <td className="px-2 py-2 text-muted" data-testid="invalid-reason">{m.invalidReason ?? ''}</td>
                            <td className="px-2 py-2">{m.result !== 'in progress' ? <a className="text-action underline" href={`/report/${m.matchId}`}>Report</a> : null}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                </div>
                <ul className="grid gap-2 md:hidden">
                  {detail.matches.map((m) => (
                    <li key={m.matchId} className="grid gap-2 rounded-control border border-line p-3 text-sm" data-testid="history-card">
                      <span className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2"><Avatar level={m.level} size={22} decorative /><b>{gameName(m.game)}</b> <span className="text-muted">{personaFor(m.level).name}</span></span>
                        <Chip tone={RESULT_TONE[m.result]!}>{m.result}</Chip>
                      </span>
                      <span className="flex items-center justify-between gap-2 text-muted"><span>{shortDate(m.at)} {utcTime(m.at)} UTC</span>{m.result !== 'in progress' ? <a className="text-action underline" href={`/report/${m.matchId}`}>Report</a> : null}</span>
                      <CountedChips m={m} />
                      {m.invalidReason ? <span className="text-bad-ink">{m.invalidReason}</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : null}
        </div>
      ) : null}
    </dialog>
  )
}

/**
 * The owner's people-and-activity section: totals, the People table, the live feed and a per-player drill-down. It loads after the
 * page paints (the first screen never waits on it), refreshes every minute, and reports the account refs on screen so the page's
 * audited "Reveal emails" switch can cover them.
 */
export function AdminSection({ emails, onRefs }: { emails: Record<string, string> | null; onRefs: (refs: string[]) => void }) {
  const overview = useLoad<AdminOverview>(() => getAdminOverview(), [], REFRESH_MS)
  const [open, setOpen] = useState<PersonRow | FeedRow | null>(null)
  const peopleRefs = useRef<string[]>([])
  const feedRefs = useRef<string[]>([])
  const push = useCallback(() => onRefs([...new Set([...peopleRefs.current, ...feedRefs.current])]), [onRefs])
  const onPeopleRefs = useCallback((r: string[]) => { peopleRefs.current = r; push() }, [push])
  useEffect(() => {
    feedRefs.current = (overview.data?.feed ?? []).filter((f) => f.kind === 'user').map((f) => f.ref)
    push()
  }, [overview.data, push])
  const o = overview.data
  return (
    <section className="grid gap-4" aria-labelledby="admin-title" data-testid="admin-section">
      <div className="flex flex-wrap items-baseline justify-between gap-2 pt-4">
        <h2 id="admin-title" className="font-display text-display-md">People and activity</h2>
        <p className="text-sm text-muted">Guests and accounts, from the match store. Names only; emails stay behind the reveal switch above.</p>
      </div>
      {overview.error ? (
        <p role="alert" className="rounded-control bg-warn-soft p-3 text-sm text-warn-ink">
          The totals did not load. <button type="button" className="font-semibold underline" onClick={overview.retry}>Try again</button>
        </p>
      ) : null}
      {o ? <Totals o={o} /> : <div aria-busy="true" className="h-40 rounded-card border border-line bg-surface" data-testid="admin-loading" />}
      <People emails={emails} onRefs={onPeopleRefs} onOpen={setOpen} />
      {o ? <Feed o={o} emails={emails} onOpen={setOpen} /> : null}
      <PlayerSheet p={open} emails={emails} onClose={() => setOpen(null)} />
    </section>
  )
}
