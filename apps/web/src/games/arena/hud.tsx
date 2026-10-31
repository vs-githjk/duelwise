import { useEffect, useRef, useState } from 'react'
import { MAP_LIST, type MapData } from '@duelwise/core/src/games/arena/map'
import { MAX_HEALTH, ROUNDS_TO_WIN } from '@duelwise/core/src/games/arena/economy'
import { PHASE } from '@duelwise/core/src/games/arena/state'
import { WEAPONS } from '@duelwise/core/src/games/arena/weapons'
import type { ArenaSettings } from './input'
import './hud.css'

// The arena HUD (design pass 2). Pure view over a HudView the match hook builds from the sim state:
// score box with round pips and the timer, kill feed, minimap, health, armour and money, ammo, the
// opponent pill with its real limits, crosshair, hit marker, damage direction, round banner and the
// scoreboard. The opponent is on the minimap only while the sim says this seat sees it.

export interface FeedRow {
  id: number
  killer: 0 | 1
  victim: 0 | 1
  weapon: number
  headshot: boolean
}

export interface Stats {
  kills: [number, number]
  deaths: [number, number]
  headshots: [number, number]
  damage: [number, number]
}

/** Why a round was lost, for the one place the AI's limits become visible: when it saw you, when it fired, when you fired. */
export interface DeathLine {
  seenAt: number
  aiAlreadyFiring?: boolean
  /** Frames from that seat's first sight of the other to its first shot; negative when it fired before it saw. null: no shot. */
  aiShotAt: number | null
  youShotAt: number | null
  /** The level's reaction delay in milliseconds. */
  limitMs: number
  /** Whether the human died (true) or the AI did (false). */
  youDied: boolean
}

export interface RoundSummary {
  round: number
  winner: 0 | 1 | null
  reason: number
  /** Money each seat gained at the end of the round. */
  money: [number, number]
  line: DeathLine | null
}

export interface HudView {
  frame: number
  phase: number
  phaseFrame: number
  buyFrames: number
  round: number
  /** Frames left in a live round. */
  timer: number
  wins: [number, number]
  health: number
  armor: number
  money: number
  /** The opponent's money: it buys under the same rules, so the scoreboard shows it. */
  aiMoney: number
  weapon: number
  ammo: number
  /** Frames of reload left. */
  reload: number
  alive: boolean
  mapIdx: number
  you: { x: number; y: number; yaw: number }
  /** The opponent's position while this seat sees it, otherwise null. */
  opp: { x: number; y: number } | null
  hit: { id: number; kind: 'hit' | 'head' | 'kill' } | null
  /** Where the last damage came from, in radians relative to the view (0 ahead, positive right, pi behind). */
  damage: { id: number; angle: number } | null
  feed: FeedRow[]
  stats: Stats
  /** Per finished round: who won it (0 you, 1 AI). */
  history: Array<0 | 1 | null>
  summary: RoundSummary | null
}

export interface HudNames {
  you: string
  ai: string
  level: string
  /** "Reacts in 200 ms, at most 240 actions a minute" style text, from the level's limits. */
  limits: string
  preview: boolean
  matchId: string
  seed: number
  /** Label of the bound reload key. */
  reloadKey: string
}

const fmt = (n: number) => Math.max(0, Math.round(n)).toLocaleString('en-US')
const secs = (frames: number) => (frames / 60).toFixed(2)

/**
 * The round-end sentence about who shot when, from the killer's first sight (R30). A shot before the first sight is
 * said so ("before it saw you") instead of printing 0.00 s, and a shot on the very frame of sight says so too.
 */
export function reactionText(line: DeathLine, level: string): string {
  const who = line.youDied ? 'It' : 'You'
  const other = line.youDied ? 'you' : 'it'
  const v = line.youDied ? line.aiShotAt : line.youShotAt
  const window = `At ${level} its reaction window is ${line.limitMs} ms.`
  if (line.youDied && line.aiAlreadyFiring) return `It was already firing toward that spot when you came into view. It reacts to what it saw ${line.limitMs} ms ago.`
  if (v === null) return `${who} fired no shot before the kill. ${window}`
  if (v < 0) return `${who} fired ${secs(-v)} s before ${line.youDied ? 'it' : 'you'} first saw ${other}. ${window}`
  if (v === 0) return `${who} fired on the frame ${line.youDied ? 'it' : 'you'} first saw ${other}. ${window}`
  return `${who} fired ${secs(v)} s after ${line.youDied ? 'it' : 'you'} first saw ${other}. ${window}`
}

