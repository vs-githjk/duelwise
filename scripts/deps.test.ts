import { expect, test } from 'bun:test'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

// Resolves a package the way the workspace's own code would, from its folder.
function resolves(workspace: string, spec: string): boolean {
  try {
    Bun.resolveSync(spec, join(ROOT, workspace))
    return true
  } catch {
    return false
  }
}

test('packages/core resolves chess.js', () => {
  expect(resolves('packages/core', 'chess.js')).toBe(true)
})

test('packages/agents resolves onnxruntime-web, chess.js and @duelwise/core', () => {
  for (const spec of ['onnxruntime-web', 'chess.js', '@duelwise/core']) expect(resolves('packages/agents', spec), spec).toBe(true)
})

test('apps/web resolves the workspace packages', () => {
  for (const spec of ['@duelwise/core', '@duelwise/agents']) expect(resolves('apps/web', spec), spec).toBe(true)
})
