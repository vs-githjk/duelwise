import type { SlackView } from './types'

const FILES = 'ABCDEFGH'
const CORNER_AT = [0, 7, 56, 63]

/**
 * The final Crosscurrent position. Each disc is its colour plus a ring in the other colour, never colour alone. The player's discs are dark when they
 * moved first and pale when they moved second (view.youColor). A corner someone placed on carries a small ring marker. The sentence under the board gives the same facts for a screen reader.
 */
export function SlackBoard({ view, viewer = 'owner', opponent = 'The AI' }: { view: SlackView; viewer?: 'owner' | 'public'; opponent?: string }) {
  const you = viewer === 'owner' ? 'You' : 'The player'
  const [mine, theirs] = view.discs
  // The player's discs are dark when they moved first and pale when they moved second; the AI has the other colour.
  const youColor = view.youColor ?? 'dark'
  const themColor = youColor === 'dark' ? 'pale' : 'dark'
  const paint = (v: 1 | 2) => `var(--slack-${(v === 1 ? youColor : themColor)})`
  const ringOf = (v: 1 | 2) => `var(--slack-${(v === 1 ? themColor : youColor)})`
  return (
    <div className="grid gap-3" data-testid="slack-final">
      <div
        className="mx-auto grid w-full max-w-xs grid-cols-8 overflow-hidden rounded-control border border-line"
        style={{ background: 'var(--slack-water)' }}
        role="img"
        aria-label={`Final board. ${you} ${mine} discs, ${youColor} with a ${themColor} ring. ${opponent} ${theirs} discs, ${themColor} with a ${youColor} ring.`}
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
                    background: paint(v as 1 | 2),
                    boxShadow: `inset 0 0 0 2px ${ringOf(v as 1 | 2)}`,
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
        {you}: {youColor} discs with a {themColor} ring, {mine}. {opponent}: {themColor} discs with a {youColor} ring, {theirs}. A blue outline marks a corner disc, which can never flip.
      </p>
    </div>
  )
}
