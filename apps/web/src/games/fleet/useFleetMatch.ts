import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SHIPS, fleetCore, type FleetObs, type FleetState, type Placement } from '@duelwise/core/src/games/fleet'
import type { Level } from '@duelwise/core/src/product'
import type { Seat } from '@duelwise/core/src/types'
import type { PreviewAgent } from '@duelwise/agents/src/agent-types'
import { createGameAgent } from '@duelwise/agents/src/fleet/agent'
import { coord } from './fleet-match'
import { recordTrainingAllowed } from '../../lib/honest-copy'
import { openMatch } from '../../lib/open-match'
import { detectDevice, useMatchRecorder, type FinishedMatch, type Upload } from '../../lib/match-recorder'
import { serverFetchTurn, TurnRefused, type FetchTurn, type FleetTurnReply } from './api'

export type Phase = 'setup' | 'starting' | 'play' | 'over'

const HUMAN: Seat = 0
const AGENT: Seat = 1
const SHOT_BASE = 200

/** What the page says when the server could not be reached for a request; never the server's own wording. */
export const SETUP_FAILED = 'The match could not start. Check your connection and press Start match again.'
/** The line after a shot whose reply never came; it names the square so the player knows which shot Fire will send. */
export const shotFailed = (cell: number): string => `Shot at ${coord(cell)} not sent. Press Fire to send it again.`
export const MATCH_ENDED = 'This match has ended. Place your fleet to start a new one.'

/** What the page shows. In a counted match `view` is only what the server sent: my fleet, my shots, theirs at me, ships already sunk. */
export interface FleetSnapshot {
  phase: Phase
  level: Level
  view: FleetObs | null
  /** True while the opponent's answer is on its way or being held back. */
  thinking: boolean
  resigned: boolean
  failure: string | null
  /** The square of a shot whose reply was lost: it stays aimed and locked, because Fire can only send that shot again. Null when none is waiting. */
  unsentCell: number | null
  /** True from the moment the server's final reply is in: the match is over and being settled, so Resign is gone and does nothing. */
  ending: boolean
  /** True when the server holds the enemy fleet (a counted match). */
  sealed: boolean
}

const INITIAL: FleetSnapshot = { phase: 'setup', level: 'easy', view: null, thinking: false, resigned: false, failure: null, unsentCell: null, ending: false, sealed: false }

/** The five setup actions, in ship order, as the server and the record expect them. */
export function setupCodes(fleet: Placement[]): number[] {
  if (fleet.length !== SHIPS.length) throw new Error('fleet: the fleet is not valid')
  return [...fleet].sort((a, b) => a.id - b.id).map((p) => fleetCore.encodeAction({ kind: 'place', cell: p.cell, vertical: p.vertical }))
}

export const shotCode = (cell: number): number => SHOT_BASE + cell

/**
 * Rebuilds the record's actions from the two action lists a finished counted match yields, by playing them through the real
 * core. Throws when the lists do not make exactly one finished game (an action left over, one missing, or an illegal one).
 */
export function recordFromLists(seed: number, human: number[], agent: number[]): { actions: Array<[number, Seat, number]>; state: FleetState } {
  let s = fleetCore.init(seed)
  const actions: Array<[number, Seat, number]> = []
  let hi = 0
  let ai = 0
  let tick = 0
  while (!fleetCore.terminal(s)) {
    const toAct = fleetCore.toAct(s)
    const step: [unknown, unknown] = [null, null]
    for (const seat of [HUMAN, AGENT] as Seat[]) {
      if (!toAct.includes(seat)) continue
      const n = seat === HUMAN ? human[hi++] : agent[ai++]
      if (n === undefined) throw new Error('The server sent a match that does not add up.')
      const chosen = fleetCore.legal(s, seat).find((l) => fleetCore.encodeAction(l) === n)
      if (!chosen) throw new Error('The server sent a match that does not add up.')
      step[seat] = chosen
      actions.push([tick, seat, n])
    }
    s = fleetCore.step(s, step as never)
    tick++
  }
  if (hi !== human.length || ai !== agent.length) throw new Error('The server sent a match that does not add up.')
  return { actions, state: s }
}

