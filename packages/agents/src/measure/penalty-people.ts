import type { KickView, PenaltyObs } from '@duelwise/core/src/games/penalty/core'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng, Seat } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { COVER, mirrorZone } from '../penalty/habits'
import { EQ_KEEPER, EQ_SHOOTER } from '../penalty/levels'
import type { Proxy } from './people'
import { PROXY_LEVEL } from './turn-people'

// A7: the Twelve Yards panel of test players: people's habits, written by hand. Nobody here reads the match; each one is a few rules a person plausibly has.
// Every rate below is a LABELLED ASSUMPTION, not a published figure: published penalty studies (professional shootouts) report side preferences for
// pro kickers and keepers, but no source was checked for amateurs and none is cited. The test (turn-people.test.ts) measures each stated rate over 10,000 kicks.
//   beginner  kicker: a favourite bottom corner at first, then 70% habit: after a goal the same zone again, after a miss the mirror zone; 30% any zone.
//             keeper: its favourite low dive half the time, any of the five dives the other half.
//   average   kicker: 80% habit: alternates sides (left column then right, right then left), low row 60% / high row 40%; 20% any zone.
//             keeper: 45% dives to cover where the kicker last shot, 55% any of the five dives.
//   strong    a well-mixed player: the equilibrium mix of the goal table with 6% of kicks and dives at random. The ceiling reads off this player.

export interface PenaltyProxyConfig {
  kicker: { kind: 'repeat-or-flip' | 'alternate' | 'mix'; /** Share of kicks that follow the habit; the rest are any zone (for `mix`, any zone is the noise). */ habit: number; /** alternate: share of habit kicks on the low row. */ low?: number }
  keeper: { kind: 'favourite' | 'cover-last' | 'mix'; habit: number }
}

export const PROXY_CONFIG: Record<Proxy, PenaltyProxyConfig> = {
  beginner: { kicker: { kind: 'repeat-or-flip', habit: 0.7 }, keeper: { kind: 'favourite', habit: 0.5 } },
  average: { kicker: { kind: 'alternate', habit: 0.8, low: 0.6 }, keeper: { kind: 'cover-last', habit: 0.45 } },
  strong: { kicker: { kind: 'mix', habit: 0.94 }, keeper: { kind: 'mix', habit: 0.94 } },
}

export const PROXY_WORDS: Record<Proxy, string> = {
  beginner: 'kicks at a favourite bottom corner first, then repeats a zone that scored and flips to the mirror zone after a miss (70% of kicks, otherwise any zone); dives to a favourite low side half the time and anywhere otherwise',
  average: 'alternates the side it kicks to (low row 60%, 80% of kicks, otherwise any zone); dives to cover where the kicker last shot 45% of the time and anywhere otherwise',
  strong: 'a well-mixed player: kicks and dives at the game\'s equilibrium mix, with 6% of picks at random; it cannot be read, so it sets the ceiling',
}

function pick(d: readonly number[], rng: Rng): number {
  let r = rng.float()
  for (let i = 0; i < d.length; i++) {
    r -= d[i]!
    if (r < 0) return i
  }
  return d.length - 1
}

/** The salt fixes the match's favourites: a bottom corner to kick at and a low side dive. */
function favourites(salt: number): { corner: 6 | 8; dive: 1 | 4 } {
  const h = Math.imul(salt | 0, 0x9e3779b1) >>> 0
  return { corner: h & 1 ? 8 : 6, dive: h & 2 ? 4 : 1 }
}

const column = (z: number): number => z % 3
const row = (z: number): number => Math.floor(z / 3)

/** This test player's kick for the observation: a zone 0..8. */
export function proxyKick(proxy: Proxy, mine: KickView[], rng: Rng, salt: number, cfg: PenaltyProxyConfig = PROXY_CONFIG[proxy]): number {
  const k = cfg.kicker
  const fav = favourites(salt)
  const last = mine.length ? mine[mine.length - 1]! : null
  const any = (): number => rng.int(9)
  if (rng.float() >= k.habit) return any()
  switch (k.kind) {
    case 'repeat-or-flip':
      if (!last) return fav.corner
      return last.outcome === 'goal' ? last.zone : mirrorZone(last.zone)
    case 'alternate': {
      const lowRow = rng.float() < (k.low ?? 0.6)
      const r = lowRow ? 2 : 0
      const c = !last ? (rng.int(2) === 0 ? 0 : 2) : column(last.zone) === 0 ? 2 : column(last.zone) === 2 ? 0 : rng.int(2) === 0 ? 0 : 2
      return r * 3 + c
    }
    case 'mix':
      return pick(EQ_SHOOTER, rng)
  }
}

/** This test player's dive for the observation: a dive 0..4. `theirs` are the kicks the opponent took (their zones). */
export function proxyDive(proxy: Proxy, theirs: KickView[], rng: Rng, salt: number, cfg: PenaltyProxyConfig = PROXY_CONFIG[proxy]): number {
  const k = cfg.keeper
  const fav = favourites(salt)
  const last = theirs.length ? theirs[theirs.length - 1]! : null
  if (rng.float() >= k.habit) return rng.int(5)
  switch (k.kind) {
    case 'favourite':
      return fav.dive
    case 'cover-last':
      return last ? COVER[last.zone]! : rng.int(5)
    case 'mix':
      return pick(EQ_KEEPER, rng)
  }
}

/** The action for an observation (a zone as shooter, a dive as keeper). */
export function proxyAction(proxy: Proxy, obs: PenaltyObs, rng: Rng, salt: number, cfg: PenaltyProxyConfig = PROXY_CONFIG[proxy]): number {
  if (obs.role === null) throw new Error('penalty people: no action once the shootout is over')
  // My kicks are the ones taken by me; the kicks the opponent took are the ones the opponent shot (byMe false), whose zone is theirs.
  return obs.role === 'shooter' ? proxyKick(proxy, obs.kicks.filter((x) => x.byMe), rng, salt, cfg) : proxyDive(proxy, obs.kicks.filter((x) => !x.byMe), rng, salt, cfg)
}

const hash = (n: number): number => {
  let x = n | 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) | 0
}

export function createProxyAgent(proxy: Proxy, opts: AgentOpts = {}): PreviewAgent {
  const seat = opts.seat ?? 1
  let seed = 0
  let forSeat: Seat = seat
  return {
    preview: false,
    reset(next, nextSeat) {
      seed = next
      forSeat = nextSeat ?? seat
    },
    async act(obs) {
      const o = obs as PenaltyObs
      const mixed = (seed ^ Math.imul(forSeat + 1, 0x7f4a7c15)) | 0
      const rng = makeRng(hash(mixed ^ Math.imul(o.kicks.length + 1, 0x85ebca6b)))
      return [proxyAction(proxy, o, rng, hash(mixed ^ 0x5bd1e995))]
    },
    dispose() {},
  }
}

const LEVEL_PROXY: Record<string, Proxy> = Object.fromEntries((Object.entries(PROXY_LEVEL) as Array<[Proxy, Level]>).map(([p, l]) => [l, p]))

/** The module hook the match harness loads: the level name picks the proxy (easy = beginner, medium = average, hard = strong). */
export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const proxy = LEVEL_PROXY[level]
  if (!proxy) throw new Error(`penalty people panel: no test player for level ${level}`)
  return createProxyAgent(proxy, opts)
}
