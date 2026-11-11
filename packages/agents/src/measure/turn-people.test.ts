import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { fourCore } from '@duelwise/core/src/games/four/core'
import { fourFromMoves, isLegalColumn, drop, type FourState } from '@duelwise/core/src/games/four/rules'
import { makeRng } from '@duelwise/core/src/rng'
import { safeColumns, threatColumns, winningColumns } from '../four/tactics'
import { fleetCore, type FleetObs } from '@duelwise/core/src/games/fleet'
import { ANSWERS } from '@duelwise/core/src/games/word/lists'
import { wordCore } from '@duelwise/core/src/games/word/core'
import { slackCore } from '@duelwise/core/src/games/slack/core'
import { flipsOf, fromCells, legalMoves } from '../slack/board'
import { createSlackOpeningCore } from '../slack/opening'
import { PROXY_CONFIG as FLEET_CONFIG, createGameAgent as createFleetPanel, proxyShot } from './fleet-people'
import { overrideFor as fleetOverride } from './fleet-tried'
import { PROXY_CONFIG as SLACK_CONFIG, createGameAgent as createSlackPanel, proxyMove as slackMove } from './slack-people'
import { overrideFor as slackOverride } from './slack-tried'
import { AVERAGE_TARGET, createGameAgent as createWordPanel, proxyGuess } from './word-people'
import { overrideFor as wordOverride } from './word-tried'
import { PROXY_CONFIG, createGameAgent as createChessPanel, createProxyAgent as createChessProxy } from './chess-people'
import { overrideFor as chessOverride } from './chess-tried'
import { createGameAgent as createFourPanel, proxyMove } from './four-people'
import { overrideFor as fourOverride } from './four-tried'
import { createPenaltyCore, type KickView } from '@duelwise/core/src/games/penalty/core'
import { COVER, mirrorZone } from '../penalty/habits'
import { EQ_KEEPER, EQ_SHOOTER } from '../penalty/levels'
import { PROXY_CONFIG as PENALTY_CONFIG, createGameAgent as createPenaltyPanel, proxyDive, proxyKick } from './penalty-people'
import { createGameAgent as createMindReader } from './penalty-mindreader'
import { overrideFor as penaltyOverride } from './penalty-tried'
import { makeCard } from '@duelwise/core/src/games/holdem/cards'
import { botPlayer, levelPlayer } from './holdem'
import { PROXY_CONFIG as HOLDEM_CONFIG, createProxyPlayer, emptyStyle, inRange } from './holdem-people'
import { pointsAt, playTrace, type MatchTrace } from './holdem-people-run'
import { checkPeopleBlock, type PeopleEstimate, type Proxy } from './people'
import type { Level } from '@duelwise/core/src/product'
import { PROXIES, PROXY_LEVEL } from './turn-people'
import type { SolvedPosition } from './four'

// A5: the Chess and Four in a Row test players. A proxy that is not what it says it is would tune a level against nobody.

const EVAL = join(import.meta.dir, '../../eval')
const solved = (): SolvedPosition[] => (JSON.parse(readFileSync(join(EVAL, 'four-positions.json'), 'utf8')) as { positions: SolvedPosition[] }).positions

/** Random playouts: positions for which `want` holds, in a fixed order. */
function playouts(want: (s: FourState) => boolean, count: number, seed: number): FourState[] {
  const rng = makeRng(seed)
  const out: FourState[] = []
  while (out.length < count) {
    let s = fourFromMoves([])
    const len = 6 + rng.int(24)
    for (let i = 0; i < len && s.winner === null; i++) {
      const legal = [0, 1, 2, 3, 4, 5, 6].filter((c) => isLegalColumn(s, c))
      if (legal.length === 0) break
      s = drop(s, legal[rng.int(legal.length)]!)
    }
    if (s.winner === null && want(s)) out.push(s)
  }
  return out
}

