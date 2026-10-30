import {
  ACESFilmicToneMapping, PCFShadowMap, Scene, SRGBColorSpace, Vector2, WebGLRenderer,
} from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { isAttackId, M, MOVES } from '@duelwise/core/src/games/fighter/moves.ts'
import { EV, PHASE, type Fighter, type FighterState } from '@duelwise/core/src/games/fighter/state.ts'
import { ANIMATION_MAP, baseTime, clipTime, type MoveAnim } from './animation-map'
import { CameraRig, UNIT } from './camera'
import { CHARACTERS, FighterRig, loadCharacterAssets, type CharacterAssets, type PoseEntry } from './characters'
import { createStage, type Stage } from './stage'
import { ProjectileFx, travelDirection } from './projectile'
import { Vfx, type HitKind } from './vfx'

// The 2.5D fighter renderer. It reads sim state only, never changes it. The sim's own numbers drive
// everything visual: hitstop freezes the pose, MOVES[...].startup/active line the strike pose up with
// the active frames (animation-map.ts), and the EV event bits spawn the hit language (vfx.ts).

/** A sim event for renderers that are given them explicitly; this renderer derives its own from Fighter.events. */
export interface SimEvent {
  type: string
  seat?: 0 | 1
}

export interface SimRenderer<S> {
  mount(el: HTMLElement): Promise<void>
  render(prev: S, next: S, alpha: number, events: SimEvent[]): void
  resize(w: number, h: number): void
  dispose(): void
}

/** Health and gauge values for the HUD (T34) once per sim frame. Health 0 to 10000, surge 0 to 60000, super 0 to 30000. */
export interface HudSnapshot {
  frame: number
  phase: number
  round: number
  /** Frames left in the round (60 per second). */
  timer: number
  wins: [number, number]
  health: [number, number]
  surge: [number, number]
  /** Frames of overheat left. */
  overheat: [number, number]
  superMeter: [number, number]
  combo: [number, number]
  /** True on frames where either fighter is frozen in hitstop. */
  hitstop: boolean
  /** Kinds of hit effects spawned on this frame, for callouts. */
  hits: HitKind[]
}

export interface CharacterChoice {
  character: number
  colorway: number
}

export interface FighterRendererOptions {
  quality?: 'high' | 'low'
  /** Which character and colorway each seat uses (defaults: seat 0 character a in Ember, seat 1 character b in Navy, so the seats contrast). */
  choices?: [CharacterChoice, CharacterChoice]
  onHud?: (h: HudSnapshot) => void
  /** Keep the drawing buffer so a screenshot or canvas read works at any time (tests and capture). */
  preserveDrawingBuffer?: boolean
}

const BLEND_SECONDS = 0.06
/** The super holds the camera on the attacker for 20 frames (design v2 camera spec). */
const SUPER_HOLD_FRAMES = 20
const REACTION_IDS = new Set<number>([M.HITSTUN, M.BLOCKSTUN, M.KNOCKDOWN, M.THROWN, M.PARRIED, M.TECH])

function kindOfMove(id: number): HitKind {
  if (id === M.STAND_L || id === M.CROUCH_L || id === M.AIR_L) return 'light'
  if (id === M.STAND_M || id === M.CROUCH_M || id === M.AIR_M) return 'medium'
  if (id === M.SPARK || id === M.EMBER) return 'medium'
  return 'heavy'
}

/**
 * The strike spark for a hit that landed in `next`, classified by the move that caused it. On the
 * frame a hit lands the attacker is often already in a reaction state (a trade) or has recovered
 * (a projectile), so the attacker's current move is used only when it is an attack; otherwise the
 * previous step's attack, otherwise the projectile that was in flight.
 */
export function hitKindFor(prev: FighterState, next: FighterState, attacker: 0 | 1): HitKind {
  const before = prev.fighters[attacker]!
  // The sim sets HIT_DEALT on the attacker only for strikes; a projectile hit never sets it.
  if ((next.fighters[attacker]!.events & EV.HIT_DEALT) === 0 && before.projectile.on !== 0) return kindOfMove(before.projectile.move)
  const nowId = next.fighters[attacker]!.moveId
  if (isAttackId(nowId)) return kindOfMove(nowId)
  if (isAttackId(before.moveId)) return kindOfMove(before.moveId)
  if (before.projectile.on !== 0) return kindOfMove(before.projectile.move)
  return 'medium'
}

