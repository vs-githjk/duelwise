import { TouchControls, usePlayViewport, useTouchDevice } from '../touch/TouchControls'
import { RotateOverlay, useLandscapeGate, useReleaseLandscape, useRotatePause } from '../touch/landscape'
import { LevelPicker } from '../../components/LevelPicker'
import { PlayMode } from '../../components/PlayModeToggle'
import { visibleRegistry } from '../../lib/strength-gates'
import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { parseRegistry, type Registry } from '@duelwise/agents/src/registry'
import { GameShell } from '../../components/GameShell'
import { ResultPanel } from '../../components/ResultPanel'
import { playTrainingBullet, resultTrainingNote } from '../../lib/honest-copy'
import { cn } from '../../lib/cn'
import { LEVELS, LEVEL_LABEL } from '../../lib/level-info'
import { personaFor } from '../../personas'
import { FighterHud, useStageScale, type HudNames } from './hud'
import { ACTIONS, ACTION_LABEL, DEFAULT_KEYS, keyLabel, rebind, type Action, type KeyMap } from './input'
import { ROSTER, SHARED_MOVES_NOTE, aiChoiceFor } from './roster'
import { SelectPreview } from './SelectPreview'
import { useFocusTrap } from './focusTrap'
import { moveListRows } from './moveList'
import { matchScrollTarget } from './scroll'
import { agentVersionFor, isPublished, limitsExplainer, practiceResult, strengthLine } from './strength'
import { apmCapFor, delayMsFor, limitsText, useFighterMatch, type CharacterChoice } from './useFighterMatch'
import { formatClock, highlightsFor } from './highlights'
import { DIR_GLYPH, DIR_NAME, MOVE_INPUT, dirAction } from './moveInputs'

// Eager glob: a missing registry file is an empty object, not a build error; no level is then playable.
const found = import.meta.glob('../../../../../packages/agents/registry/fighter.json', { eager: true, import: 'default' })
const raw = Object.values(found)[0]
const sourceRegistry: Registry | null = raw ? parseRegistry(raw) : null
const registry: Registry | null = sourceRegistry ? visibleRegistry(sourceRegistry) : null
const published = (l: Level): boolean => isPublished(registry, l)

/** `?seed=<number>` fixes the first match's seed (an unrated match), for tests and bug reports. */
function seedFromUrl(): number | undefined {
  const q = new URLSearchParams(window.location.search).get('seed')
  return q !== null && /^\d{1,10}$/.test(q) && Number(q) < 2 ** 32 ? Number(q) : undefined
}

function levelFromUrl(): Level {
  const q = new URLSearchParams(window.location.search).get('level')
  // R32: every level is playable; an unpublished one is a labelled Practice level.
  if ((LEVELS as readonly string[]).includes(q ?? '')) return q as Level
  return (['hard', 'champion', 'medium', 'easy'] as const).find(published) ?? 'hard'
}

const btnPrimary = 'inline-flex min-h-11 items-center justify-center rounded-control bg-action px-5 font-semibold text-action-ink'
const btnPlain = 'inline-flex min-h-11 items-center justify-center rounded-control border border-line bg-surface px-5 font-semibold text-ink'

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="fighter-key">{children}</kbd>
}

const BUTTON_COLOUR: Record<string, string> = {
  light: 'var(--hud-counter)',
  medium: 'var(--hud-surge)',
  heavy: 'var(--hud-punish)',
  special: '#f5c542',
  surge: '#b58cff',
  throw: '#f5f5f5',
}

