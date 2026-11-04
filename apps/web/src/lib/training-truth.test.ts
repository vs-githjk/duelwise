import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { validateRegistry, type Registry } from '@duelwise/agents/src/registry'
import { funnelNotes, HERO_SUBLINE, howItLearnsClosing, learnsNote, matchesTrainAgent, notTrainedSentence, recordsTrainable, reportLearnsCard, resultTrainingNote, settingsTrainingLine, trainingNoticeText, trainingStripLabel, trainingSurfaces } from './honest-copy'

const GAMES = Object.keys(PRODUCT.games) as GameId[]
const LEVELS: Level[] = ['easy', 'medium', 'hard', 'champion']
const REGISTRY_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'agents', 'registry')

function loadRegistry(game: GameId): Registry {
  const raw = JSON.parse(readFileSync(join(REGISTRY_DIR, `${game}.json`), 'utf8'))
  expect(validateRegistry(raw).ok).toBe(true)
  return raw as Registry
}
const fake = (learnsFromHumans: boolean) => ({ learnsFromHumans })

// What a sentence claims about training. Order matters: the negative forms contain the words of the positive ones.
function claim(text: string): 'uses' | 'not' | 'silent' {
  if (/\b(not used|never used|is not used|do not learn|does not learn|not for training|not use)\b/i.test(text)) return 'not'
  if (/\b(may be used|may use|may help train|may train|can feed|help train|can learn from|used to train)\b/i.test(text)) return 'uses'
  return 'silent'
}

test('one rule: matches train the agent exactly when the game registry says it learns from humans, for every game and level', () => {
  for (const game of GAMES) {
    for (const level of LEVELS) {
      expect(matchesTrainAgent(game, level, fake(true))).toBe(true)
      expect(matchesTrainAgent(game, level, fake(false))).toBe(false)
      expect(matchesTrainAgent(game, level, null)).toBe(false)
    }
  }
})

test('every surface says the same thing as the rule, for every game, level and registry state', () => {
  for (const game of GAMES) {
    for (const level of LEVELS) {
      for (const learns of [true, false]) {
        const reg = fake(learns)
        const expected = learns ? 'uses' : 'not'
        const s = trainingSurfaces(game, level, reg)
        const cell = `${game}/${level}/${learns}`
        expect([cell, 'notice', claim(s.notice)]).toEqual([cell, 'notice', expected])
        expect([cell, 'playBullet', claim(s.playBullet)]).toEqual([cell, 'playBullet', expected])
        expect([cell, 'resultNote', claim(s.resultNote)]).toEqual([cell, 'resultNote', expected])
        expect([cell, 'reportCard', claim(`${s.reportCard.title}. ${s.reportCard.text}`)]).toEqual([cell, 'reportCard', expected])
        expect(s.trainable).toBe(learns)
        expect(recordsTrainable(game, reg)).toBe(learns)
        expect(reportLearnsCard(game, reg)).toEqual(s.reportCard)
        // The player's own opt-out never makes a non-learning game claim training.
        for (const allowed of [true, false]) {
          const r = resultTrainingNote(game, reg, allowed)
          if (!learns) expect(claim(r)).toBe('not')
          else expect(claim(r)).toBe(allowed ? 'uses' : 'not')
        }
      }
    }
  }
})

test('the report card never promises that every match feeds the AI for a game that does not learn', () => {
  for (const game of GAMES) {
    const off = reportLearnsCard(game, fake(false))
    expect(`${off.title} ${off.text}`).not.toMatch(/learns from every match|can feed the next/i)
    const on = reportLearnsCard(game, fake(true))
    expect(on.text).toMatch(/can feed the next challenger/i)
  }
})

