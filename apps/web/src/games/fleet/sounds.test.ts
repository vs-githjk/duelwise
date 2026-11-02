import { expect, test } from 'bun:test'
import { playCue } from './sounds'
import { moodForGame } from '../../lib/music'

test('every cue is safe to play with no audio device, and fleet has a music mood', () => {
  for (const c of ['aim', 'fire', 'miss', 'hit', 'sunk', 'win', 'lose'] as const) expect(() => playCue(c)).not.toThrow()
  expect(moodForGame('fleet')).toBe('board')
})
