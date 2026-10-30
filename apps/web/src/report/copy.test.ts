import { describe, expect, test } from 'bun:test'
import { duration, headline, learningCopy, shareControlsNote } from './copy'

describe('report copy', () => {
  test('owner and public headlines', () => {
    expect(headline({ mode: 'owner', playerName: null, level: 'medium' }, 'win')).toBe('You beat Marlow.')
    expect(headline({ mode: 'owner', playerName: null, level: 'hard' }, 'loss')).toBe('Vesper beat you.')
    expect(headline({ mode: 'public', playerName: null, level: 'medium' }, 'win')).toBe('A Duelwise player beat Marlow.')
    expect(headline({ mode: 'public', playerName: null, level: 'easy' }, 'loss')).toBe('Pip beat a Duelwise player.')
    expect(headline({ mode: 'public', playerName: 'Sam', level: 'easy' }, 'draw')).toBe('Sam drew with Pip.')
  })

  test('duration', () => {
    expect(duration(0)).toBe('not recorded')
    expect(duration(45_000)).toBe('45 s')
    expect(duration(580_000)).toBe('9 min 40 s')
  })

  test('only a stored match claims it can be learned from', () => {
    expect(learningCopy({ state: 'stored' }, 'Marlow').title).toBe('Stored for training')
    for (const l of [{ state: 'stats_only', reason: 'opt_out' }, { state: 'not_used', reason: 'resigned' }, { state: 'not_used', reason: 'abandoned' }, { state: 'not_used', reason: 'rejected' }, { state: 'not_used', reason: 'not_learning' }] as const) {
      expect(learningCopy(l, 'Marlow').text).not.toMatch(/can learn from|next challenger/)
    }
  })

  test('the share note says what the page and the card show, and what stays private', () => {
    const t = shareControlsNote('Marlow', { signedIn: true, linkPublic: true })
    expect(t).toMatch(/result/)
    expect(t).toMatch(/key moments/)
    expect(t).toMatch(/Marlow/)
    expect(t).toMatch(/link preview image/)
    expect(t).toMatch(/rating/)
    expect(t).toMatch(/email/)
    expect(t).toMatch(/training/)
    expect(t).toMatch(/name .*only if you/)
    expect(t).not.toMatch(/'s side|account/)
  })

  test('the share note only mentions the name box when the box is on the page', () => {
    expect(shareControlsNote('Marlow', { signedIn: true, linkPublic: true })).toMatch(/name .*only if you tick the box below/)
    for (const o of [{ signedIn: false, linkPublic: true }, { signedIn: true, linkPublic: false }, { signedIn: false, linkPublic: false }]) {
      const t = shareControlsNote('Marlow', o)
      expect(t).not.toMatch(/name|tick|box/)
      expect(t).toMatch(/rating, email and training status stay private/)
    }
  })

  test('the share note promises only what the page has', () => {
    const none = shareControlsNote('Marlow', { signedIn: false, linkPublic: true, gameView: false, keyMoments: false })
    expect(none).toMatch(/^The page shows the result, and the link preview/)
    expect(none).not.toMatch(/key moments|how the game went/)
    expect(shareControlsNote('Marlow', { signedIn: false, linkPublic: true, gameView: false })).toMatch(/shows the result and the key moments,/)
    expect(shareControlsNote('Marlow', { signedIn: false, linkPublic: true })).toMatch(/shows the result, how the game went and the key moments,/)
  })
})
