import { visibleRegistry } from '../../lib/strength-gates'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { parseRegistry, type Registry } from '@duelwise/agents/src/registry'
import { GameShell } from '../../components/GameShell'
import { LevelPicker } from '../../components/LevelPicker'
import { PlayMode } from '../../components/PlayModeToggle'
import { StrengthLine } from '../../components/SiteElo'
import { personaFor } from '../../personas'
import { ResultPanel } from '../../components/ResultPanel'
import { getVolume, isMuted, setMuted, subscribeAudio } from '../../lib/audio'
import { LeavingNotice } from '../../components/LeavingNotice'
import { LEVEL_LABEL, levelInfoFromRegistry } from '../../lib/level-info'
import { PlayHud } from '../../components/PlayHud'
import { boardSummary, moveAnnouncement } from './announce'
import { ChessBoard } from './ChessBoard'
import { HUMAN, useChessMatch } from './useChessMatch'
import { warmChessAssets } from './warm'

export const meta = { title: 'Chess' }

// The registry file appears when this game's measurement lands (a later task or lane). Until then every
// level is a preview and no strength is shown. Eager glob: a missing file is an empty object, not a build error.
const found = import.meta.glob('../../../../../packages/agents/registry/chess.json', { eager: true, import: 'default' })
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

/** `?fen=` starts from another position. Dev builds only (tests use it for promotion and mate); a custom position cannot be replayed from the seed. */
function fenFromUrl(): string | undefined {
  if (!import.meta.env.DEV) return undefined
  return new URLSearchParams(window.location.search).get('fen') ?? undefined
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

/** Moves in pairs ("1. e4 e5"), newest last, scrolled to the end. */
function MoveList({ sans }: { sans: string[] }) {
  const list = useRef<HTMLOListElement>(null)
  // Scroll the list itself, never the page: scrollIntoView on the newest row also scrolled the window down to this list (below the board on a
  // phone) after every move, and the player had to scroll back up to the board each time.
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sans.length])
  const rows: Array<[string, string | undefined]> = []
  for (let i = 0; i < sans.length; i += 2) rows.push([sans[i]!, sans[i + 1]])
  return (
    <ol ref={list} className="max-h-40 overflow-y-auto font-mono text-sm leading-5 tabular" data-testid="move-list" aria-label="Moves">
      {rows.length === 0 ? <li className="text-muted">No moves yet.</li> : null}
      {rows.map(([w, b], i) => (
        <li key={i} className="grid grid-cols-[2.5rem_1fr_1fr] gap-2">
          <span className="text-muted">{i + 1}.</span>
          <span>{w}</span>
          <span>{b ?? ''}</span>
        </li>
      ))}
    </ol>
  )
}

export default function ChessPage() {
  const match = useChessMatch((level) => sourceRegistry?.levels[level]?.version ?? 'preview', sourceRegistry?.learnsFromHumans === true)
  const [picked, setPicked] = useState<Level>(firstSelectable)
  // Fetch the model while the player is still choosing, so Start finds it in the HTTP cache.
  useEffect(() => warmChessAssets(picked), [picked])
  const [fixed, setFixed] = useState(() => ({ seed: seedFromUrl(), fen: fenFromUrl() }))
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 3000)
    return () => clearTimeout(t)
  }, [notice])
  useEffect(() => {
    if (match.phase !== 'playing') setConfirming(false)
  }, [match.phase])

  const begin = (level: Level) => {
    const { seed, fen } = fixed
    setFixed({ seed: undefined, fen: undefined })
    setNotice('')
    return match.start(level, seed, fen)
  }

  const measured = registry?.measured[match.level]
  const over = match.phase === 'over'
  const state = match.state
  const turn = over ? 'over' : match.thinking ? 'ai' : 'you'
  const status = over ? 'Match over' : match.failure ? 'Stopped' : match.thinking ? `${personaFor(match.level).name} is thinking` : match.checkSquare ? 'Your move, you are in check' : 'Your move'
  const setup = match.phase === 'setup' || match.phase === 'starting'

  return (
    <GameShell
      game="chess"
      level={setup ? undefined : match.level}
      preview={!setup && (match.preview || levelInfo[match.level].preview)}
      previewLabel="In training"
      thinking={match.thinking}
      actions={<MuteToggle />}
      result={over && match.result ? (
            <>
              {match.sans.at(-1)?.endsWith('#') ? <p className="text-center font-semibold" data-testid="chess-mating-move">{moveAnnouncement({ opponent: personaFor(match.level).name, plies: match.plies, lastSan: match.sans.at(-1), inCheck: true, over: true })}</p> : null}
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
                <span hidden data-testid="chess-record" data-record-ok={String(match.finished.ok)} data-final-hash={match.finished.record.finalHash} data-seed={String(match.seed)} />
              ) : null}
            </>
          ) : null}
      aside={
        setup ? undefined : (
          <div className="grid gap-4">
            <section className="grid gap-1 rounded-card border border-line bg-surface p-4" data-testid="agent-card">
              <b className="font-display text-display-sm">
                {personaFor(match.level).name}, {LEVEL_LABEL[match.level]}
              </b>
            {match.counted ? <LeavingNotice /> : null}
              <StrengthLine siteElo={measured?.siteElo} />
              <p className="mt-2 flex items-center gap-4 text-sm">
                <span className="inline-flex items-center gap-1.5">
                  <i data-swatch="white" className="inline-block size-4 rounded-full border-2 border-muted bg-[var(--piece-white)]" aria-hidden="true" /> You, White
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <i data-swatch="black" className="inline-block size-4 rounded-full border-2 border-muted bg-[var(--piece-black)]" aria-hidden="true" /> {personaFor(match.level).name}, Black
                </span>
              </p>
            </section>
            <section className="grid gap-2 rounded-card border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold text-muted">Moves</h2>
              <MoveList sans={match.sans} />
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
      {setup ? (
        <section className="grid gap-4" data-testid="chess-setup">
          <p className="text-muted">You play White and move first. Tap a piece and then a highlighted square, or drag it. Draws by stalemate, repetition and the fifty-move rule are detected for you.</p>
          <PlayMode disabled={match.phase === 'starting'} />
          <LevelPicker value={picked} onChange={setPicked} levels={levelInfo} statsSlug={PRODUCT.games.chess.slug} disabled={match.phase === 'starting'}
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
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <PlayHud turn={turn} youLabel="You, White" swatch="bg-piece-white" matchKey={match.seed} />
          <p className="text-center text-sm font-semibold text-muted" data-testid="chess-status">
            {status}
          </p>
          {/* Spoken, not shown: the opponent's move as it happens, and the whole position on request (it is read as a normal paragraph). */}
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="chess-announce">
            {moveAnnouncement({ opponent: personaFor(match.level).name, plies: match.plies, lastSan: match.sans[match.sans.length - 1], inCheck: match.checkSquare !== null, over })}
          </p>
          <p className="sr-only" data-testid="chess-board-summary">
            {boardSummary(state.fen)}
          </p>
          <div className="stage">
          <ChessBoard
            fen={state.fen}
            legal={match.legal}
            lastMove={match.lastMove}
            checkSquare={match.checkSquare}
            turn={turn}
            plies={match.plies}
            onMove={(uci) => {
              setNotice('')
              void match.play(uci)
            }}
            onNotice={setNotice}
          />
          </div>
          <p className="min-h-5 text-center text-sm text-bad-ink" role="status" aria-live="polite" data-testid="chess-notice">
            {notice}
          </p>
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
