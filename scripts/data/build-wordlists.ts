// Builds the Word Duel lists from the SCOWL 2020.12.07 release (notice licence, see lists/SOURCE.md).
//
//   bun scripts/data/build-wordlists.ts   (from the repo root)
//
// Downloads the release into data/raw (gitignored) when it is missing, checks its SHA-256 against the pin below,
// and writes lists/answers.txt (SCOWL size 35 or less, most common first), lists/allowed.txt (size 70 or less,
// alphabetical), lists/SOURCE.md and lists.generated.ts (the same lists as strings, so the browser, Bun and Node
// load them the same way). lists/exclude.txt is hand-kept and removed from both lists. lists/guess-only.txt is hand-kept
// too: words from exclude.txt that stay out of the answers and out of allowed.txt (the AI's pool and the action
// indices) but may be guessed; they are checked against SCOWL size 70 or less here. The output is deterministic.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { dataDir } from '../paths'

const ROOT = join(import.meta.dir, '..', '..')
const RAW = join(dataDir(), 'raw', 'scowl')
const TARBALL = join(RAW, 'scowl-2020.12.07.tar.gz')
const URL_ = 'https://downloads.sourceforge.net/wordlist/scowl-2020.12.07.tar.gz'
const TARBALL_SHA256 = '5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc'
const OUT = join(ROOT, 'packages', 'core', 'src', 'games', 'word')
const ANSWER_MAX_SIZE = 35
const ALLOWED_MAX_SIZE = 70
// SCOWL size tiers that exist for the base and American word files.
const SIZES = [10, 20, 35, 40, 50, 55, 60, 70]
const FILES = ['english-words', 'american-words']

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

