import { visibleRegistry } from '../../lib/strength-gates'
import { useEffect, useRef, useState } from 'react'
import { holdemCore } from '@duelwise/core/src/games/holdem/core'
import { luckLine, luckOfMatchAsync } from '@duelwise/core/src/games/holdem/luck'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { parseRegistry, type Registry } from '@duelwise/agents/src/registry'
import { GameShell } from '../../components/GameShell'
import { LevelPicker } from '../../components/LevelPicker'
import { StrengthLine } from '../../components/SiteElo'
import { ResultPanel } from '../../components/ResultPanel'
import { PlayHud } from '../../components/PlayHud'
import { LeavingNotice } from '../../components/LeavingNotice'
import { PlayMode } from '../../components/PlayModeToggle'
import { usePractice } from '../../lib/practice'
import { LEVEL_LABEL, levelInfoFromRegistry } from '../../lib/level-info'
import { personaFor } from '../../personas'
import { BetControls } from './BetControls'
import { HandHistory } from './HandHistory'
import { optionsFor, readChoice, saveChoice, type LengthChoice } from './length'
import { MatchLength } from './MatchLength'
import { progressNumbers } from './progress'
import { HoldemStyles, Table, type TableTurn } from './Table'
import { HUMAN, useHoldemMatch } from './useHoldemMatch'
import { useNearMiss } from '../../lib/use-near-miss'

export const meta = { title: "Heads-Up Hold'em" }

// The registry file appears when this game's measurement lands (T28). Until then every level is a preview and
// no strength is shown. Eager glob: a missing file is an empty object, not a build error.
const found = import.meta.glob('../../../../../packages/agents/registry/holdem.json', { eager: true, import: 'default' })
const raw = Object.values(found)[0]
const sourceRegistry: Registry | null = raw ? parseRegistry(raw) : null
const registry: Registry | null = sourceRegistry ? visibleRegistry(sourceRegistry) : null
const levelInfo = levelInfoFromRegistry(registry)

const CHIPS_ONLY = 'Play chips only, no prizes. The chips are never sold, never redeemable and carry no value.'

function firstSelectable(): Level {
  return (['easy', 'medium', 'hard', 'champion'] as const).find((l) => !levelInfo[l].inTraining) ?? 'easy'
}

/** `?seed=<number>` fixes the first match's deals, for tests and bug reports; later matches are random. */
function seedFromUrl(): number | undefined {
  const q = new URLSearchParams(window.location.search).get('seed')
  return q !== null && /^\d{1,10}$/.test(q) && Number(q) < 2 ** 32 ? Number(q) : undefined
}

const nameOf = (level: Level) => personaFor(level).name

