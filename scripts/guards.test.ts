import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { scanRoot } from './guards-lib'

const BANNED: { terms: string[]; caseSensitive: string[] } = JSON.parse(readFileSync(join(import.meta.dir, 'banned-terms.json'), 'utf8'))
const REJECTED_NAME = ['Beat', 'Me'].join(' ')

const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)

function fixture(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guards-test-')))
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  return root
}

test('clean fixture passes', () => {
  const root = fixture({ 'packages/core/src/a.ts': 'export const a = 1\n', 'README.md': 'Hello\n' })
  expect(scanRoot(root)).toEqual([])
})

test('em dash fails', () => {
  const root = fixture({ 'packages/core/src/a.ts': `// bad ${EM} dash\n` })
  expect(scanRoot(root).length).toBe(1)
})

test('en dash fails', () => {
  const root = fixture({ 'docs/x.md': `1${EN}2\n` })
  expect(scanRoot(root).length).toBe(1)
})

test('banned terms fail, case-insensitive', () => {
  for (const t of BANNED.terms) {
    const root = fixture({ 'apps/web/src/a.tsx': `export const x = "play ${t} now"\n` })
    expect(scanRoot(root).length, t).toBeGreaterThan(0)
    const lower = fixture({ 'apps/web/src/a.tsx': `export const x = "${t.toLowerCase()}"\n` })
    if (!BANNED.caseSensitive.includes(t)) expect(scanRoot(lower).length, t).toBeGreaterThan(0)
  }
})

test('rejected name fails outside plan', () => {
  const root = fixture({ 'README.md': `Welcome to ${REJECTED_NAME}\n` })
  expect(scanRoot(root).length).toBe(1)
  const ok = fixture({ 'plan/x.md': `${REJECTED_NAME} rejected\n` })
  expect(scanRoot(ok)).toEqual([])
})

test('banned-terms.json and game-design docs are excluded', () => {
  const root = fixture({
    'scripts/banned-terms.json': `{"terms":["${BANNED.terms[0]}"]}`,
    'docs/game-design/fighter.md': `Source: ${BANNED.terms[0]} frame data\n`,
  })
  expect(scanRoot(root)).toEqual([])
})

test('numeric percent or Elo literals in web copy fail', () => {
  const root = fixture({ 'apps/web/src/a.tsx': 'export const A = () => <p>Wins 63% of games</p>\n' })
  expect(scanRoot(root).length).toBe(1)
  const root2 = fixture({ 'apps/web/src/a.tsx': 'export const A = () => <p>Rated 1800 Elo</p>\n' })
  expect(scanRoot(root2).length).toBe(1)
})

test('percent literals are caught beside className and plain words', () => {
  for (const body of [
    '<p className="stat">Wins 63% of games</p>',
    '<p>Top players lose 70% of the time</p>',
    '<p>Bigger size, wins 63% of games</p>',
    '<p>Rated 1800 ELO</p>',
  ]) {
    const root = fixture({ 'apps/web/src/a.tsx': `export const A = () => ${body}\n` })
    expect(scanRoot(root).length, body).toBe(1)
  }
})

test('Tailwind arbitrary values are not flagged', () => {
  for (const body of [
    '<div className="w-[50%] h-full" />',
    '<div className="translate-x-[10%]" />',
    "<div className={cn('w-[50%]', { on: x })} />",
    '<div className={cn(\n  \'absolute w-[50%] h-full\',\n  extra,\n)} />',
  ]) {
    const root = fixture({ 'apps/web/src/a.tsx': `export const A = () => ${body}\n` })
    expect(scanRoot(root), body).toEqual([])
  }
})

test('guard-allow marker exempts its own line only', () => {
  const root = fixture({
    'apps/web/src/a.tsx': 'const w = "calc(100% - 4px)" // guard-allow: css length\nconst s = "Wins 63% of games"\n',
  })
  const v = scanRoot(root)
  expect(v.length).toBe(1)
  expect(v[0].line).toBe(2)
  const bare = fixture({ 'apps/web/src/a.tsx': 'const w = "calc(100% - 4px)" // guard-allow:\n' })
  expect(scanRoot(bare).length).toBe(1)
})

test('css files are not scanned as web copy', () => {
  const root = fixture({ 'apps/web/src/a.css': '.a { width: 50%; }\n' })
  expect(scanRoot(root)).toEqual([])
})

test('copy that looks like CSS keys or comments still flags (R5)', () => {
  for (const body of [
    '<StatCard top="Champion wins 90% of games" />',
    'const s = { offset: "Down 30% this week" }',
    'const s = { width: "Wins 63% of games" }',
    '<p>\n * Wins 63% of games\n</p>',
    '<p>\n  * 90% of players quit\n</p>',
  ]) {
    const root = fixture({ 'apps/web/src/a.tsx': `export const A = () => ${body}\n` })
    expect(scanRoot(root).length, body).toBeGreaterThan(0)
  }
})

test('binary model files are not scanned, even with no NUL in the first 4 KB', () => {
  const term = BANNED.terms[0]
  const late = 'x'.repeat(5000) + term + '\u0000\n'
  const root = fixture({
    'apps/web/public/agents/four/hard.onnx': `${term}\n`,
    'apps/web/public/agents/chess/value.bin': `${term}\n`,
    'training/trainer/ckpt.pt': `${term}\n`,
    'packages/core/src/blob.dat': late,
  })
  expect(scanRoot(root)).toEqual([])
  const text = fixture({ 'packages/core/src/a.ts': `// ${term}\n` })
  expect(scanRoot(text).length).toBe(1)
})

test('the repo itself passes', () => {
  const repo = join(import.meta.dir, '..')
  expect(scanRoot(repo)).toEqual([])
})
