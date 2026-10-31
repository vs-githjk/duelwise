import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Result } from '@duelwise/core/src/types'
import { OpponentContext } from '../personas/context'
import { ResultPanel } from './ResultPanel'

const won: Result = { winner: 0, score: [1, 0], reason: 'ahead by 300 chips after 4 hands' }
const render = (leftAfter?: number | null) =>
  renderToStaticMarkup(
    <OpponentContext.Provider value={{ game: 'holdem', level: 'easy' }}>
      <ResultPanel result={won} humanSeat={0} onRematch={() => {}} onPlayLevel={() => {}} onChangeLevel={() => {}} upload={{ status: 'counted', matchId: 'm' }} leftAfter={leftAfter} />
    </OpponentContext.Provider>,
  )

test('a finished win beats the opponent, unlocks the next stop and offers it', () => {
  const html = render(null)
  expect(html).toContain('You beat Pip.')
  expect(html).toContain('data-testid="play-next"')
  expect(html).toContain('Marlow is unlocked')
  expect(html).toContain('share-block')
})

test('leaving the table leads with Unrated, never says beat, and offers no unlock, next level or share', () => {
  const html = render(4)
  expect(html).toContain('Unrated, you left after 4 hands')
  expect(html).not.toContain('beat')
  expect(html).not.toContain('Beat')
  expect(html).not.toContain('is unlocked')
  expect(html).not.toContain('play-next')
  expect(html).not.toContain('Play Marlow')
  expect(html).not.toContain('share-block')
  expect(html).toContain('Left early')
})

test('one hand reads in the singular', () => {
  expect(render(1)).toContain('Unrated, you left after 1 hand<')
})
