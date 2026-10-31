import { visibleRegistry } from '../../lib/strength-gates'
import { useState } from 'react'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { parseRegistry, type Registry } from '@duelwise/agents/src/registry'
import { GameShell } from '../../components/GameShell'
import { LevelPicker } from '../../components/LevelPicker'
import { PlayMode } from '../../components/PlayModeToggle'
import { StrengthLine } from '../../components/SiteElo'
import { ResultPanel } from '../../components/ResultPanel'
import { personaFor } from '../../personas'
import { PlayHud } from '../../components/PlayHud'
import { LeavingNotice } from '../../components/LeavingNotice'
import { LEVEL_LABEL, levelInfoFromRegistry } from '../../lib/level-info'
import { boardSummary, dropAnnouncement } from './announce'
import { Board } from './Board'
import { HUMAN, showPracticeBadge, useFourMatch } from './useFourMatch'

export const meta = { title: 'Four in a Row' }

// The registry file appears when this game's measurement lands (a later task or lane). Until then every
// level is a preview and no strength is shown. Eager glob: a missing file is an empty object, not a build error.
const found = import.meta.glob('../../../../../packages/agents/registry/four.json', { eager: true, import: 'default' })
const raw = Object.values(found)[0]
const sourceRegistry: Registry | null = raw ? parseRegistry(raw) : null
const registry: Registry | null = sourceRegistry ? visibleRegistry(sourceRegistry) : null
const levelInfo = levelInfoFromRegistry(registry)

function firstSelectable(): Level {
  return (['easy', 'medium', 'hard', 'champion'] as const).find((l) => !levelInfo[l].inTraining) ?? 'easy'
}

/** `?seed=<number>` fixes the first match's seed, for tests and bug reports; later matches are random. */
function seedFromUrl(): number | undefined {
  const q = new URLSearchParams(window.location.search).get('seed')
  return q !== null && /^\d{1,10}$/.test(q) && Number(q) < 2 ** 32 ? Number(q) : undefined
}

export default function FourPage() {
  const match = useFourMatch((level) => sourceRegistry?.levels[level]?.version ?? 'preview', sourceRegistry?.learnsFromHumans === true)
  const [picked, setPicked] = useState<Level>(firstSelectable)
  const [fixedSeed, setFixedSeed] = useState<number | undefined>(seedFromUrl)
  const [confirming, setConfirming] = useState(false)

  const begin = (level: Level) => {
    const s = fixedSeed
    setFixedSeed(undefined)
    setConfirming(false)
    return match.start(level, s)
  }

  const measured = registry?.measured[match.level]
  const over = match.phase === 'over'
  const state = match.state
  const turn = over ? 'over' : match.thinking ? 'ai' : 'you'
  const status = over ? 'Match over' : match.failure ? 'Stopped' : match.thinking ? `${personaFor(match.level).name} is thinking` : 'Your move'

  return (
    <GameShell
      game="four"
      level={match.phase === 'setup' ? undefined : match.level}
      preview={showPracticeBadge(match.phase, match.preview, levelInfo[match.level].preview)}
      previewLabel="In training"
      thinking={match.thinking}
      result={over && match.result ? (
            <>
              <ResultPanel
                result={match.result}
                humanSeat={HUMAN}
                recordOk={match.finished ? match.finished.ok : true}
                upload={match.upload}
                unratedReason={match.unratedReason}
                onRematch={() => void match.start(match.level)}
                onPlayLevel={(l) => void match.start(l)}
                levels={levelInfo}
                moves={match.finished ? match.finished.record.actions.filter((a) => a[1] === match.finished!.record.humanSeat).length : 0}
                onChangeLevel={match.backToSetup}
              />
              {match.finished ? (
                <span hidden data-testid="four-record" data-record-ok={String(match.finished.ok)} data-final-hash={match.finished.record.finalHash} data-seed={String(match.seed)} />
              ) : null}
            </>
          ) : null}
      aside={
        match.phase === 'setup' || match.phase === 'starting' ? undefined : (
          <div className="grid gap-4">
          <section className="grid gap-1 rounded-card border border-line bg-surface p-4" data-testid="agent-card">
            <b className="font-display text-display-sm">
              {personaFor(match.level).name}, {LEVEL_LABEL[match.level]}
            </b>
            {match.counted ? <LeavingNotice /> : null}
            <StrengthLine siteElo={measured?.siteElo} />
            <p className="mt-2 flex items-center gap-4 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <i data-swatch="you" className="inline-block size-4 rounded-full border-2 border-muted bg-four-you" aria-hidden="true" /> You
              </span>
              <span className="inline-flex items-center gap-1.5">
                <i data-swatch="ai" className="inline-block size-4 rounded-full border-2 border-muted bg-four-ai" aria-hidden="true" /> {personaFor(match.level).name}
              </span>
            </p>
          </section>
          {match.phase === 'playing' ? (
            confirming ? (
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm resign">
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false)
                    match.resign()
                  }}
                  className="min-h-11 rounded-control bg-bad px-4 text-sm font-semibold text-white"
                >
                  Yes, resign
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="min-h-11 rounded-control border border-line bg-surface px-4 text-sm font-semibold">
                  Keep playing
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className="min-h-11 justify-self-start rounded-control border border-line bg-surface px-4 text-sm font-semibold">
                Resign
              </button>
            )
          ) : null}
          </div>
        )
      }
    >
      {match.phase === 'setup' || match.phase === 'starting' ? (
        <section className="grid gap-4" data-testid="four-setup">
          <p className="text-muted">Drop stones into the columns. The first to line up four, across, down or diagonally, wins. You move first.</p>
          <PlayMode disabled={match.phase === 'starting'} />
          <LevelPicker value={picked} onChange={setPicked} levels={levelInfo} statsSlug={PRODUCT.games.four.slug} disabled={match.phase === 'starting'}
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
          <PlayHud turn={turn} swatch="bg-four-you" matchKey={match.seed} />
          <p className="text-center text-sm font-semibold text-muted" data-testid="four-status">
            {status}
          </p>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="four-announce">
            {dropAnnouncement({ opponent: personaFor(match.level).name, lastCol: match.lastMove?.col ?? null, lastSeat: match.lastMove?.seat ?? null, moves: state.n, over })}
          </p>
          <p className="sr-only" data-testid="four-board-summary">
            {boardSummary(state, personaFor(match.level).name)}
          </p>
          <div className="stage">
            <Board opponent={personaFor(match.level).name} state={state} lastMove={match.lastMove} winCells={match.winCells} winLines={match.winLines} canMove={match.canMove} turn={turn} onDrop={(c) => void match.play(c)} />
          </div>
          {match.failure ? (
            <div className="grid justify-items-center gap-2">
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
