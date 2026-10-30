import type { FeatureEncoder } from '../../types'
import { CELLS } from './rules'
import type { FourObservation } from './core'

/** 3 planes of 6 x 7 (row-major, row 0 at the bottom): own stones, opponent stones, own turn. */
export const fourEncoder: FeatureEncoder<FourObservation> = {
  shape: [3, 6, 7],
  encode(o, out, offset) {
    for (let i = 0; i < CELLS; i++) {
      const v = o.cells[i]!
      out[offset + i] = v === 1 ? 1 : 0
      out[offset + CELLS + i] = v === 2 ? 1 : 0
      out[offset + 2 * CELLS + i] = o.toMove ? 1 : 0
    }
  },
}
