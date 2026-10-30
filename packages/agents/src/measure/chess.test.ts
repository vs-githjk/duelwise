import { describe, expect, test } from 'bun:test'
import { Chess } from 'chess.js'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { encodeAbs } from '@duelwise/core/src/games/chess/policy-index'
import type { PreviewAgent } from '../agent-types'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CHAMPION_SEARCH, CHESS_LEVELS } from '../chess/agent'
import { assertCleanTree, chessSeatGate, twoPlyGate, publishChessLadder, cacheFor, createOpeningCore, entriesFor, measureFingerprint, type FingerprintInputs, samplePositions, solvesPuzzle, workingTreeHash } from './chess'
import { parseRegistry } from '../registry'
import { readFileSync } from 'node:fs'

/** An agent that plays a fixed list of moves, in order. */
function scripted(moves: string[]): PreviewAgent {
  let i = 0
  return { preview: false, reset: () => (i = 0), act: async () => [encodeAbs(moves[i++]!)], dispose() {} }
}

test('chess gate requires 400 games and a passing Wilson bound on each seat', () => {
  const games = (n: number, score: number) => Array.from({ length: n }, (_, index) => ({ seatOfA: (index % 2) as 0 | 1, scoreA: score }))
  expect(chessSeatGate(games(400, 1), 0.5).passed).toBe(false)
  expect(chessSeatGate(games(800, 1), 0.5).passed).toBe(true)
  const lopsided = games(800, 1).map((g) => ({ ...g, scoreA: g.seatOfA === 0 ? 1 : 0 }))
  expect(chessSeatGate(lopsided, 0.5).passed).toBe(false)
})

test('2-ply gate requires 400 games, pooled 0.7 and each seat 0.6', () => {
  const games = (seat0: number, seat1: number, count = 200) => ([0, 1] as const).flatMap((seat) => Array.from({ length: count }, (_, index) => ({ seatOfA: seat, scoreA: index < (seat === 0 ? seat0 : seat1) ? 1 : 0 })))
  expect(twoPlyGate(games(120, 160)).passed).toBe(true)
  expect(twoPlyGate(games(119, 161)).passed).toBe(false)
  expect(twoPlyGate(games(120, 159)).passed).toBe(false)
  expect(twoPlyGate(games(120, 160, 199)).passed).toBe(false)
})

test('failed chess gates publish the passing prefix without throwing', () => {
  const registry = parseRegistry(JSON.parse(readFileSync(join(import.meta.dir, '../../registry/chess.json'), 'utf8')))
  const stats = { points: 700, n: 800, score: 0.875, ci95: [0.8, 0.9] as [number, number], stoppedEarly: false, passed: true }
  const ladder = { game: 'chess' as const, levels: ['easy', 'medium', 'hard', 'champion'] as const, pairs: ([['easy', 'medium'], ['medium', 'hard'], ['hard', 'champion']] as const).map(([lower, upper]) => ({ lower, upper, ...stats })), baseline: { label: 'random', ...stats }, elo: { easy: 1000, medium: 1100, hard: 1200, champion: 1300 } }
  const meta = { harness: 'bun' as const, commit: 'test', measuredAt: '2026-01-01', version: 'v1' }
  const failed = publishChessLadder(registry, { ...ladder, levels: [...ladder.levels] }, meta, false)
  expect(Object.keys(failed.measured)).toEqual(['easy', 'medium'])
  expect(failed.unpublished?.hard).toContain('2-ply')
  expect(failed.unpublished?.champion).toContain('hard')
  const baseline = publishChessLadder(registry, { ...ladder, levels: [...ladder.levels], baseline: { ...ladder.baseline, passed: false } }, meta, true)
  expect(Object.keys(baseline.measured)).toHaveLength(0)
  expect(baseline.unpublished?.easy).toContain('random')
})

