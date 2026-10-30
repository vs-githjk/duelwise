import {
  ACESFilmicToneMapping, Color, DirectionalLight, EquirectangularReflectionMapping, FogExp2, PCFShadowMap, PMREMGenerator, PointLight, Scene, SRGBColorSpace,
  Vector2, Vector3, WebGLRenderer, WebGLRenderTarget, type Texture,
} from 'three'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import { MAP_LIST, type MapData } from '@duelwise/core/src/games/arena/map.ts'
import { EV, PHASE, type ArenaState, type Player } from '@duelwise/core/src/games/arena/state.ts'
import { Audio3D, FootstepClock, stepsAudible } from './audio3d'
import { CameraRig, toScene, unitsToRad, type PendingTurn } from './camera'
import { buildMap, loadMapMaterials, type MapMaterials, type MapScene } from './map-mesh'
import { buildProps, fixturePlacements, loadPropKit, propPlacements, type PropKit } from './props'
import { loadOpponentAssets, Opponent } from './opponent'
import { ShotEffects, shotVisual } from './tracers'
import { spreadDegrees, Viewmodel, WeaponModels } from './viewmodel'

// The first person shooter renderer ("Coldstore"). It draws the match from the human seat's eyes and
// reads sim state only: the map is built from the same boxes the sim collides with, the weapon kicks
// and dips from sim fields (sinceShot, reload, recoilIdx), the crosshair spread is the sim's own
// formula, and shots, hits and footsteps come from the per-step event bits.

/** A sim event for renderers that are handed them explicitly; this renderer derives its own from Player.events. */
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

export interface ViewSnapshot {
  frame: number
  phase: number
  round: number
  /** Frames left in a live round. */
  timer: number
  wins: [number, number]
  health: number
  armor: number
  money: number
  weapon: number
  ammo: number
  /** Frames of reload left. */
  reload: number
  alive: boolean
  /** Crosshair half angle in degrees (the sim's spread). */
  spreadDeg: number
  /** Horizontal speed in units per second. */
  speed: number
  /** A hit you landed on this step, for the hit marker. */
  hit: null | 'hit' | 'head' | 'kill'
  /** A hit you took on this step: where the shooter is relative to your view in radians (0 ahead, positive right, pi behind). */
  damageFrom: number | null
  /** Your shot count this step (for sound and feed), 0 or 1. */
  fired: number
}

export interface ArenaRendererOptions {
  /** Which seat the camera follows. Default 0. */
  seat?: 0 | 1
  quality?: 'high' | 'low'
  onView?: (v: ViewSnapshot) => void
  /** Keep the drawing buffer so a screenshot or canvas read works at any time (tests and capture). */
  preserveDrawingBuffer?: boolean
  /** Synthesised positional sound. Call unlockAudio() from a user gesture to start it. */
  audio?: boolean
  /** Which map to build first (index into MAP_LIST). The renderer also follows ArenaState.mapIdx. Default 0. */
  mapIdx?: number
}

/** Muzzle offset from the eye in sim units: forward, right, down. */
const MUZZLE: [number, number, number] = [30, 7, 6]
const HDR_URL = '/assets/arena/polyhaven/empty_warehouse_01/empty_warehouse_01_1k.hdr'

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))

export class ArenaRenderer implements SimRenderer<ArenaState> {
  readonly label = 'stage' as const
  private renderer: WebGLRenderer | null = null
  private scene = new Scene()
  private rig = new CameraRig()
  private map: MapScene | null = null
  private mapIdx = 0
  private mats: MapMaterials | null = null
  private sun: DirectionalLight | null = null
  private reduced = false
  private effects = new ShotEffects()
  private models = new WeaponModels()
  private viewmodel: Viewmodel | null = null
  private opponent: Opponent | null = null
  private audio: Audio3D | null = null
  private env: Texture | null = null
  private oppFlash = new PointLight(0xffc27a, 0, 6, 2)
  private foot: [FootstepClock, FootstepClock] = [new FootstepClock(), new FootstepClock()]
  private lastFrame = -1
  private stepFrame = -1
  private lastRound = -1
  private lastNow = 0
  private pendingTurn: PendingTurn | undefined
  private propKit: PropKit | null = null
  private oppFlashFrames = 0
  private disposed = false
  private ready = false
  private hudPending: ViewSnapshot | null = null
  private tmp = new Vector3()
  /** Milliseconds the last render() call took on the CPU. */
  lastRenderMs = 0
  readonly opts: Required<Pick<ArenaRendererOptions, 'seat' | 'quality'>> & ArenaRendererOptions

