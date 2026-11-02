import type { PenaltyObs } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { bestKeeper, bestShooter, DIVE_HABITS, KICK_HABITS, mix, one, predict, streamsOf, type Dist } from './habits'
import { EQ_KEEPER, EQ_SHOOTER, PENALTY_LEVELS } from './levels'

/**
 * Twelve Yards agent: four habit levels, each a small scripted reader of the opponent's last kicks.
 * Pip has one favourite side. Marlow echoes the last kick. Vesper expects a pattern. Sable weighs nine habit shapes and
 * answers the likeliest, staying near the equilibrium mix when nothing stands out.
 *
 * choosePenaltyAction is pure: the action depends on the level, the observation, the rng state and the salt, and nothing
 * is kept between calls. What an agent "knows" about a player is only the kicks inside this one match.
 */

function pick(d: readonly number[], rng: Rng): 0 | 1 | 2 {
  let r = rng.float()
  for (let i = 0; i < 3; i++) {
    r -= d[i]!
    if (r < 0) return i as 0 | 1 | 2
  }
  return 2
}

/** Integer hash so the salt's low bits are not the seed's low bits. */
function hashSalt(salt: number): number {
  let x = salt | 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

/** A favourite side (0 or 2) per role, from the salt alone. */
function favourites(salt: number): { shoot: 0 | 2; dive: 0 | 2 } {
  const h = hashSalt(salt)
  return { shoot: h & 1 ? 2 : 0, dive: h & 2 ? 2 : 0 }
}

function distFor(level: Level, obs: PenaltyObs, salt: number): Dist {
  const cfg = PENALTY_LEVELS[level]
  const shooter = obs.role === 'shooter'
  const eq = shooter ? EQ_SHOOTER : EQ_KEEPER
  const s = streamsOf(obs.kicks)
  const fav = favourites(salt)
  switch (cfg.kind) {
    case 'pip': {
      const f = shooter ? fav.shoot : fav.dive
      const d: Dist = [0, 0, 0]
      d[f] = cfg.favourite
      d[2 - f] = 1 - cfg.favourite
      return d
    }
    case 'marlow': {
      if (shooter) {
        // Goes away from the side the keeper dived to most; the first kick is the favourite side.
        if (!s.oppDives.length) return one(fav.shoot)
        const cnt = [0, 0, 0]
        for (const z of s.oppDives) cnt[z]!++
        const away = cnt[0]! > cnt[2]! ? 2 : cnt[2]! > cnt[0]! ? 0 : fav.shoot
        return mix(one(away), eq, cfg.read)
      }
      if (!s.oppKicks.length) return [...EQ_KEEPER]
      return mix(one(s.oppKicks[s.oppKicks.length - 1]!), eq, cfg.read)
    }
    case 'vesper': {
      if (shooter) {
        // Swaps sides every kick: strong, and predictable on purpose.
        if (!s.myKicks.length) return one(fav.shoot)
        const last = s.myKicks[s.myKicks.length - 1]!
        return mix(one(last === 0 ? 2 : last === 2 ? 0 : fav.shoot), eq, cfg.read)
      }
      if (!s.oppKicks.length) return [...EQ_KEEPER]
      const recent = s.oppKicks.slice(-3)
      const cnt = [0, 0, 0]
      for (const z of recent) cnt[z]!++
      const common = cnt.indexOf(Math.max(...cnt))
      const n = s.oppKicks.length
      const pred = n >= 2 && s.oppKicks[n - 1] !== s.oppKicks[n - 2] ? s.oppKicks[n - 2]! : common
      return mix(one(pred), eq, cfg.read)
    }
    case 'sable': {
      const { out, eqP } = shooter ? predict(DIVE_HABITS, s.oppDives, s.myKicks) : predict(KICK_HABITS, s.oppKicks, s.myDives)
      const conf = Math.min(1, (1 - eqP) * cfg.weight)
      return mix(shooter ? bestShooter(out, fav.shoot) : bestKeeper(out, fav.dive), eq, conf)
    }
  }
}

/** The zone (0 left, 1 middle, 2 right) this level picks now. Reads only `obs`; draws from `rng`; `salt` fixes the favourite sides of Pip, Marlow and Vesper, and breaks Sable's left/right ties. */
export function choosePenaltyAction(level: Level, obs: PenaltyObs, rng: Rng, salt: number): 0 | 1 | 2 {
  if (obs.role === null) throw new Error('penalty: no action once the shootout is over')
  return pick(distFor(level, obs, salt), rng)
}

/** Matches the factory signature in agent-dispatch.ts: (level, opts) => Promise<PreviewAgent>. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const seat = opts.seat ?? 1
  let rng: Rng = makeRng(0)
  let salt = 0
  return {
    // false: this agent is final, not a stand-in for one that is still being trained.
    preview: false,
    reset(seed) {
      // Mixing in the seat keeps two agents of the same level from drawing the same numbers or picking the same favourites.
      const mixed = (seed ^ Math.imul(seat + 1, 0x9e3779b1)) | 0
      rng = makeRng(mixed)
      salt = Math.imul(mixed ^ 0x5bd1e995, 0x85ebca6b) | 0
    },
    async act(obs) {
      return [choosePenaltyAction(level, obs as PenaltyObs, rng, salt)]
    },
    dispose() {},
  }
}
