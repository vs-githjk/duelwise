import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EQUITY_VERSION } from './abstraction'
import { main } from './cfr-main'

function runDir(): string {
  return mkdtempSync(join(tmpdir(), 'cfr-main-'))
}

test('a thresholds file from another equity definition is refused with a clear error', () => {
  const dir = runDir()
  writeFileSync(join(dir, 'thresholds-coarse.json'), JSON.stringify({ equityVersion: 'turn-exact-no-river', thresholds: [[0.5], [0.5], [0.5]] }))
  expect(() => main(['--abstraction', 'coarse', '--iterations', '1', '--out-dir', dir])).toThrow(/equity definition turn-exact-no-river/)
})

test('a legacy thresholds file with no version is refused', () => {
  const dir = runDir()
  writeFileSync(join(dir, 'thresholds-coarse.json'), JSON.stringify([[0.5], [0.5], [0.5]]))
  expect(() => main(['--abstraction', 'coarse', '--iterations', '1', '--out-dir', dir])).toThrow(/equity definition undefined/)
})

test('a checkpoint from another equity definition is refused on resume', () => {
  const dir = runDir()
  const thr = (n: number) => Array.from({ length: n }, (_, i) => (i + 1) / (n + 1))
  writeFileSync(join(dir, 'thresholds-coarse.json'), JSON.stringify({ equityVersion: EQUITY_VERSION, thresholds: [thr(19), thr(19), thr(19)] }))
  mkdirSync(join(dir, 'ckpt'))
  writeFileSync(join(dir, 'ckpt', 'state.bin'), new Uint8Array(4))
  writeFileSync(join(dir, 'ckpt', 'state.equity'), 'turn-exact-no-river')
  expect(() => main(['--abstraction', 'coarse', '--iterations', '1', '--out-dir', dir, '--resume'])).toThrow(/equity definition turn-exact-no-river/)
  writeFileSync(join(dir, 'ckpt', 'state.equity'), '')
  expect(() => main(['--abstraction', 'coarse', '--iterations', '1', '--out-dir', dir, '--resume'])).toThrow(/equity definition/)
})
