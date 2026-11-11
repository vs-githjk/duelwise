/**
 * Minting for friend challenges (M5). Server side only: it holds DUEL_SIGNING_SECRET, which never reaches a browser.
 *
 * The functions here are pure over injected reads: they are given who is looking (read only) and a saved display name (read only),
 * and return a signed token for the relay. They cannot write anything, which is how "creating a challenge writes no Neon row" is
 * kept true. The token carries a hashed reference, never an email, user id or guest id.
 */
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { ROOM_CODE, signDuelToken } from '@duelwise/core/src/duel/token'
import { checkName } from '../lib/display-name'
import { CHALLENGE_GAMES } from '../lib/challenge-games'

export { signDuelToken, verifyDuelToken, ROOM_CODE } from '@duelwise/core/src/duel/token'

export { CHALLENGE_GAMES }

/** A token lives as long as a room can (the relay's 3 hour cap), so a reconnect never needs a new one. */
export const TOKEN_TTL_MS = 3 * 60 * 60_000

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Six characters of A-Z and 2-7 from the platform CSPRNG (a byte mod 32 is unbiased because 256 is a multiple of 32). */
export function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let s = ''
  for (const b of bytes) s += BASE32[b % 32]
  return s
}

const DEVICE_ID = /^[0-9a-f-]{36}$/i

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * The hashed caller reference the relay limits and seats by: HMAC-SHA256 of the account (when signed in) and this browser's
 * device id, keyed by the signing secret, cut to 32 hex characters. Device id is part of it on purpose: one account on two
 * phones must be two seats. It is not a secret the client can use, only a label.
 */
export async function callerRef(secret: string, who: { userId?: string }, deviceId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`duel-ref-v1|${who.userId ?? ''}|${deviceId}`))
  return hex(sig).slice(0, 32)
}

/**
 * The head-to-head key of a person (the `pid` in a token and in a result): a keyed hash of the account when signed in, so the record follows
 * them to another phone, else of this browser's friend device id. Not the id itself and not reversible without the secret.
 */
export async function playerKey(secret: string, who: { userId?: string }, deviceId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(who.userId ? `duel-pid-v1|u:${who.userId}` : `duel-pid-v1|d:${deviceId}`))
  return hex(sig).slice(0, 32)
}

export interface ChallengeDeps {
  /** DUEL_SIGNING_SECRET. Missing or short means friend links are not switched on. */
  secret: string | undefined
  now(): number
  code(): string
  /** Who is looking, read only: never creates a guest row or a cookie. */
  viewer(): Promise<{ userId?: string; guestId?: string }>
  /** The display name this person already saved on the boards, read only. */
  savedName(who: { userId?: string; guestId?: string }): Promise<string | null>
  /** The rating this signed-in person already has against the AI, per game (a public number on the boards). Read only; empty for a guest. */
  ratings(who: { userId?: string; guestId?: string }): Promise<Partial<Record<GameId, number>>>
}

export type ChallengeError = 'unavailable' | 'bad-game' | 'bad-code' | 'bad-name' | 'no-device'
export type Minted = { ok: true; code: string; token: string; exp: number; name: string } | { ok: false; error: ChallengeError; message?: string }

async function mint(d: ChallengeDeps, raw: { name?: unknown; deviceId?: unknown }, code: string, host: { game: GameId } | undefined, fallback: string): Promise<Minted> {
  if (!d.secret || d.secret.length < 16) return { ok: false, error: 'unavailable' }
  if (typeof raw.deviceId !== 'string' || !DEVICE_ID.test(raw.deviceId)) return { ok: false, error: 'no-device' }
  const who = await d.viewer()
  let name: string
  if (typeof raw.name === 'string' && raw.name.trim() !== '') {
    const c = checkName(raw.name)
    if (!c.ok) return { ok: false, error: 'bad-name', message: c.error }
    name = c.name
  } else {
    name = (await d.savedName(who)) ?? fallback
  }
  const exp = d.now() + TOKEN_TTL_MS
  const ref = await callerRef(d.secret, { userId: who.userId }, raw.deviceId)
  const pid = await playerKey(d.secret, { userId: who.userId }, raw.deviceId)
  const rt = who.userId ? await d.ratings(who).catch(() => ({})) : {}
  const token = await signDuelToken({ code, ref, name, exp, pid, ...(Object.keys(rt).length ? { rt } : {}), ...(host ? { host } : {}) }, d.secret)
  return { ok: true, code, token, exp, name }
}

/** A host token for a brand new room code. The relay creates the room when the host's socket first connects. */
export async function createChallenge(d: ChallengeDeps, input: { game: unknown; name?: unknown; deviceId?: unknown }): Promise<Minted> {
  const game = input.game
  if (typeof game !== 'string' || !(CHALLENGE_GAMES as readonly string[]).includes(game) || !Object.prototype.hasOwnProperty.call(PRODUCT.games, game)) {
    return { ok: false, error: 'bad-game' }
  }
  return mint(d, input, d.code(), { game: game as GameId }, 'Player 1')
}

/** A guest token for an existing code. Also used by the host to rejoin after a long gap (a host token is just as good). */
export async function joinChallenge(d: ChallengeDeps, input: { code: unknown; name?: unknown; deviceId?: unknown }): Promise<Minted> {
  if (typeof input.code !== 'string' || !ROOM_CODE.test(input.code)) return { ok: false, error: 'bad-code' }
  return mint(d, input, input.code, undefined, 'Player 2')
}
