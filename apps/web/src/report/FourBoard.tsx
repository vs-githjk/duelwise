import type { FourView } from './types'

const GLYPH = ['', '●', '○']
const NAME = ['empty', "the player's disc", "the opponent's disc"]

/**
 * The final Four in a Row position and the drop order. Discs are shape plus colour (filled for the player,
 * ringed for the AI), never colour alone, and the strip below lists every drop for screen readers too.
 */
export function FourBoard({ view, viewer = 'owner', opponent = 'The AI' }: { view: FourView; viewer?: 'owner' | 'public'; opponent?: string }) {
  const you = viewer === 'owner' ? 'You' : 'The player'
  return (
    <div className="grid gap-4" data-testid="four-final">
      <div
        className="mx-auto grid w-full max-w-xs gap-1 rounded-control bg-four-frame p-2"
        role="img"
        aria-label={`Final board. ${you === 'You' ? 'You play' : 'The player plays'} filled discs, ${opponent} plays ringed discs.`}
        data-testid="four-final-board"
      >
        {view.cells.map((row, r) => (
          <div key={r} className="grid grid-cols-7 gap-1">
            {row.map((v, c) => (
              <span
                key={c}
                title={NAME[v]}
                className={
                  'grid aspect-square place-items-center rounded-full border border-line text-lg leading-none ' +
                  (v === 1 ? 'bg-four-you text-black' : v === 2 ? 'bg-four-ai text-white' : 'bg-four-hole')
                }
              >
                <span aria-hidden>{GLYPH[v]}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
      <p className="text-center text-sm text-muted">{you}: yellow filled discs. {opponent}: dark ringed discs.</p>
      <div data-testid="four-drops">
        <h3 className="mb-1 text-sm font-semibold text-muted">Drops in order (column 1 to 7)</h3>
        <ol className="flex flex-wrap gap-1 font-mono text-sm tabular">
          {view.drops.map((d, i) => (
            <li key={i} className={'rounded-control border border-line px-2 py-0.5 ' + (d.by === 'player' ? 'bg-action text-action-ink' : 'bg-surface text-ink')} data-by={d.by}>
              <span className="sr-only">{`Drop ${i + 1}, ${d.by === 'player' ? you : opponent}, column `}</span>
              <span aria-hidden>{d.by === 'player' ? '●' : '○'} </span>
              {d.column}
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
