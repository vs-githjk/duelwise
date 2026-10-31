import { useCallback, useEffect, useRef, useState } from 'react'
import type { FinishBody, StartBody } from '../server/match-handlers'
import type { MatchRecordV1 } from '@duelwise/core/src/match-record'
import { encodeRecordAsync } from '@duelwise/core/src/match-record'
import { PRODUCT, type GameId, type Level } from '@duelwise/core/src/product'
import { replay } from '@duelwise/core/src/replay'
import type { GameCore, Seat } from '@duelwise/core/src/types'
import { enqueueUpload, drainUploads, uploadStore, QUEUE_EVENT, type UploadOutcome } from './upload-queue'
import { notePlayed, refillTickets, settleConsumed, takeLocalTicket, type Ticket, type TicketOwner } from './tickets'
import { recordOffline, tallyLine } from './offline-record'
import { requestWakeDrain } from './pwa'
import { takeCall } from './progress'
import { isOffline, subscribeConnection } from './connection'
import { setMatchActive } from './match-active'
import { beaconFinish, beaconResign, clearPending, postResign, retryPending, savePending, type ResignReply } from './integrity'

export interface RecorderInit {
  game: GameId
  matchId: string
  seed: number
  humanSeat: Seat
  agent: { version: string; level: Level }
  trainingAllowed: boolean
  device: MatchRecordV1['device']
  input: MatchRecordV1['input']
  /** Test hook for the clock. */
  now?: () => Date
}

export interface FinishedMatch {
  record: MatchRecordV1
  /** gzip bytes ready for upload. */
  bytes: Uint8Array
  /** True when replaying the record from its seed reproduces the played result and final hash. */
  ok: boolean
  error?: string
}

export interface MatchRecorder {
  /** Turn games: tick is the step index. Realtime: the frame; repeated inputs are dropped. */
  recordAction(tick: number, seat: Seat, action: number, humanInputMs?: number): void
  finish(core: GameCore<any, any, any>, finalState: unknown): Promise<FinishedMatch>
  /** Sets the seed of a sealed match once the server reveals it at the end; call before `finish`. */
  setSeed(seed: number): void
  readonly actionCount: number
}

/**
 * Builds a MatchRecordV1 while a match is played and proves it with replay() before it is handed
 * on. Pure (no React), so tests and non-React callers can use it; `useMatchRecorder` wraps it.
 */
export function createMatchRecorder(init: RecorderInit): MatchRecorder {
  const now = init.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const realtime = PRODUCT.games[init.game].kind === 'realtime'
  const actions: MatchRecordV1['actions'] = []
  const humanTimes: number[] = []
  const last: [number | null, number | null] = [null, null]
  let done = false
  let seed = init.seed

  return {
    setSeed(next) {
      if (done) throw new Error('recorder: match already finished')
      seed = next
    },
    recordAction(tick, seat, action, humanInputMs) {
      if (done) throw new Error('recorder: match already finished')
      if (realtime) {
        if (last[seat] === action) return
        last[seat] = action
      }
      actions.push([tick, seat, action])
      if (humanInputMs !== undefined && seat === init.humanSeat && Number.isFinite(humanInputMs)) humanTimes.push(humanInputMs)
    },
    get actionCount() {
      return actions.length
    },
    async finish(core, finalState) {
      if (done) throw new Error('recorder: match already finished')
      if (!core.terminal(finalState)) throw new Error('recorder: game not finished')
      const result = core.result(finalState)
      if (!result) throw new Error('recorder: terminal state has no result')
      done = true
      const record: MatchRecordV1 = {
        schema: 1,
        matchId: init.matchId,
        game: init.game,
        coreVersion: core.version,
        agent: init.agent,
        seed,
        humanSeat: init.humanSeat,
        actions,
        ...(humanTimes.length > 0 ? { humanInputTimesMs: humanTimes } : {}),
        result,
        finalHash: core.hash(finalState),
        startedAt,
        endedAt: now().toISOString(),
        device: init.device,
        input: init.input,
        trainingAllowed: init.trainingAllowed,
      }
      const check = replay(record, { core })
      return { record, bytes: await encodeRecordAsync(record), ok: check.ok, error: check.error }
    },
  }
}

/** The two server calls a counted match makes. Injected so tests and other callers need no network. */
export interface MatchApi {
  start(input: { game: GameId; level: Level; call?: Level }): Promise<StartBody>
  finish(bytes: Uint8Array): Promise<FinishBody>
  /** Gives up a counted match; the server scores it as a loss. */
  resign?(matchId: string, tick: number): Promise<ResignReply>
}

