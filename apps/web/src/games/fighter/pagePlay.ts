import { stepPacked, fighterCore } from '@duelwise/core/src/games/fighter/core'
import { agentInputLagFor } from '@duelwise/core/src/games/fighter/constants'
import { packInput } from '@duelwise/core/src/games/fighter/input'
import { createState, PHASE } from '@duelwise/core/src/games/fighter/state'
import { makeRng } from '@duelwise/core/src/rng'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import { createGameAgent } from '@duelwise/agents/src/fighter/agent'
import { seatView, viewDue } from '@duelwise/agents/src/fighter/view'
import { AgentLink } from './agentLink'
import { KeyboardInput } from './input'

// A human at the keyboard against the agent, through the page's own path (LC1, tinderbox-r3): the script presses KeyboardInput
// keys exactly as the page's key handlers do and the sim is fed what KeyboardInput.sample() returns; the agent's answers go through the
// AgentLink the hook uses. The script reads a state 12 frames old (a person's reaction), decides every 4 frames, follows the opponent
// across the stage (it turns round when the fighters swap sides, which the offline throw loop used to be spared) and holds each tap for
// two frames, like a 35 ms key press. This is the loop the judge ran in the browser (plan/judge/tinderbox-r3.md), frame by frame.

export type PageScript = 'throw' | 'poke' | 'zone' | 'holdspecial'
export const PAGE_SCRIPTS: readonly PageScript[] = ['throw', 'poke', 'zone', 'holdspecial']

const VIEW_FRAMES = 12
const DECIDE_EVERY = 4
const TAP_HOLD = 2

interface Pos {
  frame: number
  x0: number
  x1: number
}

/**
 * One best-of-3 of `level` (the agent, seat 1) against the script (seat 0). Returns 1 when the script wins, 0.5 for a draw. `bytes`
 * overrides the served network (the canary). The agent's input lag is the page's (AgentLink) or `lag` when given.
 */
export async function playThroughPage(level: Level, script: PageScript, seed: number, opts: { bytes?: Uint8Array; lag?: number; disableActionLayer?: boolean } = {}): Promise<0 | 0.5 | 1> {
  const cfg = LEVEL_LIMITS.fighter[level]
  const agent = await createGameAgent(level, { seat: 1, modelBytes: opts.bytes, disableActionLayer: opts.disableActionLayer })
  agent.reset(seed)
  const link = new AgentLink(opts.lag ?? agentInputLagFor(seed))
  const kb = new KeyboardInput()
  const rng = makeRng((seed * 31 + 7) >>> 0)
  const s = createState(seed)
  const seen: Pos[] = []
  let anchor = -1
  let wasFighting = false
  let nextDecide = 0
  let lastTap = -99
  let specialInterval = 25
  let releaseAt = -1
  let tapKey = ''
  let frames = 0
  const tap = (key: string, frame: number) => {
    kb.down(key)
    tapKey = key
    releaseAt = frame + TAP_HOLD
  }
  try {
    while (s.matchOver === 0 && frames < 60 * 60 * 8) {
      const fighting = s.phase === PHASE.FIGHT
      if (fighting) {
        if (!wasFighting) {
          anchor = s.frame
          nextDecide = s.frame
          seen.length = 0
        }
        const due = viewDue(s.frame, anchor, cfg.delayFrames)
        if (due.capture || due.decide) {
          const q = link.ask(s.frame, due.decide)
          const a = await agent.act(seatView(s, 1), { frame: s.frame, anchor })
          link.answer(q, packInput({ dir: a[0]!, btn: a[1]! }))
        }
        seen.push({ frame: s.frame, x0: s.fighters[0].pos.x, x1: s.fighters[1].pos.x })
        if (releaseAt === s.frame) {
          kb.up(tapKey)
          releaseAt = -1
        }
        if (s.frame >= nextDecide) {
          nextDecide = s.frame + DECIDE_EVERY + (rng.int(4) === 0 ? 1 : 0)
          let v = seen[0]!
          for (const p of seen) if (p.frame <= s.frame - VIEW_FRAMES) v = p
          const dist = Math.abs(v.x1 - v.x0)
          const fwd = v.x1 > v.x0 ? 'KeyD' : 'KeyA'
          const back = fwd === 'KeyD' ? 'KeyA' : 'KeyD'
          const hold = (...keys: string[]) => {
            for (const k of ['KeyA', 'KeyD', 'KeyS']) if (!keys.includes(k)) kb.up(k)
            for (const k of keys) kb.down(k)
          }
          if (script === 'throw') {
            if (dist > 70) hold(fwd)
            else {
              hold()
              if (s.frame - lastTap >= 12) {
                lastTap = s.frame
                tap('Space', s.frame)
              }
            }
          } else if (script === 'poke') {
            if (dist > 120) hold(fwd)
            else {
              hold('KeyS')
              if (s.frame - lastTap >= 10) {
                lastTap = s.frame
                tap('KeyJ', s.frame)
              }
            }
          } else {
            hold(back)
            if (s.frame - lastTap >= (script === 'holdspecial' ? specialInterval : 40)) {
              lastTap = s.frame
              specialInterval = 20 + rng.int(11)
              tap('KeyU', s.frame)
            }
          }
        }
      } else seen.length = 0
      wasFighting = fighting
      stepPacked(s, fighting ? packInput(kb.sample()) : 0, fighting ? link.inputAt(s.frame) : 0)
      frames++
    }
  } finally {
    agent.dispose()
  }
  const result = fighterCore.result(s)
  if (result?.winner === 0) return 1
  if (result?.winner === 1) return 0
  return 0.5
}