/** The part of the match recorder the engine uses; `useMatchRecorder` provides it and a test can stand in. */
export interface RecorderPort {
  begin(level: Level, devSeed?: number): Promise<import('../../lib/match-recorder').Session>
  start(init: Parameters<ReturnType<typeof useMatchRecorder>['start']>[0]): void
  act(tick: number, seat: Seat, action: number, humanInputMs?: number): void
  reach(tick: number): void
  setSeed(seed: number): void
  finish(core: typeof fleetCore, state: unknown): Promise<FinishedMatch>
  resign(tick?: number): Promise<void>
  /** Forgets a counted match that never really began (its setup request failed), with no loss and no call to the server. */
  discard(): void
}

export interface EngineDeps {
  recorder: () => RecorderPort
  fetchTurn: FetchTurn
  createAgent?: (level: Level) => Promise<PreviewAgent>
  agentVersion?: (level: Level) => string
  trainingAllowed?: boolean
  /** How long the opponent's shot is held back, in ms. */
  hold?: number
  sleep?: (ms: number) => Promise<void>
  /** Resolves once the screen has painted what was just set; the default waits for a frame and a timer, and never longer than 100 ms (a hidden tab paints nothing). */
  nextPaint?: () => Promise<void>
  input?: 'keyboard' | 'touch' | 'mouse'
  onChange: (s: FleetSnapshot) => void
}

export interface FleetEngine {
  snapshot(): FleetSnapshot
  /** Starts a match with my fleet. A `forcedSeed` makes an unrated match played on this page's own core. */
  start(level: Level, fleet: Placement[], forcedSeed?: number): Promise<void>
  /** Returns a message when the shot is refused, otherwise null. */
  fire(cell: number): Promise<string | null>
  resign(): Promise<void>
  backToSetup(): void
  dispose(): void
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Owns one Stormglass match without React, so a test can drive it. In a counted match the browser sends only my own
 * actions and keeps only the view the server returns: the enemy fleet, the seed and the opponent's actions stay on the
 * server until the match is over, and the record is written from them then. An unrated match (fixed test seed, server
 * unreachable) plays on the local core with a local opponent.
 */
/** After the browser has painted what was just set: a frame, then a timer; a page that cannot paint (hidden tab, no animation frames) waits at most 100 ms. */
function defaultNextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => resolve()
    requestAnimationFrame(() => setTimeout(done, 0))
    setTimeout(done, 100)
  })
}

