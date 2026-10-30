import { createContext, useContext } from 'react'
import type { GameId, Level } from '@duelwise/core/src/product'

/** Set by GameShell so the picker and the result panel know which game and which opponent they are about. */
export interface OpponentContextValue {
  game?: GameId
  level?: Level
}

export const OpponentContext = createContext<OpponentContextValue>({})

export function useOpponent(): OpponentContextValue {
  return useContext(OpponentContext)
}