describe('four: the test players', () => {
  test('every proxy is deterministic per seed and the seed changes the moves', () => {
    const positions = solved().slice(0, 80).map((p) => fourFromMoves(p.moves))
    for (const proxy of PROXIES) {
      const run = (seed: number) => {
        const rng = makeRng(seed)
        return positions.map((s) => proxyMove(proxy, s, rng))
      }
      expect(run(7)).toEqual(run(7))
      if (proxy !== 'average') expect(run(7)).not.toEqual(run(8))
    }
  })

  test('the beginner takes a win in one every time (200 of 200) and blocks a one-move threat about 60% of the time', () => {
    const wins = playouts((s) => winningColumns(s).length > 0, 200, 31)
    const rng = makeRng(5)
    for (const s of wins) expect(winningColumns(s)).toContain(proxyMove('beginner', s, rng))
    const threats = playouts((s) => winningColumns(s).length === 0 && threatColumns(s).length === 1, 200, 32)
    let blocked = 0
    for (const s of threats) if (threatColumns(s).includes(proxyMove('beginner', s, rng))) blocked++
    // The dice may also land on the block by luck, so the rate sits a little above the setting.
    expect(blocked / 200).toBeGreaterThan(0.6 - 0.08)
    expect(blocked / 200).toBeLessThan(0.6 + 0.17)
  })

  test('the average player always wins, always blocks and never hands over a win in one when it can help it', () => {
    const rng = makeRng(9)
    for (const s of playouts((s) => winningColumns(s).length > 0, 100, 41)) expect(winningColumns(s)).toContain(proxyMove('average', s, rng))
    for (const s of playouts((s) => winningColumns(s).length === 0 && threatColumns(s).length === 1, 100, 42)) expect(threatColumns(s)).toContain(proxyMove('average', s, rng))
    for (const s of playouts((s) => winningColumns(s).length === 0 && threatColumns(s).length === 0 && safeColumns(s).length > 0, 200, 43)) {
      expect(safeColumns(s)).toContain(proxyMove('average', s, rng))
    }
  })

  test('the strong player plays the solvers best move about 85% of the time (78 to 90)', () => {
    const positions = solved().filter((p) => p.moves.length >= 12).slice(0, 150)
    const rng = makeRng(13)
    let agree = 0
    for (const p of positions) if (p.optimalMoves.includes(proxyMove('strong', fourFromMoves(p.moves), rng))) agree++
    // 85% of the time a column that keeps the result (usually the best one), 15% random: about 83% on the solver's exact best moves (measured 82.7% over 300 positions).
    expect(agree / positions.length).toBeGreaterThan(0.78)
    expect(agree / positions.length).toBeLessThan(0.9)
  }, 120_000)

  test('the panel module maps easy, medium, hard to beginner, average, strong and refuses champion', async () => {
    expect(PROXY_LEVEL).toEqual({ beginner: 'easy', average: 'medium', strong: 'hard' })
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const a = await createFourPanel(level)
      a.reset(3, 0)
      const s = fourFromMoves([3, 3])
      const m = (await a.act(fourCore.observe(s, 0), s))[0]!
      expect(isLegalColumn(s, m)).toBe(true)
    }
    await expect(createFourPanel('champion')).rejects.toThrow(/no test player/)
  })

  test('a tuning override reaches only the level it names, and unset plays the shipped level', () => {
    expect(fourOverride('medium', undefined)).toBeUndefined()
    expect(fourOverride('medium', '{"medium":{"sims":8}}')).toEqual({ sims: 8 })
    expect(fourOverride('hard', '{"medium":{"sims":8}}')).toBeUndefined()
  })
})

