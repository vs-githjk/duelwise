import { MATCH_HANDS, type MatchOptions } from '@duelwise/core/src/games/holdem/match'

/** What the player picks before a match: a number of hands. A bust (losing all 100 chips in one hand) ends every match at once, so it is not a choice. */
export type LengthChoice = '5' | '10' | '15' | '30'

export const LENGTH_CHOICES: readonly { id: LengthChoice; label: string; hint: string }[] = [
  { id: '5', label: '5 hands', hint: 'A quick game' },
  { id: '10', label: '10 hands', hint: 'About five minutes' },
  { id: '15', label: '15 hands', hint: 'A bit longer' },
  { id: '30', label: '30 hands', hint: 'The full match' },
]

export const DEFAULT_CHOICE: LengthChoice = '10'
export const STORAGE_KEY = 'duelwise.holdem.length'

const isChoice = (v: unknown): v is LengthChoice => LENGTH_CHOICES.some((c) => c.id === v)

/**
 * The match options a choice stands for. Every rated match uses the strict bust rule; a practice match has none (a busted player buys
 * back in for free), so it carries only the length. The 30 hand length is the default, so it is left out.
 */
export function optionsFor(choice: LengthChoice, practice = false): MatchOptions {
  const bust = practice ? {} : { untilBust: true as const }
  return Number(choice) === MATCH_HANDS ? { ...bust } : { hands: Number(choice), ...bust }
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The last choice on this device; the default when nothing is stored or storage is blocked. */
export function readChoice(store: Store | null = defaultStore()): LengthChoice {
  try {
    const v = store?.getItem(STORAGE_KEY)
    return isChoice(v) ? v : DEFAULT_CHOICE
  } catch {
    return DEFAULT_CHOICE
  }
}

export function saveChoice(choice: LengthChoice, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(STORAGE_KEY, choice)
  } catch {
    // Private windows and blocked storage: the pick simply is not remembered.
  }
}