/** Where a match stands with the server. */
export type Upload =
  | { status: 'none' }
  | { status: 'uploading'; matchId?: string }
  /** `matchId` is the counted match, which is also the id of its report page. */
  | { status: 'counted'; matchId?: string; elo?: { before: number; after: number }; provisional?: boolean }
  | { status: 'rejected'; reason: string }
  /** `kind: 'resign'` marks a failed give-up call; otherwise the finished record could not be uploaded. */
  | { status: 'failed'; message: string; kind?: 'resign' }
  /** An offline match saved on this device; it is uploaded and checked when the connection is back. */
  | { status: 'queued'; matchId: string }
  /** A queued match the server has now settled (its report page has the outcome). */
  | { status: 'synced'; matchId: string }
  /** A queued match the server answered but did not count (its slot expired, the opponent was updated, ...); `reason` says why. */
  | { status: 'not-counted'; matchId: string; reason: string }

export interface Session {
  seed: number
  /** Set only for a counted match: the server issued this seed and will check the record against it. */
  matchId?: string
  agentVersion?: string
  rated: boolean
  /** True when the server withheld the seed (Word Duel): `seed` is 0 and must not be used for the game. */
  sealed?: boolean
  /** Why the match is not counted, when it is not. */
  unratedReason?: string
  /** True when the match runs on an offline ticket: counted later, when its record can be uploaded. */
  offline?: boolean
  /** Who the offline ticket was issued to; the queued record carries it so only that player's page sends it. */
  owner?: TicketOwner
}

const randomLocalSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!

/**
 * The seed for a new match, on every page. A counted match takes its seed from the server (startMatch),
 * so a player cannot choose the position. `devSeed` (the ?seed query) makes an unrated match for tests
 * and bug reports; if the server cannot be reached the match still plays, unrated, and says so.
 */
export async function beginSession(
  api: MatchApi,
  game: GameId,
  level: Level,
  devSeed?: number,
  takeTicket: (game: GameId, level: Level) => Promise<Ticket | null> = takeLocalTicket,
  call?: Level,
): Promise<Session> {
  if (devSeed !== undefined) return { seed: devSeed, rated: false, unratedReason: 'This match used a fixed test seed, so it is not counted.' }
  try {
    const s = await api.start({ game, level, ...(call ? { call } : {}) })
    if (typeof s.matchId !== 'string' || typeof s.seed !== 'number') throw new Error('bad reply')
    return { seed: s.seed, matchId: s.matchId, agentVersion: s.agentVersion, rated: true, ...(s.sealed === true ? { sealed: true } : {}) }
  } catch {
    // No server: a ticket issued earlier (while online) keeps the match counted, once its record uploads.
    const ticket = await takeTicket(game, level).catch(() => null)
    if (ticket) return { seed: ticket.seed, matchId: ticket.matchId, agentVersion: ticket.agentVersion, rated: true, offline: true, owner: ticket.owner }
    return { seed: randomLocalSeed(), rated: false, unratedReason: offlineReason(game) }
  }
}

const offlineNow = isOffline

/** The calm line that says why an unrated match is unrated when the server was not reached. */
export function offlineReason(game: GameId): string {
  if (game === 'word') return offlineNow() ? 'You are offline, so this Word Duel is unranked. It counts on your record on this device only.' : 'The server could not be reached, so this match is not counted.'
  return offlineNow() ? 'You are offline and have no saved match slots left, so this match is not counted. Open the game once while online to get more.' : 'The server could not be reached, so this match is not counted.'
}

/**
 * Sends the record to the server (one retry on a network error) and reports what it made of it. A record
 * that failed the client replay is sent too: the server stores it as finished and invalid, which settles
 * the match without a rating instead of leaving the row 'started' for the abandon rule to score as a loss.
 */
export async function uploadMatch(api: MatchApi, finished: FinishedMatch): Promise<Upload> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await api.finish(finished.bytes)
      if (r.valid) return { status: 'counted', matchId: finished.record.matchId, elo: r.elo, provisional: r.provisional }
      return { status: 'rejected', reason: r.reason ?? finished.error ?? 'The server could not verify this match.' }
    } catch (e) {
      if (attempt >= 1) return { status: 'failed', message: e instanceof Error ? e.message : 'Upload failed.' }
    }
  }
}

