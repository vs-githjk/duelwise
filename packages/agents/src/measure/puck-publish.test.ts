import { describe, expect, test } from 'bun:test'
import { parseRegistry } from '../registry'
import { build, goodPairs, measure, model, pair, seat, strong } from './puck-fixtures'
import { levelVerdict, pairVerdict } from './puck-publish'

// The puck registry builder, from synthetic measurements (puck-fixtures.ts): what publishes, what stays in training and why. The page's
// reading of the result is tested in apps/web/src/lib/strength-gates.test.ts; the measurements themselves in puck-compliance.test.ts.

describe('buildPuckRegistry', () => {
  test('publishes every level that clears its bars, with Elo from the ladder and Pip anchored at 1000', () => {
    const reg = build(strong, goodPairs)
    expect(Object.keys(reg.levels)).toEqual(['easy', 'medium', 'hard', 'champion'])
    expect(reg.measured.easy!.siteElo).toBe(1000)
    const elo = (['easy', 'medium', 'hard', 'champion'] as const).map((l) => reg.measured[l]!.siteElo)
    expect(elo.every((e, i) => i === 0 || e > elo[i - 1]!)).toBe(true)
    expect(reg.unpublished).toEqual({})
    expect(reg.levels.easy!.config).toMatchObject({ scripted: true, kind: 'pip' })
    expect(reg.levels.medium!.config).toMatchObject({ kind: 'marlow', model: 'hard.onnx', delayMs: 250, replyLagTicks: 1 })
    // A9: a level that ships its own network no longer carries the hint that it borrows Vesper's.
    expect(reg.levels.medium!.config).not.toHaveProperty('network')
    expect(Object.keys(reg.versions[0]!.sha256)).toEqual(['hard.onnx', 'champion.onnx'])
  })

  test('a level one bot beats on one seat stays in training, with a reason that names that bot and seat', () => {
    const levels = { ...strong, hard: { measure: measure('hard', 392, { only: { banker: 230 } }), model } }
    const reg = build(levels, goodPairs)
    expect(reg.levels.hard).toBeUndefined()
    expect(reg.measured.hard).toBeUndefined()
    expect(reg.unpublished!.hard).toMatch(/^in training: banker: 230 of 400, Wilson lower bound 0\.5\d+ on seat 0 is below 0\.6/)
    expect(reg.unpublished!.hard).not.toContain('striker')
    expect(reg.unpublishedConfig!.hard).toMatchObject({ kind: 'vesper', limits: 'hard' })
  })

  test('a level that does not beat the level below from both seats is not published, even if it clears its bots', () => {
    const reg = build(strong, [pair('easy', 'medium', 300, 300), pair('medium', 'hard', 380, 190), pair('hard', 'champion', 300, 300)])
    expect(reg.levels.hard).toBeUndefined()
    expect(reg.unpublished!.hard).toContain('does not beat medium')
    expect(reg.unpublished!.hard).toContain('seat 1')
  })

  test('Champion is held back by a shot lane above 50%, and by a mallet above its speed cap', () => {
    expect(levelVerdict('champion', { measure: measure('champion', 360, { lanes: [10, 90, 10] }), model }, goodPairs).failures.join(' ')).toContain('shot lane')
    expect(levelVerdict('champion', { measure: measure('champion', 360, { peakSpeed: 6.4 }), model }, goodPairs).failures.join(' ')).toContain('peak mallet speed')
    expect(levelVerdict('champion', { measure: measure('champion', 360), model }, goodPairs).passed).toBe(true)
  })

  test('the strict and the human-limits outcomes record which bots Champion beat', () => {
    expect((build(strong, goodPairs, 'live').versions[0]!.gate as any).levels.champion.botLimits).toBe('live')
    expect((build(strong, goodPairs, 'human').versions[0]!.gate as any).levels.champion.botLimits).toBe('human')
    expect(build(strong, goodPairs, 'live').measured.champion!.opponents).toBe('scripted bots that see the live game')
    expect(build(strong, goodPairs, 'human').measured.champion!.opponents).toContain('same limits')
  })

  test('a human-hands measurement is labelled as such on every level, with the slower person run reported beside it', () => {
    const hands = (m: ReturnType<typeof measure>, delay: number) => ({ ...m, botHands: 'human' as const, botDelay: delay })
    const levels = Object.fromEntries(Object.entries(strong).map(([k, v]) => [k, { ...v!, measure: hands(v!.measure, 12), slower: hands(v!.measure, 18) }])) as typeof strong
    const reg = build(levels, goodPairs, 'human-hands')
    const gate = reg.versions[0]!.gate as any
    expect(gate.levels.hard.botLimits).toBe('human-hands')
    expect(gate.levels.hard.botDelayFrames).toBe(12)
    expect(gate.levels.hard.slowerHuman.botDelayFrames).toBe(18)
    expect(gate.rule).toContain('human hands')
    expect(reg.measured.hard!.opponents).toContain('rule mallet')
    expect(reg.measured.hard!.opponents).toContain('12-frame')
  })

  test('pairVerdict needs both seats above 0.5 by Wilson lower bound over 400 each', () => {
    expect(pairVerdict(pair('easy', 'medium', 260, 260)).passed).toBe(true)
    expect(pairVerdict(pair('easy', 'medium', 300, 215)).passed).toBe(false)
    expect(pairVerdict({ ...pair('easy', 'medium', 300, 300), bySeat: { '0': seat(150, 200), '1': seat(150, 200) } }).passed).toBe(false)
  })

  test('the registry validates and carries no machine path or secret', () => {
    const text = JSON.stringify(build(strong, goodPairs))
    expect(text).not.toMatch(/\/Users\//)
    expect(parseRegistry(JSON.parse(text)).game).toBe('puck')
  })
})