export function Crosshair({ settings, size = 64 }: { settings: ArenaSettings['crosshair']; size?: number }) {
  const { style, color, gap, thickness, outline } = settings
  const len = settings.size
  const c = size / 2
  const bar = (x: number, y: number, w: number, h: number, key: string) => (
    <g key={key}>
      {outline ? <rect x={x - 1} y={y - 1} width={w + 2} height={h + 2} fill="rgba(0,0,0,0.75)" /> : null}
      <rect x={x} y={y} width={w} height={h} fill={color} />
    </g>
  )
  const t = thickness
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
      {style === 'dot' ? bar(c - t, c - t, t * 2, t * 2, 'dot') : null}
      {style === 'classic'
        ? [
            bar(c - t / 2, c - gap - len, t, len, 'u'),
            bar(c - t / 2, c + gap, t, len, 'd'),
            bar(c - gap - len, c - t / 2, len, t, 'l'),
            bar(c + gap, c - t / 2, len, t, 'r'),
          ]
        : null}
      {style === 'cross'
        ? [bar(c - t / 2, c - gap - len, t, len, 'u'), bar(c - gap - len, c - t / 2, len, t, 'l'), bar(c + gap, c - t / 2, len, t, 'r')]
        : null}
    </svg>
  )
}

/** Whether the buy menu is on screen: only in the live buy phase while alive and playing, and never while the scoreboard key is held, so the two cannot overlap (R30). */
export function buyMenuVisible(o: { playing: boolean; phase: number | undefined; alive: boolean; paused: boolean; board: boolean }): boolean {
  return o.playing && o.phase === PHASE.BUY && o.alive && !o.paused && !o.board
}

/** The map as drawn on the minimap (pure, so a test can check it matches the sim's boxes): the arena outline and every box, y flipped so north is up. */
export function minimapGeometry(map: MapData): { outline: string; boxes: Array<{ x: number; y: number; w: number; h: number; kind: 'wall' | 'cover' }> } {
  const b = map.bounds
  const flipY = (y: number) => b.y1 - (y - b.y0)
  return {
    outline: `M ${b.x0} ${b.y0} H ${b.x1} V ${b.y1} H ${b.x0} Z`,
    boxes: map.json.boxes.map((box) => ({ x: box.x0, y: flipY(box.y1), w: box.x1 - box.x0, h: box.y1 - box.y0, kind: box.kind === 'cover' ? 'cover' : 'wall' })),
  }
}

