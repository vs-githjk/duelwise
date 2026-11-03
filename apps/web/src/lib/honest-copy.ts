import { PRODUCT, gameCountWord, type GameId, type Level } from '@duelwise/core/src/product'
import type { Registry } from '@duelwise/agents/src/registry'
import { personaFor } from '../personas'
import { LEVEL_LABEL, type LevelInfo } from './level-info'

/** The name every page uses for the opponent. Never the product name. */
export function opponentLabel(level: Level): string {
  return personaFor(level).name
}

const BAND = /^b(\d{3,4})$/

/**
 * Which levels learned from human games, read from the registry level configs (a `band` such as b1100 names the
 * Lichess rating band the policy net was trained on). Null when no level of this game did.
 */
export function pretrainingSentence(reg: Registry | null): string | null {
  if (!reg || reg.game !== 'chess') return null
  const found: Array<{ level: Level; band: string }> = []
  for (const level of ['easy', 'medium', 'hard', 'champion'] as const) {
    // A level held back as Practice keeps its config in unpublishedConfig; the network it plays still learned from those games.
    const band = (reg.levels[level]?.config ?? reg.unpublishedConfig?.[level])?.band
    const m = typeof band === 'string' ? BAND.exec(band) : null
    if (m) found.push({ level, band: m[1]! })
  }
  if (found.length === 0) return null
  const names = found.map((f) => LEVEL_LABEL[f.level])
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const bands = found.map((f) => f.band)
  const band = bands.length === 1 ? `rating band ${bands[0]}` : `rating bands ${bands.slice(0, -1).join(', ')} and ${bands[bands.length - 1]}`
  return `${who} learned from Lichess human games (${band}).`
}

/** Stormglass has no model at all: its levels are hand-written algorithms, so "yet" would promise training that can never happen. */
const isScripted = (game: GameId): boolean => game === 'fleet'
const NOTHING_TO_TRAIN = 'is a scripted solver and does not learn from matches'

export interface TrainingNoticeCopy {
  /** False when the agent does not learn from human matches yet, so the match record must not be marked trainable. */
  trainable: boolean
  text: string
}

/**
 * The training notice for one game. It follows the game's registry: when the agent does not learn from human
 * matches yet (learnsFromHumans false) the notice says so and the records are not trainable. Only a game whose
 * registry says it learns (Four today) gets the product-wide "may be used" wording.
 */
export function trainingNoticeText(game: GameId, learnsFromHumans: boolean, basis: 'opt-in' | 'legitimate-interest'): TrainingNoticeCopy {
  if (!matchesTrainAgent(game, ANY_LEVEL, { learnsFromHumans })) {
    const agent = PRODUCT.games[game].displayName.replace(/^Heads-Up /, '')
    return {
      trainable: false,
      text: `The ${agent} agent ${isScripted(game) ? NOTHING_TO_TRAIN : 'does not learn from human matches yet'}. A replayable record of each match (the moves, the result and your input timing, never your name or email) is kept for your match report and is not used to train the agent.`,
    }
  }
  return {
    trainable: true,
    text:
      basis === 'opt-in'
        ? `${PRODUCT.name} can learn from the matches you play: the moves, the result and your input timing, never your name or email. Tick the box if you want to help; it is off until you do.`
        : `${PRODUCT.name} keeps a replayable record of each match (the moves, the result and your input timing, never your name or email) and may use it to train the agents. You can turn that off at any time.`,
  }
}

type LearnsReg = Pick<Registry, 'learnsFromHumans'> | null

/**
 * THE rule: do a game's matches train its agent? It reads one registry fact, learnsFromHumans, and nothing else.
 * Training pools are per game, so a level never changes the answer (a Practice level included); the argument is
 * here so every caller says which cell of the game x level matrix it asks about, and so a future per-level rule
 * has one place to live. The player's own opt-out is a separate setting and never turns this on.
 * A missing registry cannot promise training.
 */
export function matchesTrainAgent(game: GameId, level: Level, registry: LearnsReg): boolean {
  void game
  void level
  return registry?.learnsFromHumans === true
}

const ANY_LEVEL: Level = 'easy'

/**
 * Whether a game's stored records are meant to be trainable. This is the same rule the training notice follows, so a
 * record stored with the flag off by design (every game whose registry says it does not learn yet) is told apart
 * from a player's own opt-out.
 */
export function recordsTrainable(game: GameId, registry: LearnsReg): boolean {
  return matchesTrainAgent(game, ANY_LEVEL, registry)
}

