import type { RecentRow } from '../../server/telemetry-stats'

/** m:ss, or a dash when there is no value. */
export function clock(ms: number | null): string {
  if (ms === null) return '-'
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "just now", "9 min ago", "3 h ago", "2 d ago" from the server clock, so the server and browser agree. */
export function ago(iso: string, nowIso: string): string {
  const m = Math.max(0, Math.round((new Date(nowIso).getTime() - new Date(iso).getTime()) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`
  return `${Math.round(m / 1440)} d ago`
}

/** HH:MM in UTC. */
export function utcTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

const PROVIDER: Record<string, string> = { google: 'Google', github: 'GitHub', credential: 'Email' }
export const providerName = (p: string | null): string => (p ? (PROVIDER[p] ?? p) : 'Guest')
export const DEVICE_NAME: Record<string, string> = { desktop: 'Desktop', phone: 'Phone', tablet: 'Tablet', unknown: 'Unknown' }

const cell = (v: string | number | null) => {
  const s = v === null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The recent-matches rows as CSV: ids only, never an email. */
export function recentCsv(rows: RecentRow[]): string {
  const head = ['when_utc', 'match_id', 'player', 'game', 'level', 'opponent', 'result', 'length_seconds', 'device', 'training']
  const lines = rows.map((r) => [r.at, r.matchId, r.player, r.game, r.level, r.persona, r.result, r.durationMs === null ? null : Math.round(r.durationMs / 1000), r.device, r.training].map(cell).join(','))
  return [head.join(','), ...lines].join('\n') + '\n'
}
