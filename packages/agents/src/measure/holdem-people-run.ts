// A7: measure Hold'em's levels against the people panel at every match length and write packages/agents/eval/people/holdem.json.
//   bun /abs/holdem-people-run.ts --label <name> [--levels easy,medium,hard,champion] [--deals 500] [--champion-deals 500] [--override '{"medium":{"callBias":0.6}}']
//        [--procs 2] [--seed-base 12000000] [--out <abs file>] [--stage]
// A game is one deal played twice with the seats swapped (a duplicate pair), so card luck cancels in the pooled score; the score is wins plus half of draws over
// the 2 x deals matches, under the strict bust rule a rated match uses. ONE 30 hand match per seed is played and its running chip total kept after every hand;
// the result at 5, 10 or 15 hands is read off the same hands (the agent sees a 30 hand match whatever the choice, so a shorter match plays the same first hands and only
// stops sooner: a bust ends it at once, otherwise the chip leader after the last hand wins). matchesAt() is checked against really playing the shorter match in the test.
// Nothing here edits the registry. `--stage` records a level's override as the settings A9 should publish.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { holdemCore, type HoldemObservation } from '@duelwise/core/src/games/holdem/core'
import { MATCH_HANDS } from '@duelwise/core/src/games/holdem/match'
import type { Level } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'
import type { PreviewAgent } from '../agent-types'
import { createGameAgent as createHoldemLevelAgent } from '../holdem/agent'
import { publishedTable } from './holdem'
import { countDecision, createProxyPlayer, emptyStyle, PROXY_CONFIG, PROXY_WORDS, type StyleCount } from './holdem-people'
import { wilson } from './ladder'
import { estimatePeople, loadBaseline, PEOPLE_BANDS, type PeopleEstimate, type Proxy, type ProxyScore } from './people'
import { PROXIES, pct, realCheck, writeJson, type RealCheck } from './turn-people'

export const LENGTHS = [5, 10, 15, 30] as const
export type Length = (typeof LENGTHS)[number]

/** One played match: the agent's running chips after each finished hand, and the bust, if one ended it. */
export interface MatchTrace {
  /** The agent under test's net chips after hand 1, 2, ... (as many as were played). */
  net: number[]
  /** The 1-based hand the match ended in a bust, and who lost it, or null when no one did. */
  bust: { hand: number; agentLost: boolean } | null
}

/** The agent's points (1, 0.5, 0) in the same match stopped at `length` hands, from a trace of the 30 hand match. */
export function pointsAt(t: MatchTrace, length: number): number {
  if (t.bust && t.bust.hand <= length) return t.bust.agentLost ? 0 : 1
  const net = t.net[length - 1]
  if (net === undefined) throw new Error(`pointsAt: the match ended before hand ${length} without a bust`)
  return net > 0 ? 1 : net < 0 ? 0 : 0.5
}

interface Player {
  reset(seed: number): void
  act(obs: HoldemObservation): Promise<number>
}

function asPlayer(agent: PreviewAgent): Player {
  return { reset: (seed) => agent.reset(seed), act: async (obs) => (await agent.act(obs))[0]! }
}

/** Plays one match (30 hands, strict bust rule) with the agent in `agentSeat` and a test player in the other seat. `options` lets the test play a shorter match for real. */
export async function playTrace(seed: number, agent: Player, other: Player, agentSeat: Seat, otherStyle?: StyleCount, options: { hands?: number } = {}): Promise<MatchTrace> {
  const players: [Player, Player] = agentSeat === 0 ? [agent, other] : [other, agent]
  players[0].reset(seed * 4 + 1)
  players[1].reset(seed * 4 + 2)
  let s = holdemCore.init(seed, { untilBust: true, ...options })
  const net: number[] = []
  let lastHand = 0
  const flag = { v: false }
  let handOfFlag = -1
  while (!holdemCore.terminal(s)) {
    const seat = s.actor
    const obs = holdemCore.observe(s, seat)
    const action = await players[seat].act(obs)
    if (otherStyle && seat !== agentSeat) {
      if (s.hand !== handOfFlag) {
        handOfFlag = s.hand
        flag.v = false
        otherStyle.hands++
      }
      countDecision(otherStyle, obs, action, flag)
    }
    s = holdemCore.step(s, seat === 0 ? [holdemCore.decodeAction(action), null] : [null, holdemCore.decodeAction(action)])
    const done = s.last ? s.last.hand + 1 : 0
    if (done > lastHand) {
      lastHand = done
      net.push(s.net[agentSeat])
    }
  }
  const over = s.over!
  const bust = /lost all/.test(over.reason) ? { hand: lastHand, agentLost: over.winner !== agentSeat } : null
  return { net, bust }
}

export interface CellTally {
  games: number
  wins: number
  draws: number
  losses: number
  bySeat: Record<'0' | '1', number>
}
export interface CellResult {
  level: Level
  proxy: Proxy
  deals: number
  byLength: Record<string, CellTally & { score: number; ci95: [number, number] }>
  /** What the test player did, so a reader can check VPIP and aggression against the stated figures. */
  proxyStyle: { vpipPercent: number; aggressionPercent: number; hands: number; decisions: number }
}