export default function HoldemPage() {
  const match = useHoldemMatch((level) => sourceRegistry?.levels[level]?.version ?? 'preview', nameOf, sourceRegistry?.learnsFromHumans === true)
  const nearMiss = useNearMiss(match.finished?.record)
  const [picked, setPicked] = useState<Level>(firstSelectable)
  const [fixedSeed, setFixedSeed] = useState<number | undefined>(seedFromUrl)
  const [confirming, setConfirming] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [length, setLength] = useState<LengthChoice>(readChoice)
  const controlsRef = useRef<HTMLDivElement>(null)
  const practicePick = usePractice()

  const begin = (level: Level) => {
    const s = fixedSeed
    setFixedSeed(undefined)
    setConfirming(false)
    setLeaving(false)
    saveChoice(length)
    return match.start(level, s, optionsFor(length, practicePick))
  }

  const measured = registry?.measured[match.level]
  const state = match.state
  const over = match.phase === 'over'
  // How much of the result was the cards: all-ins before the river paid at equity. It is worked out after the result has rendered, one
  // all-in hand per tick, so the verdict and Rematch never wait for it. Null (no line) when nobody went all-in.
  const [luck, setLuck] = useState<string | null>(null)
  useEffect(() => {
    const rec = match.finished?.record
    setLuck(null)
    if (!over || !rec) return
    let dead = false
    luckOfMatchAsync({ seed: rec.seed, humanSeat: rec.humanSeat, options: rec.options, actions: rec.actions }, { cancelled: () => dead })
      .then((l) => { if (!dead) setLuck(luckLine(l, match.practice ? match.buyIns : 0)) })
      .catch(() => {})
    return () => { dead = true }
  }, [over, match.finished, match.practice, match.buyIns])
  const opponent = nameOf(match.level)
  const turn: TableTurn = over || state?.over ? 'over' : match.reveal ? 'reveal' : match.canAct ? 'you' : 'ai'
  const status = over
    ? 'Match over'
    : match.buyBackOffer
      ? 'Out of chips'
    : match.failure
      ? 'Stopped'
      : match.reveal
        ? match.reveal.headline
        : match.canAct
          ? 'Your action'
          : `${opponent} is thinking`
  // When it becomes your turn, bring the action bar fully into view: on a phone it starts below the fold.
  useEffect(() => {
    const el = controlsRef.current
    if (!match.canAct || !el) return
    const hidden = el.getBoundingClientRect().bottom - window.innerHeight + 12
    if (hidden > 0) window.scrollBy({ top: hidden, behavior: 'auto' })
  }, [match.canAct, state])
  const shown = state ? progressNumbers(state, match.reveal, match.buyBackOffer) : null
  const netText = shown ? (shown.net > 0 ? `+${shown.net}` : String(shown.net)) : ''

  return (
    <GameShell
      game="holdem"
      level={match.phase === 'setup' ? undefined : match.level}
      preview={match.phase !== 'setup' && (match.preview || levelInfo[match.level].preview)}
      previewLabel="In training"
      thinking={match.thinking}
      result={over && match.result ? (
            <>
              {match.practice && match.buyIns > 0 ? (
                <p className="mb-3 rounded-control bg-surface-2 px-3 py-2 text-sm font-semibold" data-testid="holdem-buyins">
                  You bought back in {match.buyIns} {match.buyIns === 1 ? 'time' : 'times'}
                </p>
              ) : null}
              <ResultPanel
                result={match.result}
                leftAfter={match.leftAfter}
                buyIns={match.practice ? match.buyIns : 0}
                humanSeat={HUMAN}
                nearMiss={nearMiss}
                recordOk={match.finished ? match.finished.ok : true}
                upload={match.upload}
                unratedReason={match.unratedReason}
                onRematch={() => void match.start(match.level, undefined, match.options)}
                onPlayLevel={(l) => void match.start(l, undefined, match.options)}
                levels={levelInfo}
                moves={match.finished ? match.finished.record.actions.filter((a) => a[1] === match.finished!.record.humanSeat).length : 0}
                onChangeLevel={match.backToSetup}
                reveal={luck ? <p className="text-sm text-muted" data-testid="holdem-luck">{luck}</p> : null}
              />
              {match.finished ? (
                <span hidden data-testid="holdem-record" data-record-ok={String(match.finished.ok)} data-final-hash={match.finished.record.finalHash} data-seed={String(match.seed)} />
              ) : null}
            </>
          ) : null}
      aside={
        match.phase === 'setup' || match.phase === 'starting' ? undefined : (
          <div className="grid gap-4">
            <section className="grid gap-1 rounded-card border border-line bg-surface p-4" data-testid="agent-card">
              <b className="font-display text-display-sm">
                {opponent}, {LEVEL_LABEL[match.level]}
              </b>
              {match.counted ? <LeavingNotice /> : null}
              <StrengthLine siteElo={measured?.siteElo} />
              <p className="mt-1 text-sm text-muted" data-testid="chips-only-note">
                {CHIPS_ONLY}
              </p>
            </section>
            <HandHistory hands={match.history} opponent={opponent} />
            {match.phase === 'playing' ? (
              confirming ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm concede">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(false)
                      void match.concede()
                    }}
                    className="min-h-11 rounded-control bg-bad px-4 text-sm font-semibold text-white"
                  >
                    Yes, concede
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="min-h-11 rounded-control border border-line bg-surface px-4 text-sm font-semibold">
                    Keep playing
                  </button>
                </div>
              ) : leaving ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm leaving the table">
                  <button
                    type="button"
                    onClick={() => {
                      setLeaving(false)
                      void match.leave()
                    }}
                    className="min-h-11 rounded-control bg-bad px-4 text-sm font-semibold text-white"
                    data-testid="leave-confirm"
                  >
                    Yes, leave (unrated)
                  </button>
                  <button type="button" onClick={() => setLeaving(false)} className="min-h-11 rounded-control border border-line bg-surface px-4 text-sm font-semibold">
                    Keep playing
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => setConfirming(true)} disabled={!match.canAct} className="min-h-11 justify-self-start rounded-control border border-line bg-surface px-4 text-sm font-semibold disabled:opacity-50">
                    Concede
                  </button>
                  <button type="button" onClick={() => setLeaving(true)} disabled={match.handsDone < 1} data-testid="leave-table" className="min-h-11 rounded-control border border-line bg-surface px-4 text-sm font-semibold disabled:opacity-50">
                    Leave table
                  </button>
                  <p className="basis-full text-xs text-muted">{match.handsDone < 1 ? 'You can leave the table after the first hand. A match you leave is scored on the chips so far and is unrated.' : 'Leaving scores the match on the chips so far. It is unrated.'}</p>
                </div>
              )
            ) : null}
          </div>
        )
      }
    >
      {match.phase === 'setup' || match.phase === 'starting' ? (
        <section className="grid gap-4" data-testid="holdem-setup">
          <p className="text-muted">
            Heads-up no-limit Texas Hold&apos;em. Blinds 1 and 2, and both stacks reset to 100 chips every hand. Pick a match of 5, 10, 15 or 30 hands. If a player loses all 100 chips in one hand, the match ends at once and that player loses. Otherwise whoever has more chips after the last hand wins. You can leave the table after any finished hand: the match is scored on the chips so far, but it is unrated.
          </p>
          <MatchLength value={length} onChange={setLength} disabled={match.phase === 'starting'} />
          <PlayMode disabled={match.phase === 'starting'} practiceHint="If you bust, buy back in for free as often as you like." />
          <p className="rounded-control bg-surface-2 px-3 py-2 text-sm font-semibold" data-testid="chips-only-note">
            {CHIPS_ONLY}
          </p>
          <LevelPicker value={picked} onChange={setPicked} levels={levelInfo} statsSlug={PRODUCT.games.holdem.slug} disabled={match.phase === 'starting'}
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
          <HoldemStyles />
          <PlayHud turn={over ? 'over' : match.canAct || match.reveal ? 'you' : 'ai'} swatch="bg-felt" matchKey={match.seed} />
          <p className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm text-muted" data-testid="holdem-progress">
            <span>
              Hand <b className="font-mono tabular text-ink">{shown!.hand}</b> of {match.limit}
            </span>
            <span>
              Chips <b className="font-mono tabular text-ink" data-testid="net-chips">{netText}</b>
            </span>
          </p>
          {/* Tapping the table cuts a reading pause short, one stage per tap; the button is the keyboard and screen reader way. */}
          <div onClick={match.reveal && !state.over && !match.buyBackOffer ? match.skipReveal : undefined}>
            <Table state={state} reveal={match.reveal} level={match.level} turn={turn} />
          </div>
          <p className="text-center text-sm font-semibold text-muted" role="status" aria-live="polite" data-testid="holdem-status">
            {status}
          </p>
          {match.reveal && !state.over && !match.buyBackOffer ? (
            <button type="button" onClick={match.skipReveal} className="min-h-11 justify-self-center rounded-control border border-line bg-surface px-4 text-sm font-semibold" data-testid="holdem-skip">
              Skip
            </button>
          ) : null}
          <p className="sr-only" role="log" aria-live="polite" data-testid="holdem-log-sr">
            {match.log}
          </p>
          <p className="text-center text-sm" data-testid="holdem-log">
            {over ? '' : match.log}
          </p>
          {over ? null : match.buyBackOffer ? (
            <section className="grid justify-items-center gap-2 rounded-card border border-line bg-surface-2 p-4 text-center" data-testid="buyback" aria-label="Buy back in">
              <b className="font-display text-display-sm">You are out of chips</b>
              <p className="max-w-prose text-sm text-muted">This is practice, so buying back in is free. You get a fresh 100 chips and the match goes on to the {match.limit} hands you chose.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" onClick={match.buyBackIn} className="min-h-12 rounded-control bg-action px-6 font-semibold text-action-ink" data-testid="buy-back">
                  Buy back in
                </button>
                <button type="button" onClick={() => void match.leave()} className="min-h-12 rounded-control border border-line bg-surface px-5 font-semibold" data-testid="buyback-leave">
                  Leave table
                </button>
              </div>
            </section>
          ) : match.failure ? (
            <div className="grid justify-items-center gap-2">
              <p role="alert" className="rounded-control bg-bad-soft px-3 py-2 text-sm text-bad-ink">
                {match.failure}
              </p>
              <button type="button" onClick={match.backToSetup} className="min-h-11 rounded-control border border-line bg-surface px-5 font-semibold">
                Back to setup
              </button>
            </div>
          ) : match.canAct ? (
            <div ref={controlsRef}>
              <BetControls obs={holdemCore.observe(state, HUMAN)} disabled={false} onAction={(a) => void match.act(a)} />
            </div>
          ) : null}

        </div>
      ) : null}
    </GameShell>
  )
}
