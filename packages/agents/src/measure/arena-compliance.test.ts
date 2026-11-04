import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { PUBLISHED_V1 } from '../arena/agent'
import { parseRegistry } from '../registry'
import { ARENA_BARS, aimCap, applyLevelsRule, chainElo, gateArenaLevel, pairLowerBound, recordArenaGame, stressArenaPresses, type ArenaLadderPair, type ArenaRecordedGame } from './arena'
import { wilson } from './ladder'
import { GATE_MATCHES, maxPressesPerMinute, medianLag, type BotRow } from './fighter'

const V1 = join(import.meta.dir, '../../../../apps/web/public/agents/arena/v1')
const V2_FIXTURE = join(import.meta.dir, '../../test-fixtures/arena-v2-hard-b2.onnx')
/** The b2 gated Medium snapshot (step 10,027,008), v2 export. It cleared the scripted-bot gate but not the Levels rule, so it is not served; its limits are still under test. */
const MEDIUM_FIXTURE = join(import.meta.dir, '../../test-fixtures/arena-v2-medium-b2.onnx')
const load = async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer())
/** A published level plays its published model; Medium (in training) plays its own gated snapshot and Champion the b2 Hard fixture (its limits are what is under test). */
const modelFor = (level: Level) => load(PUBLISHED_V1.includes(level) || level === 'easy' ? `${V1}/${level}.onnx` : level === 'medium' ? MEDIUM_FIXTURE : V2_FIXTURE)

// Recorded ladder games: the real agents (ONNX policy, limiter, delayed view) play each other on the real core.
const games = new Map<Level, ArenaRecordedGame[]>()
const LEVELS = ['easy', 'medium', 'hard', 'champion'] as const