/** One cell: the agent of `level` (with `override` settings) against one test player over `deals` duplicate deals. */
export async function runCell(level: Level, proxy: Proxy, deals: number, override: Record<string, unknown> | undefined, seedBase: number): Promise<CellResult> {
  const table = publishedTable(level).bytes
  const agentPlayer = asPlayer(await createHoldemLevelAgent(level, { table, ...(override ?? {}) }))
  const other = createProxyPlayer(proxy)
  const style = emptyStyle()
  const points: Record<string, { wins: number; draws: number; losses: number; seat: [number, number]; seatN: [number, number] }> = {}
  for (const L of LENGTHS) points[String(L)] = { wins: 0, draws: 0, losses: 0, seat: [0, 0], seatN: [0, 0] }
  const slot = PROXIES.indexOf(proxy)
  for (let d = 0; d < deals; d++) {
    for (const agentSeat of [0, 1] as Seat[]) {
      const trace = await playTrace(seedBase + slot * 1_000_000 + d, agentPlayer, other, agentSeat, style)
      for (const L of LENGTHS) {
        const p = pointsAt(trace, L)
        const c = points[String(L)]!
        if (p === 1) c.wins++
        else if (p === 0) c.losses++
        else c.draws++
        c.seat[agentSeat] += p
        c.seatN[agentSeat]++
      }
    }
  }
  const byLength: CellResult['byLength'] = {}
  for (const L of LENGTHS) {
    const c = points[String(L)]!
    const games = c.wins + c.draws + c.losses
    const score = c.wins + c.draws / 2
    byLength[String(L)] = {
      games,
      wins: c.wins,
      draws: c.draws,
      losses: c.losses,
      bySeat: { '0': c.seat[0] / c.seatN[0], '1': c.seat[1] / c.seatN[1] },
      score: score / games,
      ci95: wilson(score, games),
    }
  }
  return { level, proxy, deals, byLength, proxyStyle: { vpipPercent: (100 * style.voluntary) / style.hands, aggressionPercent: (100 * style.raises) / Math.max(1, style.decisions), hands: style.hands, decisions: style.decisions } }
}

