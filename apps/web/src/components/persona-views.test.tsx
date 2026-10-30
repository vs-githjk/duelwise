import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Result } from '@duelwise/core/src/types'
import { OpponentContext } from '../personas/context'
import { Avatar } from '../personas/Avatar'
import { ResultPanel } from './ResultPanel'
import { LevelPicker } from './LevelPicker'

const result = { winner: 1, reason: 'resigned' } as unknown as Result

test('result panel names the persona it was played against', () => {
  const html = renderToStaticMarkup(
    <OpponentContext.Provider value={{ game: 'chess', level: 'hard' }}>
      <ResultPanel result={result} humanSeat={0} onRematch={() => {}} />
    </OpponentContext.Provider>,
  )
  expect(html).toContain('data-testid="result-persona"')
  expect(html).toContain('You played Vesper (Hard).')
  expect(html).toContain('data-testid="persona-avatar-hard"')
})

test('result panel outside a game shell shows no persona line', () => {
  expect(renderToStaticMarkup(<ResultPanel result={result} humanSeat={0} onRematch={() => {}} />)).not.toContain('result-persona')
})

test('picker rows lead with the persona name and show this game style line', () => {
  const html = renderToStaticMarkup(
    <OpponentContext.Provider value={{ game: 'word' }}>
      <LevelPicker value="medium" onChange={() => {}} levels={{ easy: { preview: false }, medium: { preview: false }, hard: { preview: false }, champion: { preview: false } }} />
    </OpponentContext.Provider>,
  )
  for (const name of ['Pip', 'Marlow', 'Vesper', 'Sable']) expect(html).toContain(`>${name}</b>`)
  expect(html).toContain('Guesses the most common word that fits every clue.')
  expect(html).toContain('checked="" value="medium"')
  expect(renderToStaticMarkup(<LevelPicker value="easy" onChange={() => {}} />)).toContain('Early version, not yet strength tested.')
})

test('a decorative avatar is hidden from screen readers, a bare one is labelled', () => {
  expect(renderToStaticMarkup(<Avatar level="easy" decorative />)).toContain('aria-hidden="true"')
  expect(renderToStaticMarkup(<Avatar level="easy" />)).toContain('aria-label="Pip, the Easy opponent"')
})

test('a counted fighter Hard result is provisional without saying the opponent is not measured', () => {
  const html = renderToStaticMarkup(
    <OpponentContext.Provider value={{ game: 'fighter', level: 'hard' }}>
      <ResultPanel result={result} humanSeat={0} onRematch={() => {}} elo={{ before: 1000, after: 1012 }} provisional />
    </OpponentContext.Provider>,
  )
  expect(html).toContain('result-elo-provisional')
  expect(html).not.toContain('not measured yet')
  expect(html).toContain('test bots')
})

test('while a counted match uploads, a server-checked game says it is being checked', () => {
  const view = (game: 'chess' | 'word') =>
    renderToStaticMarkup(
      <OpponentContext.Provider value={{ game, level: 'hard' }}>
        <ResultPanel result={result} humanSeat={0} onRematch={() => {}} upload={{ status: 'uploading' }} />
      </OpponentContext.Provider>,
    )
  expect(view('chess')).toContain('Saving and checking this match')
  expect(view('word')).toContain('Saving this match')
  expect(view('word')).not.toContain('checking')
})

test('a report is available while its finished match uploads', () => {
  const html = renderToStaticMarkup(<ResultPanel result={result} humanSeat={0} onRematch={() => {}} upload={{ status: 'uploading', matchId: 'match-123' }} />)
  expect(html).toContain('/report/match-123')
})