test('the real registries drive the strip label, the agents note, privacy, settings and the home page the same way', () => {
  const regs = Object.fromEntries(GAMES.map((g) => [g, loadRegistry(g)])) as Record<GameId, Registry>
  const trained = GAMES.filter((g) => regs[g].learnsFromHumans)
  const untrained = GAMES.filter((g) => !regs[g].learnsFromHumans)
  expect(trained.length + untrained.length).toBe(GAMES.length)
  for (const g of GAMES) {
    expect(trainingStripLabel(regs[g].learnsFromHumans)).toBe(regs[g].learnsFromHumans ? 'Trains on site matches' : 'Not yet')
    const note = learnsNote({ learns: regs[g].learnsFromHumans, hasLearned: false, pretraining: null, selfPlay: false, game: g })
    expect(claim(note)).toBe(regs[g].learnsFromHumans ? 'uses' : 'not')
  }
  const privacy = notTrainedSentence(regs)
  const closing = howItLearnsClosing(regs)
  const settings = settingsTrainingLine(regs)
  for (const g of untrained) {
    expect(privacy).toContain(PRODUCT.games[g].displayName)
    expect(closing).toContain(PRODUCT.games[g].displayName)
    expect(settings).not.toMatch(new RegExp(`\\b${PRODUCT.games[g].displayName}\\b[^.]*can be used`))
  }
  for (const g of trained) {
    expect(privacy).not.toContain(PRODUCT.games[g].displayName)
    expect(closing).toContain(PRODUCT.games[g].displayName)
    expect(settings).toContain(PRODUCT.games[g].displayName)
  }
})

test('a registry that learns from no game never claims training on the home page or in settings', () => {
  const none = Object.fromEntries(GAMES.map((g) => [g, fake(false)])) as Record<GameId, ReturnType<typeof fake>>
  expect(howItLearnsClosing(none)).toMatch(/no game trains on them yet/i)
  expect(settingsTrainingLine(none)).toMatch(/no game uses them for training yet/i)
  const all = Object.fromEntries(GAMES.map((g) => [g, fake(true)])) as Record<GameId, ReturnType<typeof fake>>
  expect(howItLearnsClosing(all)).toMatch(/unless you opt out/i)
})

test('the hero says nothing a Practice level would make false', () => {
  expect(HERO_SUBLINE).not.toMatch(/every level|every finished match|measured strength, and/i)
  expect(HERO_SUBLINE).toMatch(/in training/)
})

// Source scan: no page or component hard-codes a training claim; they all come from honest-copy.ts.
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|json)$/.test(f) && !/\.test\./.test(f) && f !== 'routeTree.gen.ts') out.push(p)
  }
  return out
}
const SRC = join(import.meta.dirname, '..')
const HARD_CODED = /help train the next version|learns from every match|will make the next version stronger|every finished match can make/i

test('no source file outside honest-copy.ts hard-codes a training line', () => {
  const offenders = walk(SRC)
    .filter((p) => !p.endsWith('lib/honest-copy.ts'))
    .filter((p) => HARD_CODED.test(readFileSync(p, 'utf8')))
    .map((p) => p.slice(SRC.length + 1))
  expect(offenders).toEqual([])
})

test('Stormglass, Crosscurrent and Twelve Yards are scripted (no model to train): its stats copy never says "yet" about training, and every other game reads as before', () => {
  const note = (game: GameId) => learnsNote({ learns: false, hasLearned: false, pretraining: null, selfPlay: false, game })
  for (const scripted of ['fleet', 'slack', 'penalty'] as const) {
    expect(trainingStripLabel(false, scripted)).toBe('Scripted')
    expect(note(scripted)).toBe('Scripted solver: does not learn from site matches, because there is nothing to train.')
    expect(funnelNotes(scripted)).toEqual({ nothingUsed: 'Nothing is used for training.', notLearning: 'not used: this agent is scripted and has nothing to train.' })
    expect(`${resultTrainingNote(scripted, fake(false), true)} ${reportLearnsCard(scripted, fake(false)).text} ${trainingNoticeText(scripted, false, 'opt-in').text}`).not.toMatch(/\byet\b/i)
  }
  for (const game of GAMES.filter((g) => g !== 'fleet' && g !== 'slack' && g !== 'penalty')) {
    expect(trainingStripLabel(false, game)).toBe('Not yet')
    expect(trainingStripLabel(true, game)).toBe('Trains on site matches')
    expect(funnelNotes(game)).toEqual({ nothingUsed: 'Nothing is used for training yet.', notLearning: 'not used: this agent does not learn from people yet.' })
    expect(note(game)).toContain('Does not learn from site matches yet.')
    expect(resultTrainingNote(game, fake(false), true)).toContain('does not learn from human matches yet')
    expect(reportLearnsCard(game, fake(false)).text).toContain('does not learn from human matches yet')
    expect(trainingNoticeText(game, false, 'opt-in').text).toContain('does not learn from human matches yet')
  }
})
