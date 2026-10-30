import { useCallback, useEffect, useState } from 'react'
import type { GameId, Level } from '@duelwise/core/src/product'
import { LEVELS } from './level-info'
import { NAME_STORAGE_KEY } from './display-name'

/**
 * What this browser remembers about the player: a name, the call for each game, and the adventure path. All of it is a mirror
 * (the server is the source of truth for the path and the name) so the page paints at once, offline included.
 * Every read and write is wrapped, because private windows and blocked storage throw.
 */

export const CALL_KEY = 'duelwise.call'
export const PATH_KEY = 'duelwise.path'
export const VOICE_KEY = 'duelwise.voice'
export const ANY_KEY = 'duelwise.any'
export const WELCOMED_KEY = 'duelwise.welcomed'
export const PROGRESS_EVENT = 'duelwise:progress'

export type PathMap = Record<Level, boolean>

const emptyPath = (): PathMap => ({ easy: false, medium: false, hard: false, champion: false })
const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v)

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {}
  try {
    window.dispatchEvent(new Event(PROGRESS_EVENT))
  } catch {}
}
function readJson<T>(key: string): T | null {
  const raw = read(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export const readName = (): string => (typeof window === 'undefined' ? '' : (read(NAME_STORAGE_KEY) ?? ''))
export const writeName = (name: string | null): void => write(NAME_STORAGE_KEY, name && name.length > 0 ? name : null)

/** True once this visitor has met the one-time welcome (named themselves or skipped it). */
export const readWelcomed = (): boolean => typeof window !== 'undefined' && read(WELCOMED_KEY) === '1'
export const writeWelcomed = (): void => write(WELCOMED_KEY, '1')

export function readCall(game: GameId): Level | null {
  if (typeof window === 'undefined') return null
  const v = readJson<Partial<Record<GameId, string>>>(CALL_KEY)?.[game]
  return isLevel(v) ? v : null
}
export function writeCall(game: GameId, level: Level): void {
  const all = readJson<Record<string, string>>(CALL_KEY) ?? {}
  all[game] = level
  write(CALL_KEY, JSON.stringify(all))
}

export function readPath(game: GameId): PathMap {
  const raw = typeof window === 'undefined' ? null : readJson<Partial<Record<GameId, Partial<Record<Level, unknown>>>>>(PATH_KEY)?.[game]
  const out = emptyPath()
  if (raw) for (const l of LEVELS) out[l] = raw[l] === true
  return out
}
export function writePath(game: GameId, path: PathMap): void {
  const all = readJson<Record<string, PathMap>>(PATH_KEY) ?? {}
  all[game] = path
  write(PATH_KEY, JSON.stringify(all))
}
/** Marks one stop cleared in the mirror at once, before the server has heard about the match. */
export function markCleared(game: GameId, level: Level): void {
  const p = readPath(game)
  if (!p[level]) writePath(game, { ...p, [level]: true })
}

/** The first stop not cleared yet, or null when all four are. */
export function currentStop(path: PathMap): Level | null {
  return LEVELS.find((l) => !path[l]) ?? null
}

/** The call a first visit starts on: the stop after the current one (Marlow before anything is cleared), and Sable once the path is done. */
export function defaultCall(path: PathMap): Level {
  const cur = currentStop(path)
  if (!cur) return 'champion'
  return LEVELS[Math.min(LEVELS.indexOf(cur) + 1, LEVELS.length - 1)]!
}

/** Whether every stop is open: `?any=1` on the page (testing and measurement), remembered for the tab's browser; never linked from the UI. */
export function anyUnlocked(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (new URLSearchParams(window.location.search).get('any') === '1') {
      window.localStorage.setItem(ANY_KEY, '1')
      return true
    }
  } catch {}
  return read(ANY_KEY) === '1'
}

/** "Forget me on this device": the name, calls, path and sound keys. The server cookie is cleared by the caller. */
export function forgetLocal(): void {
  for (const k of [NAME_STORAGE_KEY, CALL_KEY, PATH_KEY, VOICE_KEY, ANY_KEY, WELCOMED_KEY, 'duelwise.audio']) write(k, null)
}

export interface PathState {
  path: PathMap
  current: Level | null
  /** Open means every stop is selectable (owner escape hatch). */
  open: boolean
  /** False until the server has answered (or failed to). */
  loaded: boolean
  /** True once the browser mirror has been read, so locks never flash on a render that has not seen it. */
  hydrated: boolean
}

/** The path for a game: the browser mirror first, then the server's answer (which wins), and again whenever the mirror changes. */
export function usePath(game: GameId | undefined): PathState {
  const [path, setPath] = useState<PathMap>(emptyPath)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    if (!game) return
    setOpen(anyUnlocked())
    setPath(readPath(game))
    setHydrated(true)
    const onChange = () => setPath(readPath(game))
    window.addEventListener(PROGRESS_EVENT, onChange)
    let alive = true
    // The server's answer comes a beat after the first paint (the browser mirror is already on screen), so a page left at once never leaves a request half sent.
    const timer = setTimeout(() => void import('../server/identity-fns')
      .then(({ getMyPath }) => getMyPath({ data: { game } }))
      .then((server) => {
        if (!alive) return
        // The server wins, except for a win the browser has just recorded that the server has not been told about yet.
        const merged = { ...server }
        const local = readPath(game)
        for (const l of LEVELS) if (!server[l] && local[l] && Date.now() - lastClearAt < 60_000) merged[l] = true
        writePath(game, merged)
        setPath(merged)
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true)), 300)
    return () => {
      alive = false
      clearTimeout(timer)
      window.removeEventListener(PROGRESS_EVENT, onChange)
    }
  }, [game])
  return { path, current: currentStop(path), open, loaded, hydrated }
}

let lastClearAt = 0
export function noteCleared(game: GameId, level: Level): void {
  lastClearAt = Date.now()
  markCleared(game, level)
}

const played: Partial<Record<GameId, Level>> = {}

/** The call a match starts with: the one the player picked, else the default for their path. It is used up here, so the next match starts from the default again. */
export function takeCall(game: GameId): Level {
  const call = readCall(game) ?? defaultCall(readPath(game))
  played[game] = call
  write(CALL_KEY, JSON.stringify(Object.fromEntries(Object.entries(readJson<Record<string, string>>(CALL_KEY) ?? {}).filter(([g]) => g !== game))))
  return call
}

/** The call the match just played was started with, for the result sheet. Null before any match. */
export const calledFor = (game: GameId): Level | null => played[game] ?? null

/** A rematch keeps the same call. */
export function keepCall(game: GameId): void {
  const c = played[game]
  if (c) writeCall(game, c)
}

/** The picked call for one game, with the path-based default when nothing is picked. */
export function useCall(game: GameId | undefined, path: PathMap): [Level, (l: Level) => void] {
  const [picked, setPicked] = useState<Level | null>(null)
  useEffect(() => {
    if (!game) return
    const sync = () => setPicked(readCall(game))
    sync()
    window.addEventListener(PROGRESS_EVENT, sync)
    return () => window.removeEventListener(PROGRESS_EVENT, sync)
  }, [game])
  const set = useCallback(
    (l: Level) => {
      setPicked(l)
      if (game) writeCall(game, l)
    },
    [game],
  )
  return [picked ?? defaultCall(path), set]
}
