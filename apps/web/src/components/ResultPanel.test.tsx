import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Result } from '@duelwise/core/src/types'
import { OpponentContext } from '../personas/context'
import { mayClear, ResultPanel, toggleSpeaksNow } from './ResultPanel'
import type { Upload } from '../lib/match-recorder'

const won: Result = { winner: 0, score: [1, 0], reason: 'ahead by 300 chips after 4 hands' }
const renderWith = (upload: Upload) =>
  renderToStaticMarkup(
    <OpponentContext.Provider value={{ game: 'holdem', level: 'easy' }}>
      <ResultPanel result={won} humanSeat={0} onRematch={() => {}} onPlayLevel={() => {}} onChangeLevel={() => {}} upload={upload} />
    </OpponentContext.Provider>,
  )
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

test('a win is announced as a clear only after the server accepts it; until then it says it is checking', () => {
  for (const upload of [{ status: 'uploading' }, { status: 'queued', matchId: 'm' }] as Upload[]) {
    const html = renderWith(upload)
    expect(html).toContain('Checking your result...')
    expect(html).not.toContain('is unlocked')
    expect(html).not.toContain('play-next')
    expect(html).toContain('data-testid="rematch"')
  }
  for (const upload of [{ status: 'counted', matchId: 'm' }, { status: 'synced', matchId: 'm' }] as Upload[]) {
    const html = renderWith(upload)
    expect(html).toContain('Marlow is unlocked')
    expect(html).toContain('play-next')
    expect(html).not.toContain('Checking your result')
  }
})

test('a rejected, failed, not-counted or unrated (fixed seed) win never says it unlocked anything', () => {
  for (const upload of [{ status: 'rejected', reason: 'x' }, { status: 'failed', message: 'x' }, { status: 'not-counted', matchId: 'm', reason: 'x' }, { status: 'none' }] as Upload[]) {
    const html = renderWith(upload)
    expect(html).not.toContain('is unlocked')
    expect(html).not.toContain('Checking your result')
    expect(html).not.toContain('play-next')
  }
})

test('a refused record that moved the rating says it was charged as a loss and shows the fall, never that it was not counted', () => {
  const html = renderWith({ status: 'rejected', reason: 'seed does not match the one issued for this match', elo: { before: 1000, after: 980 }, provisional: true })
  expect(html).toContain('This match could not be verified, so it was charged as a loss.')
  expect(html).not.toContain('not counted')
  expect(html).toContain('data-testid="result-elo"')
  expect(html).toContain('Rating 1000 to 980')
  expect(html).toContain('data-testid="result-elo-provisional"')
  expect(html).not.toContain('is unlocked')
})

test('a refused record that moved no rating still says it was not counted', () => {
  const html = renderWith({ status: 'rejected', reason: 'replay failed' })
  expect(html).toContain('This match could not be verified, so it was not counted.')
  expect(html).not.toContain('charged')
  expect(html).not.toContain('data-testid="result-elo"')
})

test('mayClear: only an accepted, rated, played-out win moves the path', () => {
  const base = { left: false, practice: false, outcome: 'win' as const, status: 'counted' }
  expect(mayClear(base)).toBe(true)
  expect(mayClear({ ...base, status: 'synced' })).toBe(true)
  for (const status of ['uploading', 'queued', 'rejected', 'failed', 'not-counted', 'none', undefined]) expect(mayClear({ ...base, status })).toBe(false)
  expect(mayClear({ ...base, left: true })).toBe(false)
  expect(mayClear({ ...base, practice: true })).toBe(false)
  expect(mayClear({ ...base, outcome: 'loss' })).toBe(false)
})

test('a win that did not count never says the next opponent is up next, unlocked or opening', () => {
  const uncounted = [{ status: 'uploading' }, { status: 'queued' }, { status: 'rejected', reason: 'x' }, { status: 'failed', message: 'x' }, { status: 'not-counted', matchId: 'm', reason: 'x' }, { status: 'none' }] as Upload[]
  for (const upload of uncounted) {
    const html = renderWith(upload)
    expect(html, upload.status).toContain('Clean win over Pip. Well done.')
    expect(html, upload.status).not.toMatch(/up next|is up\b|unlocked|Marlow notices/i)
  }
})
test('a counted win may promise the next opponent', () => {
  expect(renderWith({ status: 'counted', matchId: 'm' })).toContain('Marlow is up next')
})
test('a practice win offers a rated match, not progression', () => {
  const html = renderToStaticMarkup(
    <OpponentContext.Provider value={{ game: 'holdem', level: 'easy', practice: true }}>
      <ResultPanel result={won} humanSeat={0} onRematch={() => {}} upload={{ status: 'counted', matchId: 'm' }} />
    </OpponentContext.Provider>,
  )
  expect(html).toContain('Win it again in a rated match to open Marlow')
  expect(html).not.toMatch(/up next|unlocked/i)
})

test('turning the voice on while a rated win is settling does not speak the provisional line', () => {
  expect(toggleSpeaksNow('on', true)).toBe(false)
  expect(toggleSpeaksNow('on', false)).toBe(true)
  expect(toggleSpeaksNow('off', false)).toBe(false)
})

test('a resignation before the first shot says it does not count, with or without an account', () => {
  const lost: Result = { winner: 1, score: [0, 1], reason: 'resigned' }
  const html = renderToStaticMarkup(
    <OpponentContext.Provider value={{ game: 'fleet', level: 'easy' }}>
      <ResultPanel result={lost} humanSeat={0} onRematch={() => {}} onChangeLevel={() => {}} upload={{ status: 'counted', matchId: 'm', unplayed: true }} />
    </OpponentContext.Provider>,
  )
  expect(html).toContain('No shot was fired, so this match does not count.')
  expect(html).not.toContain('Sign in to get a rating')
})
