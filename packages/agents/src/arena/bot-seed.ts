import { ARENA_BOT_KINDS, type BotKind } from '@duelwise/core/src/games/arena/bots'

export function arenaBotSeed(seed: number, seat: 0 | 1, kind: BotKind): number {
  return ((seed + 104729 * (seat + 1)) >>> 0) + ARENA_BOT_KINDS.indexOf(kind)
}