describe('chess measurement helpers', () => {
  test('the opening core gives the two colour-swapped games one opening, other pairs another, and never starts terminal', () => {
    const core = createOpeningCore()
    expect(core.init(10).fen).toBe(core.init(11).fen)
    expect(core.init(10).fen).toBe(core.init(10).fen)
    const fens = new Set(Array.from({ length: 20 }, (_, k) => core.init(2 * k).fen))
    expect(fens.size).toBeGreaterThan(15)
    for (let k = 0; k < 50; k++) expect(core.terminal(core.init(k))).toBe(false)
    expect(core.init(0, { fen: chessCore.init(0).fen }).fen).toBe(chessCore.init(0).fen)
  })

  test('sample positions are fixed by the seed', () => {
    expect(samplePositions(10)).toEqual(samplePositions(10))
    expect(samplePositions(10, 6)).not.toEqual(samplePositions(10))
  })

  test('a puzzle is solved only when every solver move matches', async () => {
    // Lichess form: the first move belongs to the opponent. White errs with a2a3, black must find the mate d8h4.
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR w KQkq - 0 2'
    const puzzle = { id: 'x', fen, moves: ['a2a3', 'd8h4'], rating: 900, band: 1 }
    expect(await solvesPuzzle(scripted(['d8h4']), puzzle, 1)).toBe(true)
    expect(await solvesPuzzle(scripted(['a7a6']), puzzle, 1)).toBe(false)
  })

  test('another mate than the one in the line is accepted, a non-mating alternative is not', async () => {
    const fen = 'k7/8/1K6/8/8/8/8/6RR b - - 0 1'
    const c = new Chess('k7/8/1K6/8/8/8/8/6RR b - - 0 1')
    c.move('Kb8')
    const mates = c.moves({ verbose: true }).filter((m) => { c.move(m); const mate = c.isCheckmate(); c.undo(); return mate }).map((m) => m.lan)
    expect(mates).toContain('g1g8')
    expect(mates).toContain('h1h8')
    const puzzle = { id: 'y', fen, moves: ['a8b8', 'g1g8'], rating: 1200, band: 1 }
    expect(await solvesPuzzle(scripted(['g1g8']), puzzle, 1)).toBe(true)
    expect(await solvesPuzzle(scripted(['h1h8']), puzzle, 1)).toBe(true)
    expect(await solvesPuzzle(scripted(['g1g2']), puzzle, 1)).toBe(false)
  })
})

describe('measurement cache fingerprint', () => {
  test('cached blocks are reused only under the same fingerprint', () => {
    const fp = measureFingerprint(1000)
    const raw = { fingerprint: fp, entries: { 'medium>easy:0-50': 32 } }
    expect(entriesFor<number>(raw, fp)).toEqual({ 'medium>easy:0-50': 32 })
    expect(entriesFor<number>(raw, measureFingerprint(1500))).toEqual({})
    expect(entriesFor<number>(raw, 'other-model-sha')).toEqual({})
  })

  test('a missing or old unstamped cache file yields nothing', () => {
    const fp = measureFingerprint(1000)
    expect(entriesFor<number>(null, fp)).toEqual({})
    expect(entriesFor<number>({ 'medium>easy:0-50': 32 }, fp)).toEqual({})
  })

  test('the fingerprint is stable for one budget and differs between budgets', () => {
    expect(measureFingerprint(1000)).toBe(measureFingerprint(1000))
    expect(measureFingerprint(1000)).not.toBe(measureFingerprint(2000))
  })
})

describe('measure fingerprint inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-'))
  writeFileSync(join(dir, 'value.bin'), 'aaa')
  const base = (): FingerprintInputs => ({ modelsDir: dir, levels: CHESS_LEVELS, search: CHAMPION_SEARCH, code: 'tree-1' })

  test('the same inputs give the same fingerprint', () => {
    expect(measureFingerprint(1000, base())).toBe(measureFingerprint(1000, base()))
  })

  test('a changed level config, search config or working-tree hash changes it', () => {
    const fp = measureFingerprint(1000, base())
    const lv = structuredClone(CHESS_LEVELS) as Record<string, { temperature?: number }>
    lv.medium!.temperature = 0.5
    expect(measureFingerprint(1000, { ...base(), levels: lv })).not.toBe(fp)
    expect(measureFingerprint(1000, { ...base(), search: { ...CHAMPION_SEARCH, maxDepth: 99 } })).not.toBe(fp)
    expect(measureFingerprint(1000, { ...base(), code: 'tree-2' })).not.toBe(fp)
  })

  test('a changed model file changes it, and a missing one differs from a present one', () => {
    const fp = measureFingerprint(1000, base())
    const other = mkdtempSync(join(tmpdir(), 'fp-'))
    writeFileSync(join(other, 'value.bin'), 'bbb')
    expect(measureFingerprint(1000, { ...base(), modelsDir: other })).not.toBe(fp)
    expect(measureFingerprint(1000, { ...base(), modelsDir: mkdtempSync(join(tmpdir(), 'fp-')) })).not.toBe(fp)
  })

  test('the default fingerprint hashes the working tree of packages/agents and packages/core', () => {
    expect(measureFingerprint(1000)).toMatch(/^[0-9a-f]{64}$/)
  })
})

