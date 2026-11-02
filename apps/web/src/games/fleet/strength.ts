import { SHIPS } from '@duelwise/core/src/games/fleet'

/** Every ship cell has to be hit, so no fleet ever goes down in fewer shots than this. */
const FEWEST_SHOTS = SHIPS.reduce((a, b) => a + b, 0)

/**
 * The aside's strength line. It prints only `meanShots`, the mean the measurement script records. `value` is a head-to-head score
 * and must never read as shots, and a mean below the size of the fleet cannot be true, so either way it says nothing is measured.
 */
export function strengthSentence(measured: { meanShots?: { mean: number } } | undefined): string {
  const mean = measured?.meanShots?.mean
  if (mean === undefined || mean < FEWEST_SHOTS) return 'No measured strength yet.'
  return `Sinks a random fleet in ${mean.toFixed(1)} shots on average.`
}