  constructor(opts: ArenaRendererOptions = {}) {
    this.opts = { seat: 0, quality: 'high', ...opts }
    if (opts.audio !== false) this.audio = new Audio3D()
  }

  get canvas(): HTMLCanvasElement | null {
    return this.renderer?.domElement ?? null
  }

  get isReady(): boolean {
    return this.ready
  }

  /** Scene box meshes, for the dev view's map-versus-sim check. */
  get boxMeshes(): readonly import('three').Mesh[] {
    return this.map?.boxes ?? []
  }

  /** The sim map data the scene currently shows (null before mount). */
  get mapData(): MapData | null {
    return this.map ? MAP_LIST[this.mapIdx]! : null
  }

  /** Opponent barrel line miss distance from your eye (metres) and the aim's eye weight; null before the first aimed frame. */
  get barrel(): { miss: number; w: number; weapon: number } | null {
    return this.opponent?.barrel ?? null
  }

  get info(): { renderer: string; calls: number; triangles: number; decals: number } {
    const gl = this.renderer?.getContext()
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const name = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown'
    const i = this.renderer?.info.render
    return { renderer: name, calls: i?.calls ?? 0, triangles: i?.triangles ?? 0, decals: this.effects.activeDecals }
  }

  /** Call from a click or key press so the browser lets sound start. */
  unlockAudio(): void {
    this.audio?.unlock()
  }

  setVolume(v: number): void {
    this.audio?.setVolume(v)
  }

  setMuted(m: boolean): void {
    this.audio?.setMuted(m)
  }