function tempRepo(): { repo: string; git: (...a: string[]) => ReturnType<typeof spawnSync> } {
  const repo = mkdtempSync(join(tmpdir(), 'fp-git-'))
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  git('init', '-q')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'one')
  git('add', 'src/a.ts')
  git('commit', '-q', '-m', 'x')
  return { repo, git }
}

describe('working-tree hash (R17)', () => {
  test('it changes on an uncommitted edit, an untracked file and a deletion, and returns to the same value when undone', () => {
    const { repo } = tempRepo()
    const h0 = workingTreeHash(repo, ['src'])
    expect(workingTreeHash(repo, ['src'])).toBe(h0)
    writeFileSync(join(repo, 'src', 'a.ts'), 'two')
    const h1 = workingTreeHash(repo, ['src'])
    expect(h1).not.toBe(h0)
    writeFileSync(join(repo, 'src', 'b.ts'), 'new')
    const h2 = workingTreeHash(repo, ['src'])
    expect(h2).not.toBe(h1)
    writeFileSync(join(repo, 'src', 'a.ts'), 'one')
    spawnSync('rm', [join(repo, 'src', 'b.ts')])
    expect(workingTreeHash(repo, ['src'])).toBe(h0)
  })

  test('excluded folders (the registry that publish writes) do not change it', () => {
    const { repo } = tempRepo()
    mkdirSync(join(repo, 'src', 'registry'))
    writeFileSync(join(repo, 'src', 'registry', 'chess.json'), '1')
    const h = workingTreeHash(repo, ['src'], ['src/registry/'])
    writeFileSync(join(repo, 'src', 'registry', 'chess.json'), '2')
    expect(workingTreeHash(repo, ['src'], ['src/registry/'])).toBe(h)
  })
})

describe('publish never reads the caches (R17)', () => {
  const fp = 'fp-1'
  const stamped = () => {
    const d = mkdtempSync(join(tmpdir(), 'cache-'))
    writeFileSync(join(d, 'blocks.json'), JSON.stringify({ fingerprint: fp, entries: { 'medium>easy:0-50': 32 } }))
    return d
  }

  test('local mode reuses a stamped entry, publish mode starts empty even when a matching file exists', () => {
    const d = stamped()
    expect(cacheFor<number>('local', 'blocks.json', fp, d).entries).toEqual({ 'medium>easy:0-50': 32 })
    expect(cacheFor<number>('publish', 'blocks.json', fp, d).entries).toEqual({})
  })

  test('publish mode never writes the cache file either', () => {
    const d = stamped()
    cacheFor<number>('publish', 'blocks.json', fp, d).set('x', 1)
    expect(cacheFor<number>('local', 'blocks.json', fp, d).entries).toEqual({ 'medium>easy:0-50': 32 })
  })

  test('local mode persists what it computes', () => {
    const d = mkdtempSync(join(tmpdir(), 'cache-'))
    cacheFor<number>('local', 'blocks.json', fp, d).set('k', 7)
    expect(cacheFor<number>('local', 'blocks.json', fp, d).entries).toEqual({ k: 7 })
    expect(cacheFor<number>('local', 'blocks.json', 'other', d).entries).toEqual({})
  })
})

describe('publish refuses a dirty tree (R17)', () => {
  test('a clean tree passes; an edit or an untracked file anywhere refuses', () => {
    const { repo } = tempRepo()
    expect(() => assertCleanTree(repo)).not.toThrow()
    writeFileSync(join(repo, 'src', 'a.ts'), 'two')
    expect(() => assertCleanTree(repo)).toThrow(/dirty/)
    writeFileSync(join(repo, 'src', 'a.ts'), 'one')
    writeFileSync(join(repo, 'stray.txt'), 'x')
    expect(() => assertCleanTree(repo)).toThrow(/dirty/)
  })
})
