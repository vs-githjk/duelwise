import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { parseRegistry, type Registry } from '@duelwise/agents/src/registry'
import { GameShell } from '../../components/GameShell'
import { LeavingNotice } from '../../components/LeavingNotice'
import { LevelPicker } from '../../components/LevelPicker'
import { PlayHud } from '../../components/PlayHud'
import { PlayMode } from '../../components/PlayModeToggle'
import { ResultPanel } from '../../components/ResultPanel'
import { StrengthLine } from '../../components/SiteElo'
import { chipText, OfflinePill } from '../../components/OfflineChip'
import { isOffline, subscribeConnection } from '../../lib/connection'
import { LEVEL_LABEL, levelInfoFromRegistry } from '../../lib/level-info'
import { setRatedLive } from '../../lib/match-active'
import { usePractice } from '../../lib/practice'
import { visibleRegistry } from '../../lib/strength-gates'
import { personaFor, styleLine } from '../../personas'
import { Board } from './Board'
import { discCounts, finalCount, flipPreview, humanMoveCount, legalCells, liveText, parseMoves, pressPlace, statusLine, startMatch, tapCell, cellName, type SlackMatch } from './match'
import { useSlackMatch } from './useSlackMatch'
import { FriendSlack } from '../friends/FriendSlack'
import { FriendSetup, OpponentTabs } from '../friends/FriendSetup'
import type { LocalSetup } from '../friends/useLocalDuel'
import { SLACK_FRIEND } from './opponent'

export const meta = { title: 'Crosscurrent' }

// The registry file is written by the measurement. Until a level has a measured block it shows as In training and no strength is shown.
// Eager glob: a missing file is an empty object, not a build error.
const found = import.meta.glob('../../../../../packages/agents/registry/slack.json', { eager: true, import: 'default' })
const raw = Object.values(found)[0]
const sourceRegistry: Registry | null = raw ? parseRegistry(raw) : null
const registry: Registry | null = sourceRegistry ? visibleRegistry(sourceRegistry) : null
const levelInfo = levelInfoFromRegistry(registry)

/** Each opponent's own line in this game. Without it an unmeasured level shows the generic early-version line instead of who it is. */
const STYLE: Record<Level, string> = { easy: styleLine('easy', 'slack'), medium: styleLine('medium', 'slack'), hard: styleLine('hard', 'slack'), champion: styleLine('champion', 'slack') }

function firstSelectable(): Level {
  return (['easy', 'medium', 'hard', 'champion'] as const).find((l) => !levelInfo[l].inTraining) ?? 'easy'
}

/** `?seed=<number>` fixes the first match's seed, for tests and bug reports; later matches are random. */
function seedFromUrl(): number | undefined {
  const q = new URLSearchParams(window.location.search).get('seed')
  return q !== null && /^\d{1,10}$/.test(q) && Number(q) < 2 ** 32 ? Number(q) : undefined
}

/** Dev builds only: `?moves=D3,C3,pass` starts the first match from that position, so a spec can reach a pass or the end quickly. A production build never reads it. */
function presetFromUrl(): SlackMatch | null {
  return import.meta.env.DEV ? parseMoves(new URLSearchParams(window.location.search).get('moves')) : null
}

