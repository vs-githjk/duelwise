import type { GameId } from '../product'
import type { GameCore } from '../types'
import { core as chess } from './chess/index'
import { core as four } from './four/index'
import { core as holdem } from './holdem/index'
import { core as word } from './word/index'
import { core as fighter } from './fighter/index'
import { core as arena } from './arena/index'
import { core as fleet } from './fleet/index'
import { core as slack } from './slack/index'
import { core as penalty } from './penalty/index'

// Each games/<id>/index.ts is a stub (`core = null`) until its owner replaces the file with
// a module that exports the real `core`. This registry never needs editing again.

const OWNER: Record<GameId, string> = {
  chess: 'Lane A (T4)',
  four: 'Lane A (T11)',
  holdem: 'Lane A (T13)',
  word: 'Lane B (T15)',
  fighter: 'Lane C (T6)',
  arena: 'Lane C (T9)',
  fleet: 'Fleet lane (F1)',
  slack: 'Crosscurrent lane (SW1)',
  penalty: 'Twelve Yards lane (TY1)',
}

export class NotBuiltError extends Error {
  readonly game: GameId
  constructor(game: GameId) {
    super(`The ${game} core is not built yet; it belongs to ${OWNER[game]}.`)
    this.name = 'NotBuiltError'
    this.game = game
  }
}

const CORES: Record<GameId, GameCore<any, any, any> | null> = { chess, four, holdem, word, fighter, arena, fleet, slack, penalty }

export function getCore(id: GameId): GameCore<any, any, any> {
  const core = CORES[id]
  if (!core) throw new NotBuiltError(id)
  return core
}
