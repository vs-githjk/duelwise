import { FLEET_SIZE, fleetCore, type FleetObs } from '@duelwise/core/src/games/fleet'
import type { Level } from '@duelwise/core/src/product'
import { makeRng } from '@duelwise/core/src/rng'
import type { Rng } from '@duelwise/core/src/types'
import type { AgentOpts, PreviewAgent } from '../agent-types'
import { placeNext } from '../fleet/placer'
import { chooseShot } from '../fleet/shooter'
import type { FleetLevel } from '../fleet/levels'
import type { Proxy } from './people'
import { PROXY_LEVEL } from './turn-people'

// A6: the Stormglass panel of test players. People place their ships anywhere (uniform here, like every level), so the panel differs in the shooting only.
//   beginner  fires at random cells, and once a shot hits follows it up with a neighbour 55% of the time.
//   average   hunts on a chequerboard pattern, follows a hit up 90% of the time, and 10% of the time fires at any open cell.
//   strong    hunts on the probability map and follows a hit up every time, but 5% of the time fires at any open cell.
// Deterministic per seed.

export interface FleetProxyConfig extends FleetLevel {
  /** Chance of firing at any open cell whatever the plan says. */
  slipRate: number
}

export const PROXY_CONFIG: Record<Proxy, FleetProxyConfig> = {
  beginner: { name: 'beginner', hunt: 'random', target: 'follow', followRate: 0.55, slipRate: 0 },
  average: { name: 'average', hunt: 'checkerboard', target: 'neighbours', followRate: 0.9, slipRate: 0.1 },
  strong: { name: 'strong', hunt: 'map', target: 'neighbours', followRate: 1, slipRate: 0.05 },
}

export const PROXY_WORDS: Record<Proxy, string> = {
  beginner: 'fires at random cells and follows a hit with a neighbour 55% of the time',
  average: 'hunts on a chequerboard, follows a hit up 90% of the time, 10% of the time fires anywhere open',
  strong: 'hunts on the probability map and always follows a hit, 5% of the time fires anywhere open',
}

/** The cell a test player fires at for an observation. */
export function proxyShot(proxy: Proxy, obs: FleetObs, rng: Rng, cfg: FleetProxyConfig = PROXY_CONFIG[proxy]): number {
  if (cfg.slipRate > 0 && rng.float() < cfg.slipRate) {
    const taken = new Set(obs.shots.map((m) => m.cell))
    const open: number[] = []
    for (let i = 0; i < FLEET_SIZE * FLEET_SIZE; i++) if (!taken.has(i)) open.push(i)
    // Cells of a sunk ship are already in `shots`, so `open` is exactly the cells never fired at.
    return open[rng.int(open.length)]!
  }
  return chooseShot(cfg, obs, rng)
}

export function createProxyAgent(proxy: Proxy, opts: AgentOpts = {}): PreviewAgent {
  const seat = opts.seat ?? 1
  let rng: Rng = makeRng(0)
  return {
    preview: false,
    reset(seed) {
      rng = makeRng((seed ^ Math.imul(seat + 1, 0x9e3779b1) ^ 0x3c6ef372) | 0)
    },
    async act(obs) {
      const o = obs as FleetObs
      if (o.phase === 'setup') {
        const p = placeNext(o.ships, rng)
        return [fleetCore.encodeAction({ kind: 'place', cell: p.cell, vertical: p.vertical })]
      }
      return [fleetCore.encodeAction({ kind: 'shot', cell: proxyShot(proxy, o, rng) })]
    },
    dispose() {},
  }
}

const LEVEL_PROXY: Record<string, Proxy> = Object.fromEntries((Object.entries(PROXY_LEVEL) as Array<[Proxy, Level]>).map(([p, l]) => [l, p]))

export async function createGameAgent(level: Level, opts: AgentOpts = {}): Promise<PreviewAgent> {
  const proxy = LEVEL_PROXY[level]
  if (!proxy) throw new Error(`fleet people panel: no test player for level ${level}`)
  return createProxyAgent(proxy, opts)
}
