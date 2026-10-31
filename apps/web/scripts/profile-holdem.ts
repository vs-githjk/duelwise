// Read-only Hold'em opponent profiles from human match records: per player, how often they enter the pot, raise, fold to a
// continuation bet and reach showdown (packages/core/src/games/holdem/profile.ts). It changes no agent and writes only files.
//   DATABASE_URL=... bun /abs/apps/web/scripts/profile-holdem.ts --out /abs/dir
// Reads through exportHuman, so it uses the same READ ONLY connection. Differences from the training export, on purpose:
//   - no daily or share cap (a profile is not training data), no holdout
//   - matches the player LEFT are included: the actions up to the exit are real behaviour (practice is still excluded)
//   - players who switched poker profiles off in Settings are left out entirely (needs migration 0007: without the switch it refuses to run)
//   - only matches the player allows training on (the same consent as the training export)
// Output: <out>/holdem-profiles/profiles.json (opaque player keys, never a name or id) and summary.json.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { countMatch, emptyCounts, profileOf, type PlayerProfile, type ProfileCounts } from '@duelwise/core/src/games/holdem/profile'
import { assertKnownArgs, exportHuman, flagValue, runScript, sourceFromArgs, type Defer, type HumanRow } from './export-human'

export interface ProfileEntry {
  player: string
  profile: PlayerProfile
}

export interface ProfileSummary {
  players: number
  confidentPlayers: number
  matches: number
  hands: number
  optedOutMatches: number
  note: string
}

/** Pure: counts each player's behaviour over their rows and drops opted-out players. */
export function buildProfiles(rows: readonly HumanRow[], alreadyDropped = 0): { profiles: ProfileEntry[]; summary: ProfileSummary } {
  const counts = new Map<string, ProfileCounts>()
  let optedOut = alreadyDropped
  for (const r of rows) {
    if (r.profileOk === false) { optedOut++; continue }
    if (r.profileOk === null) throw new Error('profile-holdem: the database has no poker profile switch (migration 0007); refusing to profile without the opt-out')
    const c = counts.get(r.player) ?? emptyCounts()
    countMatch(c, { seed: r.seed, actions: r.actions, options: r.options ?? undefined, humanSeat: r.humanSeat })
    counts.set(r.player, c)
  }
  const profiles = [...counts].map(([player, c]) => ({ player, profile: profileOf(c) })).sort((a, b) => b.profile.hands - a.profile.hands || a.player.localeCompare(b.player))
  return {
    profiles,
    summary: {
      players: profiles.length,
      confidentPlayers: profiles.filter((p) => p.profile.confident).length,
      matches: profiles.reduce((a, p) => a + p.profile.matches, 0),
      hands: profiles.reduce((a, p) => a + p.profile.hands, 0),
      optedOutMatches: optedOut,
      note: 'rates are shrunk toward population priors; a profile is confident from 200 hands. Offline analysis only: no agent reads these files.',
    },
  }
}

async function main(defer: Defer) {
  const args = process.argv.slice(2)
  assertKnownArgs(args, ['--out', '--pglite'])
  const out = flagValue(args, '--out')
  if (!out || !out.startsWith('/')) {
    console.error('usage: DATABASE_URL=... bun profile-holdem.ts --out <absolute dir> [--pglite <absolute scratch db dir>]')
    process.exitCode = 2
    return
  }
  const src = await sourceFromArgs(args)
  defer(() => src.close())
  const scratch = await mkdtemp(join(tmpdir(), 'duelwise-profile-'))
  defer(() => rm(scratch, { recursive: true, force: true }))
  const exported = await exportHuman({ game: 'holdem', query: src.query, outDir: scratch, holdoutPercent: 0, uncapped: true, shareCap: false, includeLeft: true, excludePokerOptOut: true })
  const rows = (await readFile(join(scratch, 'holdem', 'matches.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as HumanRow)
  const { profiles, summary } = buildProfiles(rows, exported.rejected.poker_opt_out ?? 0)
  const dir = join(resolve(out), 'holdem-profiles')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'profiles.json'), JSON.stringify(profiles, null, 1) + '\n')
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify(summary))
}

if (import.meta.main) await runScript('profile-holdem', main)
