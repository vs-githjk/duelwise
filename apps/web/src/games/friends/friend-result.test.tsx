import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FriendRecord } from './friend-record'

// The result screen links to the leaderboard and the friends page; a plain anchor stands in for the router's Link.
mock.module('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children: unknown } & Record<string, unknown>) => (
    <a href={params ? to.replace('$game', params.game!) : to} {...(rest as object)}>
      {children as never}
    </a>
  ),
}))
const { FriendResult } = await import('./FriendResult')

const base = {
  result: { winner: 0 as const, score: [1, 0] as [number, number], reason: 'checkmate' },
  names: ['Ada', 'Sam'] as [string, string],
  tally: { one: 1, two: 0, draws: 0 },
  nameOne: 'Ada',
  nameTwo: 'Sam',
  onRematch: () => {},
  onDone: () => {},
}
const ready = (over: Partial<Extract<FriendRecord, { status: 'ready' }>> = {}): FriendRecord => ({
  status: 'ready',
  card: { friend: 'Sam', game: { you: 2, them: 1, draws: 0 }, all: { you: 2, them: 1, draws: 0 }, gamesPlayed: 1 },
  ratings: { friend: 'Sam', them: 1240, you: 1180 },
  ...over,
})
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')

describe('the friend result', () => {
  test('never shows a rating change and says friend games are not rated, on one device too', () => {
    const html = renderToStaticMarkup(<FriendResult {...base} />)
    expect(text(html)).toContain('Friend games are not rated')
    expect(html).not.toMatch(/Elo|[+-]\d+ rating|rating (went|rose|fell)|data-testid="friend-record"/)
    expect(html).not.toContain('friend-ratings')
  })

  test('two devices: the head-to-head reads You 2, Sam 1 for one player and the mirror for the other', () => {
    const mine = text(renderToStaticMarkup(<FriendResult {...base} game="four" record={ready()} />))
    expect(mine).toContain('Your record against Sam')
    expect(mine).toContain('You 2, Sam 1')
    const theirs = text(
      renderToStaticMarkup(
        <FriendResult {...base} nameOne="Sam" nameTwo="Ada" game="four" record={ready({ card: { friend: 'Ada', game: { you: 1, them: 2, draws: 0 }, all: { you: 1, them: 2, draws: 0 }, gamesPlayed: 1 }, ratings: { friend: 'Ada', them: 1180, you: 1240 } })} />,
      ),
    )
    expect(theirs).toContain('You 1, Ada 2')
  })

  test('both existing ratings against the AI show with a link to that game\'s leaderboard; a missing one is left out', () => {
    const html = renderToStaticMarkup(<FriendResult {...base} game="four" record={ready()} />)
    expect(text(html)).toContain("Beat Sam's score: Sam is on 1240 against the AI.")
    expect(text(html)).toContain('Your rating against the AI is 1180.')
    expect(html).toContain('href="/leaderboard/four-in-a-row"')
    const half = renderToStaticMarkup(<FriendResult {...base} game="four" record={ready({ ratings: { friend: 'Sam', them: 1240 } })} />)
    expect(text(half)).toContain("Beat Sam's score")
    expect(text(half)).not.toContain('Your rating')
    const none = renderToStaticMarkup(<FriendResult {...base} game="four" record={ready({ ratings: { friend: 'Sam' } })} />)
    expect(none).not.toContain('friend-ratings')
  })

  test('draws and a second game both show; loading holds the space; off and one device show no record', () => {
    const rich = text(renderToStaticMarkup(<FriendResult {...base} game="chess" record={ready({ card: { friend: 'Sam', game: { you: 1, them: 1, draws: 1 }, all: { you: 3, them: 2, draws: 1 }, gamesPlayed: 2 } })} />))
    expect(rich).toContain('You 1, Sam 1, 1 drawn')
    expect(rich).toContain('All games together: You 3, Sam 2, 1 drawn')
    const loading = renderToStaticMarkup(<FriendResult {...base} game="four" record={{ status: 'loading' }} />)
    expect(loading).toContain('data-state="loading"')
    expect(renderToStaticMarkup(<FriendResult {...base} game="four" record={{ status: 'off' }} />)).not.toContain('friend-record')
  })

  test('no em or en dash in the copy it renders', () => {
    const html = renderToStaticMarkup(<FriendResult {...base} game="four" record={ready()} />)
    expect(html).not.toMatch(/[\u2013\u2014]/)
  })
})