/** A move's input drawn as keys: a direction circle (when it needs one) and the coloured button key from the current key map. */
function MoveKeys({ id, keys }: { id: number; keys: KeyMap }) {
  const inp = MOVE_INPUT[id]
  if (!inp) return null
  const dAct = dirAction(inp.dir)
  const dKey = dAct ? keys[dAct].map(keyLabel).join(' or ') : ''
  const bKey = keys[inp.button][0]
  const name = `${DIR_NAME[inp.dir]}${dKey ? ` (${dKey})` : ''} plus ${inp.button} (${bKey ? keyLabel(bKey) : 'unbound'})`
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" role="img" aria-label={name}>
      {inp.dir !== 'none' ? (
        <span className="inline-flex size-6 items-center justify-center rounded-full border border-line bg-surface-2 text-xs" aria-hidden="true" title={dKey || 'toward the opponent'}>
          {DIR_GLYPH[inp.dir]}
        </span>
      ) : null}
      {inp.dir === 'air' ? <span className="text-xs text-muted" aria-hidden="true">in air</span> : null}
      <kbd className="fighter-key" aria-hidden="true" style={{ borderColor: BUTTON_COLOUR[inp.button], borderBottomWidth: 3 }}>
        {bKey ? keyLabel(bKey) : '?'}
      </kbd>
    </span>
  )
}

/** The key map as a table; a click on a key waits for the next key press and rebinds the action to it. */
function ControlsPanel({ keys, onChange, onClose }: { keys: KeyMap; onChange: (k: KeyMap) => void; onClose: () => void }) {
  const [listening, setListening] = useState<Action | null>(null)
  const box = useRef<HTMLElement>(null)
  useFocusTrap(box, true)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!listening) {
        // Escape closes the panel; the match's own handler must not read it as "resume".
        if (e.code === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.code !== 'Escape') onChange(rebind(keys, listening, e.code))
      setListening(null)
    }
    // Capture phase: the match's own key handler must not see the key that is being assigned.
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [listening, keys, onChange, onClose])
  return (
    <section ref={box} className="grid w-full max-w-lg gap-4 rounded-card border border-line bg-surface p-6 shadow-card" aria-label="Controls" role="dialog">
      <h2 className="font-display text-display-md">Controls</h2>
      <p className="text-sm text-muted">Keyboard only for now; gamepad comes later. Select a key to change it, then press the new key.</p>
      <ul className="grid gap-1.5">
        {ACTIONS.map((a) => (
          <li key={a} className="flex items-center justify-between gap-3 text-sm">
            <span>{ACTION_LABEL[a]}</span>
            <button type="button" onClick={() => setListening(listening === a ? null : a)} aria-label={`${ACTION_LABEL[a]}: ${keys[a].map(keyLabel).join(' or ') || 'unbound'}. Change`} className="min-h-9 min-w-20 rounded-control border border-line bg-surface-2 px-3 font-mono text-xs">
              {listening === a ? 'Press a key' : keys[a].map(keyLabel).join(' / ') || 'none'}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnPlain} onClick={() => onChange(DEFAULT_KEYS)}>
          Reset to defaults
        </button>
        <button type="button" className={btnPrimary} onClick={onClose}>
          Done
        </button>
      </div>
    </section>
  )
}

/** Startup, active, recovery, damage and advantage read from the running frame data, never typed in. */
function MoveList({ keys, onClose }: { keys: KeyMap; onClose: () => void }) {
  const box = useRef<HTMLElement>(null)
  useFocusTrap(box, true)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onClose])
  const fmt = (n: number | null) => (n === null ? 'n/a' : `${n >= 0 ? '+' : ''}${n}`)
  const rows = moveListRows().map((m) => (
    <tr key={m.id} className="border-t border-line align-top">
      <th scope="row" className="py-1.5 pr-3 text-left font-medium">
        {m.name}
        {m.note ? <span className="block max-w-56 whitespace-normal font-sans text-xs font-normal text-muted">{m.note}</span> : null}
      </th>
      <td className="whitespace-nowrap px-2"><MoveKeys id={m.id} keys={keys} /></td>
      <td className="px-2 text-right">{m.startup}</td>
      <td className="px-2 text-right">{m.active}</td>
      <td className="px-2 text-right">{m.recovery}</td>
      <td className="px-2 text-right">{m.damage ?? 'n/a'}</td>
      <td className="px-2 text-right">{fmt(m.onHit)}</td>
      <td className="px-2 text-right">{fmt(m.onBlock)}</td>
    </tr>
  ))
  // The table scrolls inside the dialog and the Back button stays pinned under it, so it is never clipped.
  return (
    <section ref={box} className="flex max-h-full w-full max-w-2xl flex-col gap-3 rounded-card border border-line bg-surface p-6 shadow-card" aria-label="Move list" role="dialog" data-testid="move-list">
      <h2 className="font-display text-display-md">Move list</h2>
      <p className="text-sm text-muted">The default movement keys are WASD or the arrow keys. Directions below use your current controls.</p>
      <p className="text-sm text-muted">Frame data at 60 frames a second, read from the game itself. Startup is the frame the first hit can land.</p>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="move-list-scroll" tabIndex={0} aria-label="Moves, scrolls">
        <table className="w-full font-mono text-xs tabular">
          <thead className="sticky top-0 bg-surface">
            <tr className="text-muted">
              <th scope="col" className="pb-1 text-left font-medium">Move</th>
              <th scope="col" className="px-2 text-left font-medium">Input</th>
              <th scope="col" className="px-2 text-right font-medium">Startup</th>
              <th scope="col" className="px-2 text-right font-medium">Active</th>
              <th scope="col" className="px-2 text-right font-medium">Recovery</th>
              <th scope="col" className="px-2 text-right font-medium">Damage</th>
              <th scope="col" className="px-2 text-right font-medium">On hit</th>
              <th scope="col" className="px-2 text-right font-medium">On block</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      <div>
        <button type="button" className={btnPrimary} onClick={onClose}>
          Back
        </button>
      </div>
    </section>
  )
}

