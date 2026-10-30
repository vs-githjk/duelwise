import { describe, expect, test } from 'bun:test'
import { loadSelfPlay, selfPlaySpecifier } from './selfplay-loader'

const MAIN = new URL('./main.ts', import.meta.url).pathname

describe('selfplay loader', () => {
  test('chess uses its own module, other games the shared host', () => {
    expect(selfPlaySpecifier('chess')).toBe('./chess-selfplay')
    expect(selfPlaySpecifier('four')).toBe('./selfplay-host')
    expect(selfPlaySpecifier('holdem')).toBe('./selfplay-host')
  })

  test('returns the owner export when present', async () => {
    const run = async () => 0
    expect(await loadSelfPlay('four', async () => ({ runSelfPlay: run }))).toBe(run)
  })

  test('returns null when the export is null or absent', async () => {
    expect(await loadSelfPlay('four', async () => ({ runSelfPlay: null }))).toBeNull()
    expect(await loadSelfPlay('four', async () => ({}))).toBeNull()
  })

  test('returns null when the owner module does not exist yet', async () => {
    const missing = async (s: string) => {
      throw new Error(`Cannot find module '${s}' from '/x/main.ts'`)
    }
    expect(await loadSelfPlay('chess', missing)).toBeNull()
  })

  test('a module that fails while loading is a real error', async () => {
    const broken = async () => {
      throw new Error('boom')
    }
    await expect(loadSelfPlay('four', broken)).rejects.toThrow('boom')
    const other = async () => {
      throw new Error("Cannot find module 'onnxruntime-node'")
    }
    await expect(loadSelfPlay('four', other)).rejects.toThrow('onnxruntime-node')
  })

  test('main.ts --mode selfplay exits 2 with the not-provided message while no host exists', async () => {
    const p = Bun.spawn(['bun', MAIN, '--game', 'four', '--n', '1', '--mode', 'selfplay'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [code, err] = [await p.exited, await new Response(p.stderr).text()]
    expect(code).toBe(2)
    expect(err).toContain('self-play host')
  })
})
