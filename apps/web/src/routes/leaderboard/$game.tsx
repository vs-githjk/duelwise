import { useEffect, useRef } from 'react'
import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { cn } from '../../lib/cn'
import { gameBySlug } from '../../games/registry'
import { getLeaderboardView } from '../../server/leaderboard-fns'
import { getLevelBoardView } from '../../server/identity-fns'
import type { BoardColumn, LevelBoard } from '../../server/board'
import { Avatar } from '../../personas/Avatar'
import { LEVELS, LEVEL_LABEL, boardPracticeLine } from '../../lib/level-info'
import { buildCast } from '../../personas/cast'
import { personaFor } from '../../personas'
import { registryFor } from '../../lib/registries'

export const Route = createFileRoute('/leaderboard/$game')({
  beforeLoad: ({ params }) => {
    if (!gameBySlug(params.game)) throw notFound()
  },
  loader: async ({ params }) => {
    const game = gameBySlug(params.game)!
    const [view, board] = await Promise.all([getLeaderboardView({ data: { game } }), getLevelBoardView({ data: { game } })])
    return { ...view, board }
  },
  head: ({ params }) => {
    const id = gameBySlug(params.game)
    return { meta: [{ title: `${id ? PRODUCT.games[id].displayName : 'Game'} leaderboard | ${PRODUCT.name}` }] }
  },
  component: Leaderboard,
})

