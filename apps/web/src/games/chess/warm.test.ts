import { describe, expect, test } from 'bun:test'
import { CHESS_LEVELS } from '@duelwise/agents/src/chess/agent'
import { WARM_BANDS, warmFiles } from './warm-files'

describe('chess warm-up files', () => {
  test('bands match the shipped level configs', () => {
    for (const level of ['easy', 'medium', 'hard'] as const) expect(WARM_BANDS[level]).toBe(CHESS_LEVELS[level].band)
  })
  test('a policy level warms its net, the value net and the runtime; the champion needs no policy net', () => {
    expect(warmFiles('medium', '/w.wasm')).toEqual(['/agents/chess/v1/policy-b1500.onnx', '/agents/chess/v1/value.bin', '/w.wasm'])
    expect(warmFiles('champion', '/w.wasm')).toEqual(['/agents/chess/v1/value.bin', '/w.wasm'])
  })
})