describe('chess: the test players', () => {
  test('the proxies are the human-imitation nets at temperature 1, with no guard, margin or nucleus', () => {
    expect<unknown>(PROXY_CONFIG).toEqual({
      beginner: { band: 'b1100', temperature: 1 },
      average: { band: 'b1500', temperature: 1 },
      strong: { band: 'b1900', temperature: 1 },
    })
  })

  test('a proxy is deterministic per seed and the seed changes its moves', async () => {
    const play = async (proxy: Proxy, seed: number): Promise<string> => {
      const a = await createChessProxy(proxy, { seat: 0 })
      a.reset(seed, 0)
      const core = chessCore
      let s = core.init(1)
      const seen: number[] = []
      for (let i = 0; i < 16 && !core.terminal(s); i++) {
        const seat = core.toAct(s)[0]!
        const m = (await a.act(core.observe(s, seat), s))[0]!
        seen.push(m)
        s = core.step(s, seat === 0 ? [core.decodeAction(m), null] : [null, core.decodeAction(m)])
      }
      a.dispose()
      return seen.join(',')
    }
    for (const proxy of PROXIES) {
      expect(await play(proxy, 11)).toBe(await play(proxy, 11))
      expect(await play(proxy, 11)).not.toBe(await play(proxy, 12))
    }
  }, 120_000)

  test('the panel module maps easy, medium, hard to the three nets and refuses champion; overrides parse per level', async () => {
    for (const level of ['easy', 'medium', 'hard'] as const) expect(await createChessPanel(level)).toBeTruthy()
    await expect(createChessPanel('champion')).rejects.toThrow(/no test player/)
    expect(chessOverride('medium', undefined)).toBeUndefined()
    expect(chessOverride('medium', '{"medium":{"temperature":0.7},"champion":{"nodeBudget":5000}}')).toEqual({ temperature: 0.7 })
    expect(chessOverride('champion', '{"medium":{"temperature":0.7},"champion":{"nodeBudget":5000}}')).toEqual({ nodeBudget: 5000 })
  })
})

describe('slack: the test players', () => {
  const obsAt = (plies: number, seed: number) => {
    const core = createSlackOpeningCore()
    const rng = makeRng(seed)
    let s = core.init(seed)
    for (let i = 0; i < plies && !core.terminal(s); i++) {
      const seat = core.toAct(s)[0]!
      const legal = core.legal(s, seat)
      const m = legal[rng.int(legal.length)]!
      s = core.step(s, seat === 0 ? [m, null] : [null, m])
    }
    const seat = core.toAct(s)[0]!
    return core.observe(s, seat)
  }

  test('the beginner is greedy: it plays a most-flipping move 65% of the time plus the chance that a random move is one (60 to 80%)', () => {
    expect(SLACK_CONFIG.beginner).toMatchObject({ kind: 'greedy', randomPercent: 35 })
    const rng = makeRng(3)
    let greedy = 0
    let expected = 0
    const n = 600
    for (let i = 0; i < n; i++) {
      const obs = obsAt(4 + (i % 20), 100 + i)
      if (!obs.toMove || obs.legal.length === 0 || (obs.legal.length === 1 && obs.legal[0] === 64)) continue
      const board = fromCells(obs.cells)
      const moves = legalMoves(board, 1)
      const best = Math.max(...moves.map((m) => flipsOf(board, m, 1).length))
      const top = moves.filter((m) => flipsOf(board, m, 1).length === best)
      expected += 0.65 + 0.35 * (top.length / moves.length)
      if (top.includes(slackMove('beginner', obs, rng))) greedy++
    }
    // The count of greedy plays is binomial around the expected rate for these exact positions.
    expect(Math.abs(greedy - expected)).toBeLessThan(40)
  })

  test('every proxy is deterministic per seed, always legal, and the seed changes its moves', () => {
    for (const proxy of PROXIES) {
      const run = (seed: number) => {
        const rng = makeRng(seed)
        return Array.from({ length: 40 }, (_, i) => slackMove(proxy, obsAt(6 + (i % 14), 500 + i), rng))
      }
      expect(run(5)).toEqual(run(5))
      expect(run(5)).not.toEqual(run(6))
      const rng = makeRng(9)
      for (let i = 0; i < 40; i++) {
        const obs = obsAt(8, 900 + i)
        expect(obs.legal).toContain(slackMove(proxy, obs, rng))
      }
    }
  })

  test('the panel module maps easy, medium, hard to the three proxies and refuses champion; overrides parse per level', async () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const a = await createSlackPanel(level)
      a.reset(3, 0)
      const obs = obsAt(4, 3)
      expect(obs.legal).toContain((await a.act(obs, undefined))[0]!)
    }
    await expect(createSlackPanel('champion')).rejects.toThrow(/no test player/)
    expect(slackOverride('hard', undefined)).toBeUndefined()
    expect(slackOverride('hard', '{"hard":{"noise":9}}')).toEqual({ noise: 9 })
    expect(slackOverride('easy', '{"hard":{"noise":9}}')).toBeUndefined()
    expect(slackCore.id).toBe('slack')
  })
})