/**
 * Whether a clean hit on `defender` is a counter or a punish. The sim records it on the hit frame
 * (EV.COUNTER_HIT / EV.PUNISH_HIT, set by applyStrike), so this reads the event and never re-derives
 * it. Null for an ordinary hit.
 */
export function counterKindFor(_prev: FighterState, next: FighterState, defender: 0 | 1): 'counter' | 'punish' | null {
  const ev = next.fighters[defender]!.events
  if ((ev & EV.COUNTER_HIT) !== 0) return 'counter'
  if ((ev & EV.PUNISH_HIT) !== 0) return 'punish'
  return null
}

interface SeatView {
  rig: FighterRig
  yaw: number
  key: number
  lastEntries: PoseEntry[]
  blendFrom: PoseEntry[] | null
  blendT: number
  blendDur: number
  orb: ProjectileFx
}

function entriesFor(anim: MoveAnim, moveId: number, f: Fighter, frame: number, frac: number): PoseEntry[] {
  const t = clipTime(anim, moveId, f.moveFrame, frame, frac)
  if (anim.base) return [{ clip: anim.base + ':body', time: baseTime(anim.base, frame, frac), weight: 1 }, { clip: anim.clip + ':arms', time: t, weight: 1 }]
  return [{ clip: anim.clip, time: t, weight: 1 }]
}

export class FighterRenderer implements SimRenderer<FighterState> {
  private renderer: WebGLRenderer | null = null
  private composer: EffectComposer | null = null
  private scene = new Scene()
  private rig = new CameraRig()
  private stage: Stage | null = null
  private vfx = new Vfx()
  private assets: CharacterAssets | null = null
  private seats: SeatView[] = []
  private host: HTMLElement | null = null
  private lastFrame = -1
  private lastNow = 0
  private clock = 0
  private koFrames = 0
  private stepFrame = -1
  private hudPending: HudSnapshot | null = null
  private disposed = false
  /** Milliseconds the last render() call took on the CPU (frame time hook for the benchmark). */
  lastRenderMs = 0
  readonly opts: Required<Pick<FighterRendererOptions, 'quality'>> & FighterRendererOptions

  constructor(opts: FighterRendererOptions = {}) {
    this.opts = { quality: 'high', ...opts }
    this.scene.add(this.vfx.group)
  }

  get canvas(): HTMLCanvasElement | null {
    return this.renderer?.domElement ?? null
  }

  get info(): { renderer: string; calls: number; triangles: number } {
    const gl = this.renderer?.getContext()
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const name = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown'
    const i = this.renderer?.info.render
    return { renderer: name, calls: i?.calls ?? 0, triangles: i?.triangles ?? 0 }
  }

