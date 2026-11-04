import type { PenaltyObs } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng, Seat } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { bestKeeper, bestShooter, VESPER_SHAPES, CORNERS, COVER, DIVE_COUNT, DIVE_HABITS, floored, KICK_HABITS, mirrorDive, mirrorZone, mix, one, predict, sideOfDive, SIDE_DIVES, streamsOf, ZONE_COUNT, type Dist } from './habits'
import { EQ_KEEPER, EQ_SHOOTER, PENALTY_LEVELS, PIP_HABIT_SHARE, PIP_KEEPER, PIP_SHOOTER, VESPER_SWAP } from './levels'

/**
 * Twelve Yards agent: four habit levels, each a small scripted reader of the opponent's last kicks. Pip has one favourite corner
 * and one favourite dive. Marlow echoes the last kick. Vesper expects a pattern. Sable weighs fourteen habit shapes and answers the
 * likeliest, staying near the equilibrium mix when nothing stands out.
 *
 * choosePenaltyAction is pure: the action depends on the level, the observation, the rng state and the salt, and nothing is kept
 * between calls. What an agent "knows" about a player is only the kicks inside this one match.
 */

/** Sable's first shot or dive has nothing to read: the equilibrium, with at least 3% on every choice so no zone or dive is ruled out on that one pick. */
const OPEN_FLOOR = 0.03

function pick(d: readonly number[], rng: Rng): number {
  let r = rng.float()
  for (let i = 0; i < d.length; i++) {
    r -= d[i]!
    if (r < 0) return i
  }
  return d.length - 1
}

