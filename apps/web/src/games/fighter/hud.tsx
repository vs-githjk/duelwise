import { useEffect, useRef, useState } from 'react'
import { MAX_HEALTH, ROUNDS_TO_WIN, ROUND_FRAMES, SUPER_MAX, SURGE_MAX } from '@duelwise/core/src/games/fighter/constants'
import { PHASE } from '@duelwise/core/src/games/fighter/state'
import { ACTION_LABEL, keyLabel, type Action, type KeyMap } from './input'
import './hud.css'

// The fighter HUD (design pass 2). Pure view over a HudView the match hook builds from the sim state.
// Health, timer, round pips, six-segment Surge with the overheat countdown, three super stocks, the
// combo counter and callouts, the opponent pill with its real limits, and the round banners.

export interface HudView {
  phase: number
  phaseFrame: number
  round: number
  /** Frames left in the round. */
  timer: number
  wins: [number, number]
  health: [number, number]
  surge: [number, number]
  /** Frames of overheat left. */
  overheat: [number, number]
  superMeter: [number, number]
  /** The combo each seat is landing: hits and damage, null when none. */
  combo: [{ hits: number; damage: number } | null, { hits: number; damage: number } | null]
}

export type CalloutKind = 'counter' | 'punish' | 'deflect'
export interface Callout {
  id: number
  kind: CalloutKind
  /** The seat the callout belongs to: the one who landed the hit, or who deflected. */
  seat: 0 | 1
}

export interface HudNames {
  you: string
  ai: string
  youCharacter: string
  aiCharacter: string
  level: string
  /** "Reacts in 200 ms, at most 240 actions a minute" style text, from the level's limits. */
  limits: string
  preview: boolean
}

const FIGHT_BANNER_FRAMES = 20
const SEG = SURGE_MAX / 6
const STOCK = SUPER_MAX / 3
const fmt = (n: number) => Math.max(0, Math.round(n)).toLocaleString('en-US')

function HealthBar({ side, health, wins, name, character, id }: { side: 'l' | 'r'; health: number; wins: number; name: string; character: string; id: string }) {
  const pct = Math.max(0, Math.min(100, (health / MAX_HEALTH) * 100))
  return (
    <div className={`fh-hp ${side}`} data-testid={id}>
      <div className="nm">
        <div>
          {name}
          <span className="chr">{character}</span>
        </div>
        <span>
          {fmt(health)} / {fmt(MAX_HEALTH)}
        </span>
      </div>
      <div className="bar" role="meter" aria-label={`${name} health`} aria-valuemin={0} aria-valuemax={MAX_HEALTH} aria-valuenow={Math.max(0, health)}>
        <i className="lost" style={{ ['--pl' as string]: `${pct}%` }} />
        <i className={`cur${health < 2500 ? ' low' : ''}`} style={{ ['--p' as string]: `${pct}%` }} />
      </div>
      <div className="rp" aria-label={`${name} rounds won`}>
        {Array.from({ length: ROUNDS_TO_WIN }, (_, i) => (
          <i key={i} className={i < wins ? 'on' : ''} />
        ))}
      </div>
    </div>
  )
}

function Gauges({ side, surge, overheat, superMeter, id }: { side: 'l' | 'r'; surge: number; overheat: number; superMeter: number; id: string }) {
  const hot = overheat > 0
  const segs = Array.from({ length: 6 }, (_, i) => Math.max(0, Math.min(1, (surge - i * SEG) / SEG)))
  return (
    <div className={`fh-gauge ${side}`}>
      <div className="lbl" data-testid={`surge-${id}`}>
        Surge
        {hot ? <span className="hot">overheated, {(overheat / 60).toFixed(1)} s</span> : <span>{Math.floor(surge / SEG)} of 6</span>}
      </div>
      <div className="seg6" aria-hidden="true">
        {segs.map((f, i) => (
          <i key={i} className={hot ? 'hot' : f >= 1 ? 'on' : f > 0 ? 'part' : ''} style={f > 0 && f < 1 ? { ['--f' as string]: `${f * 100}%` } : undefined} />
        ))}
      </div>
      <div className="sup" data-testid={`super-${id}`}>
        {[0, 1, 2].map((i) => {
          const f = Math.max(0, Math.min(1, (superMeter - i * STOCK) / STOCK))
          return <i key={i} className={f >= 1 ? 'full' : ''} style={{ ['--f' as string]: `${f * 100}%` }} />
        })}
        <small>Super {Math.floor(superMeter / STOCK)} of 3</small>
      </div>
    </div>
  )
}

