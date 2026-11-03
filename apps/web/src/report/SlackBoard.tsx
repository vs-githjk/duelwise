import type { SlackView } from './types'

const FILES = 'ABCDEFGH'
const CORNER_AT = [0, 7, 56, 63]

/**
 * The final Crosscurrent position. Discs are shape plus colour (filled dark for the player, pale and ringed for the AI), never colour alone,
 * and a corner someone placed on carries a small ring marker. The sentence under the board gives the same facts for a screen reader.
 */
export function SlackBoard({ view, viewer = 'owner', opponent = 'The AI' }: { view: SlackView; viewer?: 'owner' | 'public'; opponent?: string }) {
  const you = viewer === 'owner' ? 'You' : 'The player'
  const [mine, theirs] = view.discs
  return (
    <div className="grid gap-3" data-testid="slack-final">
      <div
        className="mx-auto grid w-full max-w-xs grid-cols-8 overflow-hidden rounded-control border border-line"
        style={{ background: 'var(--slack-water)' }}
        role="img"
        aria-label={`Final board. ${you} ${mine} discs, dark and filled. ${opponent} ${theirs} discs, pale and ringed.`}
        data-testid="slack-final-board"
      >
        {view.cells.map((v, i) => {
          const corner = CORNER_AT.indexOf(i)
          return (
            <span
              key={i}
              title={`${FILES[i % 8]}${Math.floor(i / 8) + 1}`}
              className="grid aspect-square place-items-center"
              style={{ background: (Math.floor(i / 8) + (i % 8)) % 2 ? 'var(--slack-water-deep)' : 'var(--slack-water)', boxShadow: 'inset 0 0 0 0.5px var(--slack-line)' }}
              data-corner={corner >= 0 ? (view.corners[corner] ?? 'empty') : undefined}
            >
              {v !== 0 ? (
                <span
                  className="block w-4/5 rounded-full"
                  style={{
                    aspectRatio: '1',
                    background: v === 1 ? 'var(--slack-dark)' : 'var(--slack-pale)',
                    boxShadow: v === 2 ? 'inset 0 0 0 2px var(--slack-dark)' : 'inset 0 0 0 2px var(--slack-pale)',
                    outline: corner >= 0 ? '2px solid var(--action)' : undefined,
                    outlineOffset: 1,
                  }}
                />
              ) : null}
            </span>
          )
        })}
      </div>
      <p className="text-center text-sm text-muted">
        {you}: dark discs, {mine}. {opponent}: pale discs with a dark ring, {theirs}. A blue outline marks a corner disc, which can never flip.
      </p>
    </div>
  )
}
