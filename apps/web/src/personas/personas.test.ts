import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'
import { LEVEL_LIMITS } from '@duelwise/core/src/limiter'
import { CHESS_LEVELS } from '@duelwise/agents/src/chess/agent'
import { LEVELS } from '../lib/level-info'
import { bioFor, PERSONAS, personaFor, reactionLimit, styleLine } from './index'
import { buildCast } from './cast'
import { AVATAR_SVG } from './avatar-svg'

const GAMES = Object.keys(PRODUCT.games) as GameId[]
const raw = readFileSync(join(import.meta.dirname, 'personas.json'), 'utf8')

test('one persona per level, in level order, each with a name, bio and a style line for every game', () => {
  expect(Object.keys(PERSONAS)).toEqual([...LEVELS])
  for (const level of LEVELS) {
    const p = personaFor(level)
    expect(p.name.length).toBeGreaterThan(0)
    expect(p.bio.length).toBeGreaterThan(0)
    for (const g of GAMES) expect(styleLine(level, g).length).toBeGreaterThan(0)
  }
  expect(LEVELS.map((l) => personaFor(l).name)).toEqual(['Pip', 'Marlow', 'Vesper', 'Sable'])
})

test('Champion chess copy makes no time limit promise', () => {
  expect(styleLine('champion', 'chess')).not.toMatch(/time limit|seconds|time cap/i)
})

test('guard: no persona string carries a number, a digit, a percent sign or an Elo claim', () => {
  const strings: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(JSON.parse(raw))
  const bad = strings.filter((s) => /\d|%|\bElo\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|once|twice)\b/i.test(s))
  expect(bad).toEqual([])
})

test('inlined avatars are identical to the files in public/personas', () => {
  for (const level of LEVELS) {
    const file = personaFor(level).avatar
    const onDisk = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'personas', file), 'utf8')
    expect(AVATAR_SVG[file]).toBe(onDisk.trimEnd())
  }
})

test('reaction limits come from the level config, the champion falls back to PRODUCT', () => {
  expect(reactionLimit('easy', undefined)).toBeNull()
  const cfg = { reactionFrames: PRODUCT.championMinDelayFrames + 5, apmCap: PRODUCT.championMinDelayFrames * 77 }
  const r = reactionLimit('medium', cfg)!
  expect(r.frames).toBe(cfg.reactionFrames)
  expect(r.apm).toBe(cfg.apmCap)
  expect(r.ms).toBe(Math.round((cfg.reactionFrames * 1000) / 60))
  expect(reactionLimit('champion', {})!.frames).toBe(PRODUCT.championMinDelayFrames)
  expect(reactionLimit('champion', {})!.apm).toBeNull()
})

function fixture(elo: number): Registry {
  const m = { metric: 'score vs medium', value: 0.7, ci95: [0.6, 0.8] as [number, number], n: 10, opponents: 'medium', siteElo: elo, measuredAt: 'x', harness: 'bun' as const, commit: 'c' }
  return {
    game: 'fighter', champion: 'v1', learnsFromHumans: false,
    versions: [{ version: 'v1', parent: null, createdAt: 'x', promotedAt: null, status: 'measured', artifacts: {}, sha256: {}, trainedSteps: 0, humanMatchesUsed: 0, gate: null }],
    levels: { easy: { version: 'v1', config: {} }, medium: { version: 'v1', config: { reactionFrames: 9, apmCap: 123 } } },
    measured: { easy: { ...m, siteElo: elo }, medium: { ...m, siteElo: elo + 400.4 } },
    unpublished: { hard: 'hard does not beat medium' },
  } as Registry
}

