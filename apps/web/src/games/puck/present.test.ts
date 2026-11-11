import { describe, expect, test } from 'bun:test'
import { puckCore, stepState } from '@duelwise/core/src/games/puck/core'
import { cloneState, createState, type PuckState } from '@duelwise/core/src/games/puck/state'
import { collectFrame, type FrameEvent, type PresentEvent } from '@duelwise/core/src/netplay/events'
import { NETPLAY_CORES } from '@duelwise/core/src/netplay/session'
import { NET_VECTORS, vectorCodes } from '@duelwise/core/src/netplay/vectors'
import { cuesForTick, cuesFromEvents, snapOf, type CueReq } from './sounds'

// S6: the cues rollback presentation events ask for equal, frame for frame, what the AI path's cuesForTick gives for the same step.

const nc = NETPLAY_CORES.puck

describe('puck cues from presentation events', () => {
  for (const human of [0, 1] as const) {
    test(`equal cuesForTick on every frame of all three input logs, seat ${human}`, () => {
      const kinds = new Set<string>()
      for (const v of NET_VECTORS.filter((x) => x.game === 'puck')) {
        const codes = vectorCodes(v)
        const s = createState(v.seed, { limits: [null, null] })
        let prev = cloneState(s)
        const buf: FrameEvent[] = []
        for (let f = 0; f < v.frames && s.matchOver === 0; f++) {
          const snap = snapOf(s)
          nc.copyState(prev, s)
          stepState(s, [codes[0][f]!, codes[1][f]!])
          collectFrame(nc, prev, s, buf)
          const evs: PresentEvent[] = buf.map((e) => ({ op: 'fire', frame: f, ...e, final: false }))
          const got = cuesFromEvents(evs, human)
          const want = cuesForTick(snap, s as PuckState, human)
          expect(got.map((c) => c.cue)).toEqual(want.map((c) => c.cue))
          got.forEach((c: CueReq, i) => {
            expect(c.delayMs).toBe(want[i]!.delayMs)
            expect(c.gain).toBeCloseTo(want[i]!.gain, 2)
            kinds.add(c.cue)
          })
        }
        prev = s
      }
      // Hits, rail knocks, serves and goals all happened in the logs.
      for (const k of ['hit', 'wall', 'serve'] as const) expect(kinds.has(k)).toBe(true)
      expect(kinds.has(human === 0 ? 'goalYou' : 'goalThem') || kinds.has(human === 0 ? 'goalThem' : 'goalYou')).toBe(true)
    })
  }

  test('a cancelled event makes no sound', () => {
    const e: PresentEvent = { op: 'cancel', frame: 4, kind: 1 << 22, seat: 0, arg: 800, final: false }
    expect(cuesFromEvents([e], 0)).toEqual([])
    expect(cuesFromEvents([{ ...e, op: 'fire' }], 0).map((c) => c.cue)).toEqual(['hit'])
  })

  test('puckCore is the sim these events read (sanity)', () => {
    expect(puckCore.id).toBe('puck')
  })
})