/** Integer hash so the salt's low bits are not the seed's low bits. */
function hashSalt(salt: number): number {
  let x = salt | 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

/** The match's favourites, from the salt alone: a corner to shoot at, a side dive, and a side (0 or 2) for left/right ties. */
function favourites(salt: number): { shoot: number; dive: number; side: 0 | 2 } {
  const h = hashSalt(salt)
  return { shoot: CORNERS[h & 3]!, dive: SIDE_DIVES[(h >>> 2) & 3]!, side: (h >>> 4) & 1 ? 2 : 0 }
}

/** The corner above or below this one (top row 0 and 2, bottom row 6 and 8). */
function otherRow(corner: number): number {
  return corner < 3 ? corner + 6 : corner - 6
}

/** Pip's kicks: a favourite corner, its mirror, a little on the other corners, the centre and the edge zones. Stateless, so nothing it saw changes it. */
function pipShooter(fav: number): Dist {
  const d = new Array<number>(ZONE_COUNT).fill(PIP_SHOOTER.edge)
  for (const c of CORNERS) d[c] = c < 3 ? PIP_SHOOTER.topCorner : PIP_SHOOTER.bottomCorner
  d[4] = PIP_SHOOTER.centre
  d[fav] = PIP_SHOOTER.favourite
  d[mirrorZone(fav)] = PIP_SHOOTER.mirror
  const sum = d.reduce((x, y) => x + y, 0)
  return d.map((x) => x / sum)
}

/** Pip's dives: a favourite side dive, its mirror, a little on the other two side dives, and the stay. */
function pipKeeper(fav: number): Dist {
  const d = new Array<number>(DIVE_COUNT).fill(PIP_KEEPER.stay)
  for (const c of SIDE_DIVES) d[c] = PIP_KEEPER.otherSide
  d[fav] = PIP_KEEPER.favourite
  d[mirrorDive(fav)] = PIP_KEEPER.mirror
  return d
}

export function levelDist(level: Level, obs: PenaltyObs, salt: number): Dist {
  const cfg = PENALTY_LEVELS[level]
  const shooter = obs.role === 'shooter'
  const eq = shooter ? EQ_SHOOTER : EQ_KEEPER
  const s = streamsOf(obs.kicks)
  const fav = favourites(salt)
  const zone = (z: number) => one(z, ZONE_COUNT)
  const dive = (d: number) => one(d, DIVE_COUNT)
  switch (cfg.kind) {
    case 'pip':
      return shooter ? mix(mix(zone(fav.shoot), zone(mirrorZone(fav.shoot)), 0.75), pipShooter(fav.shoot), PIP_HABIT_SHARE) : mix(mix(dive(fav.dive), dive(mirrorDive(fav.dive)), 0.75), pipKeeper(fav.dive), PIP_HABIT_SHARE)
    case 'marlow': {
      if (shooter) {
        // Goes away from the side the keeper dived to most, at the favourite corner's height; the first kick is the favourite.
        if (!s.oppDives.length) return mix(zone(fav.shoot), eq, cfg.kickRead)
        let left = 0
        let right = 0
        for (const d of s.oppDives) {
          if (sideOfDive(d) === 0) left++
          if (sideOfDive(d) === 2) right++
        }
        const row = fav.shoot >= 6 ? 6 : 0
        const away = left > right ? row + 2 : right > left ? row : fav.shoot
        return mix(zone(away), eq, cfg.kickRead)
      }
      if (!s.oppKicks.length) return [...EQ_KEEPER]
      return mix(dive(COVER[s.oppKicks[s.oppKicks.length - 1]!]!), eq, cfg.read)
    }
    case 'vesper': {
      if (shooter) {
        // Leans towards a swap of corners, but a loose one: the other side of the goal in either row, or the other row on the same side, or a repeat.
        const last = s.myKicks.length ? s.myKicks[s.myKicks.length - 1]! : fav.shoot
        const from = CORNERS.includes(last as (typeof CORNERS)[number]) ? last : fav.shoot
        const across = mirrorZone(from)
        const swap = new Array<number>(ZONE_COUNT).fill(0)
        swap[across] += VESPER_SWAP.across
        swap[otherRow(across)] += VESPER_SWAP.acrossOtherRow
        swap[otherRow(from)] += VESPER_SWAP.sameSideOtherRow
        swap[from] += VESPER_SWAP.repeat
        return mix(swap, eq, cfg.kickRead)
      }
      if (!s.oppKicks.length) return [...EQ_KEEPER]
      const cnt = new Array<number>(ZONE_COUNT).fill(0)
      for (const z of s.oppKicks.slice(-3)) cnt[z]!++
      const common = cnt.indexOf(Math.max(...cnt))
      const n = s.oppKicks.length
      const pred = n >= 2 && s.oppKicks[n - 1] !== s.oppKicks[n - 2] ? s.oppKicks[n - 2]! : common
      // The rule above, plus a small pattern reader (repeat, alternate, and the same as 3 to 6 back). The reader's share is at least `reader` and grows with the evidence of a pattern, so a loop that repeats gets read.
      const { out, eqP } = predict(VESPER_SHAPES, s.oppKicks, s.myDives, cfg.prior)
      const reader = mix(bestKeeper(out, fav.side), eq, Math.min(cfg.read, 1 - eqP))
      return mix(reader, mix(dive(COVER[pred]!), eq, cfg.read), Math.max(cfg.reader, cfg.readerGrowth * (1 - eqP)))
    }
    case 'sable': {
      const stream = shooter ? s.oppDives : s.oppKicks
      if (!stream.length) return floored(eq, OPEN_FLOOR)
      const { out, eqP } = shooter ? predict(DIVE_HABITS, s.oppDives, s.myKicks) : predict(KICK_HABITS, s.oppKicks, s.myDives)
      const conf = Math.min(cfg.cap, (1 - eqP) * cfg.weight)
      return mix(shooter ? bestShooter(out, fav.side) : bestKeeper(out, fav.side), eq, conf)
    }
  }
}

/** This level's pick now: a zone 0..8 as shooter, a dive 0..4 as keeper. Reads only `obs`; draws from `rng`; `salt` fixes the favourites of Pip, Marlow and Vesper, and breaks Sable's left/right ties. */
export function choosePenaltyAction(level: Level, obs: PenaltyObs, rng: Rng, salt: number): number {
  if (obs.role === null) throw new Error('penalty: no action once the shootout is over')
  return pick(levelDist(level, obs, salt), rng)
}

/** The seat's mixed seed: the match seed with the seat folded in, so two agents of the same level do not draw the same numbers or pick the same favourites. */
function mixedSeed(seed: number, seat: Seat): number {
  return (seed ^ Math.imul(seat + 1, 0x9e3779b1)) | 0
}

/**
 * This level's pick for one kick, as a pure function of the match seed, the agent's seat and what that seat can see. The random draw belongs to the kick
 * (the number of kicks already taken), so nothing is carried between calls and the same inputs give the same pick wherever they are asked: on the page
 * (unrated play), on the server when it plays the opponent of a counted match (server/sealed-duel.ts), and in the server's re-check of a record.
 */
export function penaltyAgentAction(level: Level, seed: number, seat: Seat, obs: PenaltyObs, entropy?: readonly number[]): number {
  if (entropy !== undefined) {
    // A match the server holds: the draw and the favourites come from the kicks' random words, never from the seed. The first word fixes the favourites for the
    // whole match, and each kick's own word is its draw, so a word the player has seen says nothing about the next one.
    const first = entropy[0]
    const word = entropy[obs.kicks.length]
    if (first === undefined || word === undefined) throw new Error('penalty: no entropy for this kick')
    const base = hashSalt(first ^ Math.imul(seat + 1, 0x9e3779b1))
    const salt = Math.imul(base ^ 0x5bd1e995, 0x85ebca6b) | 0
    return choosePenaltyAction(level, obs, makeRng(hashSalt(word ^ Math.imul(seat + 1, 0x9e3779b1) ^ 0x7f4a7c15) | 0), salt)
  }
  const mixed = mixedSeed(seed, seat)
  const salt = Math.imul(mixed ^ 0x5bd1e995, 0x85ebca6b) | 0
  const rng = makeRng(hashSalt(mixed ^ Math.imul(obs.kicks.length + 1, 0x85ebca6b)) | 0)
  return choosePenaltyAction(level, obs, rng, salt)
}

/** Matches the factory signature in agent-dispatch.ts: (level, opts) => Promise<PreviewAgent>. */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const seat = opts.seat ?? 1
  let seed = 0
  let forSeat: Seat = seat
  return {
    // false: this agent is final, not a stand-in for one that is still being trained.
    preview: false,
    reset(next, nextSeat) {
      // A page learns the player's side only after the server row exists, which is after the opponent is built, so it passes the seat here.
      seed = next
      forSeat = nextSeat ?? seat
    },
    async act(obs, state) {
      // The server's check passes the state, which carries the match's entropy words when the match was held by the server.
      return [penaltyAgentAction(level, seed, forSeat, obs as PenaltyObs, (state as { entropy?: number[] } | undefined)?.entropy)]
    },
    dispose() {},
  }
}