function bannerFor(v: HudView): { text: string; cls: string; sub?: string } | null {
  if (v.phase === PHASE.INTRO) return { text: `Round ${v.round}`, cls: '' }
  // The sim does not count frames inside the fight phase, so the banner runs off the round clock instead.
  if (v.phase === PHASE.FIGHT && ROUND_FRAMES - v.timer < FIGHT_BANNER_FRAMES) return { text: 'Fight', cls: 'fight' }
  if (v.phase === PHASE.ROUND_END) {
    const ko = v.health[0] <= 0 || v.health[1] <= 0
    return ko ? { text: 'KO', cls: 'ko' } : { text: 'Time', cls: '' }
  }
  return null
}

const HINTS: Array<[string, Action[]]> = [
  ['move and jump', ['up', 'left', 'down', 'right']],
  ['light', ['light']],
  ['medium', ['medium']],
  ['heavy', ['heavy']],
  ['special', ['special']],
  ['surge', ['surge']],
  ['throw', ['throw']],
  ['pause', ['pause']],
]

export function FighterHud({ view, names, callouts, keys, showKeys, scale }: { view: HudView; names: HudNames; callouts: Callout[]; keys: KeyMap; showKeys: boolean; scale: number }) {
  const seconds = Math.max(0, Math.ceil(view.timer / 60))
  const banner = bannerFor(view)
  return (
    <div className="fh-scale" style={{ ['--s' as string]: scale }} data-testid="fighter-hud">
      <div className="fh-top">
        <HealthBar side="l" id="hp-you" health={view.health[0]} wins={view.wins[0]} name={names.you} character={names.youCharacter} />
        <div className="fh-rt">
          <div className={`n${seconds < 10 ? ' urgent' : ''}`} data-testid="round-timer">
            {seconds}
          </div>
          <div className="rn">Round {view.round}</div>
        </div>
        <HealthBar side="r" id="hp-ai" health={view.health[1]} wins={view.wins[1]} name={names.ai} character={names.aiCharacter} />
      </div>
      {showKeys ? (
        <div className="fh-keys" aria-hidden="true">
          {HINTS.map(([label, actions]) => (
            <div key={label}>
              {actions.map((a) => (
                <kbd key={a} title={ACTION_LABEL[a]}>
                  {keys[a].map(keyLabel).join(' / ') || '?'}
                </kbd>
              ))}{' '}
              {label}
            </div>
          ))}
        </div>
      ) : null}
      {([0, 1] as const).map((seat) => {
        const c = view.combo[seat]
        return c && c.hits >= 2 ? (
          <div key={`combo-${seat}-${c.hits}`} className={`fh-combo ${seat === 0 ? 'l' : 'r'}`} data-testid={`combo-${seat === 0 ? 'you' : 'ai'}`}>
            <div className="n">{c.hits}</div>
            <div className="l">Hit combo</div>
            <div className="d">{fmt(c.damage)} damage</div>
          </div>
        ) : null
      })}
      {callouts.map((c) => (
        <div key={c.id} className={`fh-callout ${c.kind} ${c.seat === 0 ? 'l' : 'r'}`} style={{ top: 400 }} data-testid="callout">
          {c.kind === 'counter' ? 'Counter hit' : c.kind === 'punish' ? 'Punish counter' : 'Deflect'}
        </div>
      ))}
      <Gauges side="l" id="you" surge={view.surge[0]} overheat={view.overheat[0]} superMeter={view.superMeter[0]} />
      <Gauges side="r" id="ai" surge={view.surge[1]} overheat={view.overheat[1]} superMeter={view.superMeter[1]} />
      <div className="fh-pill" data-testid="ai-pill">
        <b>{names.ai}</b>
        <span>{names.limits}</span>
        {names.preview ? <em>Practice</em> : null}
      </div>
      {banner ? (
        <div className="fh-banner" key={`${view.round}-${banner.text}`} data-testid="round-banner" aria-live="polite">
          <b className={banner.cls}>{banner.text}</b>
        </div>
      ) : null}
    </div>
  )
}

/** Scale of the 1440 x 810 HUD canvas to the element it sits in. */
export function useStageScale(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Fit the 1440 x 810 canvas inside the element: on a 16:9 stage this is the width ratio; on a wider phone screen the height decides.
    const update = () => setScale(Math.max(0.1, Math.min(el.clientWidth / 1440, el.clientHeight > 0 ? el.clientHeight / 810 : Infinity)))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, scale]
}