test('cast table reads strength and limits from the registries and says in training otherwise', () => {
  const elo = 1234
  const rows = buildCast({ fighter: fixture(elo), four: fixture(elo) })
  const four = rows.find((r) => r.game === 'four')!
  expect(four.cells.medium.state === 'measured' && four.cells.medium.reaction).toBeNull()
  const fighter = rows.find((r) => r.game === 'fighter')!
  expect(four.cells.easy).toEqual({ state: 'measured', strength: `site Elo ${elo}`, reaction: null })
  expect(four.cells.medium.state === 'measured' && four.cells.medium.strength).toBe(`site Elo ${Math.round(elo + 400.4)}`)
  expect(fighter.cells.medium.state === 'measured' && fighter.cells.medium.reaction).toEqual({ frames: 9, ms: 150, apm: 123 })
  expect(four.cells.hard.state).toBe('in-training')
  // R30/JC3: a realtime level shows the plain measured line, never a site Elo chained from an Easy players do not face.
  for (const l of LEVELS as readonly Level[]) {
    const c = fighter.cells[l]
    if (c.state === 'measured') expect(c.strength).not.toMatch(/site Elo/i)
  }
  const word = rows.find((r) => r.game === 'word')!
  for (const l of LEVELS as readonly Level[]) expect(word.cells[l].state).toBe('in-training')
})

test('guard: no style line claims a promotion or other event the registry may not show', () => {
  for (const level of LEVELS) {
    for (const g of GAMES) expect(styleLine(level, g).toLowerCase()).not.toContain('promoted')
  }
})

// Style lines are tested against each level's real config, so a retune that changes a behaviour fails here.
const REG_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'agents', 'registry')
const registryJson = (g: GameId) => JSON.parse(readFileSync(join(REG_DIR, `${g}.json`), 'utf8')) as Registry

test('chess and holdem levels show measured only where the registry measured them, and Practice otherwise', () => {
  const regs = { chess: registryJson('chess'), holdem: registryJson('holdem') }
  const rows = buildCast(regs)
  for (const game of ['chess', 'holdem'] as const) {
    const row = rows.find((entry) => entry.game === game)!
    for (const level of LEVELS) {
      const measured = regs[game].measured[level]
      const cell = row.cells[level as Level]
      if (measured) expect([game, level, cell]).toEqual([game, level, { state: 'measured', strength: `site Elo ${Math.round(measured.siteElo)}`, reaction: null }])
      else expect([game, level, cell.state]).toEqual([game, level, 'in-training'])
    }
  }
  // Hold'em Champion passes every seat at 1000 deals per seat (Nov 4 publish), so it is measured like the other three levels.
  expect(rows.find((entry) => entry.game === 'holdem')!.cells.champion.state).toBe('measured')
})

test('chess lines match the sampling config: temperature 0 picks the most likely move, a top-p cut avoids the long tail, plain sampling does neither', () => {
  const reg = registryJson('chess')
  for (const level of LEVELS as readonly Level[]) {
    const cfg = reg.levels[level]?.config ?? reg.unpublishedConfig?.[level] ?? {}
    const line = styleLine(level, 'chess')
    if (level === 'champion') continue
    // The code the agent runs, not only the registry: a guard or a logit margin means the top move is not always played.
    const code = CHESS_LEVELS[level as 'easy' | 'medium' | 'hard']
    const margin = (c: object) => Number((c as { logitMargin?: number }).logitMargin ?? 0)
    const hedged = code.guard !== undefined || margin(code) > 0 || margin(cfg) > 0
    if (hedged) expect(line).not.toMatch(/every time|always plays/i)
    if (code.guard === 'material') expect(line).toMatch(/hang|material/i)
    if (cfg.temperature === 0) expect(line).toMatch(/most likely/i)
    else {
      expect(line).not.toMatch(/leaning|best choice|most likely move/i)
      if (typeof cfg.topP === 'number') expect(line).toMatch(/rarely|long tail|unlikely/i)
      else expect(line).toMatch(/full spread|varied/i)
    }
  }
})

test('hold\'em lines describe each persona', () => {
  expect(styleLine('easy', 'holdem')).toMatch(/calls often and raises cautiously/i)
  expect(styleLine('medium', 'holdem')).toMatch(/calls often.*weaker starting hands/i)
  expect(styleLine('hard', 'holdem')).toMatch(/mixes bets.*strong starting hands/i)
  expect(styleLine('champion', 'holdem')).toMatch(/mixes choices.*strong starting hands/i)
})

