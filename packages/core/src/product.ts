export type GameId = 'chess' | 'four' | 'holdem' | 'word' | 'fighter' | 'arena' | 'fleet' | 'slack'
export type Level = 'easy' | 'medium' | 'hard' | 'champion'

export interface GameConfig {
  displayName: string
  slug: string
  kind: 'turn' | 'rounds' | 'realtime'
  devices: 'all' | 'desktop'
}

const COUNT_WORDS = ['Six', 'Seven', 'Eight', 'Nine', 'Ten'] as const

/** Capitalised count word for the games on offer (six to ten); copy lowercases it where needed. */
export function gameCountWord(count: number = Object.keys(GAMES).length): string {
  const word = COUNT_WORDS[count - 6]
  if (!word) throw new Error(`gameCountWord: no word for ${count} games (add one to COUNT_WORDS)`)
  return word
}

const GAMES: Record<GameId, GameConfig> = {
  chess: { displayName: 'Chess', slug: 'chess', kind: 'turn', devices: 'all' },
  four: { displayName: 'Four in a Row', slug: 'four-in-a-row', kind: 'turn', devices: 'all' },
  holdem: { displayName: "Heads-Up Hold'em", slug: 'heads-up-holdem', kind: 'rounds', devices: 'all' },
  word: { displayName: 'Word Duel', slug: 'word-duel', kind: 'rounds', devices: 'all' },
  fighter: { displayName: 'Tinderbox', slug: 'tinderbox', kind: 'realtime', devices: 'desktop' },
  arena: { displayName: 'Coldstore', slug: 'coldstore', kind: 'realtime', devices: 'desktop' },
  fleet: { displayName: 'Stormglass', slug: 'stormglass', kind: 'turn', devices: 'all' },
  slack: { displayName: 'Crosscurrent', slug: 'crosscurrent', kind: 'turn', devices: 'all' },
}

// The only place the product name lives. A game is playable when
// apps/web/src/games/<id>/index.tsx exists; there is deliberately no enabled flag.
export const PRODUCT: {
  name: string
  tagline: string
  trainingDataBasis: 'legitimate-interest' | 'opt-in'
  championMinDelayFrames: number
  games: Record<GameId, GameConfig>
} = {
  name: 'Duelwise',
  tagline: `${gameCountWord()} games. Learning from you, starting with Four in a Row. Beat them if you can.`,
  trainingDataBasis: 'legitimate-interest',
  championMinDelayFrames: 3,
  games: GAMES,
}
