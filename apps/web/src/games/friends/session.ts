/**
 * What a phone remembers about a friend room, in local storage only: a random device id (so one account on two phones is two seats)
 * and the seat token for each room it is in (so a dropped phone comes back to the same seat). Every access is guarded, because
 * storage can be blocked or full; without it the game still works, it just cannot reconnect after a reload.
 */
import type { RemoteOptions } from './useRemoteDuel'
import type { Minted } from '../../server/duel-token'

import { NAME_STORAGE_KEY } from '../../lib/display-name'

const DEVICE_KEY = 'duelwise.friend-device'
const tokenKey = (code: string) => `duelwise.friend.${code}`

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

const uuid = (): string => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000'.replace(/[08]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16)))

/** The display name this browser saved (the same key lib/progress reads), read here so the friend pages stay off that shared chunk. */
export const readName = (): string => store()?.getItem(NAME_STORAGE_KEY) ?? ''

/** This browser's friend device id, created on first use. */
export function friendDeviceId(): string {
  const s = store()
  try {
    const have = s?.getItem(DEVICE_KEY)
    if (have && /^[0-9a-f-]{36}$/i.test(have)) return have
    const fresh = uuid()
    s?.setItem(DEVICE_KEY, fresh)
    return fresh
  } catch {
    return uuid()
  }
}

export interface StoredSeat {
  token: string
  exp: number
  role: 'host' | 'guest'
  game?: string
}

export function readSeat(code: string, now = Date.now()): StoredSeat | null {
  try {
    const raw = store()?.getItem(tokenKey(code))
    if (!raw) return null
    const v = JSON.parse(raw) as StoredSeat
    if (typeof v.token !== 'string' || typeof v.exp !== 'number' || v.exp - 60_000 <= now) return null
    return v
  } catch {
    return null
  }
}

export function writeSeat(code: string, seat: StoredSeat): void {
  try {
    store()?.setItem(tokenKey(code), JSON.stringify(seat))
  } catch {
    /* storage full or blocked: reconnect after a reload is lost, nothing else */
  }
}

export function forgetSeat(code: string): void {
  try {
    store()?.removeItem(tokenKey(code))
  } catch {
    /* nothing to forget */
  }
}

/** Where the relay lives. VITE_DUEL_RELAY_URL in a deployed build; `wrangler dev` on this machine otherwise. Null means links are off. */
export function relayUrl(env: { VITE_DUEL_RELAY_URL?: string; DEV?: boolean } = import.meta.env as never): string | null {
  const v = env.VITE_DUEL_RELAY_URL?.trim()
  if (v) return v.replace(/\/+$/, '')
  return env.DEV ? 'ws://127.0.0.1:8787' : null
}

/**
 * The options for one room: a token that is the stored seat token while it is good and a freshly minted guest-style token (same
 * caller reference, so the same seat) when it is not.
 */
export function remoteOptions(p: {
  relay: string
  code: string
  mint: () => Promise<Minted>
  role: 'host' | 'guest'
  first?: StoredSeat
}): RemoteOptions {
  return {
    relayUrl: p.relay,
    code: p.code,
    getToken: async () => {
      const have = readSeat(p.code) ?? (p.first && p.first.exp - 60_000 > Date.now() ? p.first : null)
      if (have) return have.token
      const m = await p.mint()
      if (!m.ok) throw new Error(m.error)
      writeSeat(p.code, { token: m.token, exp: m.exp, role: p.role })
      return m.token
    },
    onTokenRefused: () => forgetSeat(p.code),
  }
}