/** The trainingAllowed flag a browser writes into a match record: the product basis, and never for a game that does not learn yet. */
export function recordTrainingAllowed(game: GameId, registry: LearnsReg): boolean {
  return recordsTrainable(game, registry) && PRODUCT.trainingDataBasis === 'legitimate-interest'
}

/** Plain words for "site Elo". Wherever the number appears, this explains it. */
export function siteEloExplainer(): string {
  return 'Site Elo is a strength number we measure by playing the levels against each other. Easy is pinned at 1000 and every other level is placed from its results against the one below. A gap of 200 points means the stronger side is expected to win about three games in four (76 in 100, counting a draw as half). It is not a FIDE or chess.com rating, so it says nothing about how you would score against people.'
}

/** Training jobs are internal. Only the owner sees them; everyone else gets null, as if the status file were unreadable. */
export function visibleJobs<T>(jobs: T[] | null, owner: boolean): T[] | null {
  return owner ? jobs : null
}

/** The Preview badge means "no measured strength". A level that is in training already says so, so it gets no badge. */
export function showsPreviewBadge(info: Pick<LevelInfo, 'preview' | 'inTraining'>): boolean {
  return info.preview && !info.inTraining
}

/** The strip label on the agents overview: whether site matches are used for training (the registry rule), not whether a version has learned yet. */
export function trainingStripLabel(usesMatches: boolean, game?: GameId): string {
  if (usesMatches) return 'Trains on site matches'
  return game && isScripted(game) ? 'Scripted' : 'Not yet'
}

/** The two sentences under the human-matches funnel on the agents page. */
export function funnelNotes(game: GameId): { nothingUsed: string; notLearning: string } {
  return isScripted(game)
    ? { nothingUsed: 'Nothing is used for training.', notLearning: 'not used: this agent is scripted and has nothing to train.' }
    : { nothingUsed: 'Nothing is used for training yet.', notLearning: 'not used: this agent does not learn from people yet.' }
}

/**
 * The one-line "does this agent learn from people" note on the agents page, built from registry facts only.
 * `learns` is the rule (matches are used for training); `hasLearned` is the separate fact that a promoted version
 * already used human matches (adapters.json).
 */
export function learnsNote(f: { learns: boolean; hasLearned: boolean; pretraining: string | null; selfPlay: boolean; game: GameId }): string {
  if (f.learns) return `Filtered human matches may be used to train this agent. ${f.hasLearned ? 'A promoted version has learned from them.' : 'No promoted version has learned from them yet.'}`
  if (isScripted(f.game)) return 'Scripted solver: does not learn from site matches, because there is nothing to train.'
  const parts = ['Does not learn from site matches yet.']
  if (f.game === 'holdem') parts.push('Matches here are recorded for the player and are not used for training.')
  if (f.pretraining) parts.push(f.pretraining)
  if (f.selfPlay) parts.push('It also trains on self-play.')
  return parts.join(' ')
}

/** The privacy page sentence naming every game whose matches are not used for training, built from the registries. */
export function notTrainedSentence(registries: Partial<Record<GameId, Pick<Registry, 'learnsFromHumans'> | null>>): string {
  const off = (Object.keys(PRODUCT.games) as GameId[]).filter((g) => !recordsTrainable(g, registries[g] ?? null))
  if (off.length === 0) return 'Every game\'s agent learns from filtered human matches.'
  const nameOf = (g: GameId) => PRODUCT.games[g].displayName
  const join = (names: string[]) => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
  // A scripted solver can never train, so it is not promised ("yet") like an agent that may learn later.
  const later = off.filter((g) => !isScripted(g)).map(nameOf)
  const solvers = off.filter(isScripted).map(nameOf)
  const solver = solvers.length === 0 ? '' : `${join(solvers)} ${solvers.length === 1 ? 'is a scripted solver' : 'are scripted solvers'} with nothing to train.`
  if (later.length === 0) return `${join(solvers)} matches are not used for training at present: ${solver}`
  const head = `${join(later)} matches are not used for training at present: ${later.length === 1 ? 'that agent does' : 'those agents do'} not learn from human matches yet.`
  return solver ? `${head} ${solver}` : head
}

const RECORD = 'a replayable record (the inputs and the result, never your name or email)'