describe('fleet: the test players', () => {
  const obsWithHit = (hit: number): FleetObs => ({ phase: 'play', ships: [], shots: [{ cell: hit, hit: true, sunk: null } as never], incoming: [], sunk: [], enemyLeft: [5, 4, 3, 3, 2], reveal: null })
  const near = (hit: number): number[] => [hit - 10, hit + 10, hit - 1, hit + 1]

  test('the beginner follows an open hit 55% of the time, so a neighbour comes up 55% plus the 4 in 99 chance that a random shot lands beside it (53 to 62%)', () => {
    expect(FLEET_CONFIG.beginner.followRate).toBe(0.55)
    const rng = makeRng(21)
    const obs = obsWithHit(44)
    let followed = 0
    const n = 6000
    for (let i = 0; i < n; i++) if (near(44).includes(proxyShot('beginner', obs, rng))) followed++
    const expected = 0.55 + 0.45 * (4 / 99)
    expect(Math.abs(followed / n - expected)).toBeLessThan(0.025)
  })

  test('the average player follows 90% of the time and fires anywhere 10% of the time; the strong player always follows but slips 5%', () => {
    const obs = obsWithHit(44)
    const rate = (proxy: Proxy, seed: number): number => {
      const rng = makeRng(seed)
      let k = 0
      for (let i = 0; i < 6000; i++) if (near(44).includes(proxyShot(proxy, obs, rng))) k++
      return k / 6000
    }
    // average: 10% slip (a neighbour 4 times in 99), else 90% follow; the chequerboard hunt of the rest never lands on a neighbour (other parity).
    expect(Math.abs(rate('average', 22) - (0.9 * 0.9 + 0.1 * 4 / 99))).toBeLessThan(0.025)
    expect(Math.abs(rate('strong', 23) - (0.95 + 0.05 * 4 / 99))).toBeLessThan(0.02)
  })

  test('every proxy is deterministic per seed and plays legal setup and shots through the panel module; champion is refused', async () => {
    const play = async (proxy: 'easy' | 'medium' | 'hard', seed: number): Promise<string> => {
      const agents = [await createFleetPanel(proxy, { seat: 0 }), await createFleetPanel(proxy, { seat: 1 })]
      agents.forEach((a, i) => a.reset(seed, i as 0 | 1))
      let s = fleetCore.init(1)
      const seen: number[] = []
      for (let i = 0; i < 60 && !fleetCore.terminal(s); i++) {
        const seats = fleetCore.toAct(s)
        const moves = await Promise.all(seats.map((seat) => agents[seat]!.act(fleetCore.observe(s, seat), s)))
        const acts: [unknown, unknown] = [null, null]
        seats.forEach((seat, k) => {
          seen.push(moves[k]![0]!)
          acts[seat] = fleetCore.decodeAction(moves[k]![0]!)
        })
        s = fleetCore.step(s, acts as never)
      }
      return seen.join(',')
    }
    for (const level of ['easy', 'medium', 'hard'] as const) {
      expect(await play(level, 4)).toBe(await play(level, 4))
      expect(await play(level, 4)).not.toBe(await play(level, 5))
    }
    await expect(createFleetPanel('champion')).rejects.toThrow(/no test player/)
    expect(fleetOverride('easy', '{"easy":{"followRate":0.2}}')).toEqual({ followRate: 0.2 })
    expect(fleetOverride('hard', '{"easy":{"followRate":0.2}}')).toBeUndefined()
  })
})

