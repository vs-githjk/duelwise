import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { GOALS_TO_WIN } from '@duelwise/core/src/games/puck/constants'
import { parseRegistry, type Registry } from '@duelwise/agents/src/registry'
import { GameShell } from '../../components/GameShell'
import { GameSoundControl } from '../../components/GameSoundControl'
import { HowToPlay } from '../../components/HowToPlay'
import { LevelPicker } from '../../components/LevelPicker'
import { PlayMode } from '../../components/PlayModeToggle'
import { ResultPanel } from '../../components/ResultPanel'
import { useNearMiss } from '../../lib/use-near-miss'
import { playTrainingBullet, resultTrainingNote } from '../../lib/honest-copy'
import { LEVELS, LEVEL_LABEL } from '../../lib/level-info'
import { setPractice } from '../../lib/practice'
import { visibleRegistry } from '../../lib/strength-gates'
import { cn } from '../../lib/cn'
import { Avatar } from '../../personas/Avatar'
import { personaFor } from '../../personas'
import { MomentBanner, PuckHud, ServeBanner, ThumbStrip } from './hud'
import { GoalPips } from './GoalPips'
import { finishedPips, pillAnchor } from './moments'
import { summaryLine } from './summary'
import { PRACTICE_PICKER_NOTE, agentCard, agentVersionFor, isPublished, limitsText, resultReason } from './strength'
import { usePuckMatch } from './usePuckMatch'
import './puck.css'

// The registry file is read as it stands. A level not published there is a labelled "In training" level (never a strength number).
const found = import.meta.glob('../../../../../packages/agents/registry/puck.json', { eager: true, import: 'default' })
const raw = Object.values(found)[0]
const sourceRegistry: Registry | null = raw ? parseRegistry(raw) : null
const registry: Registry | null = sourceRegistry ? visibleRegistry(sourceRegistry) : null
const published = (l: Level): boolean => isPublished(registry, l)

/** `?seed=<number>` fixes the first match's seed (an unrated test match). */
function seedFromUrl(): number | undefined {
  const q = new URLSearchParams(window.location.search).get('seed')
  return q !== null && /^\d{1,10}$/.test(q) && Number(q) < 2 ** 32 ? Number(q) : undefined
}

function levelFromUrl(): Level {
  const q = new URLSearchParams(window.location.search).get('level')
  if ((LEVELS as readonly string[]).includes(q ?? '')) return q as Level
  return LEVELS.find((l) => published(l)) ?? 'easy'
}

const btnPrimary = 'inline-flex min-h-11 items-center justify-center rounded-control bg-action px-5 font-semibold text-action-ink disabled:cursor-not-allowed disabled:opacity-50'
const btnPlain = 'inline-flex min-h-11 items-center justify-center rounded-control border border-line bg-surface px-5 font-semibold text-ink'

const agentVersion = (level: Level): string => agentVersionFor(sourceRegistry, level)

