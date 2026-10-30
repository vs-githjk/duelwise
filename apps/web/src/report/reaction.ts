import { RESULT_TEMPLATES } from '../personas'
import type { ChessReport } from './chess'

const fill = (template: string, vars: Record<string, string | null>): string | null => {
  let missing = false
  const out = template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k]
    if (v === null || v === undefined) missing = true
    return v ?? ''
  })
  return missing ? null : out
}

/**
 * The persona's one-line reaction, from the design's templates. A line is only produced when every
 * fact it names was found in this match; otherwise the report simply has no reaction.
 */
export function chessReaction(outcome: 'win' | 'loss' | 'draw', facts: ChessReport['facts'], evaluator: 'value-net' | 'material'): string | null {
  // "I rated it as holding" claims the agent's own value net said so; a material count must not speak for it.
  if (outcome === 'win') return evaluator !== 'value-net' ? null :  fill(RESULT_TEMPLATES.loss_to_human!, { turn: facts.bestTurn, miss: facts.aiMiss })
  if (outcome === 'loss') return fill(RESULT_TEMPLATES.win_over_human!, { turn: facts.worstTurn, alt: facts.alt })
  return fill(RESULT_TEMPLATES.draw!, { turn: facts.swingTurn })
}
