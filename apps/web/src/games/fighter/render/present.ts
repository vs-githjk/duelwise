import { M, MOVES } from '@duelwise/core/src/games/fighter/moves.ts'
import { EV } from '@duelwise/core/src/games/fighter/state.ts'
import type { PresentEvent } from '@duelwise/core/src/netplay/events'
import type { HitKind } from './vfx'

// Fighter effects from rollback presentation events (slice 2, S6). Pure, so it is tested without WebGL. The play loop that steps the sim
// directly (the AI match, one-device friend play) keeps reading Fighter.events in FighterRenderer.onStep; a match that runs on a
// RollbackSession feeds `session.takeEvents()` through here instead, so a re-run never doubles or leaves behind a spark.

export function kindOfMove(id: number): HitKind {
  if (id === M.STAND_L || id === M.CROUCH_L || id === M.AIR_L) return 'light'
  if (id === M.STAND_M || id === M.CROUCH_M || id === M.AIR_M) return 'medium'
  if (id === M.SPARK || id === M.EMBER) return 'medium'
  return 'heavy'
}

export interface Effect {
  kind: HitKind
  /** The fighter the spark sits on. */
  seat: 0 | 1
  /** The event that asked for it, so a cancel can find the spark. */
  event: PresentEvent
}

const has = (evs: readonly PresentEvent[], frame: number, kind: number, seat: number): boolean =>
  evs.some((e) => e.op === 'fire' && e.frame === frame && e.kind === kind && e.seat === seat)

/** The sparks a batch of events asks for, in the order the AI path spawns them. Cancels are not effects (the caller drops the spark it made for them). */
export function effectsFromEvents(evs: readonly PresentEvent[]): Effect[] {
  const out: Effect[] = []
  for (const e of evs) {
    if (e.op !== 'fire') continue
    const seat = e.seat as 0 | 1
    if (e.kind === EV.HIT_TAKEN && !has(evs, e.frame, EV.THROWN, e.seat)) {
      const kind: HitKind = has(evs, e.frame, EV.COUNTER_HIT, e.seat) ? 'counter' : has(evs, e.frame, EV.PUNISH_HIT, e.seat) ? 'punish' : e.arg >= 0 ? kindOfMove(e.arg) : 'medium'
      out.push({ kind, seat, event: e })
    } else if (e.kind === EV.BLOCKED && !has(evs, e.frame, EV.DEFLECTED, 1 - e.seat)) out.push({ kind: 'block', seat, event: e })
    else if (e.kind === EV.DEFLECTED) out.push({ kind: 'deflect', seat, event: e })
    else if (e.kind === EV.THROWN) out.push({ kind: 'throw', seat, event: e })
    else if (e.kind === EV.KO) out.push({ kind: 'ko', seat, event: e })
  }
  return out
}

/** Frames of damage on the move that struck, from which the heavy hit sound is chosen (same 700 threshold as the AI path). */
export function hitIsHeavy(move: number): boolean {
  return (MOVES[move]?.damage ?? 0) >= 700
}
