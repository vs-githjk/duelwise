import { DEFLECT_COST, RUSH_COST, SURGE_MAX } from '@duelwise/core/src/games/fighter/constants'
import { FIRST_ATTACK, M, MOVES, MOVE_COUNT } from '@duelwise/core/src/games/fighter/moves'

// The rows of the move list, read from the running frame data. Throw, Deflect and Rush have no hit box of their own
// (hasHit is false) but a player must still be able to find them (R30), so they are listed with n/a for hit data.

export interface MoveRow {
  id: number
  name: string
  startup: number
  active: number
  recovery: number
  /** Null for moves that deal no damage by themselves (Deflect, Rush) or whose hit data is a throw's. */
  damage: number | null
  onHit: number | null
  onBlock: number | null
  /** A short note for the moves that cost gauge or work differently. */
  note?: string
}

const UTILITY: readonly number[] = [M.THROW, M.DEFLECT, M.RUSH]
const surge = (cost: number) => `${cost.toLocaleString('en-US')} of ${SURGE_MAX.toLocaleString('en-US')} surge`

const NOTE: Record<number, string> = {
  [M.THROW]: 'Also called the grab. Beats blocking. A throw that meets a throw is teched.',
  [M.DEFLECT]: `Costs ${surge(DEFLECT_COST)}; a deflected strike gives most of it back.`,
  [M.RUSH]: `Costs ${surge(RUSH_COST)}; moves you forward, and a new attack can start near its end.`,
}

export function moveListRows(): MoveRow[] {
  const rows: MoveRow[] = []
  for (let id = FIRST_ATTACK; id < MOVE_COUNT; id++) {
    const m = MOVES[id]
    if (!m) continue
    const utility = UTILITY.includes(id)
    if (!m.hasHit && !utility) continue
    const remaining = m.total - m.startup
    rows.push({
      id,
      name: id === M.THROW ? 'Throw' : m.name,
      startup: m.startup,
      active: m.active,
      recovery: m.total - m.startup - m.active + 1,
      damage: m.hasHit ? m.damage : null,
      onHit: m.hasHit ? m.hitstun - remaining : null,
      onBlock: m.hasHit ? m.blockstun - remaining : null,
      note: NOTE[id],
    })
  }
  return rows
}