function Minimap({ view }: { view: HudView }) {
  const map = MAP_LIST[view.mapIdx] ?? MAP_LIST[0]!
  const b = map.bounds
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  const yaw = (view.you.yaw / 8192) * Math.PI * 2
  const flipY = (y: number) => b.y1 - (y - b.y0)
  const r = Math.max(w, h) / 28
  const stroke = Math.max(w, h) / 200
  const geo = minimapGeometry(map)
  return (
    <div className="ah-mini" data-testid="minimap">
      <svg viewBox={`${b.x0 - 20} ${b.y0 - 20} ${w + 40} ${h + 40}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Minimap">
        <rect x={b.x0} y={b.y0} width={w} height={h} fill="#141a22" />
        {geo.boxes.map((box, i) => (
          <rect
            key={i}
            data-kind={box.kind}
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            fill={box.kind === 'wall' ? '#4a5564' : '#2c343f'}
            stroke={box.kind === 'wall' ? '#aab6c5' : '#7d8a9b'}
            strokeWidth={stroke}
            strokeDasharray={box.kind === 'cover' ? `${stroke * 3} ${stroke * 2}` : undefined}
          />
        ))}
        <path data-testid="minimap-outline" d={geo.outline} fill="none" stroke="#c9d3df" strokeWidth={stroke * 1.6} strokeLinejoin="round" />
        <g transform={`translate(${view.you.x} ${flipY(view.you.y)}) rotate(${(-yaw * 180) / Math.PI})`}>
          <path d={`M ${r * 1.6} 0 L ${-r} ${r} L ${-r} ${-r} Z`} fill="var(--hud-you)" />
        </g>
        {view.opp ? <circle data-testid="minimap-opp" cx={view.opp.x} cy={flipY(view.opp.y)} r={r} fill="var(--hud-ai)" /> : null}
      </svg>
    </div>
  )
}

function Pips({ n }: { n: number }) {
  return (
    <div className="pips" aria-hidden="true">
      {Array.from({ length: ROUNDS_TO_WIN }, (_, i) => (
        <i key={i} className={i < n ? 'on' : ''} />
      ))}
    </div>
  )
}

export function Timeline({ line }: { line: DeathLine }) {
  const end = Math.max(line.seenAt + line.limitMs / 1000 * 60, line.aiShotAt ?? 0, line.youShotAt ?? 0, 30) * 1.1
  const pct = (f: number) => `${Math.min(100, Math.max(0, (f / end) * 100))}%`
  return (
    <div className="ah-line" data-testid="death-line">
      <div className="track">
        <i className="win" style={{ left: pct(0), width: pct(Math.round((line.limitMs / 1000) * 60)) }} />
        <i className="mk seen" style={{ left: pct(0) }} />
        {line.youShotAt !== null && line.youShotAt >= 0 ? <i className="mk you" style={{ left: pct(line.youShotAt) }} /> : null}
        {line.aiAlreadyFiring || (line.aiShotAt !== null && line.aiShotAt >= 0) ? <i className="mk ai" data-testid="ai-shot-mark" style={{ left: pct(line.aiShotAt ?? 0) }} /> : null}
      </div>
      <div className="legend">
        <span>
          <i style={{ background: '#fff' }} />
          {line.youDied ? 'It saw you' : 'You saw it'}
        </span>
        <span>
          <i style={{ background: 'rgba(124,196,255,0.6)' }} />
          Its reaction window, {line.limitMs} ms
        </span>
        {line.youShotAt !== null ? (
          <span>
            <i style={{ background: 'var(--hud-you)' }} />
            {line.youShotAt < 0 ? 'You fired before you saw it' : `Your first shot, ${secs(line.youShotAt)} s`}
          </span>
        ) : null}
        {line.aiShotAt !== null || line.aiAlreadyFiring ? (
          <span>
            <i style={{ background: 'var(--hud-punish)' }} />
            {line.aiAlreadyFiring ? 'Already firing when you came into view' : (line.aiShotAt ?? 0) < 0 ? 'It fired before it saw you' : `Its first shot, ${secs(line.aiShotAt ?? 0)} s`}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function roundReason(reason: number): string {
  return reason === 2 ? 'Time ran out. The player with more health wins.' : reason === 3 ? 'Both players fell, or time ran out with equal health.' : ''
}

function Banner({ view, names }: { view: HudView; names: HudNames }) {
  const s = view.summary
  if (!s || view.phase !== PHASE.ROUND_END) return null
  const draw = s.winner === null
  const text = draw ? 'Round drawn' : s.winner === 0 ? 'Round won' : 'Round lost'
  const reason = roundReason(s.reason)
  return (
    <div className="ah-banner" key={`${s.round}-${text}`} data-testid="round-banner" aria-live="polite">
      <b className={s.winner === 0 ? 'win' : 'lose'}>{text}</b>
      <div className="sub">
        {reason ? <>{reason} </> : null}
        You <span className="mo">+${fmt(s.money[0])}</span> · {names.ai} <span className="mo">+${fmt(s.money[1])}</span>
        {s.line ? (
          <>
            <br />
            {reactionText(s.line, names.level)}
            <Timeline line={s.line} />
          </>
        ) : null}
      </div>
    </div>
  )
}

function Scoreboard({ view, names }: { view: HudView; names: HudNames }) {
  const st = view.stats
  const row = (i: 0 | 1, who: string, cls: string, limits: string) => (
    <tr>
      <td className={cls}>
        {who}
        <span className="lim">{limits}</span>
      </td>
      <td>{st.kills[i]}</td>
      <td>{st.deaths[i]}</td>
      <td>{st.headshots[i]}</td>
      <td>{fmt(st.damage[i])}</td>
      <td>{view.wins[i]}</td>
      <td>${fmt(i === 0 ? view.money : view.aiMoney)}</td>
    </tr>
  )
  return (
    <div className="ah-board" data-testid="scoreboard" role="dialog" aria-label="Scoreboard">
      <table>
        <thead>
          <tr>
            <th>Player</th>
            <th>Kills</th>
            <th>Deaths</th>
            <th>Headshots</th>
            <th>Damage</th>
            <th>Rounds</th>
            <th>Money</th>
          </tr>
        </thead>
        <tbody>
          {row(0, names.you, 'you', 'Mouse and keyboard. Aim and reaction are your own.')}
          {row(1, names.ai, 'ai', names.limits)}
        </tbody>
      </table>
      <div className="hist" aria-label="Round history">
        {view.history.map((w, i) => (
          <i key={i} className={w === 0 ? 'y' : w === 1 ? 'a' : ''} style={w === null ? { background: 'rgba(255,255,255,0.3)' } : undefined}>
            {i + 1}
          </i>
        ))}
      </div>
      <div className="foot">
        This match is stored as inputs and replays to the same final state on the server.
      </div>
    </div>
  )
}

export interface HudProps {
  view: HudView
  names: HudNames
  settings: ArenaSettings
  scale: number
  showBoard: boolean
}

export function ArenaHud({ view, names, settings, scale, showBoard }: HudProps) {
  const buying = view.phase === PHASE.BUY
  const left = buying ? Math.max(0, view.buyFrames - view.phaseFrame) : view.timer
  const seconds = Math.ceil(left / 60)
  const w = WEAPONS[view.weapon]!
  const low = view.health <= 25
  return (
    <div className="ah-scale" style={{ ['--s' as string]: scale }} data-testid="arena-hud">
      <Minimap view={view} />
      <div className="ah-score" data-testid="score-box">
        <div className="side l">
          <div className="nm">
            {names.you} <span data-testid="wins-you">{view.wins[0]}</span>
          </div>
          <Pips n={view.wins[0]} />
        </div>
        <div className="mid">
          <div className={`t${!buying && seconds <= 10 ? ' urgent' : ''}`} data-testid="round-timer">
            {buying ? `Buy ${seconds}` : seconds}
          </div>
          <div className="rn">Round {view.round}</div>
        </div>
        <div className="side r">
          <div className="nm">
            <span data-testid="wins-ai">{view.wins[1]}</span> {names.ai}
          </div>
          <Pips n={view.wins[1]} />
        </div>
      </div>
      <div className="ah-feed" aria-label="Kill feed">
        {view.feed.map((f) => (
          <div key={f.id} className={`row${f.killer === 0 ? ' mine' : ''}`}>
            <span className={f.killer === 0 ? 'k' : 'v'}>{f.killer === 0 ? 'You' : names.ai}</span>
            <span className="w">{WEAPONS[f.weapon]!.name}</span>
            <span className={f.victim === 0 ? 'k' : 'v'}>{f.victim === 0 ? 'You' : names.ai}</span>
            {f.headshot ? <span className="hs">headshot</span> : null}
          </div>
        ))}
      </div>
      <div className="ah-vitals">
        <div className={`bar hp${low ? ' low' : ''}`} data-testid="hp">
          <span>HP</span>
          <div className="tr">
            <i style={{ width: `${Math.max(0, Math.min(100, (view.health / MAX_HEALTH) * 100))}%` }} />
          </div>
          <b>{Math.max(0, view.health)}</b>
        </div>
        <div className="bar ar" data-testid="armor">
          <span>AR</span>
          <div className="tr">
            <i style={{ width: `${Math.max(0, Math.min(100, view.armor))}%` }} />
          </div>
          <b>{view.armor}</b>
        </div>
        <div className="ah-money" data-testid="money">
          ${fmt(view.money)}
        </div>
      </div>
      <div className="ah-ammo" data-testid="ammo">
        <div className="n">
          {view.ammo}
          <small>/ {w.magazine}</small>
        </div>
        <div className="w">{w.name}</div>
        {view.reload > 0 ? <div className="rl">Reloading</div> : view.ammo === 0 ? <div className="rl">Press {names.reloadKey} to reload</div> : null}
      </div>
      <div className="ah-pill" data-testid="ai-pill">
        <b>{names.ai}</b>
        <span>{names.limits}</span>
        {names.preview ? <em>In training</em> : null}
      </div>
      {view.alive ? (
        <div className="ah-xh">
          <Crosshair settings={settings.crosshair} />
        </div>
      ) : null}
      {settings.hitMarker && view.hit ? (
        <div className="ah-hit" key={view.hit.id} data-testid="hit-marker">
          <svg viewBox="0 0 44 44" aria-hidden="true">
            <path d="M8 8 L18 18 M36 8 L26 18 M8 36 L18 26 M36 36 L26 26" stroke={view.hit.kind === 'hit' ? '#ffffff' : '#ff4d6d'} strokeWidth="3" strokeLinecap="round" />
          </svg>
        </div>
      ) : null}
      {view.damage ? (
        <div className="ah-dmg" key={view.damage.id}>
          <i style={{ transform: `rotate(${(view.damage.angle * 180) / Math.PI}deg)` }} />
        </div>
      ) : null}
      <Banner view={view} names={names} />
      {showBoard ? <Scoreboard view={view} names={names} /> : null}
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
