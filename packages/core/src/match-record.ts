import type { GameId, Level } from './product'
import { PRODUCT } from './product'
import type { Result, Seat } from './types'
import { gunzipAsync, gunzipSync, gzipAsync, gzipSync } from './gzip'

export interface MatchRecordV1 {
  schema: 1
  matchId: string
  game: GameId
  coreVersion: string
  agent: { version: string; level: Level }
  seed: number
  humanSeat: Seat
  /** Turn-based: [step index, seat, action]. Realtime: only frames where that seat's input changed. */
  actions: Array<[tick: number, seat: Seat, action: number]>
  humanInputTimesMs?: number[]
  result: Result
  finalHash: string
  startedAt: string
  endedAt: string
  device: 'phone' | 'tablet' | 'desktop'
  input: 'mouse' | 'touch' | 'keyboard'
  trainingAllowed: boolean
}

export class RecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecordError'
  }
}

/** Largest decompressed JSON accepted (the upload cap is 2 MB gzipped; this bounds the inflate). */
export const MAX_RECORD_BYTES = 32 * 1024 * 1024

const LEVELS: readonly string[] = ['easy', 'medium', 'hard', 'champion']
const DEVICES: readonly string[] = ['phone', 'tablet', 'desktop']
const INPUTS: readonly string[] = ['mouse', 'touch', 'keyboard']

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const isSeat = (v: unknown): v is Seat => v === 0 || v === 1
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isDate = (v: unknown): boolean => typeof v === 'string' && !Number.isNaN(Date.parse(v))

function fail(msg: string): never {
  throw new RecordError(msg)
}

/** Validates an unknown value as a MatchRecordV1 (throws RecordError). Returns it typed. */
export function validateRecord(v: unknown): MatchRecordV1 {
  if (!isObj(v)) fail('record is not an object')
  if (v.schema !== 1) fail('unsupported schema ' + String(v.schema))
  if (!isStr(v.matchId)) fail('matchId must be a non-empty string')
  if (typeof v.game !== 'string' || !Object.prototype.hasOwnProperty.call(PRODUCT.games, v.game)) fail('unknown game ' + String(v.game))
  if (!isStr(v.coreVersion)) fail('coreVersion must be a non-empty string')
  if (!isObj(v.agent) || !isStr(v.agent.version) || typeof v.agent.level !== 'string' || !LEVELS.includes(v.agent.level)) fail('bad agent')
  if (!isInt(v.seed)) fail('seed must be an integer')
  if (!isSeat(v.humanSeat)) fail('humanSeat must be 0 or 1')
  if (!Array.isArray(v.actions)) fail('actions must be an array')
  for (const a of v.actions) {
    if (!Array.isArray(a) || a.length !== 3 || !isInt(a[0]) || a[0] < 0 || !isSeat(a[1]) || !isInt(a[2])) fail('bad action entry ' + JSON.stringify(a))
  }
  if (v.humanInputTimesMs !== undefined && (!Array.isArray(v.humanInputTimesMs) || v.humanInputTimesMs.some((t) => typeof t !== 'number' || !Number.isFinite(t)))) {
    fail('humanInputTimesMs must be an array of numbers')
  }
  const r = v.result
  if (!isObj(r) || !(r.winner === null || isSeat(r.winner)) || !Array.isArray(r.score) || r.score.length !== 2 || r.score.some((x) => typeof x !== 'number' || !Number.isFinite(x)) || typeof r.reason !== 'string') {
    fail('bad result')
  }
  if (typeof v.finalHash !== 'string' || !/^[0-9a-f]{16}$/.test(v.finalHash)) fail('finalHash must be 16 lowercase hex chars')
  if (!isDate(v.startedAt) || !isDate(v.endedAt)) fail('startedAt and endedAt must be ISO dates')
  if (typeof v.device !== 'string' || !DEVICES.includes(v.device)) fail('bad device')
  if (typeof v.input !== 'string' || !INPUTS.includes(v.input)) fail('bad input')
  if (typeof v.trainingAllowed !== 'boolean') fail('trainingAllowed must be a boolean')
  return v as unknown as MatchRecordV1
}

function toBytes(r: MatchRecordV1): Uint8Array {
  validateRecord(r)
  return new TextEncoder().encode(JSON.stringify(r))
}

function parse(bytes: Uint8Array): MatchRecordV1 {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail('record is not valid JSON')
  }
  return validateRecord(json)
}

function checkMagic(b: Uint8Array): void {
  if (b.length < 18 || b[0] !== 0x1f || b[1] !== 0x8b) fail('not gzip data')
}

/** JSON then gzip. */
export function encodeRecord(r: MatchRecordV1): Uint8Array {
  return gzipSync(toBytes(r))
}

/** Validates; throws RecordError on bad gzip, bad JSON or a bad shape. */
export function decodeRecord(b: Uint8Array): MatchRecordV1 {
  checkMagic(b)
  let raw: Uint8Array
  try {
    raw = gunzipSync(b, MAX_RECORD_BYTES)
  } catch {
    fail('malformed or oversized gzip')
  }
  return parse(raw)
}

/** Browser-safe versions (CompressionStream). */
export async function encodeRecordAsync(r: MatchRecordV1): Promise<Uint8Array> {
  return gzipAsync(toBytes(r))
}

export async function decodeRecordAsync(b: Uint8Array): Promise<MatchRecordV1> {
  checkMagic(b)
  let raw: Uint8Array
  try {
    raw = await gunzipAsync(b, MAX_RECORD_BYTES)
  } catch {
    fail('malformed or oversized gzip')
  }
  return parse(raw)
}
