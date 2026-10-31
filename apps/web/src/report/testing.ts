import { encodeRecord, type MatchRecordV1 } from '@duelwise/core/src/match-record'
import { getCore } from '@duelwise/core/src/games/index'
import { makeRng } from '@duelwise/core/src/rng'
import type { GameId } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'

/** Plays a whole turn-based game on the real core with random legal actions (tests only). */
export function playRandom(game: GameId, seed: number, humanSeat: Seat = 0, level: MatchRecordV1['agent']['level'] = 'medium', options?: MatchRecordV1['options']): MatchRecordV1 {
  const core = getCore(game)
  const rng = makeRng(seed ^ 0x51ed)
  let s = core.init(seed, options)
  const actions: MatchRecordV1['actions'] = []
  for (let tick = 0; !core.terminal(s); tick++) {
    const step: [unknown, unknown] = [null, null]
    for (const seat of core.toAct(s)) {
      const legal = core.legal(s, seat)
      const a = legal[rng.int(legal.length)]
      actions.push([tick, seat, core.encodeAction(a)])
      step[seat] = a
    }
    s = core.step(s, step as never)
  }
  return { ...record(game, seed, humanSeat, level, actions, core.result(s)!, core.hash(s)), ...(options ? { options } : {}) }
}

/** Plays the given moves (in the game's own action type) in order, from seat 0 on. Turn-based single-mover games only. */
export function playScript(
  game: GameId,
  seed: number,
  moves: unknown[],
  humanSeat: Seat = 0,
  level: MatchRecordV1['agent']['level'] = 'medium',
  /** Ends an unfinished script as a loss for seat 0 by resignation (the report only reads the record). */
  resign = false,
): MatchRecordV1 {
  const core = getCore(game)
  let s = core.init(seed)
  const actions: MatchRecordV1['actions'] = []
  moves.forEach((a, tick) => {
    const seat = core.toAct(s)[0]!
    actions.push([tick, seat, core.encodeAction(a)])
    s = core.step(s, (seat === 0 ? [a, null] : [null, a]) as never)
  })
  if (!core.terminal(s)) {
    if (!resign) throw new Error('script does not finish the game')
    return record(game, seed, humanSeat, level, actions, { winner: 1, score: [0, 1], reason: 'resigned' }, core.hash(s))
  }
  return record(game, seed, humanSeat, level, actions, core.result(s)!, core.hash(s))
}

function record(game: GameId, seed: number, humanSeat: Seat, level: MatchRecordV1['agent']['level'], actions: MatchRecordV1['actions'], result: MatchRecordV1['result'], finalHash: string): MatchRecordV1 {
  return {
    schema: 1,
    matchId: `t-${game}-${seed}`,
    game,
    coreVersion: getCore(game).version,
    agent: { version: 'v1', level },
    seed,
    humanSeat,
    actions,
    result,
    finalHash,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:09:40.000Z',
    device: 'desktop',
    input: 'mouse',
    trainingAllowed: true,
  }
}

export const gzipped = (r: MatchRecordV1): Uint8Array => encodeRecord(r)

/**
 * Plays a whole real-time match on the real core: both seats change their held input every `every` ticks to a random one
 * (tests only). Slow games finish in a few seconds because the sim is headless.
 */
export function playRealtime(game: 'fighter' | 'arena', seed: number, humanSeat: Seat = 0, level: MatchRecordV1['agent']['level'] = 'medium', every = 12): MatchRecordV1 {
  const core = getCore(game) as unknown as { init(seed: number): never; step(s: never, a: [unknown, unknown]): never; terminal(s: never): boolean; result(s: never): MatchRecordV1['result']; hash(s: never): string; encodeAction(a: unknown): number; decodeAction(n: number): unknown }
  const rng = makeRng(seed ^ 0x7e57)
  const pick = (): number =>
    game === 'fighter' ? rng.int(63) : core.encodeAction({ move: rng.int(9), walk: 0, crouch: 0, jump: rng.int(2), fire: rng.int(2), reload: 0, yaw: rng.int(21) - 10, pitch: 0, buy: 0 })
  let s = core.init(seed)
  const held: [number | null, number | null] = [null, null]
  const actions: MatchRecordV1['actions'] = []
  for (let tick = 0; !core.terminal(s); tick++) {
    if (tick % every === 0 || tick === 0) {
      for (const seat of [0, 1] as const) {
        const a = pick()
        actions.push([tick, seat, a])
        held[seat] = a
      }
    }
    s = core.step(s, [held[0] === null ? null : core.decodeAction(held[0]), held[1] === null ? null : core.decodeAction(held[1])])
  }
  return record(game, seed, humanSeat, level, actions, core.result(s), core.hash(s))
}
