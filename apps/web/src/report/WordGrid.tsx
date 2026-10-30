import type { WordRow } from './types'

import { Marker } from '../games/word/ledger'

const NAME = ['not in the word', 'in the word, wrong spot', 'right spot']

/** Guess by guess, both seats side by side. Markers are the game's own: a dot for the right spot, a ring for elsewhere, a dash for absent. */
export function WordGrid({ rows, viewer = 'owner', opponent = 'The AI' }: { rows: WordRow[]; viewer?: 'owner' | 'public'; opponent?: string }) {
  const you = rows.filter((r) => r.seat === 'player')
  const ai = rows.filter((r) => r.seat === 'ai')
  const col = (label: string, list: WordRow[], testId: string) => (
    <div className="grid content-start gap-2" data-testid={testId}>
      <h4 className="text-sm font-semibold text-muted">{label}</h4>
      {list.map((r, i) => (
        <p key={i} className="flex items-center gap-0.5 font-mono text-sm uppercase tabular sm:gap-1 sm:text-base">
          <span className="w-3 text-xs text-muted">{i + 1}</span>
          {Array.from(r.guess).map((ch, k) => (
            <span key={k} className="inline-grid w-4 justify-items-center sm:w-6 leading-tight" title={NAME[r.markers[k]!]}>
              <span>{ch}</span>
              <span aria-hidden="true" className="inline-flex"><Marker kind={r.markers[k]!} /></span>
            </span>
          ))}
          <span className="sr-only">{r.markers.map((m, k) => `${r.guess[k]} ${NAME[m]}`).join(', ')}</span>
        </p>
      ))}
    </div>
  )
  return (
    <div className="grid grid-cols-2 gap-3" data-testid="word-grid">
      {col(viewer === 'owner' ? 'You' : 'The player', you, 'word-you')}
      {col(opponent, ai, 'word-ai')}
    </div>
  )
}