describe('word: the test players', () => {
  const solve = (proxy: Proxy, answer: string, seed: number): number => {
    const rng = makeRng(seed)
    let s = wordCore.init(seed, { answer })
    while (!wordCore.terminal(s)) {
      const word = wordCore.decodeAction(proxyGuess(proxy, wordCore.observe(s, 0), rng))
      s = wordCore.step(s, [word, word])
    }
    const n = s.guesses[0]!.indexOf(answer) + 1
    return n === 0 ? 7 : n
  }

  test('the average player averages within 0.2 guesses of its stated target over every answer word, and the beginner needs more and the strong player fewer', () => {
    const mean = (proxy: Proxy): number => ANSWERS.reduce((t, a, i) => t + solve(proxy, a, 31_000 + i), 0) / ANSWERS.length
    const avg = mean('average')
    expect(Math.abs(avg - AVERAGE_TARGET)).toBeLessThan(0.2)
    expect(mean('beginner')).toBeGreaterThan(avg + 0.3)
    expect(mean('strong')).toBeLessThan(avg - 0.2)
  }, 600_000)

  test('every proxy is deterministic per seed and only ever guesses a word the core allows', () => {
    for (const proxy of PROXIES) {
      const run = (seed: number): number[] => ANSWERS.slice(0, 30).map((a, i) => solve(proxy, a, seed + i))
      expect(run(7)).toEqual(run(7))
    }
    const rng = makeRng(1)
    const s = wordCore.init(1, { answer: ANSWERS[10]! })
    for (const proxy of PROXIES) expect(() => wordCore.decodeAction(proxyGuess(proxy, wordCore.observe(s, 0), rng))).not.toThrow()
  })

  test('the panel module maps easy, medium, hard to the three proxies and refuses champion; the tuning override parses per level', async () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const a = await createWordPanel(level)
      a.reset(3, 0)
      const s = wordCore.init(3, { answer: ANSWERS[5]! })
      expect((await a.act(wordCore.observe(s, 0), s)).length).toBe(1)
    }
    await expect(createWordPanel('champion')).rejects.toThrow(/no test player/)
    expect(wordOverride('hard', '{"hard":{"slip":0.3}}')).toEqual({ slip: 0.3 })
    expect(wordOverride('easy', '{"hard":{"slip":0.3}}')).toBeUndefined()
  })
})

describe('the written eval files', () => {
  test('every people block in packages/agents/eval/people is reproducible from its own parts (a hand edit turns this red)', () => {
    let blocks = 0
    for (const game of ['four', 'chess', 'slack', 'fleet', 'word']) {
      const path = join(EVAL, 'people', `${game}.json`)
      if (!existsSync(path)) continue
      const file = JSON.parse(readFileSync(path, 'utf8')) as { runs: Array<{ label: string; levels: Record<string, { estimate: PeopleEstimate }> }> }
      for (const run of file.runs) {
        for (const [level, l] of Object.entries(run.levels)) {
          expect(checkPeopleBlock(l.estimate, level as Level)).toEqual([])
          blocks++
        }
      }
    }
    expect(blocks).toBeGreaterThan(0)
  })
})