  async mount(el: HTMLElement): Promise<void> {
    this.host = el
    const high = this.opts.quality === 'high'
    const renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: this.opts.preserveDrawingBuffer ?? false,
    })
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.shadowMap.enabled = high
    renderer.shadowMap.type = PCFShadowMap
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    const w = Math.max(1, el.clientWidth)
    const h = Math.max(1, el.clientHeight)
    renderer.setSize(w, h, false)
    const cv = renderer.domElement
    cv.className = 'block size-full'
    cv.setAttribute('aria-label', 'Fighter stage')
    el.appendChild(cv)
    this.renderer = renderer
    this.rig.resize(w, h)
    this.rig.setReducedMotion(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

    this.stage = createStage(this.scene, renderer, { quality: this.opts.quality })
    const [assets] = await Promise.all([loadCharacterAssets(), this.stage.ready])
    if (this.disposed) return
    this.assets = assets

    const choices = this.opts.choices ?? [{ character: 0, colorway: 0 }, { character: 1, colorway: 1 }]
    this.seats = choices.map((c) => {
      const def = CHARACTERS[c.character]!
      const rig = new FighterRig(def, def.colorways[c.colorway] ?? def.colorways[0]!, assets)
      this.scene.add(rig.root)
      const orb = new ProjectileFx()
      this.scene.add(orb.group)
      return { rig, yaw: 0, key: -1, lastEntries: [], blendFrom: null, blendT: 1, blendDur: 0, orb }
    })

    if (high) {
      const composer = new EffectComposer(renderer)
      composer.setPixelRatio(1)
      composer.setSize(w, h)
      composer.addPass(new RenderPass(this.scene, this.rig.camera))
      composer.addPass(new UnrealBloomPass(new Vector2(Math.ceil(w / 2), Math.ceil(h / 2)), 0.4, 0.55, 0.88))
      composer.addPass(new OutputPass())
      this.composer = composer
    }
    this.warmUp()
  }

  /**
   * Everything that would otherwise be built or compiled the first time it shows (tinderbox-r2: three single hitches of
   * 164 to 268 ms): every clip's action, every hit effect's shader program, the projectile glow. It runs while the page
   * still says "Loading", so the first hit costs nothing extra.
   */
  private warmUp(): void {
    const r = this.renderer
    if (!r || !this.assets) return
    for (const s of this.seats) s.rig.warm(this.assets.clips.keys())
    const shown = this.seats.map((s) => s.orb.group.visible)
    for (const s of this.seats) s.orb.group.visible = true
    try {
      this.vfx.withEveryKind(() => r.compile(this.scene, this.rig.camera))
    } finally {
      this.seats.forEach((s, i) => (s.orb.group.visible = shown[i]!))
    }
  }

  resize(w: number, h: number): void {
    if (!this.renderer) return
    this.renderer.setSize(w, h, false)
    this.composer?.setSize(w, h)
    this.rig.resize(w, h)
  }

  /**
   * Derives the effects of ONE sim step (sparks, shake, KO push in, super hold, HUD snapshot). The play
   * loop must call this after every stepPacked, because the sim clears Fighter.events each step and a
   * render that spans several steps would lose the events of the skipped ones. render() calls it itself
   * only for a frame it has not been told about (a caller that renders every step needs nothing else).
   */
  onStep(prev: FighterState, next: FighterState): void {
    if (next.frame < this.stepFrame) this.koFrames = 0
    this.stepFrame = next.frame
    if (this.koFrames > 0) this.koFrames--
    const hits: HitKind[] = []
    for (const i of [0, 1] as const) {
      const f = next.fighters[i]!
      const o = next.fighters[1 - i]!
      const ev = f.events
      const cx = f.pos.x / UNIT
      const cy = (f.pos.y + 100) / UNIT
      const thrown = (ev & EV.THROWN) !== 0
      if (ev & EV.HIT_TAKEN && !thrown) {
        const k = counterKindFor(prev, next, i as 0 | 1) ?? hitKindFor(prev, next, (1 - i) as 0 | 1)
        hits.push(k)
        this.vfx.spawn(k, cx - f.facing * 0.15, cy, f.facing)
      }
      // A deflect also flags BLOCKED on the attacker; that is the green ring, not a shield.
      if (ev & EV.BLOCKED && !(o.events & EV.DEFLECTED)) {
        hits.push('block')
        this.vfx.spawn('block', cx + f.facing * 0.3, cy, f.facing)
      }
      if (ev & EV.DEFLECTED) {
        hits.push('deflect')
        this.vfx.spawn('deflect', cx + f.facing * 0.35, cy, f.facing)
      }
      if (thrown) {
        hits.push('throw')
        this.vfx.spawn('throw', cx, cy, f.facing)
      }
      if (ev & EV.KO) {
        hits.push('ko')
        this.vfx.spawn('ko', cx, cy, f.facing)
        this.koFrames = 45
      }
      if (ev & EV.MOVE_START && f.moveId === M.EMBER) this.rig.freeze(SUPER_HOLD_FRAMES, f.pos.x)
    }
    if (this.vfx.pendingShake) {
      this.rig.kick(this.vfx.pendingShake.amount, this.vfx.pendingShake.frames)
      this.vfx.pendingShake = null
    }
    const [a, b] = next.fighters as [Fighter, Fighter]
    this.hudPending = {
      frame: next.frame,
      phase: next.phase,
      round: next.round,
      timer: next.timer,
      wins: [next.wins[0], next.wins[1]],
      health: [a.health, b.health],
      surge: [a.surge, b.surge],
      overheat: [a.overheat, b.overheat],
      superMeter: [a.superMeter, b.superMeter],
      combo: [a.comboCount, b.comboCount],
      hitstop: a.hitstop > 0 || b.hitstop > 0,
      hits,
    }
    this.opts.onHud?.(this.hudPending)
  }

  render(prev: FighterState, next: FighterState, alpha: number, _events: SimEvent[] = []): void {
    if (!this.renderer || !this.assets || this.disposed) return
    const t0 = performance.now()
    const dt = this.lastNow === 0 ? 1 / 60 : Math.min(0.1, (t0 - this.lastNow) / 1000)
    this.lastNow = t0
    this.clock += dt

    const jumped = this.lastFrame < 0 || next.frame < this.lastFrame || next.frame - this.lastFrame > 4
    if (next.frame !== this.stepFrame) this.onStep(prev, next)
    this.lastFrame = next.frame
    const advanced = prev.frame === next.frame - 1
    const a = Math.min(1, Math.max(0, alpha))

    for (let i = 0; i < 2; i++) {
      const seat = this.seats[i]!
      const f = next.fighters[i]!
      const p = prev.fighters[i]!
      const hold = f.hitstop > 0
      const frac = hold || !advanced ? 0 : a
      const px = advanced ? p.pos.x + (f.pos.x - p.pos.x) * a : f.pos.x
      const py = advanced ? p.pos.y + (f.pos.y - p.pos.y) * a : f.pos.y
      const jitter = hold && REACTION_IDS.has(f.moveId) ? (next.frame % 2 === 0 ? 0.012 : -0.012) : 0
      seat.rig.root.position.set(px / UNIT + jitter, py / UNIT, 0)
      const targetYaw = f.facing * (Math.PI / 2 - 0.35)
      seat.yaw = jumped ? targetYaw : seat.yaw + (targetYaw - seat.yaw) * Math.min(1, dt * 16)
      seat.rig.root.rotation.y = seat.yaw

      const anim = ANIMATION_MAP[f.moveId] ?? ANIMATION_MAP[M.IDLE]!
      const entries = entriesFor(anim, f.moveId, f, next.frame, frac)
      if (seat.key !== f.moveId) {
        const instant = REACTION_IDS.has(f.moveId) || seat.key < 0 || jumped
        seat.blendFrom = instant ? null : seat.lastEntries
        seat.blendT = 0
        seat.blendDur = instant ? 0 : BLEND_SECONDS
        seat.key = f.moveId
      }
      let use = entries
      if (seat.blendFrom && seat.blendT < seat.blendDur) {
        const b = seat.blendT / seat.blendDur
        const names = new Set(entries.map((e) => e.clip))
        if (!seat.blendFrom.some((e) => names.has(e.clip))) {
          use = [...seat.blendFrom.map((e) => ({ ...e, weight: 1 - b })), ...entries.map((e) => ({ ...e, weight: b }))]
        }
        seat.blendT += dt
      }
      seat.lastEntries = entries
      seat.rig.pose(use)

      const pr = f.projectile
      seat.orb.update(pr.on !== 0, pr.x / UNIT, (pr.y + 100) / UNIT, travelDirection(pr.vx, f.facing), this.clock)
    }

    const a0 = next.fighters[0]!
    const a1 = next.fighters[1]!
    const mid = (a0.pos.x + a1.pos.x) / 2
    const dist = Math.abs(a0.pos.x - a1.pos.x)
    let push = 0
    if (this.koFrames > 0) {
      push = 0.08 * Math.min(1, (45 - this.koFrames) / 8 + 0.2)
    }
    if (this.lastFrame >= 0 && jumped) this.rig.snap(mid, dist)
    this.rig.update(dt, mid, dist, push)

    this.stage?.update(dt, this.clock)
    this.vfx.update(dt)
    if (this.composer) this.composer.render(dt)
    else this.renderer.render(this.scene, this.rig.camera)
    this.lastRenderMs = performance.now() - t0
  }

  /** The latest HUD values (also delivered through onHud). */
  get hud(): HudSnapshot | null {
    return this.hudPending
  }

  /** True once the mount finished and frames can be rendered. */
  get isReady(): boolean {
    return this.seats.length === 2
  }

  /** Counts the moves in a state that have a clip mapping; used by the dev view. */
  static movesWithoutAnimation(): number[] {
    const out: number[] = []
    for (let id = 0; id < MOVES.length; id++) if (MOVES[id] && !ANIMATION_MAP[id]) out.push(id)
    return out
  }

  /** Phase helper for callers that show a round call during the intro. */
  static isFighting(s: FighterState): boolean {
    return s.phase === PHASE.FIGHT
  }

  dispose(): void {
    this.disposed = true
    for (const s of this.seats) {
      s.rig.dispose()
      s.orb.dispose()
    }
    this.vfx.dispose()
    this.stage?.dispose()
    this.composer?.dispose()
    this.renderer?.dispose()
    this.renderer?.domElement.remove()
    this.renderer = null
    this.seats = []
  }
}
