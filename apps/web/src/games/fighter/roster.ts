// The two fighters' display names and colourway names. Provisional (ruling R12), kept in this one file so a
// rename is one edit; the renderer's characters.ts holds the matching rigs and costumes by index.
export interface RosterEntry {
  name: string
  role: string
  blurb: string
  colorways: readonly string[]
}

export const ROSTER: readonly [RosterEntry, RosterEntry] = [
  { name: 'Ines Kade', role: 'All-rounder', blurb: 'Lean and quick, comfortable at any range.', colorways: ['Ember', 'Slate', 'Moss'] },
  { name: 'Baro Tenn', role: 'Bruiser', blurb: 'A heavier build that wants to be close.', colorways: ['Rust', 'Navy', 'Bone'] },
]

/** Both fighters share one move table in this version; the select screen says so. */
export const SHARED_MOVES_NOTE = 'Both fighters use the same moves in this version. The choice is the look, not the kit.'

export interface FighterChoice {
  character: number
  colorway: number
}

/** The AI picks after you: the other fighter, in the colourway that does not clash with yours (colourway 0 is the default, 1 and 2 the alternates). */
export function aiChoiceFor(me: FighterChoice): FighterChoice {
  return { character: 1 - me.character, colorway: me.colorway === 1 ? 2 : 1 }
}
