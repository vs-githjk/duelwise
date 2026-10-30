import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assemble, copiedCodeFiles, dependencyLicences, findProblems, packFolders } from './third-party'

const REPO = join(import.meta.dir, '..')

function fixture(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'third-party-test-')))
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  return root
}

const PACK = 'apps/web/public/assets/fighter/quaternius/universal-animation-library'

describe('packFolders', () => {
  test('finds every <category>/<source>/<pack> folder under the assets root, and nothing above or below', () => {
    const root = fixture({
      [`${PACK}/License.txt`]: 'CC0',
      [`${PACK}/models/a.glb`]: 'x',
      'apps/web/public/assets/ui/kenney/impact-sounds/License.txt': 'CC0',
      'apps/web/public/assets/ui/stray.txt': 'not a pack',
    })
    expect(packFolders(root).map((p) => p.path)).toEqual([
      'apps/web/public/assets/fighter/quaternius/universal-animation-library',
      'apps/web/public/assets/ui/kenney/impact-sounds',
    ])
  })
  test('no assets folder means no packs', () => {
    expect(packFolders(fixture({ 'README.md': 'x' }))).toEqual([])
  })
})

describe('findProblems', () => {
  test('an uncredited pack is a problem; crediting the source and the pack clears it', () => {
    const root = fixture({ [`${PACK}/License.txt`]: 'CC0' })
    expect(findProblems(root, '# Third-party notices\n')).toEqual([expect.stringContaining('universal-animation-library')])
    expect(findProblems(root, 'Quaternius, Universal Animation Library: universal-animation-library, CC0')).toEqual([])
  })
  test('a pack folder without a licence file is a problem even when credited', () => {
    const root = fixture({ [`${PACK}/models/a.glb`]: 'x' })
    const problems = findProblems(root, 'quaternius universal-animation-library')
    expect(problems).toEqual([expect.stringMatching(/licen[sc]e file/i)])
  })
  test('a copied-code file with a licence header must be credited by path or file name', () => {
    const root = fixture({ 'training/trainer/ppo/ppo.py': '# Copyright (c) 2019 CleanRL contributors\n# MIT License\nimport torch\n' })
    expect(copiedCodeFiles(root)).toEqual(['training/trainer/ppo/ppo.py'])
    expect(findProblems(root, 'nothing relevant')).toEqual([expect.stringContaining('training/trainer/ppo/ppo.py')])
    expect(findProblems(root, 'CleanRL: training/trainer/ppo/ppo.py (MIT)')).toEqual([])
    expect(findProblems(root, 'CleanRL: ppo.py (MIT)')).toEqual([])
  })
  test('ordinary code with no licence header is not treated as copied', () => {
    const root = fixture({ 'packages/core/src/a.ts': '// derived from the state, computed once\nexport const a = 1\n' })
    expect(copiedCodeFiles(root)).toEqual([])
  })
})

describe('assemble', () => {
  const root = fixture({
    'docs/third-party/b-word.md': '# Word data\n\n## SCOWL\n\ntext\n\n```\n# not a heading\n```\n',
    'docs/third-party/a-ui.md': '# UI assets\n\nKenney\n',
    'docs/third-party/.gitkeep': '',
    'package.json': JSON.stringify({ name: 'x', devDependencies: { left: '1.0.0' } }),
    'node_modules/left/package.json': JSON.stringify({ name: 'left', version: '1.0.0', license: 'MIT' }),
  })
  const out = assemble(root)
  test('every topic file is included, in file name order, headings moved down one level', () => {
    expect(out.indexOf('## UI assets')).toBeGreaterThan(-1)
    expect(out.indexOf('## UI assets')).toBeLessThan(out.indexOf('## Word data'))
    expect(out).toContain('### SCOWL')
  })
  test('a hash inside a code fence is not treated as a heading', () => {
    expect(out).toContain('\n# not a heading\n')
    expect(out).not.toContain('## not a heading')
  })
  test('direct dependencies are listed with the licence their installed package declares', () => {
    expect(out).toContain('| left | 1.0.0 | MIT |')
  })
  test('is deterministic', () => {
    expect(assemble(root)).toBe(out)
  })
})

describe('this repository', () => {
  test('every pack under apps/web/public/assets and every copied-code file is credited in THIRD_PARTY.md', () => {
    const text = readFileSync(join(REPO, 'THIRD_PARTY.md'), 'utf8')
    expect(findProblems(REPO, text)).toEqual([])
  })
  test('THIRD_PARTY.md carries the SCOWL notice and the Kenney credit', () => {
    const text = readFileSync(join(REPO, 'THIRD_PARTY.md'), 'utf8')
    expect(text).toContain('Kevin Atkinson')
    expect(text).toContain('Kenney')
  })
  test('no direct dependency declares a GPL family licence (plan: no GPL or AGPL in the repo)', () => {
    const bad = dependencyLicences(REPO).filter((d) => /GPL/i.test(d.license))
    expect(bad).toEqual([])
  })
  test('every direct dependency licence could be read from the installed package', () => {
    const unknown = dependencyLicences(REPO).filter((d) => d.license === 'unknown')
    expect(unknown).toEqual([])
  })
})
