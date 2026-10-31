import type { MatchRecordV1 } from './match-record'
import { PRODUCT } from './product'
import type { GameCore, Result } from './types'
import { getCore } from './games/index'

export interface ReplayOptions {
  /** Inject a core (tests); default is getCore(record.game). */
  core?: GameCore<any, any, any>
  /** Steps allowed before giving up (a realtime sim that never ends). Default 1,000,000. */
  maxTicks?: number
}

export interface ReplayOutcome {
  ok: boolean
  finalHash: string
  result: Result | null
  error?: string
}

const sameResult = (a: Result, b: Result): boolean =>
  a.winner === b.winner && a.reason === b.reason && a.score[0] === b.score[0] && a.score[1] === b.score[1]

/**
 * Re-runs a record from its seed and checks that the recorded result and final hash are what
 * the core produces. Turn-based games: tick is the step index and every seat that is to act
 * needs an action at its tick. Realtime games: an entry changes that seat's held input from
 * its tick onward, and the sim runs on until it is terminal. Never throws.
 */
export function replay(r: MatchRecordV1, opts: ReplayOptions = {}): ReplayOutcome {
  let finalHash = ''
  let result: Result | null = null
  const bad = (error: string): ReplayOutcome => ({ ok: false, finalHash, result, error })
  try {
    const core = opts.core ?? getCore(r.game)
    if (core.id !== r.game) return bad(`record is for ${r.game} but the core is ${core.id}`)
    if (core.version !== r.coreVersion) return bad(`core version mismatch: record ${r.coreVersion}, core ${core.version}`)
    const maxTicks = opts.maxTicks ?? 1_000_000
    const realtime = PRODUCT.games[core.id].kind === 'realtime'
    const acts = r.actions

    for (let k = 1; k < acts.length; k++) {
      if (acts[k]![0] < acts[k - 1]![0]) return bad(`actions out of order at entry ${k}`)
    }

    let s = core.init(r.seed, r.options)
    const held: [number | null, number | null] = [null, null]
    let i = 0
    let tick = 0
    while (!core.terminal(s)) {
      if (tick >= maxTicks) return bad(`exceeded ${maxTicks} ticks without a terminal state`)
      const cur: [number | null, number | null] = [null, null]
      while (i < acts.length && acts[i]![0] === tick) {
        const [, seat, a] = acts[i]!
        if (cur[seat] !== null) return bad(`two actions for seat ${seat} at tick ${tick}`)
        cur[seat] = a
        i++
      }
      let step: [unknown, unknown]
      if (realtime) {
        if (cur[0] !== null) held[0] = cur[0]
        if (cur[1] !== null) held[1] = cur[1]
        step = [held[0] === null ? null : core.decodeAction(held[0]), held[1] === null ? null : core.decodeAction(held[1])]
      } else {
        const toAct = core.toAct(s)
        if (toAct.length > 0 && i >= acts.length && cur[0] === null && cur[1] === null) return bad(`record ends before the game finished (tick ${tick})`)
        for (const seat of [0, 1] as const) {
          if (cur[seat] !== null && !toAct.includes(seat)) return bad(`seat ${seat} is not to act at tick ${tick}`)
        }
        const out: [unknown, unknown] = [null, null]
        for (const seat of toAct) {
          const n = cur[seat]
          if (n === null) return bad(`missing action for seat ${seat} at tick ${tick}`)
          const legal = core.legal(s, seat)
          const chosen = legal.find((l) => core.encodeAction(l) === n)
          if (chosen === undefined) return bad(`illegal action ${n} for seat ${seat} at tick ${tick}`)
          out[seat] = chosen
        }
        step = out
      }
      s = core.step(s, step as [any, any])
      tick++
    }
    finalHash = core.hash(s)
    result = core.result(s)
    if (i < acts.length) return bad(`${acts.length - i} actions after the game ended (first at tick ${acts[i]![0]})`)
    if (result === null) return bad('terminal state has no result')
    if (!sameResult(result, r.result)) return bad(`result mismatch: replay gave ${JSON.stringify(result)}, record says ${JSON.stringify(r.result)}`)
    if (finalHash !== r.finalHash) return bad(`final hash mismatch: replay gave ${finalHash}, record says ${r.finalHash}`)
    return { ok: true, finalHash, result }
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e))
  }
}