export function createFleetEngine(deps: EngineDeps): FleetEngine {
  const hold = deps.hold ?? 700
  const sleep = deps.sleep ?? wait
  const nextPaint = deps.nextPaint ?? defaultNextPaint
  const makeAgent = deps.createAgent ?? ((level: Level) => createGameAgent(level, { seat: AGENT }))
  const versionOf = deps.agentVersion ?? (() => 'preview')
  let snap: FleetSnapshot = INITIAL
  let epoch = 0
  let busy = false
  let agent: PreviewAgent | null = null
  /** The local core state of an unrated match; null in a counted match. */
  let local: FleetState | null = null
  let matchId: string | null = null
  /** My actions so far in a counted match: five placements, then one code per shot. */
  let human: number[] = []
  let humanMs: number[] = []
  /** The request whose reply never came (both tries failed): the server may have stored its shot, so the next fire sends exactly this list again. */
  let unsent: { list: number[]; ms: number } | null = null
  let roundStart = 0

  const set = (patch: Partial<FleetSnapshot>) => {
    snap = { ...snap, ...patch }
    deps.onChange(snap)
  }
  const rec = () => deps.recorder()
  const stepsPlayed = (v: FleetObs) => SHIPS.length + v.shots.length + v.incoming.length

  function clearMatch() {
    agent?.dispose()
    agent = null
    local = null
    matchId = null
    human = []
    humanMs = []
    unsent = null
    snap = { ...snap, unsentCell: null, ending: false }
  }

  /** One request, tried twice: the server answers an identical request with the same reply, so a repeat is safe. */
  async function turn(list: number[]): Promise<FleetTurnReply> {
    try {
      return await deps.fetchTurn(matchId!, list)
    } catch (e) {
      // A refusal is final: the same request would get the same answer.
      if (e instanceof TurnRefused) throw e
      return await deps.fetchTurn(matchId!, list)
    }
  }

  /** The record of a counted match that has just ended: built from what the server revealed and handed to the recorder. The screen is not touched here. */
  async function recordCounted(reply: FleetTurnReply) {
    if (!reply.reveal) throw new Error('The server did not finish the match.')
    const { seed, agentActions } = reply.reveal
    const built = recordFromLists(seed, human, agentActions)
    rec().setSeed(seed)
    let shotIx = 0
    for (const [tick, seat, code] of built.actions) {
      const isShot = seat === HUMAN && tick >= SHIPS.length
      rec().act(tick, seat, code, isShot ? humanMs[shotIx++] : undefined)
    }
    await rec().finish(fleetCore, built.state)
  }

  /** The opponent shoots on the local core until it is my turn or the game ends (unrated only). */
  async function agentShots(mine: number) {
    while (local && !fleetCore.terminal(local) && fleetCore.toAct(local)[0] === AGENT) {
      set({ thinking: true })
      if (hold > 0) await sleep(hold)
      if (mine !== epoch || !agent || !local) return
      const [code] = await agent.act(fleetCore.observe(local, AGENT), local)
      if (mine !== epoch || !local) return
      const tick = stepsPlayed(fleetCore.observe(local, HUMAN))
      const action = fleetCore.decodeAction(code!)
      local = fleetCore.step(local, [null, action])
      rec().act(tick, AGENT, code!)
      set({ view: fleetCore.observe(local, HUMAN) })
    }
    if (local && fleetCore.terminal(local)) {
      await rec().finish(fleetCore, local)
      set({ phase: 'over', thinking: false, view: fleetCore.observe(local, HUMAN) })
    } else {
      set({ thinking: false })
    }
  }

  return {
    snapshot: () => snap,

    async start(level, fleet, forcedSeed) {
      const mine = ++epoch
      clearMatch()
      const codes = setupCodes(fleet)
      set({ ...INITIAL, phase: 'starting', level })
      let opened
      try {
        // The opponent is made before the server row exists, so one that fails to start never leaves a 'started' match behind.
        opened = await openMatch({ create: () => makeAgent(level), begin: () => rec().begin(level, forcedSeed), isCurrent: () => mine === epoch })
      } catch (e) {
        if (mine === epoch) set({ phase: 'setup', failure: e instanceof Error ? e.message : 'The match could not start.' })
        return
      }
      if (opened.kind === 'stale') return
      if (opened.kind === 'agent-failed') {
        set({ phase: 'setup', failure: opened.error instanceof Error ? opened.error.message : 'The opponent could not start.' })
        return
      }
      const session = opened.session
      const sealed = session.sealed === true && session.matchId !== undefined
      const seed = sealed ? 0 : session.seed
      const init = {
        seed,
        humanSeat: HUMAN,
        agent: { version: session.agentVersion ?? versionOf(level), level },
        trainingAllowed: deps.trainingAllowed ?? false,
        ...(deps.input ? { input: deps.input } : {}),
      }
      try {
        if (sealed) {
          // A counted match: the opponent lives on the server. My five placements are the first and only setup request.
          opened.agent.dispose()
          matchId = session.matchId!
          human = codes
          rec().start(init)
          let reply: FleetTurnReply
          try {
            reply = await turn(codes)
          } catch {
            throw new Error(SETUP_FAILED)
          }
          if (mine !== epoch) return
          if (reply.over || reply.view.phase !== 'play') throw new Error('The server answered the setup with a match that is not ready.')
          rec().reach(SHIPS.length)
          roundStart = performance.now()
          set({ phase: 'play', view: reply.view, sealed: true, thinking: false })
          return
        }
        agent = opened.agent
        agent.reset(session.seed)
        let st = fleetCore.init(session.seed)
        rec().start(init)
        for (let i = 0; i < codes.length; i++) {
          const [code] = await agent.act(fleetCore.observe(st, AGENT), st)
          st = fleetCore.step(st, [fleetCore.decodeAction(codes[i]!), fleetCore.decodeAction(code!)])
          rec().act(i, HUMAN, codes[i]!)
          rec().act(i, AGENT, code!)
          if (mine !== epoch) return
        }
        local = st
        roundStart = performance.now()
        set({ phase: 'play', view: fleetCore.observe(st, HUMAN), sealed: false, thinking: false })
        await agentShots(mine)
      } catch (e) {
        if (mine !== epoch) return
        // The row (if any) is closed by the leave beacon or the server's abandon rule, never kept open by this page.
        clearMatch()
        // Nothing was played: the recorder must not keep the row live (leaving would resign it) or the page marked as in a match.
        rec().discard()
        set({ phase: 'setup', view: null, failure: e instanceof Error ? e.message : 'The match could not start.' })
      }
    },

    async fire(cell) {
      const view = snap.view
      if (snap.phase !== 'play' || !view || busy || snap.thinking) return null
      if (!Number.isInteger(cell) || cell < 0 || cell >= 100) return 'Pick a square on the grid'
      if (view.shots.some((s) => s.cell === cell)) return 'You already fired there'
      const mine = epoch
      busy = true
      // A resend of a lost request is the same list whatever cell was tapped now: the server may already hold that shot.
      const pending = matchId ? unsent : null
      const ms = pending?.ms ?? performance.now() - roundStart
      try {
        if (snap.failure) set({ failure: null, unsentCell: null })
        if (matchId) {
          const list = pending?.list ?? [...human, shotCode(cell)]
          set({ thinking: true })
          let reply: FleetTurnReply
          try {
            reply = await turn(list)
          } catch (e) {
            if (mine !== epoch) return null
            if (e instanceof TurnRefused) {
              // The server settled this match (abandoned, over its cap): resending can never work. It closed the row itself, so no beacon is needed.
              clearMatch()
              rec().discard()
              set({ phase: 'setup', view: null, thinking: false, failure: MATCH_ENDED })
              return null
            }
            if (mine === epoch) {
              unsent = { list, ms }
              set({ failure: shotFailed(list[list.length - 1]! - SHOT_BASE), unsentCell: list[list.length - 1]! - SHOT_BASE, thinking: false })
            }
            return null
          }
          if (mine !== epoch) return null
          unsent = null
          if (snap.unsentCell !== null) set({ unsentCell: null })
          human = list
          humanMs.push(ms)
          if (reply.over) {
            // The last reply puts the final board on screen first, with Fire still off: the record work below (replay, hash) takes longer than a frame and must not hold the sink
            // or the killing shot back. The reveal stays out of the view until the match is settled.
            const heldAt = performance.now()
            if (!reply.reveal) throw new Error('The server did not finish the match.')
            const before = view.incoming.length
            const interim = { ...reply.view, phase: 'play' as const, reveal: null }
            // A loss: my last shot lands first, the opponent's killing shot after the same hold as on every other turn.
            const killing = hold > 0 && reply.view.incoming.length > before
            set({ ending: true, view: killing ? { ...interim, incoming: reply.view.incoming.slice(0, before) } : interim })
            await nextPaint()
            // Resign, a rematch or leaving the page meanwhile has settled the match; settling it again here would record it twice.
            if (mine !== epoch) return null
            await recordCounted(reply)
            if (mine !== epoch) return null
            if (killing) {
              await sleep(Math.max(0, hold - (performance.now() - heldAt)))
              if (mine !== epoch) return null
            }
            set({ phase: 'over', view: reply.view, thinking: false })
            return null
          }
          rec().reach(stepsPlayed(reply.view))
          // The server has already played the opponent's answer; it appears after the same hold a local opponent would take.
          const before = view.incoming.length
          if (hold > 0 && reply.view.incoming.length > before) {
            set({ view: { ...reply.view, incoming: reply.view.incoming.slice(0, before) } })
            await sleep(hold)
            if (mine !== epoch) return null
          }
          roundStart = performance.now()
          set({ view: reply.view, thinking: false })
          return null
        }
        if (!local || !agent) return null
        const tick = stepsPlayed(view)
        local = fleetCore.step(local, [{ kind: 'shot', cell }, null])
        rec().act(tick, HUMAN, shotCode(cell), ms)
        set({ view: fleetCore.observe(local, HUMAN) })
        if (fleetCore.terminal(local)) {
          await rec().finish(fleetCore, local)
          set({ phase: 'over', thinking: false })
          return null
        }
        await agentShots(mine)
        roundStart = performance.now()
        return null
      } catch (e) {
        if (mine === epoch) set({ failure: e instanceof Error ? e.message : 'Something went wrong.', thinking: false })
        return null
      } finally {
        busy = false
      }
    },

    async resign() {
      // Once the final reply is in the match is over and being recorded: a resignation now would settle it twice or lose the record.
      if (snap.phase !== 'play' || snap.ending) return
      const tick = snap.view ? stepsPlayed(snap.view) : 0
      epoch++
      set({ phase: 'over', resigned: true, thinking: false, failure: null, unsentCell: null })
      await rec().resign(tick)
      clearMatch()
    },

    backToSetup() {
      epoch++
      clearMatch()
      set({ ...INITIAL, level: snap.level })
    },

    dispose() {
      epoch++
      clearMatch()
    },
  }
}

