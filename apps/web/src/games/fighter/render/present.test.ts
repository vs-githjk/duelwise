import { describe, expect, test } from 'bun:test'
import { fighterCore } from '@duelwise/core/src/games/fighter/core'
import { counterKindFor } from './FighterRenderer'
import { hitKindFor } from './FighterRenderer'
import { EV, type FighterState } from '@duelwise/core/src/games/fighter/state'
import { collectFrame, type FrameEvent, type PresentEvent } from '@duelwise/core/src/netplay/events'
import { NETPLAY_CORES } from '@duelwise/core/src/netplay/session'
import { NET_VECTORS, vectorCodes } from '@duelwise/core/src/netplay/vectors'
import { cuesFromEvents } from '../sounds'
import { effectsFromEvents } from './present'
import type { HitKind } from './vfx'

// S6: the fighter effects asked for by rollback presentation events equal, frame for frame, what the AI path derives from the same step.

const nc = NETPLAY_CORES.fighter
const fire = (e: FrameEvent, frame: number): PresentEvent => ({ op: 'fire', frame, ...e, final: false })

/** What FighterRenderer.onStep spawns for one step (its rules, read from the exported pure helpers). */
function expectedKinds(prev: FighterState, next: FighterState): { seat: number; kind: HitKind }[] {
  const out: { seat: number; kind: HitKind }[] = []
  for (const i of [0, 1] as const) {
    const ev = next.fighters[i]!.events
    const o = next.fighters[1 - i]!
    const thrown = (ev & EV.THROWN) !== 0
    if (ev & EV.HIT_TAKEN && !thrown) out.push({ seat: i, kind: counterKindFor(prev, next, i) ?? hitKindFor(prev, next, (1 - i) as 0 | 1) })
    if (ev & EV.BLOCKED && !(o.events & EV.DEFLECTED)) out.push({ seat: i, kind: 'block' })
    if (ev & EV.DEFLECTED) out.push({ seat: i, kind: 'deflect' })
    if (thrown) out.push({ seat: i, kind: 'throw' })
    if (ev & EV.KO) out.push({ seat: i, kind: 'ko' })
  }
  return out
}

describe('fighter effects from presentation events', () => {
  test('match the AI path on every frame of two input logs, including counters, blocks, throws and KOs', () => {
    const seen = new Set<string>()
    for (const v of NET_VECTORS.filter((x) => x.game === 'fighter').slice(0, 3)) {
      const codes = vectorCodes(v)
      const s = fighterCore.init(v.seed) as FighterState
      const prev = nc.create(v.seed)
      const buf: FrameEvent[] = []
      for (let f = 0; f < v.frames && s.matchOver === 0; f++) {
        nc.copyState(prev, s)
        nc.stepCodes(s, codes[0][f]!, codes[1][f]!)
        collectFrame(nc, prev, s, buf)
        const got: { seat: number; kind: HitKind }[] = effectsFromEvents(buf.map((e) => fire(e, f)))
          .map((e) => ({ seat: e.seat, kind: e.kind }))
          .sort((a, b) => a.seat - b.seat || a.kind.localeCompare(b.kind))
        const want = expectedKinds(prev, s).sort((a, b) => a.seat - b.seat || a.kind.localeCompare(b.kind))
        expect(got).toEqual(want)
        for (const w of want) seen.add(w.kind)
      }
    }
    // The logs reach most of the hit language, so the equality above is not vacuous.
    for (const k of ['light', 'heavy', 'block', 'ko'] as const) expect(seen.has(k)).toBe(true)
    expect(seen.size).toBeGreaterThanOrEqual(5)
  })

  test('a cancelled event asks for no effect, and a hit sound is chosen by the striking move', () => {
    const hit: PresentEvent = { op: 'fire', frame: 3, kind: EV.HIT_TAKEN, seat: 1, arg: -1, final: false }
    expect(effectsFromEvents([{ ...hit, op: 'cancel' }])).toEqual([])
    expect(effectsFromEvents([hit]).map((e) => e.kind)).toEqual(['medium'])
    expect(cuesFromEvents([hit])).toEqual(['hit-light'])
    expect(cuesFromEvents([{ ...hit, op: 'cancel' }])).toEqual([])
    expect(cuesFromEvents([{ ...hit, kind: EV.BLOCKED }, { ...hit, kind: EV.KO, final: true }])).toEqual(['block', 'ko'])
  })

  test('a thrown fighter gets the throw spark, not a hit spark or a hit sound', () => {
    const base = { op: 'fire' as const, frame: 9, seat: 0, arg: 3, final: false }
    const evs: PresentEvent[] = [{ ...base, kind: EV.HIT_TAKEN }, { ...base, kind: EV.THROWN }]
    expect(effectsFromEvents(evs).map((e) => e.kind)).toEqual(['throw'])
    expect(cuesFromEvents(evs)).toEqual([])
  })
})
