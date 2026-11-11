import { peopleHands, PEOPLE_PROFILES } from '@duelwise/core/src/games/puck/seat-hands'
import { RULE_MALLET_SPEED } from '@duelwise/core/src/games/puck/constants'
import { wilson } from './ladder'
import { estimatePeople, type PeopleEstimate, type Proxy, type ProxyScore } from './people'
import { botSpec, measureBots, type SeatSpec } from './puck'

// A3: the air hockey panel of test players, for the people estimate (people.ts). Each test player is the mouse bot (a scripted stand-in for a
// person at a mouse, games/puck/bots.ts) on a people profile (games/puck/seat-hands.ts): the rule mallet the person gets in the browser, a
// beginner's, an average person's or a strong person's reaction time, hand noise and hold. The agent under test keeps its own level's hands.
// The strong profile is exactly the earlier "human hands" gate (delay 12, Champion's noise and hold), so published Vesper and Sable numbers do not drift.

export const PANEL_KIND = 'mouse' as const

/** Words for the registry's people block: what each test player is. Non-empty by construction. */
export function panelProxies(): Record<Proxy, string> {
  const out = {} as Record<Proxy, string>
  for (const p of PEOPLE_PROFILES) {
    const h = peopleHands(p)
    out[p] = `scripted mouse player on the rule mallet (speed ${RULE_MALLET_SPEED}); reacts ${h.delayFrames} frames (${Math.round((h.delayFrames * 1000) / 60)} ms) late, aims with ${h.noiseSd} table-widths of noise, holds a target at least ${h.minHoldFrames} frames`
  }
  return out
}

/** One panel test player as a seat (for tests and single matches). */
export const panelSpec = (proxy: Proxy): SeatSpec => botSpec(PANEL_KIND, 'champion', undefined, proxy)

export interface PanelResult {
  panel: Record<Proxy, ProxyScore>
  /** Each proxy's wins, draws and losses by the agent's seat, so a reader can recount. */
  tallies: Record<Proxy, { games: number; wins: number; draws: number; losses: number; bySeat: Record<'0' | '1', number> }>
}

/** The agent against each panel player, `games` matches on each seat. Draws count half. */
export async function measurePanel(agent: SeatSpec, opts: { games: number; procs?: number; seedBase?: number }): Promise<PanelResult> {
  const panel = {} as Record<Proxy, ProxyScore>
  const tallies = {} as PanelResult['tallies']
  for (const proxy of PEOPLE_PROFILES) {
    const r = await measureBots(agent, [PANEL_KIND], { games: opts.games, botDelay: peopleHands(proxy).delayFrames, botHands: proxy, procs: opts.procs, seedBase: opts.seedBase })
    const row = r.rows[0]!
    const games = row.bySeat['0'].games + row.bySeat['1'].games
    const points = row.wins + row.draws / 2
    panel[proxy] = { value: games ? points / games : 0, ci95: wilson(points, games), n: games }
    tallies[proxy] = { games, wins: row.wins, draws: row.draws, losses: row.losses, bySeat: { '0': row.bySeat['0'].score, '1': row.bySeat['1'].score } }
  }
  return { panel, tallies }
}

/** The weighted panel estimate and its verdict against the level's band (no real matches, no calibration: the pre-read). */
export function panelEstimate(agent: SeatSpec, result: PanelResult): PeopleEstimate {
  return estimatePeople(result.panel, null, 0, agent.level, { proxies: panelProxies() })
}
