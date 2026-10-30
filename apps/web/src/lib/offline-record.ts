import type { GameId } from '@duelwise/core/src/product'
import type { Result, Seat } from '@duelwise/core/src/types'

/**
 * The player's own tally of matches played with no server and no ticket (so unranked): wins, losses and draws per game,
 * kept in this browser only. It never reaches a leaderboard or a rating.
 */
export interface OfflineTally { wins: number; losses: number; draws: number }

const KEY = 'duelwise.offline-record'

export interface TallyStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

function defaultStore(): TallyStore | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined }
}

function readAll(store: TallyStore | undefined): Partial<Record<GameId, OfflineTally>> {
  try { return store ? (JSON.parse(store.getItem(KEY) ?? '{}') as Partial<Record<GameId, OfflineTally>>) : {} } catch { return {} }
}

export function offlineTally(game: GameId, store: TallyStore | undefined = defaultStore()): OfflineTally {
  const t = readAll(store)[game]
  return { wins: t?.wins ?? 0, losses: t?.losses ?? 0, draws: t?.draws ?? 0 }
}

/** Adds one finished unranked offline match to the player's own tally and returns the new tally. */
export function recordOffline(game: GameId, result: Result, humanSeat: Seat, store: TallyStore | undefined = defaultStore()): OfflineTally {
  const all = readAll(store)
  const t = offlineTally(game, store)
  if (result.winner === null) t.draws++
  else if (result.winner === humanSeat) t.wins++
  else t.losses++
  try { store?.setItem(KEY, JSON.stringify({ ...all, [game]: t })) } catch { /* storage blocked: the match just is not tallied */ }
  return t
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** One calm sentence about the tally, for the result panel. */
export function tallyLine(t: OfflineTally): string {
  return `Your offline record on this device: ${plural(t.wins, 'win', 'wins')}, ${plural(t.losses, 'loss', 'losses')}, ${plural(t.draws, 'draw', 'draws')}.`
}
