import { visibleRegistry } from '../../lib/strength-gates'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { parseRegistry } from '@duelwise/agents/src/registry'
import registryJson from '@duelwise/agents/registry/word.json'
import { GameShell } from '../../components/GameShell'
import { LevelPicker } from '../../components/LevelPicker'
import { PlayMode } from '../../components/PlayModeToggle'
import { personaFor, styleLine } from '../../personas'
import { calledFor } from '../../lib/progress'
import { ResultPanel } from '../../components/ResultPanel'
import { getVolume, isMuted, setMuted, subscribeAudio } from '../../lib/audio'
import { PlayHud } from '../../components/PlayHud'
import { LeavingNotice } from '../../components/LeavingNotice'
import { LEVEL_LABEL, levelInfoFromRegistry } from '../../lib/level-info'
import { GuessInput } from './GuessInput'
import { LetterTracker } from './LetterTracker'
import { RoundCard, WordLedger } from './ledger'
import { roundAnnouncement } from './announce'
import { useWordMatch } from './useWordMatch'

export const meta = { title: 'Word Duel' }

const sourceRegistry = parseRegistry(registryJson)
const registry = visibleRegistry(sourceRegistry)
const levelInfo = levelInfoFromRegistry(registry)
const MAX_GUESSES = 6

function firstSelectable(): Level {
  return (['easy', 'medium', 'hard', 'champion'] as const).find((l) => !levelInfo[l].inTraining) ?? 'easy'
}

/** `?seed=<number>` fixes the first match's word, for tests and bug reports; later matches are random. */
function seedFromUrl(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get('seed')
  return raw !== null && /^\d{1,10}$/.test(raw) && Number(raw) < 2 ** 32 ? Number(raw) : undefined
}

function MuteToggle() {
  useSyncExternalStore(subscribeAudio, getVolume, getVolume)
  const muted = useSyncExternalStore(subscribeAudio, isMuted, () => false)
  return (
    <button type="button" aria-pressed={muted} onClick={() => setMuted(!muted)} className="min-h-11 rounded-control border border-line bg-surface px-3 text-sm font-semibold">
      {muted ? 'Sound off' : 'Sound on'}
    </button>
  )
}