function Leaderboard() {
  const id = gameBySlug(Route.useParams().game)!
  const { rows, minGames, me, signedIn, ranked, board } = Route.useLoaderData()
  const tabs = useRef<HTMLElement>(null)
  useEffect(() => {
    const nav = tabs.current
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (nav && active) nav.scrollLeft = active.offsetLeft - nav.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2
  }, [id])
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-6 py-8" data-testid="leaderboard">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <h1 className="min-w-0 font-display text-display-md md:text-display-lg" data-testid="board-title">{PRODUCT.games[id].displayName} board, last {board.windowDays} days</h1>
        <nav ref={tabs} aria-label="Choose a game" className="-mx-1 flex min-w-0 max-w-full flex-wrap gap-1 rounded-3xl bg-surface-2 p-1" data-testid="leaderboard-switcher">
          {(Object.keys(PRODUCT.games) as GameId[]).map((g) => (
            <Link
              key={g}
              to="/leaderboard/$game"
              params={{ game: PRODUCT.games[g].slug }}
              aria-current={g === id ? 'page' : undefined}
              className={cn('inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm font-semibold', g === id ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink')}
            >
              {PRODUCT.games[g].displayName}
            </Link>
          ))}
        </nav>
      </div>
      <LevelColumns board={board} id={id} />
      <section className="grid max-w-3xl gap-4" aria-labelledby="ratings-h" data-testid="ratings-section">
      <h2 id="ratings-h" className="font-display text-display-sm">Ratings</h2>
      {!ranked ? (
        <p className="max-w-xl rounded-control border border-line bg-surface px-3 py-2 text-muted" data-testid="leaderboard-unranked">
          {PRODUCT.games[id].displayName} matches do not change a rating yet, so this game has no leaderboard. Real-time matches count once the server can check the opponent's play the way it does for turn-based games.
        </p>
      ) : null}
      <p className="max-w-xl text-muted" hidden={!ranked}>
        Signed-in players appear here after {minGames} counted matches. Ratings are against the four AI opponents; a rating earned against an opponent still in training is provisional.
      </p>
      {ranked && me ? (
        <p className="max-w-xl rounded-control border border-line bg-surface px-3 py-2 text-sm" data-testid="leaderboard-me">
          Your rating: <span className="font-mono tabular">{me.elo}</span> after {me.games} counted {me.games === 1 ? 'match' : 'matches'}
          {me.games < minGames ? `. ${minGames - me.games} more to appear on the board.` : '.'}
        </p>
      ) : null}
      {!ranked ? null : rows.length === 0 ? (
        <div className="grid max-w-xl gap-3" data-testid="leaderboard-empty">
          <p className="text-muted">Nobody is on the board yet. {signedIn ? `Finish ${Math.max(minGames - (me?.games ?? 0), 1)} more counted ${minGames - (me?.games ?? 0) === 1 ? 'match' : 'matches'} to be the first.` : `Sign in and finish ${minGames} counted matches to be the first.`}</p>
          <p>
            {signedIn ? (
              <Link to="/play/$game" params={{ game: PRODUCT.games[id].slug }} className="inline-flex min-h-11 items-center rounded-control bg-action px-5 font-semibold text-action-ink" data-testid="leaderboard-cta">
                Play {PRODUCT.games[id].displayName}
              </Link>
            ) : (
              <Link to="/signin" className="inline-flex min-h-11 items-center rounded-control bg-action px-5 font-semibold text-action-ink" data-testid="leaderboard-cta">
                Sign in to get on the board
              </Link>
            )}
          </p>
        </div>
      ) : (
        <table className="w-full max-w-xl text-left text-sm" data-testid="leaderboard-table">
          <caption className="sr-only">{PRODUCT.games[id].displayName} ratings</caption>
          <thead>
            <tr className="border-b border-line text-muted">
              <th scope="col" className="py-2 pr-3 font-semibold">Rank</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Player</th>
              <th scope="col" className="py-2 pr-3 text-right font-semibold">Rating</th>
              <th scope="col" className="py-2 text-right font-semibold">Matches</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rank} className="border-b border-line">
                <td className="py-2 pr-3 font-mono tabular">{r.rank}</td>
                <td className="py-2 pr-3">{r.name}</td>
                <td className="py-2 pr-3 text-right font-mono tabular">{r.elo}</td>
                <td className="py-2 text-right font-mono tabular">{r.games}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <AiReference game={id} />
      </section>
    </section>
  )
}

function LevelColumns({ board, id }: { board: LevelBoard; id: GameId }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" data-testid="level-columns">
      {board.columns.map((c) => (
        <Column key={c.level} c={c} game={id} />
      ))}
      <p className="text-sm text-muted md:col-span-2 xl:col-span-4" data-testid="board-note">
        Wins at that level in the last {board.windowDays} days, then the game's margin (fewest moves or guesses, the better score), then who got there first. Names are what players typed, a repeated name gets a number, and guests are included.
        {PRODUCT.games[id].kind === 'realtime' ? ` ${PRODUCT.games[id].displayName} matches are not re-checked on the server yet, so treat this board as friendly.` : ''}
      </p>
    </div>
  )
}

function Column({ c, game }: { c: BoardColumn; game: GameId }) {
  const name = personaFor(c.level).name
  const mine = c.rows.find((r) => r.me)
  return (
    <section className="grid content-start overflow-hidden rounded-card border border-line bg-surface shadow-card" aria-label={`${name} column`} data-testid={`board-col-${c.level}`}>
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <Avatar level={c.level} size={32} decorative />
        <b className="font-semibold">{name}</b>
        <span className="ml-auto font-mono text-xs text-muted tabular" data-testid={`board-players-${c.level}`}>{c.practice ? 'In training' : `${c.players.toLocaleString('en-US')} played, ${(c.rows.length + c.more).toLocaleString('en-US')} won`}</span>
      </header>
      {c.practice ? (
        <p className="px-4 py-4 text-sm text-muted" data-testid={`board-practice-${c.level}`}>
          {boardPracticeLine(game, name)}
        </p>
      ) : c.rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted" data-testid={`board-empty-${c.level}`}>No wins at {LEVEL_LABEL[c.level]} yet. Be the first.</p>
      ) : (
        <ol className="grid" data-testid={`board-rows-${c.level}`}>
          {c.rows.map((r) => (
            <li key={r.rank} className={cn('flex items-baseline gap-3 border-b border-line px-4 py-2.5 text-sm last:border-b-0', r.me && 'bg-action-soft font-semibold')} data-me={r.me ? 'true' : undefined}>
              <span className="w-7 font-mono text-muted tabular">{r.rank}</span>
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="font-mono tabular">{r.wins} W</span>
            </li>
          ))}
        </ol>
      )}
      {!c.practice && c.more > 0 ? <p className="border-t border-line px-4 py-2 text-center font-mono text-xs text-muted">{c.more.toLocaleString('en-US')} more</p> : null}
      {c.me && !mine ? (
        <div className="flex items-baseline gap-3 border-t border-line bg-action-soft px-4 py-2.5 text-sm font-semibold" data-testid={`board-me-${c.level}`}>
          <span className="w-7 font-mono tabular">{c.me.rank ?? ''}</span>
          <span className="min-w-0 flex-1 truncate">{c.me.name}</span>
          <span className="font-mono tabular">{c.practice ? (c.me.wins > 0 ? `${c.me.wins} W` : '') : c.me.hidden ? 'hidden' : c.me.wins > 0 ? `${c.me.wins} W` : 'not yet'}</span>
        </div>
      ) : null}
      {c.me?.hidden && !c.practice ? <p className="px-4 pb-3 text-xs text-muted">You are hidden from the board. <Link to="/settings" className="text-action underline">Settings</Link></p> : null}
    </section>
  )
}

/** The AI opponents' measured strength in this game, so a player can place their own rating. Read from the registry. */
function AiReference({ game }: { game: GameId }) {
  const row = buildCast({ [game]: registryFor(game) }).find((r) => r.game === game)!
  return (
    <section className="grid max-w-xl gap-2 pt-2" data-testid="leaderboard-ai" aria-labelledby="lb-ai-title">
      <h2 id="lb-ai-title" className="text-base font-semibold">The AI opponents, for reference</h2>
      <ul className="grid divide-y divide-line text-sm">
        {LEVELS.map((l) => {
          const c = row.cells[l]
          return (
            <li key={l} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2" data-testid={`leaderboard-ai-${l}`}>
              <span className="font-semibold">{`${personaFor(l).name} (${LEVEL_LABEL[l]})`}</span>
              <span className="font-mono tabular text-muted">{c.state === 'measured' ? c.strength : 'In training'}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
