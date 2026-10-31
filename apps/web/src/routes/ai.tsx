import { ScrollCue } from '../components/ScrollCue'
import { createFileRoute } from '@tanstack/react-router'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { validateRegistry, type Registry } from '@duelwise/agents/src/registry'
import { LEVELS, LEVEL_LABEL } from '../lib/level-info'
import { Avatar } from '../personas/Avatar'
import { buildCast, type CastCell } from '../personas/cast'
import { personaFor, styleLine } from '../personas'
import { cn } from '../lib/cn'
import { EloExplainer } from '../components/SiteElo'
import { visibleRegistry, verifiedStrength } from '../lib/strength-gates'

// Registry JSON ships inside the bundle, the same way the stats page reads it.
const FILES = import.meta.glob('../../../../packages/agents/registry/*.json', { eager: true, import: 'default' }) as Record<string, unknown>

function registries(): Partial<Record<GameId, Registry | null>> {
  const out: Partial<Record<GameId, Registry | null>> = {}
  for (const game of Object.keys(PRODUCT.games) as GameId[]) {
    const raw = Object.entries(FILES).find(([path]) => path.endsWith(`/${game}.json`))?.[1]
    out[game] = raw && validateRegistry(raw).ok ? visibleRegistry(raw as Registry) : null
  }
  return out
}

export const Route = createFileRoute('/ai')({
  head: () => ({ meta: [{ title: `The AI | ${PRODUCT.name}` }] }),
  component: TheAI,
})

/** Wide screens: table cells. Phones: each row becomes a card and each cell carries its opponent's name, so nothing scrolls sideways. */
const CELL = 'py-2.5 pr-3 align-top max-sm:block max-sm:border-t max-sm:border-line max-sm:py-2 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:font-sans max-sm:before:text-xs max-sm:before:font-semibold max-sm:before:text-muted max-sm:before:content-[attr(data-label)]'

function Cell({ cell, label }: { cell: CastCell; label: string }) {
  if (cell.state === 'in-training') {
    return (
      <td className={CELL} data-label={label} data-state="in-training">
        <span className="font-semibold text-warn-ink">In training</span>
        <span className="block text-xs text-muted">{cell.practice && cell.reason.startsWith('In training') ? 'Early version, not yet strength tested.' : cell.reason}</span>
      </td>
    )
  }
  return (
    <td className={CELL} data-label={label} data-state="measured">
      <span className={cn(cell.strength.startsWith('site Elo') && 'font-mono tabular')} data-testid="cast-strength">{cell.strength}</span>
      {cell.reaction ? (
        <span className="block font-mono text-xs tabular text-muted" data-testid="cast-reaction">
          {`${cell.reaction.ms} ms (${cell.reaction.frames} frames)${cell.reaction.apm === null ? ', no action cap' : `, ${cell.reaction.apm} actions per minute`}`}
        </span>
      ) : null}
    </td>
  )
}

function TheAI() {
  const registryByGame = registries()
  const rows = buildCast(registryByGame)
  const games = Object.keys(PRODUCT.games) as GameId[]
  return (
    <div className="grid gap-8 py-8" data-testid="cast-page">
      <header className="grid max-w-prose gap-2">
        <h1 className="font-display text-display-lg">The AI</h1>
        <p className="text-muted">Four opponents sit down at every table. The same face means the same level in every game, and what each one can do is measured, never promised.</p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="The four opponents">
        {LEVELS.map((level) => {
          const p = personaFor(level)
          return (
            <li key={level} className="grid content-start gap-3 rounded-card border border-line bg-surface p-4 shadow-card" data-testid={`cast-card-${level}`}>
              <div className="flex items-center gap-3">
                <Avatar level={level} size={64} decorative />
                <div>
                  <h2 className="font-display text-display-sm">{p.name}</h2>
                  <p className="text-sm text-muted">{LEVEL_LABEL[level]}</p>
                </div>
              </div>
              <p className="text-sm">{p.bio}</p>
              <dl className="grid gap-1.5 text-sm">
                {games.map((g) => (
                  <div key={g} className="grid gap-px">
                    <dt className="text-xs font-semibold text-muted">{PRODUCT.games[g].displayName}</dt>
                    <dd>{verifiedStrength(registryByGame[g] ?? null, level) ? styleLine(level, g) : 'In training: this opponent\'s strength is still being checked.'}</dd>
                  </div>
                ))}
              </dl>
            </li>
          )
        })}
      </ul>
      <section className="grid gap-3" aria-labelledby="cast-table-title">
        <h2 id="cast-table-title" className="font-display text-display-md">How strong, measured</h2>
        <p className="max-w-prose text-sm text-muted">These numbers come from tests of each opponent. A level that has not passed its checks says so instead of showing a guess.</p>
        <EloExplainer />
        <ScrollCue>
          <table className="w-full table-fixed text-left text-sm sm:min-w-[40rem] max-sm:block" data-testid="cast-table">
            <caption className="sr-only">Measured strength by game and opponent</caption>
            <thead className="max-sm:sr-only">
              <tr className="border-b border-line text-muted">
                <th scope="col" className="py-2 pr-3 font-semibold">Game</th>
                {LEVELS.map((l) => (
                  <th key={l} scope="col" className="py-2 pr-3 font-semibold">{`${personaFor(l).name} (${LEVEL_LABEL[l]})`}</th>
                ))}
              </tr>
            </thead>
            <tbody className="max-sm:block">
              {rows.map((r) => (
                <tr key={r.game} className="border-b border-line max-sm:mb-3 max-sm:block max-sm:rounded-card max-sm:border max-sm:px-3 max-sm:py-2" data-testid={`cast-row-${r.game}`}>
                  <th scope="row" className="py-2.5 pr-3 align-top font-semibold max-sm:block max-sm:py-1 max-sm:text-base">{r.displayName}</th>
                  {LEVELS.map((l) => (
                    <Cell key={l} cell={r.cells[l]} label={`${personaFor(l).name} (${LEVEL_LABEL[l]})`} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollCue>
      </section>
    </div>
  )
}