/** The real calls: the two server functions, loaded on first use so this file stays free of server code. */
export const serverApi: MatchApi = {
  async start(input) {
    const { startMatch } = await import('../server/matches')
    const r = (await startMatch({ data: input })) as StartBody | { error: string }
    if ('error' in r) throw new Error(r.error)
    return r
  },
  async finish(bytes) {
    const { finishMatch } = await import('../server/matches')
    const form = new FormData()
    form.append('record', new Blob([bytes as BlobPart], { type: 'application/gzip' }), 'record.json.gz')
    const r = (await finishMatch({ data: form })) as FinishBody | { error: string }
    if ('error' in r) throw new Error(r.error)
    return r
  },
  resign: postResign,
}

/** Phone, tablet or desktop from the viewport and pointer. Defaults to desktop outside a browser. */
export function detectDevice(): MatchRecordV1['device'] {
  if (typeof window === 'undefined') return 'desktop'
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const w = Math.min(window.innerWidth, window.innerHeight)
  if (coarse && w < 600) return 'phone'
  if (coarse) return 'tablet'
  return 'desktop'
}

export type MatchStatus = 'idle' | 'playing' | 'finished'

/**
 * React wrapper: `start` opens a recorder, `act` records a move, `finish` replays and returns the
 * record. The page owns the game state; this hook only observes it. T22 adds the upload.
 */
