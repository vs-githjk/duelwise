// Round and money rules. Numbers and sources: docs/game-design/arena.md.

export const START_MONEY = 800
export const MONEY_CAP = 16000
export const WIN_REWARD = 3250
export const LOSS_BASE = 1400
export const LOSS_STEP = 500
export const LOSS_STREAK_MAX = 4

export const BUY_FRAMES = 600
export const ROUND_FRAMES = 3600
export const ROUND_END_FRAMES = 180
export const ROUNDS_TO_WIN = 7
export const MAX_ROUNDS = 13
export const MAX_HEALTH = 100

/** Loss bonus for a seat whose current streak is `streak` (before the new loss is counted). */
export function lossBonus(streak: number): number {
  return LOSS_BASE + LOSS_STEP * (streak > LOSS_STREAK_MAX ? LOSS_STREAK_MAX : streak)
}

export function addMoney(money: number, amount: number): number {
  const m = money + amount
  return m > MONEY_CAP ? MONEY_CAP : m
}