describe('penalty (Twelve Yards): the test players', () => {
  const N = 10_000
  const kick = (zone: number, outcome: KickView['outcome']): KickView => ({ byMe: true, zone: zone as KickView['zone'], dive: 2, outcome })
  const rate = (hit: (i: number) => boolean): number => {
    let n = 0
    for (let i = 0; i < N; i++) if (hit(i)) n++
    return n / N
  }

  test('the beginner kicker repeats a zone that scored and flips to the mirror after a miss (habit 70% plus the chance a random zone is the same)', () => {
    const rng = makeRng(11)
    const stated = 0.7 + 0.3 / 9
    expect(Math.abs(rate(() => proxyKick('beginner', [kick(6, 'goal')], rng, 5) === 6) - stated)).toBeLessThan(0.02)
    expect(Math.abs(rate(() => proxyKick('beginner', [kick(6, 'save')], rng, 5) === mirrorZone(6)) - stated)).toBeLessThan(0.02)
    expect(Math.abs(rate(() => proxyKick('beginner', [kick(0, 'wide')], rng, 5) === mirrorZone(0)) - stated)).toBeLessThan(0.02)
    // The first kick is a favourite bottom corner, the same every time within a match.
    const first = new Set(Array.from({ length: 200 }, () => proxyKick('beginner', [], makeRng(1), 5)))
    expect([...first].every((z) => z === 6 || z === 8)).toBe(true)
  })

  test('the beginner keeper dives to its favourite low side half the time and anywhere otherwise', () => {
    const rng = makeRng(12)
    const counts = new Array<number>(5).fill(0)
    for (let i = 0; i < N; i++) counts[proxyDive('beginner', [], rng, 9)]!++
    const top = counts.indexOf(Math.max(...counts))
    expect([1, 4]).toContain(top)
    expect(Math.abs(counts[top]! / N - (0.5 + 0.5 / 5))).toBeLessThan(0.02)
  })

  test('the average kicker alternates sides and kicks low 60% of its habit kicks; its keeper covers the last shot 45% of the time plus chance', () => {
    const rng = makeRng(13)
    const h = PENALTY_CONFIG.average.kicker.habit
    // Last kick on the left column: the habit is the right column.
    const toRight = rate(() => proxyKick('average', [kick(6, 'goal')], rng, 3) % 3 === 2)
    expect(Math.abs(toRight - (h + (1 - h) / 3))).toBeLessThan(0.02)
    const low = rate(() => proxyKick('average', [kick(6, 'goal')], rng, 3) >= 6)
    expect(Math.abs(low - (h * 0.6 + (1 - h) / 3))).toBeLessThan(0.02)
    const cover = rate(() => proxyDive('average', [kick(0, 'goal')], rng, 3) === COVER[0])
    expect(Math.abs(cover - (0.45 + 0.55 / 5))).toBeLessThan(0.02)
  })

  test('the well-mixed strong player kicks and dives within 2 points of the equilibrium mix (with 6% noise) on every zone and dive', () => {
    const rng = makeRng(14)
    const z = new Array<number>(9).fill(0)
    const d = new Array<number>(5).fill(0)
    for (let i = 0; i < N; i++) {
      z[proxyKick('strong', [kick(2, 'goal')], rng, 1)]!++
      d[proxyDive('strong', [kick(2, 'goal')], rng, 1)]!++
    }
    EQ_SHOOTER.forEach((p, i) => expect(Math.abs(z[i]! / N - (0.94 * p + 0.06 / 9))).toBeLessThan(0.02))
    EQ_KEEPER.forEach((p, i) => expect(Math.abs(d[i]! / N - (0.94 * p + 0.06 / 5))).toBeLessThan(0.02))
    // What it does never depends on what it saw.
    const rngA = makeRng(7)
    const rngB = makeRng(7)
    expect(Array.from({ length: 50 }, () => proxyKick('strong', [kick(0, 'goal')], rngA, 1))).toEqual(Array.from({ length: 50 }, () => proxyKick('strong', [kick(8, 'save'), kick(3, 'goal')], rngB, 1)))
  })

  test('the panel agents are deterministic per seed, play legal zones and dives, and the seed changes their picks', async () => {
    const core = createPenaltyCore()
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const play = async (seed: number) => {
        const a = await createPenaltyPanel(level, { seat: 0 })
        const b = await createPenaltyPanel(level, { seat: 1 })
        a.reset(seed)
        b.reset(seed)
        let s = core.init(seed)
        const picks: number[] = []
        while (!core.terminal(s)) {
          const acts = await Promise.all(core.toAct(s).map((seat) => (seat === 0 ? a : b).act(core.observe(s, seat), s)))
          for (const [i, seat] of core.toAct(s).entries()) expect(core.legal(s, seat) as number[]).toContain(acts[i]![0]!)
          picks.push(...acts.map((x) => x[0]!))
          s = core.step(s, [acts[0]![0]! as never, acts[1]![0]! as never])
        }
        return picks
      }
      expect(await play(21)).toEqual(await play(21))
      expect(await play(21)).not.toEqual(await play(22))
    }
}, 60_000)

  test('the mind reader, told a test player\'s next pick, beats every panel player in 95% of games or more (luck is not the ceiling)', async () => {
    const core = createPenaltyCore()
    for (const level of ['easy', 'medium', 'hard'] as const) {
      let wins = 0
      const games = 120
      for (let g = 0; g < games; g++) {
        const seatM = (g % 2) as 0 | 1
        const mr = await createMindReader(level, { seat: seatM })
        const pn = await createPenaltyPanel(level, { seat: (1 - seatM) as 0 | 1 })
        const pair = seatM === 0 ? [mr, pn] : [pn, mr]
        const seed = 5000 + g
        pair[0]!.reset(seed)
        pair[1]!.reset(seed)
        let s = core.init(seed)
        while (!core.terminal(s)) {
          const acts = await Promise.all(core.toAct(s).map((seat) => pair[seat]!.act(core.observe(s, seat), s)))
          s = core.step(s, [acts[0]![0]! as never, acts[1]![0]! as never])
        }
        if (core.result(s)!.winner === seatM) wins++
      }
      expect(wins / games).toBeGreaterThanOrEqual(0.95)
    }
}, 60_000)

  test('the tried-config hook reads a level override and nothing else', () => {
    expect(penaltyOverride('champion', undefined)).toBeUndefined()
    expect(penaltyOverride('medium', '{"medium":{"read":0.3}}')).toEqual({ read: 0.3 })
    expect(penaltyOverride('hard', '{"medium":{"read":0.3}}')).toBeUndefined()
  })
})

