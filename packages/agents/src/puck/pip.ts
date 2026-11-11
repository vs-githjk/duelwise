import { createBot, type PuckBotKind } from '@duelwise/core/src/games/puck/bots'
import { puckCore, type PuckObs } from '@duelwise/core/src/games/puck/core'
import { GRID, LEVEL_MALLET, NO_INPUT } from '@duelwise/core/src/games/puck/constants'
import { FRAME_SKIP, noise } from '@duelwise/core/src/games/puck/encode'
import { unitToCell } from '@duelwise/core/src/games/puck/input'
import { createState } from '@duelwise/core/src/games/puck/state'
import { DelayedStates, HumanLimiter, LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { GameCore } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'

// Pip, the Easy opponent of air hockey, is a hand-written script and not a trained network; the level card and the
// registry say so. The script is `pip` in core's puck/bots.ts. This file wraps any scripted puck bot as an agent that
// plays under a level's hands exactly as the training env gives them to a bot: it reads a puck view that is
// `delayFrames` old (its own mallet stays live), decides every FRAME_SKIP frames, adds the level's target noise, and holds
// a target for the level's minimum hold. Mallet speed and acceleration are the core's job (puckCoreAt).

function blank(): PuckObs {
  return { puck: [0, 0, 0, 0], me: [0, 0, 0, 0], them: [0, 0, 0, 0], score: [0, 0], phase: 0, serveToMe: 0, possession: 0, frame: 0 }
}

function copyObs(to: PuckObs, from: PuckObs): void {
  for (let i = 0; i < 4; i++) {
    to.puck[i] = from.puck[i]!
    to.me[i] = from.me[i]!
    to.them[i] = from.them[i]!
  }
  to.score[0] = from.score[0]
  to.score[1] = from.score[1]
  to.phase = from.phase
  to.serveToMe = from.serveToMe
  to.possession = from.possession
  to.frame = from.frame
}

/**
 * The puck core with the mallet limits of the two seats' levels, for the harness (it calls `core.init(seed)` with no
 * options). The agent supplies delay, noise and hold; the core supplies speed and acceleration.
 */
export function puckCoreAt(seat0: Level, seat1: Level): GameCore<any, any, any> {
  const limits = [LEVEL_MALLET[seat0], LEVEL_MALLET[seat1]] as const
  return { ...puckCore, init: (seed: number) => createState(seed, { limits: [limits[0], limits[1]] }) }
}

/** A scripted puck bot played as an agent under `level`'s hands. The answer is one encoded target (or NO_INPUT to hold). */
export async function createBotAgent(kind: PuckBotKind, level: Level, opts: AgentOpts & { delayFrames?: number; noiseSd?: number; onView?: (frame: number, viewFrame: number) => void } = {}): Promise<PreviewAgent> {
  const seat = opts.seat ?? 1
  const cfg = LEVEL_LIMITS.puck[level]
  // noiseSd lets a people-panel test player keep its own frozen noise instead of the level's.
  const sd = opts.noiseSd ?? LEVEL_MALLET[level].targetNoise
  // delayFrames lets the measurement play a bot at a level's hands with a different reaction time (0: the live game, the Champion gate's bots).
  const history = new DelayedStates<PuckObs>(opts.delayFrames ?? cfg.delayFrames, blank, copyObs)
  const view = blank()
  let limiter = new HumanLimiter(cfg, makeRng(0))
  let noiseRng = makeRng(0)
  let bot = createBot(kind, 0)
  let disposed = false

  return {
    // The script is not a trained model and has not been through the publish gate yet.
    preview: true,
    reset(seed, seatNow) {
      const k = seatNow ?? seat
      limiter = new HumanLimiter(cfg, makeRng((seed + 7919 * (k + 1)) >>> 0))
      noiseRng = makeRng((seed + 15485863 * (k + 1)) >>> 0)
      bot = createBot(kind, (seed + 104729 * (k + 1)) >>> 0)
      history.clear()
    },
    async act(obs) {
      if (disposed) throw new Error('agent disposed')
      const live = obs as PuckObs
      if (live.frame % FRAME_SKIP !== 0) return [NO_INPUT]
      history.record(live.frame, live)
      const seen = history.view(live.frame)
      opts.onView?.(live.frame, seen.frame)
      copyObs(view, seen.state)
      for (let i = 0; i < 4; i++) view.me[i] = live.me[i]!
      const t = bot.act(view)
      let ux = t[0]
      let uy = t[1]
      if (sd > 0) {
        ux += noise(noiseRng) * sd
        uy += noise(noiseRng) * sd
      }
      const code = unitToCell(ux) + GRID * unitToCell(uy)
      // The limiter's first channel is the target code plus one (0 means none yet), as in the training env.
      const held = limiter.act([code + 1, 0], live.frame)
      return [held[0] === 0 ? NO_INPUT : held[0]! - 1]
    },
    dispose() {
      disposed = true
    },
  }
}

/** The harness's module contract (`createGameAgent(level, opts)`): Easy is Pip. No other level is scripted. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  if (level !== 'easy') throw new Error(`pip: only Easy is scripted, not ${level}`)
  return createBotAgent('pip', level, opts)
}
