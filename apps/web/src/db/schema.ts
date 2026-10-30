import { bigint, boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import type { Result } from '@duelwise/core/src/types'

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array | Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => v,
  fromDriver: (v) => new Uint8Array(v),
})

/**
 * 'resigned': the player gave up a counted match (scored a loss, never used for training).
 * 'ticket': an offline match slot the server issued ahead of play (server/tickets.ts). It is not a match yet, so the abandon
 * rule ignores it; uploading a record for it turns it into a 'started' match that is checked and counted like any other.
 * 'expired': a ticket nobody used within its 14 days. Never scored.
 */
export type MatchStatus = 'started' | 'finished' | 'abandoned' | 'resigned' | 'ticket' | 'expired'

/** Players without an account. The id lives in an HttpOnly cookie. */
export const guest = pgTable('guest', {
  id: text('id').primaryKey(),
  trainingAllowed: boolean('training_allowed').notNull().default(true),
  noticeSeenAt: timestamp('notice_seen_at', { withTimezone: true }),
  /** The name the player typed for the board (lib/display-name.ts), nothing else about them. Null: the board shows "guest" and the last 4 of the id. */
  displayName: text('display_name'),
  /** Guests opt out of the public board from Settings. Default shown. */
  showOnLeaderboard: boolean('show_on_leaderboard').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Better Auth tables (names and columns are what its Drizzle adapter expects). Match, rating and
 * profile rows point at `user.id` by value, without foreign keys, so a deleted account never
 * blocks the removal of its matches.
 */
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Per-account settings. */
export const profile = pgTable('profile', {
  userId: text('user_id').primaryKey(),
  trainingAllowed: boolean('training_allowed').notNull().default(true),
  noticeSeenAt: timestamp('notice_seen_at', { withTimezone: true }),
  /** Whether the player's first name may appear on the public leaderboard once they have enough rated games. */
  showOnLeaderboard: boolean('show_on_leaderboard').notNull().default(true),
  /** The name the player typed for the board; copied from the guest row when they keep it across devices. */
  displayName: text('display_name'),
})

export const match = pgTable(
  'match',
  {
  id: text('id').primaryKey(),
  game: text('game').notNull(),
  userId: text('user_id'),
  guestId: text('guest_id'),
  agentVersion: text('agent_version').notNull(),
  level: text('level').notNull(),
  seed: bigint('seed', { mode: 'number' }).notNull(),
  status: text('status').$type<MatchStatus>().notNull().default('started'),
  result: jsonb('result').$type<Result | null>(),
  record: bytea('record'),
  recordValid: boolean('record_valid'),
  invalidReason: text('invalid_reason'),
  filterFlags: jsonb('filter_flags').$type<Record<string, unknown> | null>(),
  trainingAllowed: boolean('training_allowed').notNull().default(true),
  /** The level the player said they would reach before the match ("How far do you think you get?"): easy, medium, hard or champion. Null when none was given. */
  call: text('call'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('match_game_level_finished_idx').on(t.game, t.level, t.finishedAt)],
)

export const rating = pgTable(
  'rating',
  {
    userId: text('user_id').notNull(),
    game: text('game').notNull(),
    elo: integer('elo').notNull(),
    games: integer('games').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.game] })],
)

export const agentVersion = pgTable(
  'agent_version',
  {
    game: text('game').notNull(),
    version: text('version').notNull(),
    parent: text('parent'),
    status: text('status').notNull(),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    measured: jsonb('measured').$type<Record<string, unknown> | null>(),
  },
  (t) => [primaryKey({ columns: [t.game, t.version] })],
)

export const trainingRun = pgTable('training_run', {
  id: text('id').primaryKey(),
  game: text('game').notNull(),
  challenger: text('challenger').notNull(),
  champion: text('champion').notNull(),
  gate: jsonb('gate').$type<Record<string, unknown> | null>(),
  promoted: boolean('promoted').notNull().default(false),
  humanMatchesUsed: integer('human_matches_used').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Telemetry event kinds, one row per lifecycle step of a counted match. */
export type TelemetryKind = 'match_started' | 'match_finished' | 'match_abandoned' | 'match_resigned'

/**
 * Privacy-safe server events for the owner dashboard. No user id, email, IP address or raw browser
 * string is stored: the player is an opaque reference (a hash of the account or guest id) and the
 * device is a class (phone, tablet, desktop, unknown). Deleted with the account that owns the reference.
 */
export const telemetryEvent = pgTable(
  'telemetry_event',
  {
    id: text('id').primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').$type<TelemetryKind>().notNull(),
    matchId: text('match_id').notNull(),
    game: text('game').notNull(),
    level: text('level').notNull(),
    persona: text('persona').notNull(),
    device: text('device').notNull().default('unknown'),
    durationMs: integer('duration_ms'),
    /** Who won a finished valid match: 'human', 'ai' or 'draw'. Null otherwise. */
    outcome: text('outcome'),
    reason: text('reason'),
    trainingBasis: text('training_basis').notNull(),
    optedOut: boolean('opted_out').notNull().default(false),
    playerRef: text('player_ref').notNull(),
    playerKind: text('player_kind').notNull(),
  },
  (t) => [index('telemetry_event_at_idx').on(t.at), index('telemetry_event_match_idx').on(t.matchId), index('telemetry_event_player_idx').on(t.playerRef)],
)

/** Every owner action that exposes personal data (an email reveal). Append only. */
export const ownerAudit = pgTable('owner_audit', {
  id: text('id').primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  ownerRef: text('owner_ref').notNull(),
  action: text('action').notNull(),
  targetRef: text('target_ref').notNull(),
})

/**
 * Per-match report data that is not in the match row: the rating change the player earned, the
 * sharing choices, and the built report (a cache; the record stays the source of truth). The
 * match id is the opaque public report id, so a report row carries no user or guest id.
 */
export const matchReport = pgTable('match_report', {
  matchId: text('match_id').primaryKey(),
  eloBefore: integer('elo_before'),
  eloAfter: integer('elo_after'),
  provisional: boolean('provisional').notNull().default(false),
  /** Anyone with the link may read the public report. The player can turn this off. */
  linkPublic: boolean('link_public').notNull().default(true),
  /** Show the player's display name on the public report. Off by default. */
  showName: boolean('show_name').notNull().default(false),
  built: jsonb('built').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