export default function SlackPage() {
  const match = useSlackMatch((level) => sourceRegistry?.levels[level]?.version ?? 'preview', sourceRegistry?.learnsFromHumans === true)
  const [picked, setPicked] = useState<Level>(firstSelectable)
  const [fixedSeed, setFixedSeed] = useState<number | undefined>(seedFromUrl)
  const [preset, setPreset] = useState<SlackMatch | null>(presetFromUrl)
  const [confirming, setConfirming] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [focus, setFocus] = useState(0)
  const offline = useSyncExternalStore(subscribeConnection, isOffline, () => false)
  const practice = usePractice()
  // Who the next game is against. A friend game is two people on this device: it never touches the match recorder or the server.
  const [versus, setVersus] = useState<'ai' | 'friend'>('ai')
  const [friend, setFriend] = useState<LocalSetup | null>(null)

  // Rated needs the server to hold and check the match, so it does not start offline (Practice does). A fixed seed or a preset position was never counted.
  const ratedNeedsServer = offline && !practice && fixedSeed === undefined && preset === null

  const begin = (level: Level) => {
    if (ratedNeedsServer) return Promise.resolve()
    const s = fixedSeed
    const p = preset
    setFixedSeed(undefined)
    setPreset(null)
    setConfirming(false)
    setSelected(null)
    // The first legal cell of the new match takes the keyboard focus and the tab stop.
    setFocus(legalCells(p ?? startMatch())[0] ?? 0)
    return match.start(level, s, p)
  }

  const m = match.match
  const name = personaFor(match.level).name
  const over = match.phase === 'over'
  const playing = match.phase === 'playing'
  const legal = useMemo(() => (match.canMove && m ? legalCells(m) : []), [match.canMove, m])
  const preview = selected !== null && match.canMove && m ? flipPreview(m, selected) : []
  const closing = over || match.ending
  // A rated match the server holds is live: the offline pill then says it is reconnecting instead of "Practice only".
  const ratedLive = match.counted && !practice && match.phase === 'playing'
  useEffect(() => {
    setRatedLive(ratedLive)
    return () => setRatedLive(false)
  }, [ratedLive])
  // A match opens at the top of the page, whatever the setup page was scrolled to, so the header and HUD are on screen (instant, once per start). The page is
  // still settling on the first frame (the notice takes its compact size), so the Place bar is measured two frames later; only a screen too short for it
  // scrolls down, just far enough to bring the bar on screen.
  useLayoutEffect(() => {
    if (match.phase !== 'playing') return
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    const reveal = () => {
      const bar = document.querySelector('[data-testid="slack-action"]')
      if (!bar) return
      const over = bar.getBoundingClientRect().bottom - window.innerHeight + 8
      if (over > 0) window.scrollBy({ top: over, behavior: 'instant' })
    }
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(reveal)
    })
    return () => cancelAnimationFrame(raf)
  }, [match.seed, match.phase === 'playing'])
  if (friend) return <FriendSlack setup={friend} onDone={() => setFriend(null)} />

  const turn = closing ? 'over' : m && m.state.turn !== m.human ? 'ai' : 'you'
  // Each match gives the player the dark discs (they move first) or the pale discs at random.
  const youColor = match.humanSeat === 0 ? 'dark' : 'pale'
  const themColor = match.humanSeat === 0 ? 'pale' : 'dark'
  const youOrder = match.humanSeat === 0 ? 'move first' : 'move second'
  const [you, them] = m ? discCounts(m) : [0, 0]
  const verdict = match.resigned ? 'You resigned.' : closing && m ? statusLine(m, name) : ''
  const status = match.resigned ? verdict : m ? statusLine(m, name) : ''

  const onTap = (cell: number) => {
    setFocus(cell)
    if (!m || !match.canMove) return
    const r = tapCell(m, selected, cell)
    setSelected(r.selected)
    if (r.commit) {
      setSelected(null)
      match.play(cell)
    }
  }
  const place = () => {
    if (selected === null || !m || !pressPlace(m, selected)) return
    const cell = selected
    setSelected(null)
    match.play(cell)
  }

  return (
    <GameShell
      game="slack"
      friends={versus === 'friend'}
      level={match.phase === 'setup' ? undefined : match.level}
      preview={match.phase !== 'setup' && levelInfo[match.level].preview}
      previewLabel="In training"
      thinking={match.thinking}
      result={over && match.result ? (
        <>
          <ResultPanel
            result={match.result}
            humanSeat={match.humanSeat}
            recordOk={match.finished ? match.finished.ok : true}
            upload={match.upload}
            unratedReason={match.unratedReason}
            onRematch={() => void begin(match.level)}
            onPlayLevel={(l) => void begin(l)}
            levels={levelInfo}
            moves={m ? humanMoveCount(m.log, m.human) : 0}
            reveal={!match.resigned && m ? <p className="text-sm text-ink" data-testid="slack-final-count">{finalCount(m, name)}</p> : null}
            onChangeLevel={match.backToSetup}
          />
          {match.finished ? (
            <span hidden data-testid="slack-record" data-record-ok={String(match.finished.ok)} data-final-hash={match.finished.record.finalHash} data-seed={String(match.seed)} />
          ) : null}
        </>
      ) : null}
      aside={
        match.phase === 'setup' || match.phase === 'starting' ? undefined : (
          <div className="grid gap-4" data-testid="slack-aside">
            {/* A slot that is always there, so going offline in a match moves nothing and the pill covers nothing. */}
            <div className="h-10 overflow-hidden" data-testid="slack-offline-slot">{offline ? <OfflinePill text={chipText(true, ratedLive)} /> : null}</div>
            <section className="grid gap-1 rounded-card border border-line bg-surface p-4" data-testid="agent-card">
              <b className="font-display text-display-sm">
                {name}, {LEVEL_LABEL[match.level]}
              </b>
              {match.counted ? <LeavingNotice /> : null}
              <StrengthLine siteElo={registry?.measured[match.level]?.siteElo} />
              <p className="text-sm text-muted">Rings mark where you can place. Small dots show the discs a pick would flip.</p>
              <p className="mt-2 flex items-center gap-4 text-sm">
                <span className="inline-flex items-center gap-1.5">
                  <i data-swatch="you" className={`inline-block size-4 rounded-full border-2 border-muted ${youColor === 'dark' ? 'bg-slack-dark' : 'bg-slack-pale'}`} aria-hidden="true" /> You, {youColor}, {youOrder}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <i data-swatch="ai" className={`inline-block size-4 rounded-full border-2 border-muted ${themColor === 'dark' ? 'bg-slack-dark' : 'bg-slack-pale'}`} aria-hidden="true" /> {name}, {themColor}
                </span>
              </p>
            </section>
            {playing ? (
              confirming ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm resign">
                  <button type="button" data-testid="slack-resign-yes" disabled={match.ending} onClick={() => { setConfirming(false); setSelected(null); match.resign() }} className="min-h-11 rounded-control bg-bad px-4 text-sm font-semibold text-white">
                    Yes, resign
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="min-h-11 rounded-control border border-line bg-surface px-4 text-sm font-semibold">
                    Keep playing
                  </button>
                </div>
              ) : (
                // While the finished board is held it keeps its place but cannot be used, so nothing below the board moves before the panel.
                <button type="button" data-testid="slack-resign" disabled={match.ending} onClick={() => setConfirming(true)} className={`min-h-11 justify-self-start rounded-control border border-line bg-surface px-4 text-sm font-semibold ${match.ending ? 'invisible' : ''}`}>
                  Resign
                </button>
              )
            ) : null}
          </div>
        )
      }
    >
      {match.phase === 'setup' || match.phase === 'starting' ? (
        <section className="grid gap-4" data-testid="slack-setup">
          <OpponentTabs value={versus} onChange={setVersus} disabled={match.phase === 'starting'} />
          {versus === 'friend' ? <FriendSetup game={SLACK_FRIEND} onStart={setFriend} /> : <>
          <p className="text-muted">
            Place a disc so a line of {personaFor(picked).name}&apos;s discs ends against one of yours, and every closed line flips. Each match gives you the dark discs (you move first) or the pale discs (your opponent moves first) at random. The most discs when neither side can move wins.
          </p>
          {offline ? <OfflinePill text={chipText(true, false)} /> : null}
          {offline ? (
            <p className="text-sm text-muted" data-testid="slack-offline-line">
              Rated Crosscurrent needs a connection, because the server checks the opponent's moves. Practice works offline.
            </p>
          ) : null}
          <PlayMode disabled={match.phase === 'starting'} />
          <LevelPicker value={picked} onChange={setPicked} levels={levelInfo} descriptions={STYLE} statsSlug={PRODUCT.games.slack.slug} disabled={match.phase === 'starting'}
            action={
              <>
                {match.failure ? (
                  <p role="alert" className="rounded-control bg-bad-soft px-3 py-2 text-sm text-bad-ink" data-testid="slack-failure">
                    {match.failure}
                  </p>
                ) : null}
                <button
                  type="button"
                  data-testid="slack-start"
                  disabled={match.phase === 'starting' || ratedNeedsServer}
                  onClick={() => void begin(picked)}
                  className="start-match min-h-12 justify-self-start rounded-control bg-action px-6 font-semibold text-action-ink disabled:opacity-60"
                >
                  {ratedNeedsServer ? 'Rated needs a connection' : `Start match vs ${personaFor(picked).name}`}
                </button>
              </>
            }
          />
          </>}
        </section>
      ) : m ? (
        <div className="grid grid-cols-[minmax(0,1fr)] content-start sl-play">
          {/* One row on a laptop (the HUD, then the score and the status line); two stacked rows on a phone. */}
          <div className="sl-top">
            <PlayHud turn={turn} youLabel={`You, ${youColor}`} swatch={match.humanSeat === 0 ? 'bg-slack-dark' : 'bg-slack-pale'} matchKey={match.seed} />
            <div className="sl-status" data-testid="slack-status-row">
              <div className="sl-counts" data-testid="slack-counts">
                {/* The filled dot is the dark discs and the open dot the pale ones, so the dot beside your count is the colour you play. */}
                <span aria-hidden="true">{youColor === 'dark' ? '●' : '○'} {you}</span>
                <span aria-hidden="true">{themColor === 'dark' ? '●' : '○'} {them}</span>
                <span className="sr-only">
                  You {you} discs, {name} {them} discs.
                </span>
              </div>
              <p className="sl-line" data-testid="slack-status">
                {status}
              </p>
            </div>
          </div>
          <Board match={m} opponent={name} legal={legal} selected={selected} preview={preview} focus={focus} onFocus={setFocus} onTap={onTap} focusKey={match.seed} />
          {over ? null : (
            <div className="sl-bar">
              <button type="button" onClick={place} disabled={!(selected !== null && pressPlace(m, selected))} data-testid="slack-action" className="min-h-11 flex-1 rounded-control bg-action px-4 font-semibold text-action-ink disabled:opacity-40">
                {selected !== null && pressPlace(m, selected) ? `Place at ${cellName(selected)}` : 'Pick a ring'}
              </button>
            </div>
          )}
          <p className="sr-only" role="status" aria-live="polite" data-testid="slack-live">
            {match.resigned ? verdict : liveText(m, name, closing, verdict)}
          </p>
          {match.failure ? (
            <div className="grid justify-items-center gap-2">
              <p role="alert" className="rounded-control bg-bad-soft px-3 py-2 text-sm text-bad-ink" data-testid="slack-failure">
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