describe('arena limiter compliance over recorded games', () => {
  test('records the games', async () => {
    for (const [i, level] of LEVELS.entries()) {
      const bytes = await modelFor(level)
      games.set(level, [await recordArenaGame({ level, bytes }, { level, bytes }, 31 + i, 60 * 60 * 3)])
    }
    for (const g of games.values()) for (const r of g) expect(r.seats[0]!.decisions.length).toBeGreaterThan(200)
  }, 600_000)

  for (const level of ['easy', 'medium', 'hard'] as const) {
    test(`${level}: median reaction is at least the delay, APM within the cap, aim turn and noise within config`, () => {
      const cfg = LEVEL_LIMITS.arena[level]
      const recorded = games.get(level)!
      for (const seat of [0, 1] as const) {
        const lags = recorded.flatMap((g) => g.seats[seat]!.lags)
        expect(lags.length).toBeGreaterThan(200)
        expect(medianLag(lags)).toBeGreaterThanOrEqual(cfg.delayFrames)
        for (const g of recorded) expect(maxPressesPerMinute(g.seats[seat]!.pressFrames)).toBeLessThanOrEqual(cfg.apmCap!)
        const { yawMax, pitchMax } = aimBounds(level)
        const turns = recorded.flatMap((g) => g.seats[seat]!.aim)
        expect(turns.length).toBeGreaterThan(200)
        expect(Math.max(...turns.map((t) => Math.abs(t[0])))).toBeLessThanOrEqual(yawMax)
        expect(Math.max(...turns.map((t) => Math.abs(t[1])))).toBeLessThanOrEqual(pitchMax)
      }
    })

    test(`${level}: a seat that proposes a new press on every decision never exceeds the cap in any minute`, () => {
      const cfg = LEVEL_LIMITS.arena[level]
      for (const automatic of [false, true]) {
        const { presses, windowMax } = stressArenaPresses(cfg, 5 * 3600, 7, automatic)
        expect(maxPressesPerMinute(presses)).toBeLessThanOrEqual(cfg.apmCap!)
        expect(maxPressesPerMinute(presses)).toBeGreaterThan(cfg.apmCap! * 0.9)
        expect(windowMax).toBeLessThanOrEqual(cfg.apmCap!)
      }
    })
  }

  test('champion: the delay equals the configured minimum, there is no cap and no aim limit', () => {
    const cfg = LEVEL_LIMITS.arena.champion
    expect(cfg.delayFrames).toBe(PRODUCT.championMinDelayFrames)
    expect(cfg.apmCap).toBeNull()
    expect(cfg.aimRateDegPerSec).toBeNull()
    const g = games.get('champion')!
    expect(medianLag(g.flatMap((r) => r.seats[0]!.lags))).toBeGreaterThanOrEqual(PRODUCT.championMinDelayFrames)
    expect(Math.min(...g.flatMap((r) => r.seats[0]!.lagsAfterWarmup))).toBeGreaterThanOrEqual(PRODUCT.championMinDelayFrames)
  })

  test('an agent built without its level delay or aim limit is caught', async () => {
    const bytes = await load(V2_FIXTURE)
    // Easy: its aim cap (165 degrees per second) is below the policy's largest turn bin, so the limit binds. Hard's does not.
    const easy = LEVEL_LIMITS.arena.easy
    const free = { ...easy, delayFrames: 0, aimRateDegPerSec: null }
    const g = await recordArenaGame({ level: 'easy', bytes, limits: free }, { level: 'easy', bytes, limits: free }, 41, 60 * 60)
    expect(medianLag(g.seats[0]!.lags)).toBeLessThan(easy.delayFrames)
    expect(Math.max(...g.seats[0]!.aim.map((t) => Math.abs(t[0])))).toBeGreaterThan(aimBounds('easy').yawMax)
    const ok = await recordArenaGame({ level: 'easy', bytes }, { level: 'easy', bytes }, 41, 60 * 60)
    expect(medianLag(ok.seats[0]!.lags)).toBeGreaterThanOrEqual(easy.delayFrames)
    expect(Math.max(...ok.seats[0]!.aim.map((t) => Math.abs(t[0])))).toBeLessThanOrEqual(aimBounds('easy').yawMax)
  }, 120_000)

  test('the historical registry contains the levels the agent loads from v1, with their recorded gate results', async () => {
    const reg = parseRegistry(await Bun.file(join(import.meta.dir, '../../registry/arena.json')).json())
    for (const level of PUBLISHED_V1) expect(reg.levels[level]).toBeDefined()
    for (const level of PUBLISHED_V1) {
      const name = `${level}.onnx`
      const bytes = await Bun.file(join(V1, name)).arrayBuffer()
      expect(reg.versions[0]!.sha256[name]).toBe(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'))
      const m = reg.measured[level]!
      // KC2: the claim rests on the weakest seat of the weakest bot, 200 matches.
      expect(m.n).toBeGreaterThanOrEqual(GATE_MATCHES / 2)
      expect(m.ci95[0]).toBeGreaterThanOrEqual(Math.min(...Object.values(ARENA_BARS[level])))
    }
    for (const level of LEVELS.filter((l) => !reg.levels[l])) expect(reg.unpublished?.[level]).toMatch(/^in training: /)
  })

  test('the published gate results are retained: four levels, the chain easy>medium>hard>champion, every bar cleared on each seat', async () => {
    const raw = (await Bun.file(join(import.meta.dir, '../../registry/arena.json')).json()) as { versions: Array<{ trainedSteps: number; gate: { ladder: { pairs: ArenaLadderPair[]; note: string }; levels: Record<string, { bots: Array<{ bot: string; bar: number | null; lower: number }> | null }> } }> }
    const reg = parseRegistry(raw)
    expect(Object.keys(reg.levels)).toEqual(['easy', 'medium', 'hard', 'champion'])
    expect(Object.keys(reg.measured)).toEqual(['easy', 'medium', 'hard', 'champion'])
    expect(reg.measured.champion!.siteElo).toBeGreaterThan(reg.measured.hard!.siteElo!)
    expect(reg.measured.hard!.siteElo).toBeGreaterThan(reg.measured.medium!.siteElo!)
    expect(reg.measured.medium!.siteElo).toBeGreaterThan(reg.measured.easy!.siteElo!)
    // n is the games on the weakest seat: the gate plays GATE_MATCHES per seat per bot.
    expect(reg.measured.champion!.n).toBe(GATE_MATCHES)
    expect(raw.versions[0]!.gate.ladder.pairs.map((p) => `${p.lower}>${p.upper}`)).toEqual(['easy>medium', 'medium>hard', 'hard>champion'])
    for (const p of raw.versions[0]!.gate.ladder.pairs) expect(pairLowerBound(p)).toBeGreaterThan(0.5)
    expect(raw.versions[0]!.trainedSteps).toBe(8_028_160 + 36_003_840 + 12_025_856)
    // Every level carries all six scripted bots plus the Easy human-proxy bot (R46), and clears every bar on each seat.
    for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
      const bots = raw.versions[0]!.gate.levels[level]!.bots!
      expect(bots.map((b) => b.bot).sort()).toEqual(['holdangle', 'holder', 'human-proxy', 'peeker', 'random', 'rusher', 'strafe'])
      expect(bots.some((b) => b.bar !== null && b.lower < b.bar)).toBe(false)
    }
    expect(reg.unpublished ?? {}).toEqual({})
  })

  test('applyLevelsRule pairs a failing level out and re-pairs the next against the published level below', async () => {
    const played: string[] = []
    const scores: Record<string, number> = { 'easy>medium': 207, 'easy>hard': 251, 'hard>champion': 190 }
    const r = await applyLevelsRule(
      ['easy', 'medium', 'hard', 'champion'],
      async (lower, upper) => {
        played.push(`${lower}>${upper}`)
        return scores[`${lower}>${upper}`]!
      },
      400,
    )
    expect(played).toEqual(['easy>medium', 'easy>hard', 'hard>champion'])
    expect(r.published).toEqual(['easy', 'hard'])
    expect(r.failures.medium).toMatch(/^in training: medium does not beat easy: .*not above 0\.5/)
    expect(r.failures.champion).toMatch(/^in training: /)
    expect(pairLowerBound(r.pairs[1]!)).toBeGreaterThan(0.5)
    const elo = chainElo(r.published, r.pairs, 1000)
    expect(elo.easy).toBe(1000)
    expect(elo.hard!).toBeGreaterThan(1000)
    expect(elo.medium).toBeUndefined()
  })

  test('gateArenaLevel applies the bars to Wilson lower bounds, and short or missing samples fail', () => {
    // Rows as eval_bots.py reports them: the games split evenly over the two seats (KC2: the gate needs each seat to clear the bar by itself).
    const seat = (games: number, wins: number) => ({ games, wins, draws: 0, losses: games - wins, score: wins / games })
    const row = (bot: string, wins: number, games = 800): BotRow => ({
      bot, games, wins, draws: 0, losses: games - wins, score: wins / games, ci95: [0, 1],
      bySeat: { '0': seat(games / 2, Math.floor(wins / 2)), '1': seat(games / 2, wins - Math.floor(wins / 2)) },
    })
    const all = (hold: number, rest = 800): BotRow[] => [row('random', 800), row('rusher', rest), row('holder', hold), row('peeker', rest), row('strafe', rest), row('holdangle', rest)]
    expect(gateArenaLevel('hard', all(560)).passed).toBe(true)
    expect(gateArenaLevel('hard', all(500)).passed).toBe(false)
    expect(gateArenaLevel('hard', [row('random', 400), row('rusher', 400), row('holder', 400, 100), row('peeker', 400), row('strafe', 400), row('holdangle', 400)]).passed).toBe(false)
    expect(gateArenaLevel('hard', [row('random', 400), row('holder', 400)]).failures.join()).toContain('rusher')
    // R30: the human-proxy bots count. A level that beats rusher and holder but loses to the peeker, the strafer or the angle holder does not pass.
    for (const weak of ['peeker', 'strafe', 'holdangle']) {
      const rows = all(800).map((r) => (r.bot === weak ? row(weak, 200) : r))
      expect(gateArenaLevel('hard', rows).passed, weak).toBe(false)
      expect(gateArenaLevel('hard', rows).failures.join()).toContain(weak)
    }
    // KC2: a level that averages well but loses one seat does not pass.
    const lopsided = all(800).map((r) => (r.bot === 'holder' ? { ...r, wins: 600, losses: 200, score: 0.75, bySeat: { '0': seat(400, 400), '1': seat(400, 200) } } : r))
    expect(gateArenaLevel('hard', lopsided).passed).toBe(false)
    expect(gateArenaLevel('hard', lopsided).failures.join()).toContain('holder on seat 1')
    expect(gateArenaLevel('champion', [row('rusher', 718), row('holder', 800), row('peeker', 800), row('strafe', 800), row('holdangle', 800)]).passed).toBe(true)
  })
})

/** The largest per-frame turn the config allows: the clamp plus the jitter bound (noise degrees spread over the 4 frames of a decision). */
function aimBounds(level: Level): { yawMax: number; pitchMax: number } {
  const cfg = LEVEL_LIMITS.arena[level]
  const cap = aimCap(cfg)
  const jitter = Math.ceil((cfg.aimNoiseDeg! * (8192 / 360)) / 4) + 1
  return { yawMax: cap + jitter, pitchMax: cap + jitter }
}