/** The bullet above the Start button on a play page that has no switch of its own. */
export function playTrainingBullet(game: GameId, registry: LearnsReg): string {
  if (!matchesTrainAgent(game, ANY_LEVEL, registry)) return 'Finished matches are stored for your report and are not used to train the agent.'
  return PRODUCT.trainingDataBasis === 'opt-in'
    ? 'Finished matches are stored and are used to train the agent only if you opted in.'
    : 'Finished matches are stored and, unless you opt out, may be used to train the next version.'
}

/** The note under a finished match. `allowed` is the player's own setting, which can only turn training off. */
export function resultTrainingNote(game: GameId, registry: LearnsReg, allowed: boolean): string {
  if (!matchesTrainAgent(game, ANY_LEVEL, registry)) return `This match is stored as ${RECORD} for your report. ${isScripted(game) ? `This agent ${NOTHING_TO_TRAIN}` : 'This agent does not learn from human matches yet, so it is not used to train'}.`
  if (!allowed) return `This match is stored as ${RECORD}. Training is off for you, so it is not used to train the agent.`
  return `This match is stored as ${RECORD}. It may be used to train the next version of the agent.`
}

/** The card on a public report: what a visiting stranger is told about training. */
export function reportLearnsCard(game: GameId, registry: LearnsReg): { title: string; text: string } {
  if (!matchesTrainAgent(game, ANY_LEVEL, registry)) {
    return {
      title: 'How the AI improves',
      text: `${PRODUCT.name} has ${gameCountWord().toLowerCase()} games and four levels. ${isScripted(game) ? `This game's agent ${NOTHING_TO_TRAIN}, so matches like this one train nothing` : "This game's agent does not learn from human matches yet, so matches like this one are not used to train it"}. A new version is published only if it beats the champion.`,
    }
  }
  return {
    title: 'One AI that learns from the matches people play',
    text: `${PRODUCT.name} has ${gameCountWord().toLowerCase()} games and four levels. Matches like this one can feed the next challenger, which is published only if it beats the champion.`,
  }
}

/** Every surface for one cell of the game x level matrix, from the one rule. The matrix test compares these. */
export function trainingSurfaces(game: GameId, level: Level, registry: LearnsReg) {
  const trainable = matchesTrainAgent(game, level, registry)
  return {
    trainable,
    notice: trainingNoticeText(game, trainable, PRODUCT.trainingDataBasis).text,
    playBullet: playTrainingBullet(game, registry),
    resultNote: resultTrainingNote(game, registry, true),
    reportCard: reportLearnsCard(game, registry),
  }
}

function namesOf(games: GameId[]): string {
  const names = games.map((g) => PRODUCT.games[g].displayName)
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

type Regs = Partial<Record<GameId, LearnsReg>>
const ALL_GAMES = Object.keys(PRODUCT.games) as GameId[]
const trainedGames = (regs: Regs): GameId[] => ALL_GAMES.filter((g) => matchesTrainAgent(g, ANY_LEVEL, regs[g] ?? null))
const untrainedGames = (regs: Regs): GameId[] => ALL_GAMES.filter((g) => !matchesTrainAgent(g, ANY_LEVEL, regs[g] ?? null))

/** The closing line of the home page "How the AI learns" block. */
export function howItLearnsClosing(regs: Regs): string {
  const yes = trainedGames(regs)
  const no = untrainedGames(regs)
  const chips = 'Play chips only. Nothing to buy, nothing to win but a place on the board.'
  if (yes.length === 0) return `${chips} Matches are kept for your report and rating; no game trains on them yet.`
  const tail = no.length === 0 ? '' : ` In ${namesOf(no)} they are kept for your report and rating only.`
  return `${chips} ${PRODUCT.name} uses finished ${namesOf(yes)} matches for training unless you opt out in Settings.${tail}`
}

/** The line above the training switch in Settings. */
export function settingsTrainingLine(regs: Regs): string {
  const yes = trainedGames(regs)
  const base = 'Matches you play are stored as replayable records.'
  if (yes.length === 0) return `${base} No game uses them for training yet, so this switch changes nothing today; it will apply the day one does.`
  return `${base} Only ${namesOf(yes)} matches can be used for training today. Turn this off and none of your matches, past or future, are used to train the agents.`
}

/** The home page subline. True for Practice levels: only some levels carry a measured strength, and it says so. */
export const HERO_SUBLINE =
  'Pick a game and a level. Levels with a measured strength show it; Levels in training are playable and have no strength number yet. Where a game learns from people, finished matches can help the next version.'
