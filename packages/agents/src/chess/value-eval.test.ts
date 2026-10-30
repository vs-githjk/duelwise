import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { chessCore } from '@duelwise/core/src/games/chess/core'
import { sparseIndices } from '@duelwise/core/src/games/chess/sparse'
import { makeRng } from '@duelwise/core/src/rng'
import { OrtSession } from '../runtime/ort-session'
import { Board } from './board'
import { ValueNet } from './value-eval'

const DIR = join(import.meta.dir, '../../../../apps/web/public/agents/chess/v1')

/** 1,000 distinct positions from seeded random games (opening to endgame, either side to move). */
function positions(count: number): string[] {
  const rng = makeRng(2718)
  const out: string[] = []
  let game = 0
  while (out.length < count) {
    let s = chessCore.init(game++)
    for (let ply = 0; ply < 160 && !chessCore.terminal(s) && out.length < count; ply++) {
      if (ply % 3 === 0) out.push(s.fen)
      const seat = chessCore.toAct(s)[0]!
      const legal = chessCore.legal(s, seat)
      const m = legal[rng.int(legal.length)]!
      s = chessCore.step(s, seat === 0 ? [m, null] : [null, m])
    }
  }
  return out
}

describe('TypeScript value evaluator', () => {
  test('equals the ONNX value net within 1e-4 on 1,000 positions', async () => {
    const net = new ValueNet(new Uint8Array(await Bun.file(join(DIR, 'value.bin')).arrayBuffer()))
    const fens = positions(1000)
    expect(new Set(fens).size).toBeGreaterThan(900)
    const batch = new Float32Array(fens.length * 768)
    const ts: number[] = []
    fens.forEach((fen, i) => {
      const active = sparseIndices({ fen, seat: 0, toMove: true, repeats: 1 })
      for (const f of active) batch[i * 768 + f] = 1
      ts.push(net.score(active, active.length))
    })
    const ort = await OrtSession.create(new Uint8Array(await Bun.file(join(DIR, 'value.onnx')).arrayBuffer()))
    const out = (await ort.run('input', batch, [fens.length, 768]))['out0']!
    await ort.dispose()
    expect(out.length).toBe(fens.length)
    let worst = 0
    for (let i = 0; i < fens.length; i++) worst = Math.max(worst, Math.abs(out[i]! - ts[i]!))
    expect(worst).toBeLessThan(1e-4)
  })

  test('the search board builds the same features as the core encoder', async () => {
    const net = new ValueNet(new Uint8Array(await Bun.file(join(DIR, 'value.bin')).arrayBuffer()))
    for (const fen of positions(200)) {
      const want = [...sparseIndices({ fen, seat: 0, toMove: true, repeats: 1 })].sort((a, b) => a - b)
      const b = Board.fromFen(fen)
      const n = net.features(b)
      const got = Array.from({ length: n }, (_, i) => (net as unknown as { active: Uint16Array }).active[i]!).sort((a, b) => a - b)
      expect(got).toEqual(want)
    }
  })

  test('rejects a file that is not a value net', () => {
    expect(() => new ValueNet(new Uint8Array(40))).toThrow('bad magic')
  })
})
