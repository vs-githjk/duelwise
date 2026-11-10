import { describe, expect, test } from 'bun:test'
import registryA from '../../registry/puck.json'
import registryB from '../../eval/puck/outcome-B/puck.json'
import { parseRegistry } from '../registry'
import { PREVIEW_MODEL, playedModel } from './models'

const A = parseRegistry(registryA)
const B = parseRegistry(registryB)
// Outcome A is what the repo ships until scripts/apply-puck-outcome-b.sh runs; once B is applied the live registry is B, and the B tests cover it.
const isA = !Object.hasOwn(A.measured, 'champion')

describe('which network a Glasscut level plays (the registry decides)', () => {
  test.skipIf(!isA)('outcome A: Pip has none, Marlow plays Vesper\'s measured network, Vesper its own, Sable the preview network that was not measured', () => {
    expect(playedModel(A, 'easy')).toEqual({ path: null, measured: true })
    expect(playedModel(A, 'medium')).toEqual({ path: 'agents/puck/v1/hard.onnx', measured: true })
    expect(playedModel(A, 'hard')).toEqual({ path: 'agents/puck/v1/hard.onnx', measured: true })
    expect(playedModel(A, 'champion')).toEqual({ path: PREVIEW_MODEL, measured: false })
  })

  test('outcome B: Sable plays champion.onnx once the registry ships it; Marlow is unchanged', () => {
    expect(playedModel(B, 'champion')).toEqual({ path: 'agents/puck/v1/champion.onnx', measured: true })
    expect(playedModel(B, 'medium')).toEqual({ path: 'agents/puck/v1/hard.onnx', measured: true })
    expect(playedModel(B, 'hard')).toEqual({ path: 'agents/puck/v1/hard.onnx', measured: true })
  })

  test('a network the registry names but no version ships falls back to the preview network and is not the measured one', () => {
    const noHard = { ...A, versions: A.versions.map((v) => ({ ...v, artifacts: {} })) }
    expect(playedModel(noHard, 'medium')).toEqual({ path: PREVIEW_MODEL, measured: false })
  })
})
