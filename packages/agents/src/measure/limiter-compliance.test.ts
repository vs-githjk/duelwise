import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { createHash } from 'node:crypto'
import { PUBLISHED_V1 } from '../fighter/agent'
import { parseRegistry } from '../registry'
import { wilson } from './ladder'
import { BARS, GATE_MATCHES, championTrailsHard, buildFighterRegistry, fighterLevelFailures, gateLevel, maxPressesPerMinute, medianLag, recordGame, stressPresses, type BotRow, type RecordedGame } from './fighter'

const V1 = join(import.meta.dir, '../../../../apps/web/public/agents/fighter/v1')
const HARD_V2 = join(import.meta.dir, '../../test-fixtures/fighter-v2-hard-b2.onnx')
const load = async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer())

// Recorded ladder games: the real agents (ONNX policy, limiter, delayed view) play each other on the real core.
// The v2 Hard fixture stands in for Easy and Medium here: their limits are what is under test, not their weights.
const games = new Map<Level, RecordedGame[]>()

async function record(level: Level, bytes: Uint8Array, seeds: number[]) {
  const out: RecordedGame[] = []
  for (const seed of seeds) out.push(await recordGame({ level, bytes }, { level, bytes }, seed))
  games.set(level, out)
}

describe('limiter compliance over recorded games', () => {
  test('records the games', async () => {
    await record('easy', await load(HARD_V2), [11, 12])
    await record('medium', await load(HARD_V2), [13, 14])
    await record('hard', await load(HARD_V2), [15, 16])
    await record('champion', await load(`${V1}/champion.onnx`), [17, 18])
    for (const g of games.values()) for (const r of g) expect(r.seats[0]!.decisions.length).toBeGreaterThan(100)
  }, 240_000)

  for (const level of ['easy', 'medium', 'hard'] as const) {
    test(`${level}: median reaction is at least the delay and APM stays within the cap`, () => {
      const cfg = LEVEL_LIMITS.fighter[level]
      const recorded = games.get(level)!
      for (const seat of [0, 1] as const) {
        const lags = recorded.flatMap((g) => g.seats[seat]!.lags)
        expect(lags.length).toBeGreaterThan(100)
        expect(medianLag(lags)).toBeGreaterThanOrEqual(cfg.delayFrames)
        for (const g of recorded) expect(maxPressesPerMinute(g.seats[seat]!.pressFrames)).toBeLessThanOrEqual(cfg.apmCap!)
      }
    })

    test(`${level}: a seat that proposes a new press on every decision never exceeds the cap in any minute`, () => {
      const cfg = LEVEL_LIMITS.fighter[level]
      const presses = stressPresses(cfg, 5 * 3600, 7)
      expect(maxPressesPerMinute(presses)).toBeLessThanOrEqual(cfg.apmCap!)
      expect(maxPressesPerMinute(presses)).toBeGreaterThan(cfg.apmCap! * 0.9)
    })
  }

  test('champion: the delay equals the configured minimum and the view is exactly that old', () => {
    expect(LEVEL_LIMITS.fighter.champion.delayFrames).toBe(PRODUCT.championMinDelayFrames)
    expect(LEVEL_LIMITS.fighter.champion.apmCap).toBeNull()
    const lags = games.get('champion')!.flatMap((g) => g.seats[0]!.lags)
    expect(medianLag(lags)).toBeGreaterThanOrEqual(PRODUCT.championMinDelayFrames)
    expect(Math.min(...games.get('champion')!.flatMap((g) => g.seats[0]!.lagsAfterWarmup))).toBeGreaterThanOrEqual(PRODUCT.championMinDelayFrames)
  })

  test('an agent built without its level delay is caught: the lag it reads falls below the config', async () => {
    const bytes = await load(HARD_V2)
    const hard = LEVEL_LIMITS.fighter.hard
    const g = await recordGame({ level: 'hard', bytes, limits: { ...hard, delayFrames: 0 } }, { level: 'hard', bytes, limits: { ...hard, delayFrames: 0 } }, 21)
    expect(medianLag(g.seats[0]!.lags)).toBeLessThan(hard.delayFrames)
    const ok = await recordGame({ level: 'hard', bytes }, { level: 'hard', bytes }, 21)
    expect(medianLag(ok.seats[0]!.lags)).toBeGreaterThanOrEqual(hard.delayFrames)
  }, 120_000)

  test('the registry publishes exactly the levels the agent loads from v1, each with the R15 gate cleared', async () => {
    const reg = parseRegistry(await Bun.file(join(import.meta.dir, '../../registry/fighter.json')).json())
    expect(Object.keys(reg.levels).sort()).toEqual([...PUBLISHED_V1].sort())
    for (const level of PUBLISHED_V1) {
      const name = 'hard.onnx'
      const bytes = await Bun.file(join(V1, name)).arrayBuffer()
      expect(reg.versions[0]!.sha256[name]).toBe(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'))
      const m = reg.measured[level]!
      expect(m.n).toBeGreaterThanOrEqual(GATE_MATCHES)
      expect(m.ci95[0]).toBeGreaterThanOrEqual(Math.min(...Object.values(BARS[level])))
    }
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) if (!PUBLISHED_V1.includes(level)) expect(reg.unpublished?.[level]).toMatch(/^in training: /)
  })

  test('the registry records the ladder behind the site Elo, and every published level beats the one below it (Wilson lower bound above 0.5)', async () => {
    const raw = (await Bun.file(join(import.meta.dir, '../../registry/fighter.json')).json()) as {
      versions: Array<{ gate: { ladder: { pairs: Array<{ lower: string; upper: string; score: number; n: number; lowerBound: number }> } | null } }>
    }
    const ladder = raw.versions[0]!.gate.ladder
    expect(ladder).not.toBeNull()
    const pairs = ladder!.pairs
    if (PUBLISHED_V1.length === 0) {
      // Nothing is published (R32 Practice): the b3 pairs stay in the file as the measurement record, but no level claims them.
      expect(Object.keys((await Bun.file(join(import.meta.dir, '../../registry/fighter.json')).json() as { measured: object }).measured)).toEqual([])
      return
    }
    expect(pairs.map((p) => `${p.lower}>${p.upper}`)).toEqual(['easy>medium', 'medium>hard', 'hard>champion'])
    for (const p of pairs) {
      expect(p.n).toBeGreaterThanOrEqual(GATE_MATCHES)
      expect(p.lowerBound).toBeCloseTo(wilson(p.score * p.n, p.n)[0], 4)
    }
    if (PUBLISHED_V1.includes('champion')) {
      const champion = pairs.find((p) => p.upper === 'champion')!
      expect(champion.lower).toBe('hard')
      expect(champion.lowerBound).toBeGreaterThan(0.5)
      expect(wilson(champion.score * champion.n, champion.n)[0]).toBeGreaterThan(0.5)
    }
  })

  test('gateLevel applies the bars to Wilson lower bounds, and short or missing samples fail', () => {
    const row = (bot: string, wins: number, games = 400): BotRow => ({ bot, games, wins, draws: 0, losses: games - wins, score: wins / games, ci95: [0, 1] })
    const loops = (n: number) => [row('zoner', n), row('throwloop', n), row('backwalk', n), row('pokeloop', n), row('sweepspam', n), row('fireball', n), row('throwtap', n), row('fireball25', n)]
    // 265 of 400 (the Hard turtle measurement): lower bound 0.6148 clears 0.60; 250 of 400 (0.625 point estimate, lower bound 0.5766) does not.
    expect(gateLevel('hard', [row('random', 400), row('rushdown', 400), row('turtle', 265), ...loops(400)]).passed).toBe(true)
    expect(gateLevel('hard', [row('random', 400), row('rushdown', 400), row('turtle', 250), ...loops(400)]).passed).toBe(false)
    expect(gateLevel('hard', [row('random', 400), row('rushdown', 400), row('turtle', 400, 100), ...loops(400)]).passed).toBe(false)
    expect(gateLevel('hard', [row('random', 400), row('turtle', 400), ...loops(400)]).failures.join()).toContain('rushdown')
    // R30: the exploit bots are gated. The old three-bot rows alone no longer publish Hard or Champion.
    const old = [row('random', 400), row('rushdown', 400), row('turtle', 400)]
    expect(gateLevel('hard', old).failures.join()).toContain('zoner')
    // KC1: the crouch-light loop, sweep spam and range fireball are gated too; a Hard that only beats the first three does not publish.
    const first3 = [row('zoner', 400), row('throwloop', 400), row('backwalk', 400)]
    expect(gateLevel('hard', [...old, ...first3]).failures.join()).toContain('pokeloop')
    expect(gateLevel('champion', [row('rushdown', 400), row('turtle', 400), ...first3]).failures.join()).toMatch(/pokeloop.*sweepspam.*fireball|pokeloop/)
    // The judge's 30/30 crouch-light win over Champion: 0 of 400 fails; so does 220 of 400 (lower bound about 0.50).
    expect(gateLevel('champion', [row('rushdown', 400), row('turtle', 400), ...first3, row('pokeloop', 0), row('sweepspam', 400), row('fireball', 400)]).passed).toBe(false)
    expect(gateLevel('champion', [row('rushdown', 400), row('turtle', 400), ...first3, row('pokeloop', 400), row('sweepspam', 400), row('fireball', 400), row('throwtap', 400), row('fireball25', 400)]).passed).toBe(true)
    // LC1: the throw tapped at its own cadence is gated too; the b4 Hard measured 235 of 400 with the page's input lag and does not publish.
    expect(gateLevel('hard', [...old, ...loops(400).slice(0, 6), row('throwtap', 235)]).passed).toBe(false)
    expect(gateLevel('hard', [...old, ...loops(400).slice(0, 6)]).failures.join()).toContain('throwtap')
    expect(gateLevel('hard', [...old, ...loops(400)]).passed).toBe(true)
    expect(gateLevel('hard', [...old, ...loops(400).slice(0, 2), row('backwalk', 0), ...loops(400).slice(3)]).passed).toBe(false)
    expect(gateLevel('champion', [row('rushdown', 359), row('turtle', 400), ...loops(400)]).passed).toBe(true)
    // Hard's 12-of-12 loss to a zoner is nowhere near the bar; a 0.7 score (lower bound below 0.65) fails Champion's 0.75.
    expect(gateLevel('champion', [row('rushdown', 359), row('turtle', 400), ...loops(400).slice(0, 2), row('backwalk', 300), ...loops(400).slice(3)]).passed).toBe(false)
  })

  test('fighter publication requires 400 games on each seat for every bot', () => {
    const seat = (games: number) => ({ games, wins: games, draws: 0, losses: 0, score: 1 })
    const rows = Object.keys(BARS.hard).map((bot) => ({ bot, games: 400, wins: 400, draws: 0, losses: 0, score: 1, ci95: [0, 1] as [number, number], bySeat: { '0': seat(200), '1': seat(200) } }))
    expect(gateLevel('hard', rows, BARS, true, 400).passed).toBe(false)
    const reg = buildFighterRegistry({ rows: { hard: rows }, models: { hard: { artifact: 'hard.onnx', absolute: __filename, source: 's', step: 1, obsFeatures: 162 } }, elo: { hard: 1200 }, gatedSnapshot: { hard: true }, commit: 'x', now: 'now', trainedSteps: 1 })
    expect(reg.levels.hard).toBeUndefined()
    const full = rows.map((r) => ({ ...r, games: 800, wins: 800, bySeat: { '0': seat(400), '1': seat(400) } }))
    expect(gateLevel('hard', full, BARS, true, 400).passed).toBe(true)
  })

  test('Champion may not trail Hard against a loop they are both gated on (tinderbox-r2: levels inverted against the poke loop)', () => {
    const rows = (poke: number, fire = 0.9): BotRow[] => [
      { bot: 'pokeloop', games: 400, wins: poke * 400, draws: 0, losses: 400 - poke * 400, score: poke, ci95: [0, 1] },
      { bot: 'fireball', games: 400, wins: fire * 400, draws: 0, losses: 400 - fire * 400, score: fire, ci95: [0, 1] },
    ]
    expect(championTrailsHard(rows(0.9), rows(0.95))).toBeNull()
    expect(championTrailsHard(rows(0.9), rows(0.89))).toBeNull() // inside the margin
    expect(championTrailsHard(rows(0.9), rows(0.8))).toContain('pokeloop')
    expect(championTrailsHard(rows(0.9), rows(0.95, 0.5))).toContain('fireball')
    expect(championTrailsHard([], rows(0.1))).toBeNull() // nothing to compare against
  })

  test('measured failed Champion reports the actual failure and Practice snapshot', () => {
    const rows = JSON.parse(readFileSync(new URL('../../eval/fighter/b5-champion.json', import.meta.url), 'utf8')) as BotRow[]
    const reg = buildFighterRegistry({ rows: { champion: rows }, models: { champion: { artifact: 'champion.onnx', absolute: __filename, source: 'runs/fighter-league-b5/gated/champion/snap-champion-0026017792.pt', step: 26017792, obsFeatures: 162 } }, elo: {}, gatedSnapshot: { champion: false }, servedPractice: { champion: true }, commit: 'x', now: 'now', trainedSteps: 1 })
    expect(reg.unpublished?.champion).toContain('fireball on seat 1')
    expect(reg.unpublished?.champion).toContain('264 wins, 48 draws of 400')
    expect(reg.unpublished?.champion).toContain('Practice serves')
    expect(reg.unpublished?.champion).not.toContain('no snapshot cleared')
    expect(reg.versions[0]!.sha256['champion.onnx']).toBeDefined()
  })

  test('Champion that loses to Hard head to head is not published even when the trail rule passes', () => {
    const full = (): BotRow[] => ['random', 'rushdown', 'turtle', 'zoner', 'throwloop', 'backwalk', 'pokeloop', 'sweepspam', 'fireball', 'throwtap', 'fireball25'].map((bot) => ({ bot, games: 800, wins: 800, draws: 0, losses: 0, score: 1, ci95: [0.99, 1], bySeat: { '0': { games: 400, wins: 400, draws: 0, losses: 0, score: 1 }, '1': { games: 400, wins: 400, draws: 0, losses: 0, score: 1 } } }))
    const pairs = (score: number) => [
      { lower: 'easy' as const, upper: 'medium' as const, score: 0.8, n: 400 },
      { lower: 'medium' as const, upper: 'hard' as const, score: 0.8, n: 400 },
      { lower: 'hard' as const, upper: 'champion' as const, score, n: 400 },
    ]
    expect(fighterLevelFailures(null, pairs(0.6))).toBeUndefined()
    const bad = fighterLevelFailures(null, pairs(0.3))
    expect(Object.keys(bad ?? {})).toEqual(['champion'])
    expect(bad!.champion).toContain('champion does not beat hard')
    const reg = buildFighterRegistry({
      rows: { hard: full(), champion: full() },
      models: { hard: { artifact: 'apps/web/public/agents/fighter/v1/hard.onnx', absolute: __filename, source: 's', step: 1, obsFeatures: 1 }, champion: { artifact: 'apps/web/public/agents/fighter/v1/champion.onnx', absolute: __filename, source: 's', step: 1, obsFeatures: 1 } },
      levelFailures: bad,
      elo: { hard: 1800, champion: 1650 },
      gatedSnapshot: { hard: true, champion: true },
      commit: 'x',
      now: 'now',
      trainedSteps: 2,
    })
    expect(Object.keys(reg.levels)).toEqual(['hard'])
    expect(reg.unpublished?.champion).toContain('champion does not beat hard')
  })
})