  async mount(el: HTMLElement): Promise<void> {
    const high = this.opts.quality === 'high'
    const renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: this.opts.preserveDrawingBuffer ?? false,
    })
    renderer.outputColorSpace = SRGBColorSpace
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.2
    renderer.shadowMap.enabled = high
    renderer.shadowMap.type = PCFShadowMap
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    const w = Math.max(1, el.clientWidth)
    const h = Math.max(1, el.clientHeight)
    renderer.setSize(w, h, false)
    const cv = renderer.domElement
    cv.className = 'block size-full'
    cv.setAttribute('aria-label', 'Coldstore, first person view')
    el.appendChild(cv)
    this.renderer = renderer
    this.rig.resize(w, h)
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    this.rig.setReducedMotion(this.reduced)

    this.mapIdx = MAP_LIST[this.opts.mapIdx ?? 0] ? (this.opts.mapIdx ?? 0) : 0
    const map = MAP_LIST[this.mapIdx]!
    this.scene.background = new Color(0x080a0d)
    this.scene.fog = new FogExp2(0x0d1116, 0.016)
    this.map = buildMap(map)
    this.scene.add(this.map.group)
    this.scene.add(this.effects.group)
    this.scene.add(this.oppFlash)

    const sun = new DirectionalLight(0xbcd2ff, 1.5)
    sun.position.set(2, 9, 3)
    sun.castShadow = high
    sun.shadow.mapSize.set(2048, 2048)
    this.sun = sun
    this.fitShadow(map)
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.03
    sun.target.position.set(0, 0, 0)
    this.scene.add(sun, sun.target)

    const [mats, hdr, oppAssets] = await Promise.all([
      loadMapMaterials(),
      new HDRLoader().loadAsync(HDR_URL),
      loadOpponentAssets(),
      this.models.load(),
    ])
    if (this.disposed) return
    this.mats = mats
    this.map?.applyMaterials(mats)
    this.dress()
    void loadPropKit().then((kit) => {
      if (this.disposed) return
      this.propKit = kit
      this.dress()
    })
    hdr.mapping = EquirectangularReflectionMapping
    const pmrem = new PMREMGenerator(renderer)
    this.env = pmrem.fromEquirectangular(hdr).texture
    hdr.dispose()
    pmrem.dispose()
    this.scene.environment = this.env
    this.scene.environmentIntensity = 0.55

    this.opponent = new Opponent(oppAssets, this.models)
    this.scene.add(this.opponent.root)
    this.viewmodel = new Viewmodel(this.models)
    this.viewmodel.scene.environment = this.env
    this.viewmodel.scene.environmentIntensity = 0.55
    const vmKey = new DirectionalLight(0xdfe9ff, 1.4)
    vmKey.position.set(-0.4, 1, 0.6)
    this.viewmodel.scene.add(vmKey)
    this.viewmodel.resize(w, h)
    renderer.autoClear = false
    this.ready = true
  }

  private fitShadow(map: MapData): void {
    const cam = this.sun?.shadow.camera
    if (!cam) return
    const hw = ((map.bounds.x1 - map.bounds.x0) / 2) * 0.0254 + 1
    const hd = ((map.bounds.y1 - map.bounds.y0) / 2) * 0.0254 + 1
    Object.assign(cam, { left: -hw, right: hw, top: hd, bottom: -hd, near: 0.5, far: 24 })
    cam.updateProjectionMatrix()
  }

  /** Adds the set dressing (racks, crates, barrels, shutter doors, fixtures) to the current map once the props have loaded. */
  private dress(): void {
    if (!this.map || !this.propKit) return
    const map = MAP_LIST[this.mapIdx]!
    this.map.group.getObjectByName('coldstore-props')?.removeFromParent()
    this.map.group.add(buildProps([...propPlacements(map), ...fixturePlacements(map)], this.propKit))
  }

  /** Rebuilds the scene's map when the sim is on a different one than the scene shows. */
  private ensureMap(idx: number): void {
    if (!this.map || idx === this.mapIdx || !MAP_LIST[idx]) return
    this.scene.remove(this.map.group)
    this.map.dispose()
    const map = MAP_LIST[idx]!
    this.map = buildMap(map)
    if (this.mats) this.map.applyMaterials(this.mats)
    this.scene.add(this.map.group)
    this.mapIdx = idx
    this.dress()
    this.fitShadow(map)
    this.effects.clearDecals()
  }

  resize(w: number, h: number): void {
    if (!this.renderer) return
    this.renderer.setSize(w, h, false)
    this.rig.resize(w, h)
    this.viewmodel?.resize(w, h)
  }

  /**
   * Derives the effects of ONE sim step: tracers, impact decals, sparks, sounds, the hit marker and
   * the damage direction. The play loop calls this after every stepPacked because the sim clears
   * Player.events each step; render() calls it only for a frame it was not told about.
   */
  onStep(prev: ArenaState, next: ArenaState): void {
    this.stepFrame = next.frame
    const me = this.opts.seat
    this.ensureMap(next.mapIdx)
    const map = MAP_LIST[next.mapIdx]!
    if (next.round !== this.lastRound || (next.phase === PHASE.BUY && next.phaseFrame === 0)) {
      this.lastRound = next.round
      this.effects.clearDecals()
      this.foot[0].reset()
      this.foot[1].reset()
    }
    let hit: ViewSnapshot['hit'] = null
    let damageFrom: number | null = null
    let fired = 0
    for (const i of [0, 1] as const) {
      const cur = next.players[i]!
      const before = prev.players[i]!
      const other = next.players[1 - i]!
      const ev = cur.events
      const mine = i === me
      if (ev & EV.FIRED) {
        // The shot left before this step's recoil was added, so aim with the previous punch.
        const aimed: Player = { ...cur, punchPitch: before.punchPitch, punchYaw: before.punchYaw }
        const v = shotVisual(map, aimed, other, (ev & EV.HIT_DEALT) !== 0, MUZZLE)
        this.effects.tracer(v, mine)
        this.effects.impact(v)
        if (mine) {
          fired = 1
          this.audio?.play('shot', cur.weapon, null)
        } else {
          this.audio?.play('shot', cur.weapon, [v.from.x, v.from.y, v.from.z])
          this.oppFlashFrames = 3
          this.oppFlash.position.copy(v.from)
        }
        if (ev & EV.HIT_DEALT && mine) {
          hit = ev & EV.KILL ? 'kill' : ev & EV.HEADSHOT ? 'head' : 'hit'
          this.audio?.play(ev & EV.HEADSHOT ? 'headshot' : 'hit', cur.weapon, null)
        }
        if (mine && ev & EV.KILL && ev & EV.HEADSHOT) this.opponent?.noteHeadshotKill()
      } else if (ev & EV.HIT_DEALT && mine) {
        hit = ev & EV.KILL ? 'kill' : ev & EV.HEADSHOT ? 'head' : 'hit'
      }
      if (ev & EV.HIT_TAKEN && mine) {
        const bearing = Math.atan2(other.y - cur.y, other.x - cur.x)
        damageFrom = wrap(unitsToRad(cur.yaw) - bearing)
      }
      if (ev & EV.RELOAD) {
        if (mine) this.audio?.play('reload', cur.weapon, null)
        else this.audio?.play('reload', cur.weapon, toScene(cur.x, cur.y, cur.z + 40))
      }
      if (ev & EV.LANDED) {
        if (mine) this.audio?.play('land', cur.weapon, null, 0.6)
        else this.audio?.play('land', cur.weapon, toScene(cur.x, cur.y, cur.z))
      }
      const dist = Math.hypot(cur.x - before.x, cur.y - before.y)
      const steps = this.foot[i].advance(dist, stepsAudible(cur))
      for (let s = 0; s < steps; s++) {
        if (mine) this.audio?.play('step', cur.weapon, null, 0.35)
        else this.audio?.play('step', cur.weapon, toScene(cur.x, cur.y, cur.z + 4))
      }
      if (!mine) this.opponent?.onStep(cur)
      // Your own shot's hit reaction: the sim sets HEADSHOT on the shooter, never on the victim.
      else if (ev & EV.HIT_DEALT) this.opponent?.onHit((ev & EV.HEADSHOT) !== 0, other.alive === 1)
    }

    const p = next.players[me]!
    this.hudPending = {
      frame: next.frame,
      phase: next.phase,
      round: next.round,
      timer: next.timer,
      wins: [next.wins[0], next.wins[1]],
      health: p.health,
      armor: p.armor,
      money: p.money,
      weapon: p.weapon,
      ammo: p.ammo,
      reload: p.reload,
      alive: p.alive === 1,
      spreadDeg: spreadDegrees(p),
      speed: Math.hypot(p.vx, p.vy),
      hit,
      damageFrom,
      fired,
    }
    this.opts.onView?.(this.hudPending)
  }

  /** The mouse turn not yet taken by the sim (ArenaInputSampler.pendingTurn), set by the page before each render. Null for a view that is not the player's. */
  setPendingTurn(t: PendingTurn | null): void {
    this.pendingTurn = t ?? undefined
  }

  render(prev: ArenaState, next: ArenaState, alpha: number, _events: SimEvent[] = []): void {
    if (!this.renderer || !this.ready || this.disposed || !this.viewmodel || !this.opponent) return
    const t0 = performance.now()
    const dt = this.lastNow === 0 ? 1 / 60 : Math.min(0.1, (t0 - this.lastNow) / 1000)
    this.lastNow = t0

    const jumped = this.lastFrame < 0 || next.frame < this.lastFrame || next.frame - this.lastFrame > 4
    if (next.frame !== this.stepFrame) this.onStep(prev, next)
    this.lastFrame = next.frame
    const advanced = prev.frame === next.frame - 1
    const a = advanced ? Math.min(1, Math.max(0, alpha)) : 1
    const me = this.opts.seat
    const pm = prev.players[me]!
    const nm = next.players[me]!
    const po = prev.players[1 - me]!
    const no = next.players[1 - me]!

    if (jumped) this.rig.snap(nm)
    // The mouse turn the sim has not taken yet counts only while the sim would take it (alive, not in the round-end freeze).
    const pending = nm.alive === 1 && next.phase !== PHASE.ROUND_END ? this.pendingTurn : undefined
    this.rig.update(dt, advanced ? pm : nm, nm, a, pending)
    this.opponent.update(dt, advanced ? po : no, no, a, jumped, this.tmp.set(this.rig.pose.x, this.rig.pose.y, this.rig.pose.z))
    this.viewmodel.update(dt, nm, next.phase === PHASE.BUY ? next.phaseFrame : 99, this.reduced)
    this.effects.update(dt)
    if (this.oppFlashFrames > 0) {
      this.oppFlashFrames -= dt * 60
      this.oppFlash.intensity = this.oppFlashFrames > 0 ? 8 : 0
    }
    const p = this.rig.pose
    this.audio?.setListener(p.x, p.y, p.z, p.yaw)

    const r = this.renderer
    r.clear()
    r.render(this.scene, this.rig.camera)
    r.clearDepth()
    r.render(this.viewmodel.scene, this.viewmodel.camera)
    this.lastRenderMs = performance.now() - t0
  }

  /**
   * Test probe: how much of the opponent's torso (shoulders to pelvis, in screen space) the first person weapon
   * and hands cover. Renders the viewmodel scene alone into a render target and counts opaque pixels inside the
   * torso rectangle. Null before the first frame or when the torso is off screen.
   */
  viewmodelTorsoCoverage(): { rect: [number, number, number, number]; torsoPixels: number; coveredPixels: number } | null {
    const r = this.renderer
    const pts = this.opponent?.torsoPoints() ?? []
    if (!r || !this.viewmodel || pts.length === 0) return null
    const size = r.getSize(new Vector2())
    const w = Math.round(size.x)
    const h = Math.round(size.y)
    // The opponent is drawn by the world camera, so project the torso with it (not the narrower viewmodel field of view).
    this.rig.camera.updateMatrixWorld(true)
    const ndc = pts.map((p) => p.clone().project(this.rig.camera))
    const x0 = Math.max(0, Math.floor(((Math.min(...ndc.map((v) => v.x)) + 1) / 2) * w))
    const x1 = Math.min(w - 1, Math.ceil(((Math.max(...ndc.map((v) => v.x)) + 1) / 2) * w))
    const y0 = Math.max(0, Math.floor(((1 - Math.max(...ndc.map((v) => v.y))) / 2) * h))
    const y1 = Math.min(h - 1, Math.ceil(((1 - Math.min(...ndc.map((v) => v.y))) / 2) * h))
    if (x1 <= x0 || y1 <= y0) return null
    const rt = new WebGLRenderTarget(w, h)
    const prevColor = r.getClearColor(new Color())
    const prevAlpha = r.getClearAlpha()
    r.setRenderTarget(rt)
    r.setClearColor(0x000000, 0)
    r.clear()
    r.render(this.viewmodel.scene, this.viewmodel.camera)
    const px = new Uint8Array(w * h * 4)
    r.readRenderTargetPixels(rt, 0, 0, w, h, px)
    r.setRenderTarget(null)
    r.setClearColor(prevColor, prevAlpha)
    rt.dispose()
    let covered = 0
    for (let y = y0; y <= y1; y++) {
      const row = (h - 1 - y) * w
      for (let x = x0; x <= x1; x++) if (px[(row + x) * 4 + 3]! > 8) covered++
    }
    return { rect: [x0, y0, x1, y1], torsoPixels: (x1 - x0 + 1) * (y1 - y0 + 1), coveredPixels: covered }
  }

  /** The latest snapshot (also delivered through onView). */
  get view(): ViewSnapshot | null {
    return this.hudPending
  }

  dispose(): void {
    this.disposed = true
    this.audio?.dispose()
    this.effects.dispose()
    this.map?.dispose()
    this.opponent?.dispose()
    this.viewmodel?.dispose()
    this.env?.dispose()
    this.renderer?.dispose()
    this.renderer?.domElement.remove()
    this.renderer = null
  }
}
