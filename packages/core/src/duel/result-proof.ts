/**
 * The signed result of one finished friend game. The relay (which holds DUEL_SIGNING_SECRET and is the only thing that knows the
 * game ended and how) signs it; the site verifies the signature before it writes a head-to-head row, so one browser cannot invent
 * a result, and a browser cannot change a name, a winner or a player either. Same HMAC key as the room tokens, but the signed
 * text carries a domain tag, so a token can never pass for a result or the other way round.
 *
 * It holds no moves and no seed: who played (a hashed `ref` and `pid`, the display name, a public rating) and who won.
 */
import type { GameId } from '../product'
import { PID, b64u, hmacKey, unb64u } from './token'

export interface ProofPlayer {
  /** The hashed caller reference of the socket (account plus device). The site matches it to the caller. */
  ref: string
  /** The stable player key the head-to-head record is kept under. */
  pid: string
  name: string
  /** The player's rating against the AI for this game when they had one at join time. */
  rating?: number
}

export interface DuelResultRecord {
  /** Unique per finished game: room code, room creation time, game number. The database key, so a replay writes nothing twice. */
  id: string
  game: GameId
  /** When the game ended, epoch ms. */
  at: number
  /** By game seat at the end of the game. */
  players: [ProofPlayer, ProofPlayer]
  /** The winning game seat, or null for a draw. */
  winner: 0 | 1 | null
}

const TAG = 'duel-result-v1.'
const MAX_PROOF = 2048
const enc = new TextEncoder()
const dec = new TextDecoder()

export async function signDuelResult(rec: DuelResultRecord, secret: string): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify({ v: 1, k: 'result', ...rec })))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(TAG + body)))
  return `${body}.${b64u(sig)}`
}

const wellPlayer = (p: any): p is ProofPlayer =>
  !!p && typeof p.ref === 'string' && p.ref.length > 0 && p.ref.length <= 64 && typeof p.pid === 'string' && PID.test(p.pid) && typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 40 &&
  (p.rating === undefined || (Number.isInteger(p.rating) && p.rating >= 0 && p.rating <= 5000))

/** The record, or null for anything wrong: shape, signature. Never throws on hostile input (it does throw on a missing secret, like the token). */
export async function verifyDuelResult(proof: unknown, secret: string): Promise<DuelResultRecord | null> {
  if (typeof proof !== 'string' || proof.length > MAX_PROOF) return null
  const parts = proof.split('.')
  if (parts.length !== 2) return null
  const sig = unb64u(parts[1]!)
  if (!sig) return null
  if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sig, enc.encode(TAG + parts[0]!)))) return null
  const raw = unb64u(parts[0]!)
  if (!raw) return null
  let p: any
  try { p = JSON.parse(dec.decode(raw)) } catch { return null }
  if (!p || p.v !== 1 || p.k !== 'result' || typeof p.id !== 'string' || p.id.length < 8 || p.id.length > 80) return null
  if (typeof p.game !== 'string' || !/^[a-z]{2,12}$/.test(p.game)) return null
  if (typeof p.at !== 'number' || !Number.isFinite(p.at)) return null
  if (!Array.isArray(p.players) || p.players.length !== 2 || !wellPlayer(p.players[0]) || !wellPlayer(p.players[1])) return null
  if (p.players[0].pid === p.players[1].pid) return null
  if (p.winner !== null && p.winner !== 0 && p.winner !== 1) return null
  return { id: p.id, game: p.game as GameId, at: p.at, players: [p.players[0], p.players[1]], winner: p.winner }
}
