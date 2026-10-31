// Tags rows from before the traffic column (migration 0006) so the owner page counts them in the right class.
//   DATABASE_URL=... OWNER_EMAILS=a@b.c bun /abs/path/apps/web/scripts/backfill-traffic.ts            dry run: counts only, writes nothing
//   DATABASE_URL=... OWNER_EMAILS=a@b.c bun /abs/path/apps/web/scripts/backfill-traffic.ts --apply    writes
// Run it after migration 0006 is applied. It only touches rows whose traffic is still null, so it is safe to run twice and never
// overrides a tag the server wrote. DATABASE_URL is read from the environment and never printed.
//
// Signals (the only real ones in the old rows):
//   owner: accounts on OWNER_EMAILS (id, or verified email), and their matches. Guests cannot be linked to an account (the
//          database stores no such link), so no guest is tagged owner here; new guests are claimed at sign-in instead.
//   test:  guests whose display name is one of our e2e fixture names; accounts that are dev-login fixtures (email at
//          dev.invalid, or a fixture name) or that have a session with a HeadlessChrome user agent; and every match of those
//          players. scripts/smoke.ts creates only nameless guest rows, so those cannot be told apart and stay human.
//   everything else stays null, which the owner page reads as Human.
import { ownerEntries } from '../src/server/telemetry'

/** Names the e2e specs sign in or type as. Distinctive ones only: plausible real first names (ada, grace, rita) are left out. */
export const FIXTURE_NAMES = [
  'eowner', 'e2e-adm-nolink', 'e2e-adm-plain', 'e2e-adm-player', 'e2e-plain-player', 'e2e-report-player', 'e2e-report-resigner',
  'e2e-seed-player', 'polish-player', 'gone-soon', 'Board Rookie', 'Dash Player', 'Month Player', 'beaconer', 'retrier', 'leaver', 'wanda',
]

export type Query = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>

export interface Plan {
  ownerAccounts: number
  ownerMatches: number
  testGuests: number
  testAccounts: number
  testMatches: number
  unchangedMatches: number
}

const OWNER_USERS = `select id from "user" where lower(id) = any($1::text[]) or (email_verified and lower(email) = any($1::text[]))`
const TEST_USERS = `select id from "user" where id not in (${OWNER_USERS}) and (lower(name) = any($2::text[]) or lower(email) like '%@dev.invalid'
  or exists (select 1 from session s where s.user_id = "user".id and s.user_agent ilike '%HeadlessChrome%'))`
// cardinality($1) >= 0 is always true; it only gives the unused owners parameter a type.
const TEST_GUESTS = `select id from guest where traffic is null and cardinality($1::text[]) >= 0 and lower(display_name) = any($2::text[])`

const n = async (q: Query, text: string, params: unknown[]): Promise<number> => Number((await q(text, params))[0]?.n ?? 0)

/** Counts what each class would get and, with apply, writes it. Pure over the query function, so it is tested on PGlite. */
export async function backfill(q: Query, opts: { owners: string[]; apply: boolean }): Promise<Plan> {
  const owners = opts.owners.map((o) => o.toLowerCase())
  const fixtures = FIXTURE_NAMES.map((f) => f.toLowerCase())
  const p = [owners, fixtures]
  const plan: Plan = {
    ownerAccounts: await n(q, `select count(*)::int as n from (${OWNER_USERS}) x`, [owners]),
    ownerMatches: await n(q, `select count(*)::int as n from match where traffic is null and user_id in (${OWNER_USERS})`, [owners]),
    testGuests: await n(q, `select count(*)::int as n from (${TEST_GUESTS}) x`, p),
    testAccounts: await n(q, `select count(*)::int as n from (${TEST_USERS}) x`, p),
    testMatches: await n(q, `select count(*)::int as n from match where traffic is null and (user_id in (${TEST_USERS}) or (user_id is null and guest_id in (${TEST_GUESTS})))`, p),
    unchangedMatches: 0,
  }
  plan.unchangedMatches = (await n(q, `select count(*)::int as n from match where traffic is null`, [])) - plan.ownerMatches - plan.testMatches
  if (opts.apply) {
    // Order matters: the test matches are found through guests that are still untagged, so they go before the guests do.
    await q(`update match set traffic = 'owner' where traffic is null and user_id in (${OWNER_USERS})`, [owners])
    await q(`update match set traffic = 'test' where traffic is null and (user_id in (${TEST_USERS}) or (user_id is null and guest_id in (${TEST_GUESTS})))`, p)
    await q(`update guest set traffic = 'test' where id in (${TEST_GUESTS})`, p)
  }
  return plan
}

async function main() {
  const apply = process.argv.includes('--apply')
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Nothing was read or written.')
    process.exit(1)
  }
  const owners = ownerEntries({ OWNER_EMAILS: process.env.OWNER_EMAILS })
  if (owners.length === 0) console.error('OWNER_EMAILS is not set: no account will be proposed as owner.')
  try {
    const { neon } = await import('@neondatabase/serverless')
    const sql = neon(url)
    const q: Query = async (text, params = []) => (await sql.query(text, params)) as Array<Record<string, unknown>>
    const plan = await backfill(q, { owners, apply })
    console.log(apply ? 'APPLIED (rows whose traffic was null):' : 'DRY RUN, nothing written (pass --apply to write):')
    console.log(`  owner: ${plan.ownerAccounts} accounts, ${plan.ownerMatches} matches`)
    console.log(`  test:  ${plan.testGuests} guests, ${plan.testAccounts} accounts, ${plan.testMatches} matches`)
    console.log(`  stay null (read as Human): ${plan.unchangedMatches} matches`)
  } catch (e) {
    // Never echo the connection string: print the message only.
    console.error('backfill failed:', e instanceof Error ? e.message.replaceAll(url, '[database url]') : 'unknown error')
    process.exit(1)
  }
}

if (import.meta.main) await main()