function Swatch({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={active} onClick={onClick} className={cn('min-h-11 min-w-16 rounded-control border px-3 text-sm font-medium', active ? 'border-action bg-action-soft text-ink' : 'border-line bg-surface text-muted')}>
      {label}
    </button>
  )
}

export default function FighterPage() {
  const match = useFighterMatch((level) => agentVersionFor(sourceRegistry, level), registry?.learnsFromHumans === true)
  const [screen, setScreen] = useState<'prematch' | 'select' | 'match'>('prematch')
  const [picked, setPicked] = useState<Level>(levelFromUrl)
  const [me, setMe] = useState<CharacterChoice>({ character: 0, colorway: 0 })
  const [panel, setPanel] = useState<'controls' | 'moves' | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [fixedSeed, setFixedSeed] = useState<number | undefined>(seedFromUrl)
  const host = useRef<HTMLDivElement>(null)
  // True once the match has left 'setup' since the player pressed Start, so the first render after the
  // screen switch (phase still 'setup') is not mistaken for a match that ended.
  const sawStart = useRef(false)
  const [stageRef, scale] = useStageScale()
  const pauseBox = useRef<HTMLElement>(null)
  const cfg = PRODUCT.games.fighter

  const begin = async () => {
    const seed = fixedSeed
    setFixedSeed(undefined)
    const ai: CharacterChoice = aiChoiceFor(me)
    sawStart.current = false
    flushSync(() => setScreen('match'))
    await match.start(host.current!, { level: picked, choices: [me, ai], seed })
  }

  // A failed start (the opponent could not load) puts the player back on the pre-match screen.
  useEffect(() => {
    if (match.phase !== 'setup') sawStart.current = true
    if (match.phase === 'setup' && screen === 'match' && (sawStart.current || match.failure)) {
      setScreen('prematch')
      setPanel(null)
    }
  }, [match.phase, match.failure, screen])

  const names: HudNames = {
    you: 'You',
    ai: `${personaFor(match.level).name}, ${LEVEL_LABEL[match.level]}`,
    youCharacter: ROSTER[me.character]!.name,
    aiCharacter: ROSTER[1 - me.character]!.name,
    level: LEVEL_LABEL[match.level],
    limits: limitsText(match.level),
    preview: match.preview,
  }
  const inMatch = screen === 'match'
  const touch = useTouchDevice()
  usePlayViewport(touch && inMatch)
  const gate = useLandscapeGate(touch)
  useReleaseLandscape(inMatch, touch)
  const matchLive = inMatch && (match.phase === 'loading' || match.phase === 'playing')
  const rotateBlock = (gate.portrait && matchLive) || gate.waiting
  useRotatePause({ block: gate.portrait && matchLive, playing: match.phase === 'playing', paused: match.paused, pause: match.pause, resume: match.resume })
  const over = match.phase === 'over'
  const result = match.finished?.record.result
  const showMenu = match.paused && panel === null
  useFocusTrap(pauseBox, showMenu)
  const won = result?.winner === 0
  const highlights = useMemo(() => (match.finished ? highlightsFor(match.finished.record) : []), [match.finished])

  // The Start button sits below the fold on a 900 px window, so the click scrolls the page down; once the match is on, show the
  // title and the whole stage again instead of leaving the title clipped; in a window too short for both, the whole stage wins (tinderbox-r2).
  useEffect(() => {
    if (!inMatch) return
    const el = document.querySelector('[data-testid="fighter-stage"]')
    if (!el) return
    const r = el.getBoundingClientRect()
    window.scrollTo({ top: matchScrollTarget(r.top + window.scrollY, r.bottom + window.scrollY, window.innerHeight), left: 0, behavior: 'instant' })
  }, [inMatch])

  // A sub-panel belongs to the pause menu: once the match is running again it is gone.
  useEffect(() => {
    if (inMatch && !match.paused) { setPanel(null); setLeaving(false) }
  }, [inMatch, match.paused])

  return (
    <GameShell matchActive={matchLive} game="fighter" level={inMatch ? match.level : undefined} preview={inMatch && (match.preview || !published(match.level))} previewLabel="In training" onOpenGuide={() => { if (inMatch && match.phase === 'playing') match.pause() }}>
      {screen === 'prematch' ? (
        <div className="grid gap-5 py-2" data-testid="prematch">
          <p className="max-w-prose text-muted">2.5D, best of 3 rounds, 99 seconds each. One control scheme for you and the AI, so neither side gets an input edge.</p>
          <PlayMode />
          <LevelPicker value={picked} onChange={setPicked}
            levels={Object.fromEntries(LEVELS.map((l) => [l, { preview: !published(l), practice: !published(l), strength: published(l) ? 'Strength tested' : undefined }]))}
            descriptions={Object.fromEntries(LEVELS.map((l) => [l, limitsText(l)]))}
            action={
            <div className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} onClick={() => setScreen('select')}>
              Choose your fighter
            </button>
            <button type="button" className={btnPlain} onClick={() => setPanel('controls')}>
              Controls
            </button>
            </div>
            } />
          <div className="text-sm text-muted" data-testid="agent-card"><b data-testid="agent-name">{personaFor(picked).name}, {LEVEL_LABEL[picked]}</b><span data-testid="strength-line"> {strengthLine(registry, picked)} {practiceResult(registry, picked)} {limitsExplainer(delayMsFor(picked), apmCapFor(picked))}</span></div>
          <ul className="grid gap-1 text-sm text-muted">
            <li>Keyboard only for now; gamepad comes later.</li>
            <li>{playTrainingBullet('fighter', registry)}</li>
          </ul>
          {panel === 'controls' ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-4">
              <ControlsPanel keys={match.keys} onChange={match.setKeys} onClose={() => setPanel(null)} />
            </div>
          ) : null}
          {match.failure ? (
            <p role="alert" className="rounded-control bg-warn-soft px-3 py-2 text-sm text-warn-ink">
              {match.failure}
            </p>
          ) : null}
        </div>
      ) : null}

      {screen === 'select' ? (
        <div className="grid gap-5 py-2" data-testid="select">
          <h2 className="font-display text-display-md">Choose your fighter</h2>
          <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
          <SelectPreview me={me} ai={aiChoiceFor(me)} />
          <div className="grid gap-3">
            {ROSTER.map((r, ci) => {
              const on = me.character === ci
              return (
                <section key={r.name} className={cn('grid gap-3 rounded-card border bg-surface p-4', on ? 'border-action shadow-[inset_0_0_0_1px_var(--action)]' : 'border-line')} aria-label={r.name}>
                  <button type="button" aria-pressed={on} onClick={() => setMe({ character: ci, colorway: me.character === ci ? me.colorway : 0 })} className="grid min-h-11 gap-0.5 text-left">
                    <b className="font-display text-display-sm">{r.name}</b>
                    <span className="text-sm text-muted">
                      {r.role}. {r.blurb}
                    </span>
                  </button>
                  <div role="radiogroup" aria-label={`${r.name} colours`} className="flex flex-wrap gap-2">
                    {r.colorways.map((c, wi) => (
                      <Swatch key={c} label={c} active={on && me.colorway === wi} onClick={() => setMe({ character: ci, colorway: wi })} />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
          </div>
          <p className="text-sm text-muted">{SHARED_MOVES_NOTE} The AI picks after you.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} onClick={() => gate.requestStart(() => void begin())}>
              Start match vs {personaFor(picked).name}
            </button>
            <button type="button" className={btnPlain} onClick={() => setScreen('prematch')}>
              Back
            </button>
          </div>
        </div>
      ) : null}

      <div className={cn(!inMatch && 'hidden')}>
        <div ref={stageRef} className={cn('fighter-stage-root', touch && inMatch && 'touch-play-stage')} data-testid="fighter-stage" data-phase={match.phase} data-record-ok={match.finished ? String(match.finished.ok) : undefined} data-paused={match.paused ? 'true' : 'false'}>
          <div ref={host} className="absolute inset-0" />
          {touch && inMatch && match.phase === 'playing' && !match.paused ? <TouchControls game="fighter" action={(a, down) => match.touchAction(a as import('./input').Action, down)} pause={match.pause} /> : null}
          {match.hud && inMatch ? <FighterHud view={match.hud} names={names} callouts={match.callouts} keys={match.keys} showKeys={match.hud.round === 1} scale={scale} /> : null}
          {inMatch ? (
            <span className="fighter-debug-note" data-testid="renderer-label" hidden={match.rendererLabel === 'stage'}>
              {match.rendererLabel}
            </span>
          ) : null}
          {match.phase === 'loading' ? (
            <div className="fighter-ov" role="status">
              <p className="rounded-control bg-surface px-4 py-2 text-sm text-ink">Loading the stage and the opponent</p>
            </div>
          ) : null}
          {showMenu ? (
            <div className="fighter-ov">
              <section ref={pauseBox} role="dialog" aria-label="Paused" className="grid w-full max-w-sm gap-4 rounded-card border border-line bg-surface p-6 text-ink shadow-card">
                <div>
                  <h2 className="font-display text-display-md">Paused</h2>
                  <p className="text-sm text-muted">{names.ai}. {names.limits}.</p>
                </div>
                <div className="grid gap-1.5">
                  <button type="button" autoFocus className={btnPrimary} onClick={match.resume}>
                    Resume
                  </button>
                  <button type="button" className={btnPlain} onClick={() => setPanel('moves')}>
                    Move list
                  </button>
                  <button type="button" className={btnPlain} onClick={() => setPanel('controls')}>
                    Controls
                  </button>
                  <a className={btnPlain} href="/settings" target="_blank" rel="noopener noreferrer">
                    Settings (new tab)
                  </a>
                  {leaving ? (
                    <div className="grid gap-2 rounded-control border border-line p-3" data-testid="pause-leave-confirm" role="group" aria-label="Leave this match?">
                      <p className="text-sm">Leave this match? It is not counted and nothing is saved.</p>
                      <div className="flex flex-wrap gap-2">
                        <a className={btnPrimary} href="/play" data-testid="pause-leave">Leave match</a>
                        <button type="button" className={btnPlain} onClick={() => setLeaving(false)}>Stay</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className={btnPlain} data-testid="pause-back" onClick={() => setLeaving(true)}>
                      <span aria-hidden="true">←</span>&nbsp;All games
                    </button>
                  )}
                  <button type="button" className={cn(btnPlain, 'text-bad-ink')} onClick={() => { setPanel(null); match.quit() }}>
                    Quit match
                  </button>
                </div>
                <p className="text-xs text-muted">Quitting leaves the match. It is not counted and nothing is saved.</p>
              </section>
            </div>
          ) : null}
          {match.paused && panel ? (
            <div className={cn('fighter-ov', panel === 'moves' && 'fighter-ov-fit')}>{panel === 'controls' ? <ControlsPanel keys={match.keys} onChange={match.setKeys} onClose={() => setPanel(null)} /> : <MoveList keys={match.keys} onClose={() => setPanel(null)} />}</div>
          ) : null}
          {over && result ? (
            <div className="fighter-ov">
              <div className="grid w-full max-w-md gap-3 [@media(orientation:landscape)_and_(max-height:520px)]:max-w-3xl">
                <ResultPanel
                  result={{ ...result, reason: `Rounds ${result.score[0]} to ${result.score[1]}` }}
                  humanSeat={0}
                  onRematch={() => {
                    gate.requestStart(() => void match.start(host.current!, { level: picked, choices: [me, aiChoiceFor(me)] }))
                  }}
                  onChangeLevel={() => {
                    match.quit()
                    setScreen('prematch')
                  }}
                  onPlayLevel={(l) => {
                    setPicked(l)
                    gate.requestStart(() => void match.start(host.current!, { level: l, choices: [me, aiChoiceFor(me)] }))
                  }}
                  extra={
                    highlights.length > 0 ? (
                      <section aria-label="Replay highlights" data-testid="highlights" className="grid gap-1.5">
                        <h3 className="text-sm font-semibold">Replay highlights</h3>
                        <ol className="grid gap-1 text-sm">
                          {highlights.map((h) => (
                            <li key={h.kind} className="flex items-baseline justify-between gap-3 border-t border-line pt-1">
                              <span>
                                <b className="font-semibold">{h.label}</b> <span className="text-muted">{h.detail}</span>
                              </span>
                              <span className="font-mono text-xs tabular text-muted">{formatClock(h.seconds)}</span>
                            </li>
                          ))}
                        </ol>
                      </section>
                    ) : null
                  }
                  leaderboard={false}
                  upload={match.upload}
                  unratedReason={match.unratedReason}
                  recordOk={match.finished?.ok}
                  note={resultTrainingNote('fighter', registry, PRODUCT.trainingDataBasis === 'legitimate-interest')}
                />
              </div>
            </div>
          ) : null}
          {match.failure && inMatch && match.phase !== 'setup' ? (
            <p role="alert" className="absolute inset-x-4 top-4 z-10 rounded-control bg-warn-soft px-3 py-2 text-sm text-warn-ink">
              {match.failure}
            </p>
          ) : null}
        </div>
        {inMatch && !over && !touch ? (
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span>
              <Key>{keyLabel(match.keys.pause[0] ?? 'Esc')}</Key> pause, move list and controls
            </span>
            <span>{cfg.displayName}: best of 3 rounds</span>
          </p>
        ) : null}
      </div>
      {rotateBlock ? <RotateOverlay cancelLabel={gate.waiting ? 'Cancel' : 'Quit match'} onCancel={() => { if (gate.waiting) gate.cancel(); else match.quit() }} /> : null}
    </GameShell>
  )
}
