import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import { stepPacked } from '@duelwise/core/src/games/fighter/core'
import { agentInputLagFor } from '@duelwise/core/src/games/fighter/constants'
import { DIR, packInput, unpackInput } from '@duelwise/core/src/games/fighter/input'
import { createState, PHASE } from '@duelwise/core/src/games/fighter/state'
import { createGameAgent } from '../fighter/agent'
import { InputLag, seatView, viewDue } from '../fighter/view'

// Treat gaps over 300 world units as beyond close and midrange for this probe.
export const MIDRANGE = 300
export type Trace = { frame: number; gap: number; dir: number; btn: number; input: number[]; refused: boolean }
export async function behavior(level: Level, opponent: 'passive' | 'hold-back', seed: number, log = false, seat: 0 | 1 = 0) {
  let decision = { frame: -1, dir: 0, btn: 0, input: [0, 0], refused: false }
  const agent = await createGameAgent(level, { seat, onDecision: t => { decision = t } })
  agent.reset(seed)
  const s = createState(seed), lag = new InputLag()
  let anchor = -1, idle = 0, longestIdle = 0, attack = 0, longestAttack = 0, previous = 0
  let longFrames = 0, neutralFrames = 0, refused = 0, decisions = 0, attackPresses = 0
  let pressRun = 0, longestPressRun = 0, previousPress = 0
  const pressCounts = Array(7).fill(0) as number[]
  const attacks = Array(7).fill(0) as number[]
  try {
    while (!s.matchOver && s.frame < 60 * 60 * 6) {
      if (s.phase === PHASE.FIGHT) {
        if (anchor < 0) anchor = s.frame
        const due = viewDue(s.frame, anchor, LEVEL_LIMITS.fighter[level].delayFrames)
        if (due.capture || due.decide) {
          const input = await agent.act(seatView(s, seat), { frame: s.frame, anchor })
          if (due.decide) {
            lag.decide(s.frame, packInput({ dir: input[0]!, btn: input[1]! }), agentInputLagFor(seed))
            decisions++
            if (decision.refused) refused++
          }
        }
        const gap = Math.abs(s.fighters[1].pos.x - s.fighters[0].pos.x)
        const input = unpackInput(lag.at(s.frame))
        if (gap > MIDRANGE) {
          longFrames++
          if (input.dir === 0 && input.btn === 0) { idle++; neutralFrames++ } else idle = 0
          longestIdle = Math.max(longestIdle, idle)
        } else idle = 0
        if (input.btn > 0 && input.btn !== previous) {
          attackPresses++
          pressCounts[input.btn]++
          pressRun = previousPress === input.btn ? pressRun + 1 : 1
          previousPress = input.btn
          longestPressRun = Math.max(longestPressRun, pressRun)
        }
        if (input.btn > 0) {
          attacks[input.btn]++
          attack = input.btn === previous ? attack + 1 : 1
          longestAttack = Math.max(longestAttack, attack)
        } else attack = 0
        previous = input.btn
        if (log) console.log(JSON.stringify({ frame: s.frame, gap, decisionFrame: decision.frame, policy: [decision.dir, decision.btn], input: decision.input, refused: decision.refused, applied: input }))
        const back = s.fighters[1].pos.x >= s.fighters[0].pos.x ? DIR.R : DIR.L
        const botInput = opponent === 'passive' ? 0 : packInput({ dir: seat === 0 ? back : (back === DIR.R ? DIR.L : DIR.R), btn: 0 })
        stepPacked(s, seat === 0 ? lag.at(s.frame) : botInput, seat === 0 ? botInput : lag.at(s.frame))
      } else { anchor = -1; idle = 0; attack = 0; stepPacked(s, 0, 0) }
    }
  } finally { agent.dispose() }
  const total = attacks.reduce((a, b) => a + b, 0)
  return { level, opponent, seed, seat, frames: s.frame, longFrames, neutralFrames, longestIdle, longestHeldAttack: longestAttack, heldTopActionShare: total ? Math.max(...attacks) / total : 0, attackPresses, longestPressRun, pressTopActionShare: attackPresses ? Math.max(...pressCounts) / attackPresses : 0, refused, decisions }
}

if (import.meta.main) {
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const)
    for (const bot of ['passive', 'hold-back'] as const)
      for (let seed = 7000; seed < 7004; seed++) console.log(JSON.stringify(await behavior(level, bot, seed, process.argv.includes('--trace'))))
}
