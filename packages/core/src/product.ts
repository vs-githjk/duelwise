export type GameId = 'chess' | 'four' | 'holdem' | 'word' | 'fighter' | 'arena'
export type Level = 'easy' | 'medium' | 'hard' | 'champion'

export interface GameConfig {
  displayName: string
  slug: string
  kind: 'turn' | 'rounds' | 'realtime'
  devices: 'all' | 'desktop'
}

// The only place the product name lives. A game is playable when
// apps/web/src/games/<id>/index.tsx exists; there is deliberately no enabled flag.
export const PRODUCT: {
  name: string
  tagline: 'Six games. One AI that learns from every match. Beat it if you can.'
  trainingDataBasis: 'legitimate-interest' | 'opt-in'
  championMinDelayFrames: number
  games: Record<GameId, GameConfig>
} = {
  name: 'Duelwise',
  tagline: 'Six games. One AI that learns from every match. Beat it if you can.',
  trainingDataBasis: 'legitimate-interest',
  championMinDelayFrames: 3,
  games: {
    chess: { displayName: 'Chess', slug: 'chess', kind: 'turn', devices: 'all' },
    four: { displayName: 'Four in a Row', slug: 'four-in-a-row', kind: 'turn', devices: 'all' },
    holdem: { displayName: "Heads-Up Hold'em", slug: 'heads-up-holdem', kind: 'rounds', devices: 'all' },
    word: { displayName: 'Word Duel', slug: 'word-duel', kind: 'rounds', devices: 'all' },
    fighter: { displayName: 'Tinderbox', slug: 'tinderbox', kind: 'realtime', devices: 'desktop' },
    arena: { displayName: 'Coldstore', slug: 'coldstore', kind: 'realtime', devices: 'desktop' },
  },
}
