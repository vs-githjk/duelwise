import { TouchControls, usePlayViewport, useTouchDevice } from '../touch/TouchControls'
import { LevelPicker } from '../../components/LevelPicker'
import { visibleRegistry } from '../../lib/strength-gates'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { PRODUCT, type Level } from '@duelwise/core/src/product'
import { parseRegistry, type Registry } from '@duelwise/agents/src/registry'
import { PHASE } from '@duelwise/core/src/games/arena/state'
import { GameShell } from '../../components/GameShell'
import { ResultPanel } from '../../components/ResultPanel'
import { getVolume, isMuted, setMuted, subscribeAudio } from '../../lib/audio'
import { playTrainingBullet, resultTrainingNote } from '../../lib/honest-copy'
import { cn } from '../../lib/cn'
import { LEVELS, LEVEL_LABEL } from '../../lib/level-info'
import { personaFor, styleLine } from '../../personas'
import { ArenaHud, Crosshair, buyMenuVisible, useStageScale, type HudNames } from './hud'
import { BuyMenu } from './buy-menu'
import {
  ACTIONS, ACTION_LABEL, CROSSHAIR_COLORS, DEFAULT_KEYS, DEFAULT_SETTINGS, SENSITIVITY_RANGE, cmPer360, keyLabel, rebind, type Action, type ArenaSettings, type CrosshairStyle, type KeyMap,
} from './input'
import { useArenaMatch } from './useArenaMatch'
import { PRACTICE_PICKER_NOTE, agentVersionFor, count, isPublished, limitsSentence, limitsText, strengthLine } from './strength'

// Eager glob: a missing registry file is an empty object, not a build error; every level is then a preview.
const found = import.meta.glob('../../../../../packages/agents/registry/arena.json', { eager: true, import: 'default' })
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
  return LEVELS.find((l) => published(l)) ?? 'hard'
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

const btnPrimary = 'inline-flex min-h-11 items-center justify-center rounded-control bg-action px-5 font-semibold text-action-ink disabled:cursor-not-allowed disabled:opacity-50'
const btnPlain = 'inline-flex min-h-11 items-center justify-center rounded-control border border-line bg-surface px-5 font-semibold text-ink'

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="arena-key">{children}</kbd>
}

/** Closes a panel on Escape without the match reading it as "resume". */
function useEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const h = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onClose, enabled])
}

