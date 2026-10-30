import { expect, test } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'

// Type sizes and the content width come from tokens.css (text-sm, text-display-md, max-w-content).
test('no pixel-literal text sizes or max widths in apps/web/src', () => {
  const root = new URL('..', import.meta.url).pathname
  const bad: string[] = []
  for (const f of new Glob('**/*.{ts,tsx,css}').scanSync({ cwd: root })) {
    if (f.endsWith('.test.ts') || f.endsWith('routeTree.gen.ts')) continue
    readFileSync(root + f, 'utf8').split('\n').forEach((line, i) => {
      if (/text-\[\d+px\]|max-w-\[1440px\]/.test(line)) bad.push(`${f}:${i + 1}`)
    })
  }
  expect(bad).toEqual([])
})