interface Run {
  label: string
  at: string
  override: Record<string, unknown> | null
  deals: Record<string, number>
  seedBase: number
  /** Per length, per level: the panel scores and the estimate. */
  /** Per length: does the real match data contradict the panel (levels this run did not change). */
  realCheck: Record<string, RealCheck>
  byLength: Record<string, Partial<Record<Level, { config: unknown; cells: Record<Proxy, CellResult['byLength'][string] & { proxyStyle: CellResult['proxyStyle'] }>; estimate: PeopleEstimate }>>>
}
interface EvalFile {
  game: string
  baseline: string
  note: string
  calibration: number
  calibrationNote: string
  runs: Run[]
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (n: string): string | undefined => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined)
  const HERE = import.meta.dir
  const REPO = join(HERE, '..', '..', '..', '..')
  const seedBase = Number(flag('--seed-base') ?? 12_000_000)
  const overrideRaw = flag('--override')
  const override = overrideRaw ? (JSON.parse(overrideRaw) as Record<string, Record<string, unknown>>) : null

  if (flag('--worker')) {
    // Child: play the cells named in --worker (JSON list of [level, proxy, deals]) and print one JSON line per cell.
    const cells = JSON.parse(flag('--worker')!) as Array<[Level, Proxy, number]>
    for (const [level, proxy, deals] of cells) {
      const r = await runCell(level, proxy, deals, override?.[level], seedBase)
      process.stdout.write(JSON.stringify(r) + '\n')
    }
    process.exit(0)
  }

  const label = flag('--label')
  if (!label) throw new Error('holdem-people-run: --label is required')
  const levels = (flag('--levels') ?? 'easy,medium,hard,champion').split(',') as Level[]
  const deals = Number(flag('--deals') ?? 500)
  const champDeals = Number(flag('--champion-deals') ?? deals)
  const procs = Math.min(2, Number(flag('--procs') ?? 2))
  const outPath = flag('--out') ?? join(REPO, 'packages', 'agents', 'eval', 'people', 'holdem.json')
  const BASELINE = flag('--baseline') ?? join(REPO, 'plan', 'retune', 'human-baseline.csv')

  const cells: Array<[Level, Proxy, number]> = []
  for (const level of levels) for (const proxy of PROXIES) cells.push([level, proxy, level === 'champion' ? champDeals : deals])
  const groups: Array<typeof cells> = Array.from({ length: procs }, () => [])
  cells.forEach((c, i) => groups[i % procs]!.push(c))
  const results: CellResult[] = []
  await Promise.all(
    groups.map(
      (g) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [import.meta.path, '--worker', JSON.stringify(g), '--seed-base', String(seedBase), ...(overrideRaw ? ['--override', overrideRaw] : [])], { stdio: ['ignore', 'pipe', 'inherit'] })
          let buf = ''
          child.stdout.on('data', (d: Buffer) => {
            buf += d.toString()
            let i
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i)
              buf = buf.slice(i + 1)
              if (line.trim()) {
                const r = JSON.parse(line) as CellResult
                results.push(r)
                console.error(`holdem ${r.level} vs ${r.proxy} [${label}] ${LENGTHS.map((L) => `${L}h ${pct(r.byLength[String(L)]!.score)}`).join(' ')} (proxy vpip ${r.proxyStyle.vpipPercent.toFixed(1)} aggr ${r.proxyStyle.aggressionPercent.toFixed(1)})`)
              }
            }
          })
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))))
        }),
    ),
  )

  const base = loadBaseline(BASELINE)
  const shipped = (JSON.parse(readFileSync(join(REPO, 'packages', 'agents', 'registry', 'holdem.json'), 'utf8')) as { levels: Record<string, { config: unknown }> }).levels
  const file: EvalFile = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, 'utf8')) as EvalFile)
    : {
        game: 'holdem',
        baseline: 'plan/retune/human-baseline.csv (production, 2026-11-10)',
        note: 'Written by measure/holdem-people-run.ts only. A panel score is the level\'s points against a test player over duplicate deals (each deal twice, seats swapped), strict bust rule. One 30 hand match per seed; the 5, 10 and 15 hand results are read off the same hands.',
        calibration: 0,
        calibrationNote: 'no real row reaches the minimum of 40 matches and 10 players, so no calibration is applied: the estimate is the panel alone, labelled so',
        runs: [],
      }
  const run: Run = { label, at: new Date().toISOString(), override, deals: Object.fromEntries(levels.map((l) => [l, l === 'champion' ? champDeals : deals])), seedBase, byLength: {}, realCheck: {} }
  for (const L of LENGTHS) {
    run.byLength[String(L)] = {}
    for (const level of levels) {
      const mine = results.filter((r) => r.level === level)
      const panel = {} as Record<Proxy, ProxyScore>
      const cellsOut = {} as Record<Proxy, CellResult['byLength'][string] & { proxyStyle: CellResult['proxyStyle'] }>
      for (const proxy of PROXIES) {
        const r = mine.find((m) => m.proxy === proxy)!
        const t = r.byLength[String(L)]!
        panel[proxy] = { value: t.score, ci95: t.ci95, n: t.games }
        cellsOut[proxy] = { ...t, proxyStyle: r.proxyStyle }
      }
      const changed = Boolean(override && Object.prototype.hasOwnProperty.call(override, level))
      const real = changed ? null : (base.get(`holdem/${level}`) ?? null)
      let estimate = estimatePeople(panel, real, file.calibration, level, { proxies: PROXY_WORDS })
      // The ceiling is what the strongest settings the code has (the shipped Champion) score against the average test player at this length; it only counts for a level whose band it cannot reach.
      const champ = results.find((r) => r.level === 'champion' && r.proxy === 'average')?.byLength[String(L)]
      if (champ && estimate.verdict === 'below' && champ.score < PEOPLE_BANDS[level].low) {
        estimate = estimatePeople(panel, real, file.calibration, level, { proxies: PROXY_WORDS, ceiling: { value: champ.score, ci95: champ.ci95, by: `${champ.games} matches of the shipped Champion against the average test player at ${L} hands` } })
      }
      run.byLength[String(L)]![level] = { config: changed ? { ...(shipped[level]!.config as object), ...(override![level] as object) } : shipped[level]!.config, cells: cellsOut, estimate }
      if (L === MATCH_HANDS || L === 10) {
        const p = estimate.panel
        console.error(`holdem ${level} ${L} hands [${label}] beginner ${pct(p.beginner.value)} average ${pct(p.average.value)} strong ${pct(p.strong.value)} -> panel ${pct(estimate.estimate)} ${estimate.verdict} (band ${pct(PEOPLE_BANDS[level].low)} to ${pct(PEOPLE_BANDS[level].high)}) real ${estimate.real ? pct(estimate.real.value) : 'none'}`)
      }
    }
  }
  for (const L of LENGTHS) {
    const unchanged = (Object.entries(run.byLength[String(L)]!) as Array<[Level, { estimate: PeopleEstimate }]>).filter(([lv]) => !(override && Object.prototype.hasOwnProperty.call(override, lv)))
    run.realCheck[String(L)] = realCheck('holdem', unchanged.map(([level, v]) => ({ level, estimate: v.estimate })), BASELINE)
  }
  file.runs = [...file.runs.filter((r) => r.label !== label), run]
  writeJson(outPath, file)
  if (args.includes('--stage') && override) {
    const stagedPath = outPath.replace(/\.json$/, '.staged.json')
    const staged = existsSync(stagedPath) ? (JSON.parse(readFileSync(stagedPath, 'utf8')) as Record<string, unknown>) : {}
    for (const level of levels) {
      if (!Object.prototype.hasOwnProperty.call(override, level)) continue
      const e = run.byLength[String(MATCH_HANDS)]![level]!.estimate
      staged[level] = { fromRun: label, override: override[level], verdict: e.verdict, panel30: e.estimate, deals: run.deals[level] }
    }
    writeJson(stagedPath, staged)
  }
  process.exit(0)
}