export interface FleetMatch extends FleetSnapshot {
  finished: FinishedMatch | null
  upload: Upload
  /** Why the current match is not counted, or null when it is. */
  unratedReason: string | null
  /** True while a counted match is live: leaving the page resigns it. */
  counted: boolean
  start: (level: Level, fleet: Placement[], forcedSeed?: number) => Promise<void>
  fire: (cell: number) => Promise<string | null>
  resign: () => Promise<void>
  backToSetup: () => void
}

/**
 * The React side of the engine. `agentVersion` names the strength the record carries when the server did not; `hold` is the pause
 * before the opponent's shot lands (0 in tests).
 */
export function useFleetMatch(opts: { agentVersion?: (level: Level) => string; hold?: number; learnsFromHumans?: boolean; fetchTurn?: FetchTurn } = {}): FleetMatch {
  const recorder = useMatchRecorder('fleet')
  const latest = useRef(recorder)
  latest.current = recorder
  const [snap, setSnap] = useState<FleetSnapshot>(INITIAL)
  const engine = useMemo(
    () =>
      createFleetEngine({
        recorder: () => latest.current as unknown as RecorderPort,
        fetchTurn: opts.fetchTurn ?? serverFetchTurn,
        ...(opts.agentVersion ? { agentVersion: opts.agentVersion } : {}),
        ...(opts.hold !== undefined ? { hold: opts.hold } : {}),
        trainingAllowed: recordTrainingAllowed('fleet', { learnsFromHumans: opts.learnsFromHumans === true }),
        input: detectDevice() === 'desktop' ? 'keyboard' : 'touch',
        onChange: setSnap,
      }),
    // The options are read once per page; a page that changes them remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  useEffect(() => () => engine.dispose(), [engine])
  const start = useCallback((level: Level, fleet: Placement[], forcedSeed?: number) => engine.start(level, fleet, forcedSeed), [engine])
  return {
    ...snap,
    finished: recorder.finished,
    upload: recorder.upload,
    unratedReason: recorder.unratedReason,
    counted: recorder.counted,
    start,
    fire: engine.fire,
    resign: engine.resign,
    backToSetup: engine.backToSetup,
  }
}