async function ensureTarball(): Promise<void> {
  if (!existsSync(TARBALL)) {
    mkdirSync(RAW, { recursive: true })
    const res = await fetch(URL_, { redirect: 'follow' })
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${URL_}`)
    writeFileSync(TARBALL, new Uint8Array(await res.arrayBuffer()))
  }
  const got = sha256(readFileSync(TARBALL))
  if (got !== TARBALL_SHA256) throw new Error(`checksum mismatch for ${TARBALL}: expected ${TARBALL_SHA256}, got ${got}`)
}

function readMember(name: string): string[] {
  const r = spawnSync('tar', ['-xzOf', TARBALL, `scowl-2020.12.07/final/${name}`], { maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`tar could not read ${name}: ${r.stderr.toString()}`)
  return new TextDecoder('latin1').decode(r.stdout).split('\n')
}

const FIVE = /^[a-z]{5}$/

/** Five-letter lowercase words of every tier up to maxSize, each with the lowest tier it appears in. */
function collect(maxSize: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const size of SIZES.filter((s) => s <= maxSize)) {
    for (const f of FILES) {
      for (const w of readMember(`${f}.${size}`)) if (FIVE.test(w) && !out.has(w)) out.set(w, size)
    }
  }
  return out
}

/** Every lowercase word of any length in the SCOWL tiers up to ALLOWED_MAX_SIZE: the stems an inflected form is checked against. */
function collectStems(): Set<string> {
  const out = new Set<string>()
  for (const size of SIZES.filter((s) => s <= ALLOWED_MAX_SIZE)) {
    for (const f of FILES) for (const w of readMember(`${f}.${size}`)) if (/^[a-z]{3,5}$/.test(w)) out.add(w)
  }
  return out
}

/** The stems a five-letter word would come from if it were a plural, a third-person -s form or an -ed form. */
export function stemsOf(w: string): string[] {
  const out: string[] = []
  if (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) return out
  if (w.endsWith('ies')) out.push(w.slice(0, -3) + 'y') // tries -> try
  if (w.endsWith('ves')) out.push(w.slice(0, -3) + 'f', w.slice(0, -3) + 'fe') // wives -> wife
  if (w.endsWith('es')) out.push(w.slice(0, -2)) // boxes -> box
  if (w.endsWith('s')) out.push(w.slice(0, -1)) // books -> book, cares -> care
  if (w.endsWith('ied')) out.push(w.slice(0, -3) + 'y') // tried -> try
  if (w.endsWith('ed')) {
    out.push(w.slice(0, -2), w.slice(0, -1)) // added -> add, baked -> bake
    if (w[w.length - 3] === w[w.length - 4]) out.push(w.slice(0, -3)) // planned -> plan
  }
  // Comparatives, superlatives and -ing forms (JA: answers are base words only).
  const dbl = (stem: string) => (stem.length >= 4 && stem[stem.length - 1] === stem[stem.length - 2] ? [stem.slice(0, -1)] : [])
  if (w.endsWith('ier') || w.endsWith('iest')) out.push(w.slice(0, w.endsWith('ier') ? -3 : -4) + 'y') // dirtier -> dirty
  if (w.endsWith('er') && !w.endsWith('ier')) {
    out.push(w.slice(0, -2), w.slice(0, -1), ...dbl(w.slice(0, -2))) // older -> old, wider -> wide, bigger -> big
  }
  if (w.endsWith('est') && !w.endsWith('iest')) {
    out.push(w.slice(0, -3), w.slice(0, -2), ...dbl(w.slice(0, -3))) // oldest -> old, widest -> wide
  }
  if (w.endsWith('ying')) out.push(w.slice(0, -4) + 'ie', w.slice(0, -3)) // dying -> die, vying -> vie, buying -> buy
  else if (w.endsWith('ing')) out.push(w.slice(0, -3), w.slice(0, -3) + 'e', ...dbl(w.slice(0, -3))) // doing -> do, aging -> age, running -> run
  return out.filter((x) => x.length >= 3)
}

await ensureTarball()
const stems = collectStems()
/** Hand-reviewed words that end like an inflection but are answers on their own (kept in the answer list). */
const keepInflected = new Set(
  readFileSync(join(OUT, 'lists', 'keep-inflected.txt'), 'utf8')
    .split('\n')
    .filter(Boolean),
)
/** Hand-reviewed inflections the stem check misses (the -us and -is plurals it deliberately skips, rare verb forms). */
const dropInflected = new Set(
  readFileSync(join(OUT, 'lists', 'drop-inflected.txt'), 'utf8')
    .split('\n')
    .filter(Boolean),
)
const isInflection = (w: string): boolean => dropInflected.has(w) || (!keepInflected.has(w) && stemsOf(w).some((x) => stems.has(x)))
const exclude = new Set(
  readFileSync(join(OUT, 'lists', 'exclude.txt'), 'utf8')
    .split('\n')
    .filter(Boolean),
)
const guessOnly = readFileSync(join(OUT, 'lists', 'guess-only.txt'), 'utf8')
  .split('\n')
  .filter(Boolean)
const answerTier = collect(ANSWER_MAX_SIZE)
const allowedTier = collect(ALLOWED_MAX_SIZE)
const answers = [...answerTier.entries()]
  .filter(([w]) => !exclude.has(w) && !isInflection(w))
  .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
  .map(([w]) => w)
const allowed = [...allowedTier.keys()].filter((w) => !exclude.has(w)).sort()
const allowedSet = new Set(allowed)
for (const w of guessOnly) {
  if (!exclude.has(w)) throw new Error(`guess-only ${w} is not in exclude.txt`)
  if (!allowedTier.has(w)) throw new Error(`guess-only ${w} is not in SCOWL size ${ALLOWED_MAX_SIZE} or less`)
  if (!FIVE.test(w) || allowedSet.has(w)) throw new Error(`guess-only ${w} is malformed or already allowed`)
}
if (new Set(guessOnly).size !== guessOnly.length || [...guessOnly].sort().join() !== guessOnly.join()) throw new Error('guess-only.txt must be alphabetical with no repeats')
for (const w of answers) if (!allowedSet.has(w)) throw new Error(`answer ${w} is not allowed`)

const answersText = answers.join('\n') + '\n'
const allowedText = allowed.join('\n') + '\n'
const keepText = readFileSync(join(OUT, 'lists', 'keep-inflected.txt'), 'utf8')
const dropText = readFileSync(join(OUT, 'lists', 'drop-inflected.txt'), 'utf8')
const excludeText = readFileSync(join(OUT, 'lists', 'exclude.txt'), 'utf8')
const guessOnlyText = readFileSync(join(OUT, 'lists', 'guess-only.txt'), 'utf8')
mkdirSync(join(OUT, 'lists'), { recursive: true })
writeFileSync(join(OUT, 'lists', 'answers.txt'), answersText)
writeFileSync(join(OUT, 'lists', 'allowed.txt'), allowedText)
writeFileSync(
  join(OUT, 'lists.generated.ts'),
  `// Generated by scripts/data/build-wordlists.ts from lists/answers.txt and lists/allowed.txt. Do not edit.\n` +
    `export const ANSWERS_TEXT = ${JSON.stringify(answersText)}\n` +
    `export const ALLOWED_TEXT = ${JSON.stringify(allowedText)}\n` +
    `export const GUESS_ONLY_TEXT = ${JSON.stringify(guessOnlyText)}\n`,
)
writeFileSync(
  join(OUT, 'lists', 'SOURCE.md'),
  `# Word Duel lists: provenance

Source: SCOWL (Spell Checking Oriented Word Lists) release 2020.12.07 by Kevin Atkinson, notice licence (see docs/third-party/word.md).
Download: ${URL_}
Archive SHA-256: ${TARBALL_SHA256}
SCOWL builds on public domain sources (12dicts and ENABLE among them); the copyright file in the archive lists each.

Built by scripts/data/build-wordlists.ts, deterministic:

- Members read: ${FILES.map((f) => `final/${f}.<size>`).join(', ')} for sizes ${SIZES.join(', ')}.
- Kept: lowercase a-z words of exactly five letters.
- answers.txt: sizes ${SIZES.filter((s) => s <= ANSWER_MAX_SIZE).join(', ')} (SCOWL size ${ANSWER_MAX_SIZE} or less), ordered from most common (lowest size) to least, alphabetical within a size. Line order is the commonness rank the Medium level uses.
- allowed.txt: sizes up to ${ALLOWED_MAX_SIZE} (SCOWL size ${ALLOWED_MAX_SIZE} or less), alphabetical. Every answer is also allowed.
- Inflections: a word that is a plural, third-person -s form, -ed form, comparative (-er), superlative (-est) or -ing form of a shorter SCOWL word (size 70 or less, stems of 3 to 5 letters) is dropped from answers.txt and stays in allowed.txt, so it is still a valid guess. keep-inflected.txt lists the hand-reviewed words that only look inflected and stay answers; drop-inflected.txt lists the hand-reviewed inflections the stem check misses.
- exclude.txt: hand-kept offensive words, removed from both lists.
- guess-only.txt: hand-kept, alphabetical. Words from exclude.txt that have an ordinary meaning (Nov 3 2026: owner's call) and may be guessed but never be an answer. Each is checked here to be in SCOWL size ${ALLOWED_MAX_SIZE} or less (a miss stops the build; dicky was proposed and is not in those tiers, so it stays blocked). They sit after the last allowed.txt word in the action encoding, in file order (index = allowed.txt length + line), so every index in a stored match record is unchanged, and the solver, first-guesses and measure never see them (the AI's guess pool is allowed.txt only). Never reorder or remove a line: the index is part of stored records.
- No list from any game site or newspaper, and no web-frequency data.

| file | words | SHA-256 |
| --- | --- | --- |
| answers.txt | ${answers.length} | ${sha256(answersText)} |
| allowed.txt | ${allowed.length} | ${sha256(allowedText)} |
| guess-only.txt | ${guessOnly.length} | ${sha256(guessOnlyText)} |
| exclude.txt | ${exclude.size} | ${sha256(excludeText)} |
| keep-inflected.txt | ${keepInflected.size} | ${sha256(keepText)} |
| drop-inflected.txt | ${dropInflected.size} | ${sha256(dropText)} |
`,
)
console.log(`answers ${answers.length}, allowed ${allowed.length}, excluded ${exclude.size}`)