export default function PuckPage() {
  const match = usePuckMatch(agentVersion, registry?.learnsFromHumans === true)
  const [screen, setScreen] = useState<'prematch' | 'match'>('prematch')
  const [picked, setPicked] = useState<Level>(levelFromUrl)
  const [fixedSeed, setFixedSeed] = useState<number | undefined>(seedFromUrl)
  const [helpOpen, setHelpOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  // True once the match has left 'setup' since the player pressed Start, so the first render after the screen switch
  // (phase still 'setup') is not mistaken for a match that ended.
  const sawStart = useRef(false)

  const begin = async (level: Level = picked): Promise<void> => {
    const seed = fixedSeed
    setFixedSeed(undefined)
    sawStart.current = false
    // Glasscut has no rated path yet: every match is Practice, and the server stores it as one whatever is asked.
    setPractice(true)
    setLeaving(false)
    flushSync(() => setScreen('match'))
    await match.start({ level, stage: stage.current!, canvas: canvas.current!, seed })
  }

  // A failed start (the opponent could not load) puts the player back on the setup screen with the reason.
  useEffect(() => {
    if (match.phase !== 'setup') sawStart.current = true
    if (match.phase === 'setup' && screen === 'match' && (sawStart.current || match.failure)) setScreen('prematch')
  }, [match.phase, match.failure, screen])

  // A pause menu belongs to the pause: once the match runs again its sub-state is gone.
  useEffect(() => {
    if (!match.paused) setLeaving(false)
  }, [match.paused])

  const inMatch = screen === 'match'
  const playing = match.phase === 'playing'
  const over = match.phase === 'over'
  const matchLive = inMatch && (match.phase === 'loading' || match.phase === 'playing')
  const result = match.finished?.record.result
  const name = personaFor(match.level).name
  const training = match.preview || !published(match.level)
  const card = agentCard(registry, picked)
  const cardNow = agentCard(registry, match.level)
  const nearMiss = useNearMiss(match.finished?.record)
  const touch = match.pointer === 'touch'
  const goals = match.finished ? finishedPips(match.finished.record) : null

  const openHelp = (): void => {
    if (playing) match.pause()
    setHelpOpen(true)
  }
  const leaveClick = (): void => {
    if (playing) match.pause()
    setLeaving(true)
  }

  return (
    <GameShell matchActive={matchLive} game="puck" level={inMatch ? match.level : undefined} preview={inMatch && training} previewLabel="In training" onOpenGuide={() => { if (inMatch && playing) match.pause() }}>
      {!inMatch ? (
        <div className="grid gap-5 py-2" data-testid="prematch">
          <p className="max-w-prose text-muted">
            Air hockey on a glass table. First to {GOALS_TO_WIN} goals, or the lead at six minutes. On a phone, drag anywhere on the table: your mallet moves the way your finger moves, and nothing jumps when you touch down. With a mouse, the mallet follows the cursor.
          </p>
          <PlayMode ratedUnavailable="Glasscut has no rated matches yet." />
          <LevelPicker
            value={picked}
            onChange={setPicked}
            levels={Object.fromEntries(LEVELS.map((l) => [l, { preview: !published(l), practice: !published(l), strength: published(l) ? 'Strength tested' : undefined }]))}
            descriptions={Object.fromEntries(LEVELS.map((l) => [l, limitsText(l)]))}
            action={
              <button type="button" className={cn(btnPrimary, 'start-match')} data-testid="puck-start" onClick={() => void begin()}>
                Start match vs {personaFor(picked).name}
              </button>
            }
          />
          {LEVELS.some((l) => !published(l)) ? (
            <p className="text-sm text-muted" data-testid="practice-note">{PRACTICE_PICKER_NOTE}</p>
          ) : null}
          <div className="text-sm text-muted" data-testid="agent-card">
            <b data-testid="agent-name">{card.title}</b>
            <span data-testid="strength-line"> {card.strength}{card.why ? ` ${card.why}` : ''} {card.limits}{card.style ? ` ${card.style}` : ''}</span>
          </div>
          <ul className="grid gap-1 text-sm text-muted">
            <li>You always defend the near end. A puck that sits in one half for seven seconds goes to the other side.</li>
            <li>{playTrainingBullet('puck', registry)}</li>
          </ul>
          {match.failure ? (
            <p role="alert" className="rounded-control bg-warn-soft px-3 py-2 text-sm text-warn-ink">{match.failure}</p>
          ) : null}
        </div>
      ) : null}

      <div
        ref={stage}
        className="puck-stage"
        data-idle={inMatch ? undefined : ''}
        data-testid="puck-stage"
        data-phase={over ? 'over' : match.paused ? 'paused' : match.phase}
        data-pointer={match.pointer}
        data-landscape={match.layout.landscape ? '' : undefined}
        data-record-ok={match.finished ? String(match.finished.ok) : undefined}
      >
        <canvas ref={canvas} className="puck-canvas" data-testid="puck-canvas" aria-label="Air hockey table. Drag to move your mallet." role="img" />
        {inMatch && (playing || over || match.phase === 'loading') ? (
          <PuckHud hud={match.hud} level={match.level} training={training} paused={match.paused || over} onBack={leaveClick} onPause={match.pause} onHelp={openHelp} />
        ) : null}
        {playing && !match.paused ? (
          <div className="puck-pills" style={{ left: pillAnchor(match.layout).left, top: pillAnchor(match.layout).top }} data-testid="puck-pills">
            <ServeBanner serving={match.hud.serving} name={name} />
            <MomentBanner moment={match.moment} />
          </div>
        ) : null}
        {touch && playing && !match.paused ? <ThumbStrip layout={match.layout} size={match.size} quiet={match.dragged} /> : null}

        {match.phase === 'loading' ? (
          <div className="puck-ov" role="status">
            <p className="puck-loading">Setting up the table and {name}</p>
          </div>
        ) : null}

        {playing && match.paused ? (
          <div className="puck-ov" data-testid="puck-paused">
            <section role="dialog" aria-label="Paused" className="puck-card">
              <h2>Paused</h2>
              <div className="puck-opp">
                <Avatar level={match.level} size={40} decorative />
                <div>
                  <b>{cardNow.title}{training ? ', in training' : ''}</b>
                  <span>{cardNow.limits}</span>
                </div>
              </div>
              <div className="col">
                <button type="button" autoFocus className="puck-btn primary" data-testid="puck-resume" onClick={match.resume}>Resume</button>
                <button type="button" className="puck-btn" onClick={() => setHelpOpen(true)}>How to play</button>
                <div className="flex justify-center"><GameSoundControl /></div>
                <button type="button" className="puck-btn" onClick={() => void begin(match.level)}>Restart match</button>
                {leaving ? (
                  <div className="confirm" data-testid="pause-leave-confirm" role="group" aria-label="Leave this match?">
                    <p>Leave this match? It is not counted and nothing is saved.</p>
                    <div className="flex flex-wrap gap-2">
                      <a className="puck-btn primary" href="/play" data-testid="pause-leave">Leave match</a>
                      <button type="button" className="puck-btn" onClick={() => setLeaving(false)}>Stay</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="puck-btn" data-testid="pause-back" onClick={() => setLeaving(true)}><span aria-hidden="true">←</span>&nbsp;All games</button>
                )}
                <button type="button" className="puck-btn danger" onClick={match.quit}>Change level</button>
              </div>
            </section>
          </div>
        ) : null}

        {over && result ? (
          <div className="puck-ov" data-testid="puck-result">
            <div className="grid w-full max-w-md gap-3 [@media(orientation:landscape)_and_(max-height:520px)]:max-w-3xl">
              <ResultPanel
                result={{ ...result, reason: resultReason(result) }}
                humanSeat={0}
                keepPlace
                leaderboard={false}
                onRematch={() => void begin(match.level)}
                onChangeLevel={match.quit}
                onPlayLevel={(l) => { setPicked(l); void begin(l) }}
                nearMiss={nearMiss}
                extra={
                  <>
                    {goals && goals.label ? <GoalPips pips={goals.pips} label={goals.label} opponent={name} level={match.level} /> : null}
                    {match.summary ? (
                      <section aria-label="Match stats" data-testid="match-stats" className="grid gap-1 text-sm">
                        <h3 className="font-semibold">Your match</h3>
                        <p className="text-muted">{summaryLine(match.summary.you)}</p>
                      </section>
                    ) : null}
                  </>
                }
                upload={match.upload}
                unratedReason={match.unratedReason}
                recordOk={match.finished?.ok}
                note={resultTrainingNote('puck', registry, PRODUCT.trainingDataBasis === 'legitimate-interest')}
              />
            </div>
          </div>
        ) : null}

        {match.failure && inMatch && match.phase !== 'setup' ? <p role="alert" className="puck-alert">{match.failure}</p> : null}
      </div>
      {helpOpen ? <HowToPlay game="puck" onClose={() => setHelpOpen(false)} /> : null}
    </GameShell>
  )
}