describe('holdem: the test players and the match lengths', () => {
  test('pointsAt: a bust inside the length ends it at once and the chip leader wins otherwise', () => {
    const net = [4, -2, 6, 6, 0, 8, 8, 2, 2, 2, 2, 2, 2, 2, 2, -4]
    const t: MatchTrace = { net, bust: null }
    expect(pointsAt(t, 5)).toBe(0.5)
    expect(pointsAt(t, 3)).toBe(1)
    expect(pointsAt(t, 2)).toBe(0)
    expect(pointsAt(t, 16)).toBe(0)
    const busted: MatchTrace = { net: [2, 4, 6, -100], bust: { hand: 4, agentLost: true } }
    expect(pointsAt(busted, 5)).toBe(0)
    expect(pointsAt(busted, 3)).toBe(1)
    expect(pointsAt({ net: [2, 4, 6, 100], bust: { hand: 4, agentLost: false } }, 5)).toBe(1)
    expect(() => pointsAt({ net: [1, 2], bust: null }, 5)).toThrow()
  })

  test('reading the 5, 10 and 15 hand results off one 30 hand match gives exactly the result of playing the shorter match', async () => {
    const agent = await levelPlayer('champion')
    for (const proxy of ['beginner', 'average', 'strong'] as const) {
      const other = createProxyPlayer(proxy)
      for (let seed = 900; seed < 925; seed++) {
        for (const seat of [0, 1] as const) {
          const full = await playTrace(seed, agent, other, seat)
          for (const L of [5, 10, 15] as const) {
            const real = await playTrace(seed, agent, other, seat, undefined, { hands: L })
            expect(pointsAt(full, L)).toBe(pointsAt(real, real.net.length))
          }
        }
      }
    }
  }, 120_000)

  test('a test player puts chips in before the flop and bets or raises as often as it says (within 3 points over 20,000 hands against the equity-threshold bot)', async () => {
    for (const proxy of ['beginner', 'average', 'strong'] as const) {
      const style = emptyStyle()
      const bot = botPlayer('equity-threshold')
      const player = createProxyPlayer(proxy)
      for (let seed = 1; style.hands < 20_000; seed++) await playTrace(seed, bot, player, (seed % 2) as 0 | 1, style)
      const c = HOLDEM_CONFIG[proxy]
      expect(Math.abs((100 * style.voluntary) / style.hands - c.vpip)).toBeLessThan(3)
      expect(Math.abs((100 * style.raises) / style.decisions - c.aggression)).toBeLessThan(3)
    }
  }, 240_000)

  test('the starting-hand range is the top share of hands, and a player is deterministic per seed', () => {
    let inside = 0
    let total = 0
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) { total++; if (inRange([a, b], 0.5)) inside++ }
    expect(Math.abs(inside / total - 0.5)).toBeLessThan(0.02)
    expect(inRange([makeCard(12, 0), makeCard(12, 1)], 0.1)).toBe(true) // a pair of aces
    expect(inRange([makeCard(0, 0), makeCard(2, 1)], 0.1)).toBe(false) // a deuce and a four off suit
  })
})