/** The key map as a table; a click on a key waits for the next key press and rebinds the action to it. */
function ControlsPanel({ keys, onChange, onClose }: { keys: KeyMap; onChange: (k: KeyMap) => void; onClose: () => void }) {
  const [listening, setListening] = useState<Action | null>(null)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!listening) {
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
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [listening, keys, onChange, onClose])
  return (
    <section className="grid w-full max-w-lg gap-4 rounded-card border border-line bg-surface p-6 text-ink shadow-card" aria-label="Controls" role="dialog" data-no-capture>
      <h2 className="font-display text-display-md">Controls</h2>
      <p className="text-sm text-muted">Mouse aims and the left button fires. Keyboard and mouse only for now; gamepad comes later. Select a key to change it, then press the new key.</p>
      <ul className="grid gap-1.5">
        {ACTIONS.map((a) => (
          <li key={a} className="flex items-center justify-between gap-3 text-sm">
            <span>{ACTION_LABEL[a]}</span>
            <button type="button" onClick={() => setListening(listening === a ? null : a)} aria-label={`${ACTION_LABEL[a]}: ${keys[a].map(keyLabel).join(' or ') || 'unbound'}. Change`} className="min-h-9 min-w-20 rounded-control border border-line bg-surface-2 px-3 font-mono text-xs">
              {listening === a ? 'Press a key' : keys[a].map(keyLabel).join(' / ') || 'none'}
            </button>
          </li>
        ))}
        <li className="flex items-center justify-between gap-3 text-sm">
          <span>Buy (in the buy phase)</span>
          <span className="font-mono text-xs text-muted">1 2 3</span>
        </li>
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

const PREVIEW_BACKGROUNDS: ReadonlyArray<[string, string]> = [
  ['Concrete', '#7a7d80'],
  ['Dark hall', '#14181d'],
  ['Cold room', '#dfe8ee'],
]

function Range({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="grid grid-cols-[7rem_1fr_3rem] items-center gap-3 text-sm">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-h-9 accent-[var(--action)]" />
      <span className="text-right font-mono text-xs tabular">{value}</span>
    </label>
  )
}

/** Sensitivity with the centimetres it means, and the crosshair editor previewed over three backgrounds. */
function SettingsPanel({ settings, onChange, onClose }: { settings: ArenaSettings; onChange: (s: ArenaSettings) => void; onClose: () => void }) {
  useEscape(onClose)
  const xh = settings.crosshair
  const setXh = (p: Partial<ArenaSettings['crosshair']>) => onChange({ ...settings, crosshair: { ...xh, ...p } })
  return (
    <section className="grid max-h-full w-full max-w-xl gap-4 overflow-auto rounded-card border border-line bg-surface p-6 text-ink shadow-card" aria-label="Settings" role="dialog" data-no-capture>
      <h2 className="font-display text-display-md">Settings</h2>
      <fieldset className="grid gap-2">
        <legend className="mb-1 font-semibold">Aim sensitivity (mouse and touch)</legend>
        <label className="grid grid-cols-[7rem_1fr_4rem] items-center gap-3 text-sm">
          <span>Sensitivity</span>
          <input
            type="range"
            aria-label="Sensitivity"
            min={SENSITIVITY_RANGE.min}
            max={SENSITIVITY_RANGE.max}
            step={0.05}
            value={settings.sensitivity}
            onChange={(e) => onChange({ ...settings, sensitivity: Number(e.target.value) })}
            className="min-h-9 accent-[var(--action)]"
            data-testid="sensitivity"
          />
          <span className="text-right font-mono text-xs tabular">{settings.sensitivity.toFixed(2)}</span>
        </label>
        <label className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
          <span>Mouse DPI</span>
          <input type="number" min={100} max={32000} step={50} value={settings.dpi} onChange={(e) => onChange({ ...settings, dpi: Number(e.target.value) || DEFAULT_SETTINGS.dpi })} className="min-h-9 w-28 rounded-control border border-line bg-surface-2 px-2 font-mono text-sm" />
        </label>
        <p className="text-sm text-muted" data-testid="cm360">
          A full turn is {cmPer360(settings).toFixed(1)} cm of mouse travel at {settings.dpi} DPI. The field of view is fixed and the same for you and the opponent.
        </p>
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-1 font-semibold">Crosshair</legend>
        <div role="radiogroup" aria-label="Style" className="flex flex-wrap gap-2">
          {(['classic', 'cross', 'dot'] as CrosshairStyle[]).map((st) => (
            <button key={st} type="button" role="radio" aria-checked={xh.style === st} onClick={() => setXh({ style: st })} className={cn('min-h-11 min-w-16 rounded-control border px-3 text-sm font-medium capitalize', xh.style === st ? 'border-action bg-action-soft text-ink' : 'border-line bg-surface text-muted')}>
              {st}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label="Colour" className="flex flex-wrap items-center gap-2">
          {CROSSHAIR_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={xh.color === c} aria-label={`Colour ${c}`} onClick={() => setXh({ color: c })} className={cn('size-11 rounded-full border-2', xh.color === c ? 'border-action' : 'border-line')} style={{ background: c }} />
          ))}
        </div>
        <Range label="Size" value={xh.size} min={1} max={30} onChange={(v) => setXh({ size: v })} />
        <Range label="Gap" value={xh.gap} min={0} max={20} onChange={(v) => setXh({ gap: v })} />
        <Range label="Thickness" value={xh.thickness} min={1} max={6} onChange={(v) => setXh({ thickness: v })} />
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input type="checkbox" checked={xh.outline} onChange={(e) => setXh({ outline: e.target.checked })} /> Outline
        </label>
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.hitMarker} onChange={(e) => onChange({ ...settings, hitMarker: e.target.checked })} /> Hit marker
        </label>
        <div className="grid grid-cols-3 gap-2" aria-label="Crosshair preview">
          {PREVIEW_BACKGROUNDS.map(([name, bg]) => (
            <figure key={name} className="grid justify-items-center gap-1">
              <div className="grid size-24 place-items-center rounded-control border border-line" style={{ background: bg }}>
                <Crosshair settings={xh} />
              </div>
              <figcaption className="text-xs text-muted">{name}</figcaption>
            </figure>
          ))}
        </div>
      </fieldset>
      <div>
        <button type="button" className={btnPrimary} onClick={onClose}>
          Done
        </button>
      </div>
    </section>
  )
}

export default function ArenaPage() {
  const match = useArenaMatch((level) => agentVersionFor(sourceRegistry, level), registry?.learnsFromHumans === true)
  const [screen, setScreen] = useState<'prematch' | 'match'>('prematch')
  const [picked, setPicked] = useState<Level>(levelFromUrl)
  const [panel, setPanel] = useState<'controls' | 'settings' | null>(null)
  const [fixedSeed, setFixedSeed] = useState<number | undefined>(seedFromUrl)
  const host = useRef<HTMLDivElement>(null)
  // True once the match has left 'setup' since the player pressed Start, so the first render after the
  // screen switch (phase still 'setup') is not mistaken for a match that ended.
  const sawStart = useRef(false)
  const [stageRef, scale] = useStageScale()
  const cfg = PRODUCT.games.arena
  const wrap = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const h = () => {
      setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === wrap.current)
      // Entering or leaving fullscreen drops the pointer lock in some browsers: ask for it again.
      if (!document.pointerLockElement) match.capture()
    }
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [match])
  const toggleFullscreen = () => {
    const el = wrap.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void el.requestFullscreen().catch(() => undefined)
  }

  const begin = async (level: Level = picked) => {
    const seed = fixedSeed
    setFixedSeed(undefined)
    sawStart.current = false
    flushSync(() => setScreen('match'))
    // The stage is the largest 16:9 that fits the window (hud.css): bring it to the top so it is all in view.
    stageRef.current?.scrollIntoView({ block: 'start' })
    await match.start({ level, host: host.current!, stage: stageRef.current!, seed })
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
    level: LEVEL_LABEL[match.level],
    limits: limitsText(match.level),
    preview: match.preview,
    matchId: match.matchId,
    seed: match.seed,
    reloadKey: keyLabel(match.keys.reload[0] ?? 'R'),
  }
  const inMatch = screen === 'match'
  const touch = useTouchDevice()
  usePlayViewport(touch && inMatch)
  const over = match.phase === 'over'
  const result = match.finished?.record.result
  const playing = match.phase === 'playing'
  const showMenu = match.paused && panel === null
  const hud = match.hud
  // Holding the scoreboard key hides the buy menu so the two never overlap (R30); letting go brings it back.
  const buying = buyMenuVisible({ playing, phase: hud?.phase, alive: hud?.alive ?? false, paused: match.paused, board: match.board })
  const secondsLeft = hud ? Math.max(0, Math.ceil((hud.buyFrames - hud.phaseFrame) / 60)) : 0

  useEffect(() => {
    if (inMatch && !match.paused) setPanel(null)
  }, [inMatch, match.paused])

  return (
    <GameShell game="arena" level={inMatch ? match.level : undefined} preview={inMatch && (match.preview || !published(match.level))} previewLabel="Practice" onOpenGuide={() => { if (inMatch && match.phase === 'playing') match.pause() }} actions={<MuteToggle />}>
      {screen === 'prematch' ? (
        <div className="grid gap-5 py-2" data-testid="prematch">
          <p className="max-w-prose text-muted">
            First person, first to 7 rounds on Coldstore. You buy at the start of every round and so does the opponent, with the same rules and the same money. Mouse aims, left button fires.
          </p>
          <LevelPicker value={picked} onChange={setPicked}
            levels={Object.fromEntries(LEVELS.map((l) => [l, { preview: !published(l), practice: !published(l), strength: published(l) ? 'Strength tested' : undefined }]))}
            descriptions={Object.fromEntries(LEVELS.map((l) => [l, limitsText(l)]))}
            action={
            <div className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} onClick={() => void begin()}>
              Start match vs {personaFor(picked).name}
            </button>
            <button type="button" className={btnPlain} onClick={() => setPanel('settings')}>
              Sensitivity and crosshair
            </button>
            <button type="button" className={btnPlain} onClick={() => setPanel('controls')}>
              Controls
            </button>
            </div>
            } />
          {LEVELS.some((l) => !published(l)) ? (
            <p className="text-sm text-muted" data-testid="practice-note">
              {PRACTICE_PICKER_NOTE}
            </p>
          ) : null}
          <div className="text-sm text-muted" data-testid="agent-card"><b data-testid="agent-name">{personaFor(picked).name}, {LEVEL_LABEL[picked]}</b><span data-testid="strength-line"> {strengthLine(registry, picked)} {limitsSentence(picked)}{isPublished(registry, picked) ? ` ${styleLine(picked, 'arena')}` : ''}</span></div>
          <ul className="grid gap-1 text-sm text-muted">
            <li>On desktop, the mouse is captured while you play; Esc gives it back and pauses. On a phone, drag to aim.</li>
            <li>{playTrainingBullet('arena', registry)}</li>
          </ul>
          {panel ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-4">
              {panel === 'controls' ? <ControlsPanel keys={match.keys} onChange={match.setKeys} onClose={() => setPanel(null)} /> : <SettingsPanel settings={match.settings} onChange={match.setSettings} onClose={() => setPanel(null)} />}
            </div>
          ) : null}
          {match.failure ? (
            <p role="alert" className="rounded-control bg-warn-soft px-3 py-2 text-sm text-warn-ink">
              {match.failure}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className={cn(!inMatch && 'hidden')}>
        <div ref={wrap} className="arena-stage-wrap" data-testid="arena-stage-wrap" data-fullscreen={fullscreen ? 'true' : 'false'}>
        <div
          ref={stageRef}
          className={cn('arena-stage-root', match.locked && 'locked', touch && inMatch && 'touch-play-stage')}
          data-testid="arena-stage"
          data-phase={match.phase}
          data-locked={match.locked ? 'true' : 'false'}
          data-record-ok={match.finished ? String(match.finished.ok) : undefined}
          data-paused={match.paused ? 'true' : 'false'}
        >
          <div ref={host} className="absolute inset-0" />
          {touch && playing && !match.paused ? <TouchControls game="arena" action={(a, down) => match.touchAction(a as import('./input').Action | 'fire', down)} aim={match.touchAim} pause={match.pause} /> : null}
          {hud && inMatch ? <ArenaHud view={hud} names={names} settings={match.settings} scale={scale} showBoard={match.board} /> : null}
          {buying && hud ? <BuyMenu money={hud.money} weapon={hud.weapon} armor={hud.armor} seconds={secondsLeft} onBuy={match.buy} /> : null}
          {inMatch ? (
            <span className="arena-debug-note" data-testid="renderer-label" hidden={match.rendererLabel === 'stage'}>
              {match.rendererLabel}
            </span>
          ) : null}
          {playing && !touch && !match.locked && !match.paused && !match.board ? (
            <p className="arena-capture" data-testid="capture-hint" role="status">
              Click the view to capture the mouse
            </p>
          ) : null}
          {match.phase === 'loading' ? (
            <div className="arena-ov" role="status">
              <p className="rounded-control bg-surface px-4 py-2 text-sm text-ink">Loading Coldstore and the opponent</p>
            </div>
          ) : null}
          {showMenu ? (
            <div className="arena-ov" data-no-capture>
              <section role="dialog" aria-label="Paused" className="grid w-full max-w-sm gap-4 rounded-card border border-line bg-surface p-6 text-ink shadow-card">
                <div>
                  <h2 className="font-display text-display-md">Paused</h2>
                  <p className="text-sm text-muted">
                    {names.ai}. {names.limits}.
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <button
                    type="button"
                    autoFocus
                    className={btnPrimary}
                    onClick={() => {
                      match.resume()
                      match.capture()
                    }}
                  >
                    Resume
                  </button>
                  <button type="button" className={btnPlain} onClick={() => setPanel('settings')}>
                    Sensitivity and crosshair
                  </button>
                  <button type="button" className={btnPlain} onClick={() => setPanel('controls')}>
                    Controls
                  </button>
                  <button type="button" className={btnPlain} onClick={toggleFullscreen}>
                    {fullscreen ? 'Leave fullscreen' : 'Fullscreen'}
                  </button>
                  <a className={btnPlain} href="/settings" target="_blank" rel="noopener noreferrer">
                    Account settings (new tab)
                  </a>
                  <button
                    type="button"
                    className={cn(btnPlain, 'text-bad-ink')}
                    onClick={() => {
                      setPanel(null)
                      match.quit()
                    }}
                  >
                    Quit match
                  </button>
                </div>
                <p className="text-xs text-muted">Quitting leaves the match. It is not counted and nothing is saved.</p>
              </section>
            </div>
          ) : null}
          {match.paused && panel ? (
            <div className="arena-ov" data-no-capture>
              {panel === 'controls' ? <ControlsPanel keys={match.keys} onChange={match.setKeys} onClose={() => setPanel(null)} /> : <SettingsPanel settings={match.settings} onChange={match.setSettings} onClose={() => setPanel(null)} />}
            </div>
          ) : null}
          {over && result ? (
            <div className="arena-ov" data-no-capture>
              <div className="grid w-full max-w-md gap-3">
                <ResultPanel
                  leaderboard={false}
                  result={{ ...result, reason: `Rounds ${result.score[0]} to ${result.score[1]}` }}
                  humanSeat={0}
                  onRematch={() => void begin(picked)}
                  onChangeLevel={() => {
                    match.quit()
                    setScreen('prematch')
                  }}
                  onPlayLevel={(l) => {
                    setPicked(l)
                    void begin(l)
                  }}
                  extra={
                    hud ? (
                      <section aria-label="Match stats" data-testid="match-stats" className="grid gap-1 text-sm">
                        <h3 className="font-semibold">Your match</h3>
                        <p className="text-muted">
                          {count(hud.stats.kills[0], 'kill')}, {count(hud.stats.deaths[0], 'death')}, {count(hud.stats.headshots[0], 'headshot')}, {Math.round(hud.stats.damage[0]).toLocaleString('en-US')} damage dealt.
                        </p>
                      </section>
                    ) : null
                  }
                  upload={match.upload}
                  unratedReason={match.unratedReason}
                  recordOk={match.finished?.ok}
                  note={resultTrainingNote('arena', registry, PRODUCT.trainingDataBasis === 'legitimate-interest')}
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
        </div>
        {inMatch && !over ? (
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span>
              <Key>{keyLabel(match.keys.pause[0] ?? 'Esc')}</Key> pause, settings and controls
            </span>
            <span>
              <Key>{keyLabel(match.keys.scoreboard[0] ?? 'Tab')}</Key> scoreboard
            </span>
            <span>{cfg.displayName}: first to 7 rounds</span>
            <button type="button" className="min-h-9 rounded-control border border-line bg-surface px-3 text-sm font-semibold text-ink" aria-pressed={fullscreen} onClick={toggleFullscreen}>
              {fullscreen ? 'Leave fullscreen' : 'Fullscreen'}
            </button>
          </p>
        ) : null}
      </div>
    </GameShell>
  )
}