test('no Champion line claims an action cap: the Champion has no APM cap and the other levels are the only ones with one', () => {
  for (const g of ['fighter', 'arena'] as const) {
    expect(LEVEL_LIMITS[g].champion.apmCap).toBeNull()
    expect(styleLine('champion', g)).not.toMatch(/\bcap\b|press faster/i)
    expect(personaFor('champion').bio).not.toMatch(/\bcap\b/i)
    for (const l of ['easy', 'medium', 'hard'] as const) expect(LEVEL_LIMITS[g][l].apmCap).not.toBeNull()
  }
})

test('Stormglass tells the truth about Sable: a scripted solver, not human-like play with a reaction limit; every other game and persona keeps its bio', () => {
  expect(bioFor('champion', 'fleet')).toBe('The house champion. A scripted solver, not a learned player.')
  // The style line already says how it fires, so the bio must not repeat it.
  expect(bioFor('champion', 'fleet')).not.toMatch(/most likely square/)
  expect(styleLine('champion', 'fleet')).toMatch(/most likely square/)
  expect(bioFor('champion', 'fleet')).not.toMatch(/Human-like|reaction limit/)
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    for (const game of ['chess', 'four', 'holdem', 'word', 'fighter', 'arena'] as const) expect(bioFor(level, game)).toBe(personaFor(level).bio)
    expect(bioFor(level)).toBe(personaFor(level).bio)
  }
  for (const level of ['easy', 'medium', 'hard'] as const) expect(bioFor(level, 'fleet')).toBe(personaFor(level).bio)
  expect(personaFor('champion').bio).toBe('The house champion. Human-like play with a carefully recorded reaction limit.')
})

test('Pip on Stormglass follows up a hit only 35 percent of the time, so the line says he usually forgets; the other games keep their lines', () => {
  expect(styleLine('easy', 'fleet')).toBe('Fires at random and usually forgets to follow up a hit.')
  expect(styleLine('easy', 'four')).toBe('Plays its learned policy with a little randomness and no look-ahead.')
})

test('Glasscut style lines are honest about who is hand-written and who shares a network', () => {
  expect(styleLine('easy', 'puck')).toMatch(/Hand-written, not trained/)
  expect(styleLine('medium', 'puck')).toMatch(/Vesper's network/)
  expect(styleLine('hard', 'puck')).toMatch(/trained agent/)
  expect(styleLine('champion', 'puck')).toMatch(/trained agent/)
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) expect(bioFor(level, 'puck')).toBe(personaFor(level).bio)
})

test('Crosscurrent has a true style line for each level and its Sable is a search program, not a human-like player', () => {
  expect(styleLine('easy', 'slack')).toBe('Grabs the most discs it can and loves a corner.')
  expect(styleLine('medium', 'slack')).toBe('Knows which squares matter and looks at your reply.')
  expect(styleLine('hard', 'slack')).toBe('Looks a few moves ahead and limits your options.')
  expect(styleLine('champion', 'slack')).toMatch(/endgame/)
  expect(styleLine('easy', 'penalty')).toMatch(/favourite corner/)
  expect(styleLine('champion', 'penalty')).toMatch(/habits/)
  expect(bioFor('champion', 'penalty')).toBe('The house champion. A habit reader, not a learned player.')
  for (const level of ['easy', 'medium', 'hard'] as const) expect(bioFor(level, 'penalty')).toBe(personaFor(level).bio)
  expect(bioFor('champion', 'slack')).toBe('The house champion. A search program, not a learned player.')
  expect(bioFor('champion', 'slack')).not.toMatch(/Human-like|reaction limit/)
  for (const level of ['easy', 'medium', 'hard'] as const) expect(bioFor(level, 'slack')).toBe(personaFor(level).bio)
})