export function useMatchRecorder(game: GameId, api: MatchApi = serverApi) {
  const recorder = useRef<MatchRecorder | null>(null)
  const session = useRef<Session | null>(null)
  const [status, setStatus] = useState<MatchStatus>('idle')
  const [finished, setFinished] = useState<FinishedMatch | null>(null)
  const [upload, setUpload] = useState<Upload>({ status: 'none' })
  const [unratedReason, setUnratedReason] = useState<string | null>(null)
  /** True while a counted match is live, so the page can say that leaving it resigns. */
  const [counted, setCounted] = useState(false)
  /** The counted match in progress and the latest tick, so a closing tab can resign it. Null otherwise. */
  const live = useRef<{ matchId: string; tick: number } | null>(null)
  /** The record of a finished counted match until the server answers, so a closing tab can still deliver it. */
  const pending = useRef<{ matchId: string; bytes: Uint8Array } | null>(null)
  /** A finished offline match waiting in the upload queue; the page tells the player when the server has settled it. */
  const queuedId = useRef<string | null>(null)

  // Tell the page a match is running, so an update waits for the end of it (lib/stale-chunk.ts). Cleared on finish and on leaving.
  useEffect(() => {
    setMatchActive(status === 'playing')
    return () => setMatchActive(false)
  }, [status])

  // A counted match that is still running when the tab is hidden for good or the page unmounts is
  // resigned by beacon: closing the tab must not dodge a loss. pagehide also fires on a bfcache
  // freeze, which is the same as leaving for this purpose.
  useEffect(() => {
    const leave = () => {
      const p = pending.current
      if (p) beaconFinish(p.bytes)
      const m = live.current
      if (!m) return
      live.current = null
      beaconResign(m.matchId, m.tick)
    }
    // Records an earlier page could not deliver (closed tab, offline) are sent now, before the abandon window.
    void retryPending()
    void drainUploads().catch(() => {})
    if (!isOffline()) void refillTickets([game])
    const online = () => { void retryPending(); void drainUploads().catch(() => {}); void refillTickets([game]) }
    const settled = (e: Event) => {
      const id = queuedId.current
      const detail = (e as CustomEvent<{ matchIds: string[]; outcomes?: UploadOutcome[] }>).detail
      if (id && detail.matchIds.includes(id)) {
        queuedId.current = null
        const outcome = detail.outcomes?.find((o) => o.matchId === id)
        setUpload(outcome && !outcome.counted ? { status: 'not-counted', matchId: id, reason: outcome.reason ?? 'the server did not accept it' } : { status: 'synced', matchId: id })
      }
    }
    window.addEventListener(QUEUE_EVENT, settled)
    const unsubscribe = subscribeConnection(() => { if (!isOffline()) online() })
    window.addEventListener('online', online)
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener(QUEUE_EVENT, settled)
      unsubscribe()
      window.removeEventListener('pagehide', leave)
      leave()
    }
  }, [game])

  /** Gets the seed for a new match (from the server unless `devSeed` is given). Call before the game's init. */
  const begin = useCallback(
    async (level: Level, devSeed?: number): Promise<Session> => {
      const s = await beginSession(api, game, level, devSeed, undefined, takeCall(game))
      session.current = s
      setUnratedReason(s.unratedReason ?? null)
      // Online start: remember the level and top the offline ticket pool up in the background.
      if (s.rated && !s.offline) { notePlayed(game, level); void refillTickets([game]) }
      return s
    },
    [api, game],
  )

  const start = useCallback(
    (init: Omit<RecorderInit, 'game' | 'device' | 'input' | 'matchId'> & Partial<Pick<RecorderInit, 'device' | 'input' | 'matchId'>>) => {
      const issued = session.current
      recorder.current = createMatchRecorder({
        ...init,
        // A match on an offline ticket is recorded against the version the ticket was issued for (the server checks it).
        ...(issued?.offline && issued.agentVersion ? { agent: { ...init.agent, version: issued.agentVersion } } : {}),
        game,
        matchId: init.matchId ?? issued?.matchId ?? crypto.randomUUID(),
        device: init.device ?? detectDevice(),
        input: init.input ?? 'mouse',
      })
      setFinished(null)
      setUpload({ status: 'none' })
      // An offline ticket cannot be resigned (the server is out of reach and the ticket is not a match yet), so it is never "live".
      live.current = issued?.rated && issued.matchId && !issued.offline ? { matchId: issued.matchId, tick: 0 } : null
      setCounted(live.current !== null)
      setStatus('playing')
    },
    [game],
  )

  /** Hands the recorder the real seed a sealed match learns at its end. */
  const setSeed = useCallback((seed: number) => recorder.current?.setSeed(seed), [])

  /** Notes that the match reached `tick` without recording an action (a resign mid-match reports it). */
  const reach = useCallback((tick: number) => {
    if (live.current) live.current.tick = Math.max(live.current.tick, tick)
  }, [])

  const act = useCallback((tick: number, seat: Seat, action: number, humanInputMs?: number) => {
    recorder.current?.recordAction(tick, seat, action, humanInputMs)
    if (live.current) live.current.tick = Math.max(live.current.tick, tick + 1)
  }, [])

  const finish = useCallback(async (core: GameCore<any, any, any>, finalState: unknown) => {
    if (!recorder.current) throw new Error('useMatchRecorder: start() was not called')
    live.current = null
    setCounted(false)
    const out = await recorder.current.finish(core, finalState)
    recorder.current = null
    setFinished(out)
    setStatus('finished')
    const issued = session.current
    session.current = null
    if (issued?.rated) {
      const matchId = out.record.matchId
      pending.current = { matchId, bytes: out.bytes }
      savePending(matchId, out.bytes)
      if (offlineNow()) {
        // No connection: the record waits in the upload queue and is sent, checked and counted when the player is back online.
        queuedId.current = matchId
        void enqueueUpload(matchId, out.bytes, undefined, issued.owner).then(() => settleConsumed(matchId)).catch(() => {}).then(requestWakeDrain)
        setUpload({ status: 'queued', matchId })
      } else {
        setUpload({ status: 'uploading', matchId })
        void enqueueUpload(matchId, out.bytes, undefined, issued.owner).then(() => settleConsumed(matchId)).catch(() => {}).then(() => uploadMatch(api, out)).then((u) => {
          // Counted or rejected means the server settled the row; only a failed upload keeps the record for a retry.
          if (u.status !== 'failed') {
            if (pending.current?.matchId === matchId) pending.current = null
            clearPending(matchId)
            void uploadStore.remove(matchId).catch(() => {})
          }
          if (u.status === 'failed' && issued.offline) {
            queuedId.current = matchId
            setUpload({ status: 'queued', matchId })
          } else setUpload(u)
        })
      }
    } else if (offlineNow() && out.ok) {
      // An unranked match played with no server and no ticket still counts on the player's own record, on this device.
      const tally = recordOffline(game, out.record.result, out.record.humanSeat)
      setUnratedReason((prev) => `${prev ?? ''} ${tallyLine(tally)}`.trim())
    }
    return out
  }, [api, game])

  /**
   * Gives up the match. A counted match tells the server (a loss, rating updated); an unrated one only
   * ends locally. Never throws: a failed call is reported through `upload`.
   */
  const resign = useCallback(async (tick?: number) => {
    const m = live.current
    live.current = null
    setCounted(false)
    recorder.current = null
    session.current = null
    setStatus('finished')
    if (!m) return
    setUpload({ status: 'uploading' })
    try {
      const r = await (api.resign ?? postResign)(m.matchId, tick ?? m.tick)
      setUpload({ status: 'counted', matchId: m.matchId, elo: r.elo, provisional: r.provisional })
    } catch (e) {
      setUpload({ status: 'failed', message: e instanceof Error ? e.message : 'Resign failed.', kind: 'resign' })
    }
  }, [api])

  return { status, finished, upload, unratedReason, counted, begin, start, act, reach, setSeed, finish, resign }
}
