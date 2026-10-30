import { PRODUCT } from '@duelwise/core/src/product'
import type { OwnerView, PlayerRow, RecentRow } from '../../server/telemetry-stats'
import { Avatar } from '../../personas/Avatar'
import { shortDate } from '../charts/format'
import { cn } from '../../lib/cn'
import { Card } from './Card'
import { DEVICE_NAME, ago, clock, providerName, utcTime } from './format'

const RESULT_TONE: Record<RecentRow['result'], string> = {
  Human: 'bg-good-soft text-good-ink',
  AI: 'bg-neutral-soft text-neutral-ink',
  Draw: 'bg-neutral-soft text-neutral-ink',
  Abandoned: 'bg-warn-soft text-warn-ink',
  Resigned: 'bg-warn-soft text-warn-ink',
  Rejected: 'bg-bad-soft text-bad-ink',
  'In progress': 'bg-action-soft text-action-ink',
}
const Chip = ({ tone, children }: { tone: string; children: string }) => <span className={cn('inline-flex h-6 items-center rounded-full px-2 text-xs font-semibold', tone)}>{children}</span>
const Outline = ({ children }: { children: string }) => <span className="inline-flex h-6 items-center rounded-full border border-line px-2 text-xs text-muted">{children}</span>

/** The player cell: the id, or the email once the owner has revealed it. */
export function PlayerCell({ player, kind, emails }: { player: string; kind: string; emails: Record<string, string> | null }) {
  const email = emails?.[player]
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="font-mono text-sm" data-testid="player-id">{email ?? (kind === 'guest' ? `guest ${player}` : player)}</span>
    </span>
  )
}

export function RecentPanel({
  v,
  emails,
  onPage,
  onCsv,
}: {
  v: OwnerView
  emails: Record<string, string> | null
  onPage: (page: number) => void
  onCsv: () => void
}) {
  const { recent } = v
  const from = recent.page * recent.pageSize
  return (
    <Card title="Recent matches" note={`newest first, ${recent.total} in this period`} testId="owner-recent">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
          <thead className="text-muted">
            <tr>
              {['When', 'Player', 'Game', 'Opponent', 'Result', 'Length', 'Device', 'Training', ''].map((h, i) => (
                <th key={i} scope="col" className="px-2 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recent.rows.map((r) => (
              <tr key={r.matchId} className="border-t border-line" data-testid="recent-row" data-result={r.result}>
                <td className="px-2 py-2 tabular">{utcTime(r.at)}</td>
                <td className="px-2 py-2">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <PlayerCell player={r.player} kind={r.playerKind} emails={emails} />
                    {r.optedOut ? <Outline>opted out</Outline> : r.isNew ? <Outline>new</Outline> : <Outline>returning</Outline>}
                  </span>
                </td>
                <td className="px-2 py-2">{PRODUCT.games[r.game].displayName}</td>
                <td className="px-2 py-2">
                  <span className="inline-flex items-center gap-2">
                    <Avatar level={r.level} size={22} decorative />
                    {r.persona}
                  </span>
                </td>
                <td className="px-2 py-2"><Chip tone={RESULT_TONE[r.result]}>{r.result}</Chip></td>
                <td className="px-2 py-2 tabular">{clock(r.durationMs)}</td>
                <td className="px-2 py-2">{DEVICE_NAME[r.device] ?? r.device}</td>
                <td className="px-2 py-2">{r.training}</td>
                <td className="px-2 py-2"><a className="text-action underline" href={r.report}>Report</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
        <span>
          {recent.total === 0 ? 'No matches in this period' : `Showing ${from + 1} to ${from + recent.rows.length} of ${recent.total}`}
        </span>
        <span className="inline-flex gap-2">
          <button type="button" className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold text-ink disabled:opacity-50" disabled={recent.page === 0} onClick={() => onPage(recent.page - 1)}>
            Newer
          </button>
          <button type="button" className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold text-ink disabled:opacity-50" disabled={from + recent.pageSize >= recent.total} onClick={() => onPage(recent.page + 1)}>
            Older
          </button>
          <button type="button" className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold text-ink" onClick={onCsv} data-testid="owner-csv">
            CSV of these rows
          </button>
        </span>
      </div>
    </Card>
  )
}

function PlayerRowView({ p, emails, now }: { p: PlayerRow; emails: Record<string, string> | null; now: string }) {
  return (
    <tr className="border-t border-line" data-testid="player-row">
      <td className="px-2 py-2"><PlayerCell player={p.player} kind={p.playerKind} emails={emails} /></td>
      <td className="px-2 py-2">{providerName(p.provider)}</td>
      <td className="px-2 py-2">{shortDate(p.firstSeen)}</td>
      <td className="px-2 py-2">{ago(p.lastSeen, now)}</td>
      <td className="px-2 py-2 text-right tabular">{p.matches}</td>
      <td className="px-2 py-2">{p.games.map((g) => PRODUCT.games[g].displayName).join(', ')}</td>
      <td className="px-2 py-2 text-right tabular">{p.wins} to {p.losses}</td>
      <td className="px-2 py-2">{p.training === 'on' ? <Chip tone="bg-good-soft text-good-ink">on</Chip> : <Chip tone="bg-neutral-soft text-neutral-ink">opted out</Chip>}</td>
      <td className="px-2 py-2 text-right">{p.bestBeaten ?? 'none yet'}</td>
    </tr>
  )
}

export function WhoPlayedPanel({ v, emails }: { v: OwnerView; emails: Record<string, string> | null }) {
  return (
    <Card title="Who played" note={`${v.playersTotal} ${v.playersTotal === 1 ? 'player' : 'players'} in this period`} testId="owner-who">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
          <thead className="text-muted">
            <tr>
              {['Player', 'Signed in with', 'First seen', 'Last seen', 'Matches', 'Games', 'Record vs AI', 'Training', 'Best beaten'].map((h) => (
                <th key={h} scope="col" className={cn('px-2 py-2 font-medium', h === 'Matches' || h === 'Record vs AI' || h === 'Best beaten' ? 'text-right' : '')}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.whoPlayed.map((p) => (
              <PlayerRowView key={p.player} p={p} emails={emails} now={v.generatedAt} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