export default function WordDuelPage() {
  const match = useWordMatch((level) => sourceRegistry.levels[level]?.version ?? 'preview', undefined, sourceRegistry.learnsFromHumans === true)
  const [picked, setPicked] = useState<Level>(firstSelectable)
  const [fixedSeed, setFixedSeed] = useState<number | undefined>(seedFromUrl)
  const [draft, setDraft] = useState('')
  useEffect(() => setDraft(''), [match.seed])

  const begin = (level: Level) => {
    const s = fixedSeed
    setFixedSeed(undefined)
    return match.start(level, s)
  }

  const level = match.phase === 'setup' ? undefined : match.level
  const measured = registry.measured[match.level]
  const state = match.state
  const over = match.phase === 'over'

  return (
    <GameShell
      game="word"
      level={level}
      preview={match.phase !== 'setup' && (match.preview || levelInfo[match.level].preview)}
      previewLabel="Practice"
      thinking={match.thinking}
      actions={<MuteToggle />}
      result={
        over && match.finished && state ? (
            <div className="grid gap-3">
              <ResultPanel
                result={match.finished.record.result}
                humanSeat={0}
                recordOk={match.finished.ok}
                upload={match.upload}
                unratedReason={match.unratedReason}
                reveal={
                  state.answer ? (
                    <div data-testid="word-answer" className="grid gap-1.5">
                      <span className="text-sm text-muted">The word was</span>
                      <span className="flex gap-1.5" role="img" aria-label={state.answer.toUpperCase()}>
                        {Array.from(state.answer).map((c, i) => (
                          <span key={i} aria-hidden="true" className="tile max-w-11 font-mono text-xl font-semibold uppercase leading-none text-ink">
                            {c}
                          </span>
                        ))}
                      </span>
                    </div>
                  ) : null
                }
                onRematch={() => void match.start(match.level)}
                onPlayLevel={(l) => void match.start(l)}
                levels={levelInfo}
                moves={match.finished ? match.finished.record.actions.filter((a) => a[1] === match.finished!.record.humanSeat).length : 0}
                onChangeLevel={match.backToSetup}
              />
              <span hidden data-testid="word-record" data-record-ok={String(match.finished.ok)} data-final-hash={match.finished.record.finalHash} data-seed={String(match.seed)} />
            </div>

        ) : undefined
      }
      aside={
        match.phase === 'setup' || !state ? undefined : (
          <div className="grid gap-3">
            <RoundCard you={state.marks[0]} opponentName={personaFor(match.level).name} opponent={state.marks[1]} maxGuesses={MAX_GUESSES} over={over} />
            <section className="grid gap-1 rounded-card border border-line bg-surface p-4" data-testid="agent-card">
              <b className="font-display text-display-sm">
                {personaFor(match.level).name}, {LEVEL_LABEL[match.level]}
              </b>
              {match.counted ? <LeavingNotice /> : null}
              <p className="text-sm text-muted" data-testid="opponent-style">{styleLine(match.level, 'word')}</p>
              {measured ? (
                <p className="text-sm text-muted">
                  Averages <span className="font-mono tabular text-ink">{measured.value.toFixed(2)}</span> guesses over every answer word.
                </p>
              ) : (
                <p className="text-sm text-muted">No measured strength yet.</p>
              )}
            </section>
            {calledFor('word') ? (
              <section className="rounded-card border border-dashed border-action bg-surface px-4 py-3 text-sm" data-testid="call-card">
                You called <b>{personaFor(calledFor('word')!).name}</b>.
              </section>
            ) : null}
          </div>
        )
      }
    >
      {match.phase === 'setup' || match.phase === 'starting' ? (
        <section className="grid gap-4" data-testid="word-setup">
          <p className="text-muted">You and the opponent guess the same hidden five-letter word at the same time. Each round you both see how close the other got, but never their letters. First to solve it wins.</p>
          <p className="text-sm text-muted">In counted matches, the server keeps the answer and the opponent's words hidden until the match ends.</p>
          <PlayMode disabled={match.phase === 'starting'} />
          <LevelPicker value={picked} onChange={setPicked} levels={levelInfo} statsSlug={PRODUCT.games.word.slug} disabled={match.phase === 'starting'}
            action={
              <>
          {match.failure ? (
            <p role="alert" className="rounded-control bg-bad-soft px-3 py-2 text-sm text-bad-ink">
              {match.failure}
            </p>
          ) : null}
          <button
            type="button"
            disabled={match.phase === 'starting'}
            onClick={() => void begin(picked)}
            className="start-match min-h-12 justify-self-start rounded-control bg-action px-6 font-semibold text-action-ink disabled:opacity-60"
          >
            Start match vs {personaFor(picked).name}
          </button>
              </>
            }
          />
        </section>
      ) : state ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <PlayHud turn={over ? 'over' : 'you'} swatch="bg-token-you" matchKey={match.seed} />
          <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="word-announce">
            {roundAnnouncement({ mine: state.guesses[0], myRows: state.marks[0], oppName: personaFor(match.level).name, oppRows: state.marks[1], max: MAX_GUESSES })}
          </p>
          <div className="stage">
          <WordLedger
            you={{ words: state.guesses[0], rows: state.marks[0] }}
            opponentName={personaFor(match.level).name}
            opponent={{ rows: state.marks[1], words: over ? state.guesses[1] : undefined }}
            maxGuesses={MAX_GUESSES}
            draft={draft}
            over={over}
          />
          </div>
          {!over ? (
            <>
              <LetterTracker words={state.guesses[0]} marks={state.marks[0]} />
              <GuessInput onSubmit={match.submit} disabled={match.thinking} onDraft={setDraft} />
            </>
          ) : null}
          {match.failure ? (
            <div className="grid justify-items-start gap-2">
              <p role="alert" className="rounded-control bg-bad-soft px-3 py-2 text-sm text-bad-ink">
                {match.failure}
              </p>
              <button type="button" onClick={match.backToSetup} className="min-h-11 rounded-control border border-line bg-surface px-5 font-semibold">
                Back to setup
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </GameShell>
  )
}
