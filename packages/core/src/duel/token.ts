/**
 * Signed friend-room tokens. A Vercel function mints one for a caller (it reads the guest cookie or session and writes
 * nothing to the database); the relay Worker verifies it before any room object wakes. HMAC-SHA256 over the payload
 * with DUEL_SIGNING_SECRET, WebCrypto only, so the same file runs in a Worker, a server function, Bun and a browser test.
 *
 * The token carries no email and no user id: `ref` is a hashed caller reference chosen by the minting function.
 * Async because WebCrypto is async (the plan's M5 sketch showed it sync; callers just await).
 */
import type { GameId } from '../product'

export interface DuelTokenPayload {
  /** Room code, 6 characters of base32 (A-Z, 2-7). */
  code: string
  /** Hashed caller reference. Never an email or a user id. */
  ref: string
  /** Vetted display name. */
  name: string
  /** Expiry, epoch milliseconds. */
  exp: number
  /** Host tokens create the room (the game to play). A guest token has none and can only join a room that exists. */
  host?: { game: GameId }
  /**
   * Stable player key for the head-to-head record: a keyed hash of the account (or of this browser when signed out), never the id
   * itself. Unlike `ref` it does not change with the device of a signed-in person. Optional: older tokens have none.
   */
  pid?: string
  /** The player's existing rating against the AI per game (a public number on the boards), shown to the friend on the result. */
  rt?: Partial<Record<GameId, number>>
}

export interface VerifiedDuelToken { code: string; ref: string; name: string; exp: number; host: { game: GameId } | null; pid?: string; rt?: Partial<Record<GameId, number>> }

export const PID = /^[0-9a-f]{32}$/

/** Ratings from a token, kept only when they are small whole numbers for known games. */
export function cleanRatings(v: unknown): Partial<Record<GameId, number>> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z]{2,12}$/.test(k) || typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 5000) continue
    out[k] = n
    if (Object.keys(out).length >= 12) break
  }
  return Object.keys(out).length ? (out as Partial<Record<GameId, number>>) : undefined
}

export const ROOM_CODE = /^[A-Z2-7]{6}$/
const MIN_SECRET = 16
const MAX_TOKEN = 1024

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (secret.length < MIN_SECRET) throw new Error('duel token: the signing secret is missing or too short')
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

export async function signDuelToken(p: DuelTokenPayload, secret: string): Promise<string> {
  if (!ROOM_CODE.test(p.code)) throw new Error('duel token: bad room code')
  const body = b64u(enc.encode(JSON.stringify({ v: 1, c: p.code, r: p.ref, n: p.name, e: p.exp, ...(p.host ? { h: p.host } : {}), ...(p.pid ? { p: p.pid } : {}), ...(p.rt && Object.keys(p.rt).length ? { t: p.rt } : {}) })))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(body)))
  return `${body}.${b64u(sig)}`
}

/** Null for anything wrong: shape, signature, expiry. Never throws on hostile input. */
export async function verifyDuelToken(t: string, secret: string, now: number): Promise<VerifiedDuelToken | null> {
  if (typeof t !== 'string' || t.length > MAX_TOKEN) return null
  const parts = t.split('.')
  if (parts.length !== 2) return null
  const sig = unb64u(parts[1]!)
  if (!sig) return null
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sig, enc.encode(parts[0]!))
  if (!ok) return null
  const raw = unb64u(parts[0]!)
  if (!raw) return null
  let p: any
  try { p = JSON.parse(dec.decode(raw)) } catch { return null }
  if (!p || p.v !== 1 || typeof p.c !== 'string' || !ROOM_CODE.test(p.c)) return null
  if (typeof p.r !== 'string' || !p.r || p.r.length > 64) return null
  if (typeof p.n !== 'string' || !p.n || p.n.length > 40) return null
  if (typeof p.e !== 'number' || !Number.isFinite(p.e) || p.e <= now) return null
  let host: VerifiedDuelToken['host'] = null
  if (p.h !== undefined) {
    if (!p.h || typeof p.h.game !== 'string') return null
    host = { game: p.h.game as GameId }
  }
  const pid = typeof p.p === 'string' && PID.test(p.p) ? p.p : undefined
  const rt = cleanRatings(p.t)
  return { code: p.c, ref: p.r, name: p.n, exp: p.e, host, ...(pid ? { pid } : {}), ...(rt ? { rt } : {}) }
}
