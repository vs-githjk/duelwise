import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Result } from '@duelwise/core/src/types'
import { OpponentContext } from '../personas/context'
import { getPractice, setPractice } from '../lib/practice'
import { LeavingNotice } from './LeavingNotice'
import { PlayMode, PlayModeToggle } from './PlayModeToggle'
import { PracticeBadge } from './PracticeBadge'
import { ResultPanel } from './ResultPanel'

afterEach(() => setPractice(false))

test('the toggle offers Rated and Practice, and Rated is the default', () => {
  expect(getPractice()).toBe(false)
  const html = renderToStaticMarkup(<PlayMode />)
  expect(html).toContain('data-testid="play-mode"')
  expect(html).toContain('data-mode="rated"')
  expect(html).toContain('data-mode-option="rated"')
  expect(html).toContain('data-mode-option="practice"')
  // Rated is the checked radio.
  expect(html).toMatch(/<input[^>]*checked=""[^>]*value="rated"|<input[^>]*value="rated"[^>]*checked=""/)
  expect(html).not.toMatch(/value="practice"[^>]*checked=""|checked=""[^>]*value="practice"/)
})

test('choosing Practice shows it as selected, and each row is a 56 px target', () => {
  setPractice(true)
  const html = renderToStaticMarkup(<PlayMode />)
  expect(html).toContain('data-mode="practice"')
  expect(html).toMatch(/value="practice"[^>]*checked=""|checked=""[^>]*value="practice"/)
  expect(html.match(/min-h-14/g)?.length).toBe(2)
  expect(html).toContain('Nothing on your record changes.')
})

test('the toggle reports the pick, and a game can add its own line under Practice', () => {
  const picks: boolean[] = []
  const html = renderToStaticMarkup(<PlayModeToggle practice={false} onChange={(p) => picks.push(p)} practiceHint="Buy back in free." />)
  expect(html).toContain('Buy back in free.')
  expect(html).not.toContain('disabled')
  expect(renderToStaticMarkup(<PlayModeToggle practice={false} onChange={() => {}} disabled />)).toContain('disabled=""')
})

test('the flag is a plain switch: it can be set, read and cleared', () => {
  setPractice(true)
  expect(getPractice()).toBe(true)
  setPractice(false)
  expect(getPractice()).toBe(false)
})

test('the badge says Practice, unrated, apart from the untested-level label', () => {
  const html = renderToStaticMarkup(<PracticeBadge />)
  expect(html).toContain('data-testid="practice-badge"')
  expect(html).toContain('Practice, unrated')
  expect(html).not.toContain('preview-badge')
})

test('leaving a practice match is free; leaving a rated one still resigns', () => {
  expect(renderToStaticMarkup(<LeavingNotice />)).toContain('resigns a counted match')
  setPractice(true)
  expect(renderToStaticMarkup(<LeavingNotice />)).toContain('leaving costs nothing')
})

const win = { winner: 0, score: [1, 0], reason: 'checkmate' } as unknown as Result
const panel = (practice: boolean) =>
  renderToStaticMarkup(
    <OpponentContext.Provider value={{ game: 'chess', level: 'easy', practice }}>
      <ResultPanel result={win} humanSeat={0} onRematch={() => {}} onPlayLevel={() => {}} upload={{ status: 'counted', matchId: 'm-1' }} />
    </OpponentContext.Provider>,
  )

test('a practice result says "Practice, not rated" and offers no path, leaderboard or share', () => {
  const html = panel(true)
  expect(html).toContain('data-testid="result-practice"')
  expect(html).toContain('Practice, not rated')
  expect(html).toContain('Saved to your history. It changes no rating, path or leaderboard.')
  for (const gone of ['play-next', 'result-leaderboard-link', 'share-block', 'result-ladder']) expect(html).not.toContain(gone)
  expect(html).toContain('data-testid="rematch"')
})

test('a rated result is unchanged: no practice chip, next stop and leaderboard offered', () => {
  const html = panel(false)
  expect(html).not.toContain('result-practice')
  expect(html).not.toContain('Practice, not rated')
  expect(html).toContain('data-testid="play-next"')
  expect(html).toContain('data-testid="result-leaderboard-link"')
})
