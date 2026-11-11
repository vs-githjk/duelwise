/**
 * The one thing Duelwise asks a player for: a name for the board. This file is the whole rule (browser and server share it).
 * Trim, collapse spaces, 1 to 24 characters, letters, digits, spaces and . _ -; no links or emails; an inline blocklist of slurs and obscenities (see isBlocked).
 */

import { NAME_MAX, NAME_STORAGE_KEY } from './display-name-const'

export { NAME_MAX, NAME_STORAGE_KEY }

export type NameCheck = { ok: true; name: string } | { ok: false; error: string }

const ALLOWED = /^[\p{L}\p{N} ._-]+$/u

/**
 * Words no board row may contain. The list is inline on purpose (no dependency) and errs towards blocking: a refused name costs one retry,
 * a slur on the public board costs trust. Matching is explained at isBlocked.
 */
/** Blocked wherever they appear inside a word ("fucker", "xXfuckXx", "Pornstar"). Each is long or odd enough not to sit inside ordinary names. */
const BLOCKED_ANYWHERE = [
  'fuck', 'fck', 'fvck', 'phuck', 'shit', 'cunt', 'bitch', 'btch', 'pussy', 'whore', 'slut', 'bastard', 'asshole', 'arsehole', 'dickhead', 'cocksucker',
  'wanker', 'bollock', 'dildo', 'blowjob', 'handjob', 'jizz', 'cumshot', 'orgasm', 'masturbat', 'gangbang', 'penis', 'vagina', 'molest',
  'faggot', 'retard', 'tranny', 'shemale', 'chink', 'wetback', 'beaner', 'towelhead', 'raghead', 'kaffir', 'mongoloid', 'darkie',
  'fucc', 'phuk', 'phuq', 'fuxk', 'cvnt', 'bytch', 'biatch', 'byatch', 'azzhole', 'suckmydick', 'suckdick', 'suckcock',
  'rapist', 'hitler', 'pornstar', 'pornhub', 'porno', 'pedophile', 'paedophile', 'incest', 'hentai',
  // extremist
  'auschwitz', 'holocaust', 'sturmfuhrer', 'sturmfuehrer', 'goebbels', 'whitepower', 'whitepride', 'rimjob', 'deepthroat', 'ballsack', 'nutsack', 'siegheil', 'killjews', 'killalljews', 'gasthejews', 'heilhitler',
  // ethnic
  'jigaboo', 'porchmonkey', 'chingchong', 'slanteye', 'kebabremover', 'mudslime', 'muzzie',
  // lgbtq and sexual
  'trannie', 'sodomite', 'fudgepacker', 'poofter', 'battyboy', 'cumdump', 'cumguzzler', 'bigdick', 'dickslap', 'asswipe', 'faglord', 'urafag',
  // misspellings and look-alikes
  'rapeface', 'fcuk', 'fugk', 'fukk', 'shiat', 'sheeit', 'beyatch', 'biotch', 'pusay', 'pussi', 'dikhead', 'dickhead',
]
/** Blocked only as a whole word (plural allowed), because they sit inside ordinary words and names: grape, spice, Hancock, Dickens, Cumin, Nazir, Pornthip. */
const BLOCKED_WHOLE = [
  'rape', 'raped', 'raping', 'spic', 'coon', 'paki', 'cock', 'dick', 'wank', 'twat', 'kike', 'pedo', 'fag', 'cum', 'tit', 'ass', 'arse', 'anus',
  'nazi', 'porn', 'sex', 'sexy', 'piss', 'prick', 'bugger', 'dyke', 'lesbo', 'gook', 'negro', 'tard', 'spaz', 'fuk', 'sht', 'cnt', 'niga', 'nibba', 'kys', 'kkk',
  'fuq', 'kunt', 'nigr', 'dlck', 'whoar',
  'adolf', 'sambo', 'hymie', 'redskin', 'chinaman', 'ladyboy', 'libtard', 'downie', 'mofo', 'titties',
  'puta', 'puttana', 'pendejo', 'mierda', 'kurwa', 'blyat', 'cyka', 'pizda', 'hurensohn', 'scheisse', 'fotze', 'wichser', 'arschloch', 'cazzo', 'vaffanculo', 'connard', 'salope', 'putain', 'orospu', 'skurwysyn',
  'jap', 'jappo', 'spick', 'spik', 'kyke', 'injun', 'fagit', 'poof', 'raep', 'fock', 'fahk', 'dik', 'dikk', 'diq',
]
/** The n-word and its spellings: a doubled g after n-i (any repeats), so Nigel, Niger, Nigeria and Nigam stay allowed. */
const SLUR_PATTERNS = [/n+i+g{2,}/]
/** Phrases tested on the words of the name, single-spaced ("White Power", "Third_Reich", "efff u"). */
const PHRASES = [
  /\bwhite (power|pride)\b/, /\bsieg heil\b/, /\bthird reich\b/, /\bblood and soil\b/, /\bss officer\b/, /\bgas the\b/, /\bkill (all |the )?jews?\b/,
  /\bzionist (pig|scum)\b/, /\beff+ (u|you)\b/,
  /\baryan ?(nation|brotherhood|race|power|pride)s?\b/, /\bkill ?(yo)?u?r ?self\b/,
  /\bhang ?(yo)?u?r ?self\b/, /\bdie in a fire\b/, /\bgas chambers?\b/, /\blynch mob\b/, /\bcamel jockey\b/, /\bwindow licker\b/,
]
/** Digit codes are read on the raw name, before leetspeak turns the digits into letters: 1488, 14 88, and 88 standing alone ("Heil14_88"). */
const NUMBER_CODES = [/1[\s._-]*4[\s._-]*8[\s._-]*8/]
const isNumberCode = (raw: string) => NUMBER_CODES.some((re) => re.test(raw)) || raw.split(/[\s._-]+/).includes('88')

/** Whole names that contain a blocked word but are ordinary: tested on the words of the name, single-spaced. */
const ALLOWED_NAMES = ['dick van dyke', 'paki raza', 'jap singh']

/** Names nobody may take, so no player can pass as the game or its staff. A reserved word anywhere in the name blocks it ("Duelwise Staff"), and the staff-sounding ones also block as a prefix ("AdminBob", "SupportBot"); staff and root block only as whole words, so Staffan and Rooney stay allowed. */
const RESERVED_PREFIXES = ['admin', 'moderator', 'duelwise', 'support', 'official', 'system']
const RESERVED_WORDS = ['admin', 'administrator', 'moderator', 'mod', 'mods', 'staff', 'support', 'official', 'system', 'root', 'duelwise']

/** Innocent words and names that contain a blocked word; cut out of the text before it is tested. */
const ALLOWED_WORDS = [
  'scunthorpe', 'dickens', 'dickinson', 'cumin', 'cucumber', 'shiitake', 'shitake', 'phuket', 'cockney', 'dickson', 'dickerson', 'dickey', 'dickie', 'mishit', 'cocktail', 'cockpit', 'peacock', 'hancock', 'hitchcock', 'woodcock',
  'babcock', 'cockburn', 'penistone', 'therapist', 'retardant', 'classic', 'assassin', 'assess', 'assist', 'assume', 'asset', 'passion', 'bassett', 'hassan',
  'cassidy', 'dikshit', 'shittu', 'shitij', 'pennis', 'kuntz', 'shiatsu', 'massimo', 'sussex', 'essex', 'middlesex', 'arsenal', 'arsene', 'titan', 'title', 'tittle', 'attitude', 'constitution', 'pennistone',
]

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', $: 's', '!': 'i', '+': 't' }
/** Look-alike Cyrillic and Greek letters, so a name cannot hide a word behind them. */
const HOMOGLYPH: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', т: 't', в: 'b', ѕ: 's',
  ƒ: 'f', α: 'a', ε: 'e', ο: 'o', ρ: 'p', ν: 'v', τ: 't', ι: 'i', κ: 'k', υ: 'u', χ: 'x',
}

/** A word that tolerates repeated letters: fuck also matches fuuuck. */
const rep = (word: string) => word.split('').map((c) => `${c}+`).join('')
const ANYWHERE = BLOCKED_ANYWHERE.map((w) => new RegExp(rep(w)))
const WHOLE = BLOCKED_WHOLE.map((w) => new RegExp(`^${rep(w)}(s|es|z)?$`))
const JOINED_SHORT = ['fuck', 'shit', 'cunt', 'dick', 'cock', 'fucc', 'phuk', 'kunt', 'cvnt'].map((w) => new RegExp(rep(w)))
const ALLOW = ALLOWED_WORDS.map((w) => new RegExp(rep(w), 'g'))
const cut = (text: string) => ALLOW.reduce((acc, re) => acc.replace(re, ' '), text)

/** Spelling tricks tried as extra candidates, each replacing every occurrence: "fuk" for fuck, "niqqer", "kvnt", "shxt", "b1owjob" (biowjob), "shlt". */
const SWAPS: [string, string][] = [['q', 'g'], ['z', 's'], ['v', 'u'], ['y', 'i'], ['x', 'i'], ['l', 'i'], ['i', 'l']]
/** Swaps that only make sense on a short whole word: inside a longer one they would turn "Fukuda" into "fuckuda". */
const WORD_SWAPS: [string, string][] = [['uk', 'uck'], ['kc', 'ck']]
const variants = (text: string, swaps = SWAPS) => [...new Set([text, ...swaps.map(([from, to]) => text.replaceAll(from, to))])]

/** Lower case, no accents or invisible characters, look-alike letters and digits mapped to Latin letters. A zero can stand for o or u ("f0ck" is fock or fuck), so the caller picks. */
function normalise(name: string, zero: 'o' | 'u' = 'o'): string {
  const base = name.normalize('NFKD').replace(/[̀-ͯ​-‏⁠﻿­]/g, '').toLowerCase()
  return Array.from(base, (c) => HOMOGLYPH[c] ?? (c === '0' ? zero : LEET[c]) ?? c).join('')
}

/** True when the name is one nobody may take (see RESERVED_PREFIXES). */
export function isReserved(name: string): boolean {
  const words = normalise(name).split(/[^a-z]+/).filter(Boolean)
  const letters = words.join('').replace(/^the/, '')
  return words.some((w) => RESERVED_WORDS.includes(w)) || RESERVED_PREFIXES.some((w) => letters.startsWith(w))
}

/**
 * True when the name holds a slur or obscenity. The name is normalised (case, accents, look-alike letters, leetspeak; a zero is tried as o and as u), then tested as:
 * each word on its own; runs of one- and two-letter pieces joined ("f u c k", "f.u.c.k"); and, for strong words of five letters or more (and, when the name has several pieces, fuck, shit, cunt, dick, cock), the whole
 * name with every separator removed ("fuc k", "d.ick", "pornstar"). Repeated letters are tolerated, a leading or trailing run of x is ignored ("xxfagxx"), and each text also gets the SWAPS. Innocent words that contain a blocked one are cut out first.
 */
export function isBlocked(name: string): boolean {
  if (isNumberCode(name.normalize('NFKD'))) return true
  return (['o', 'u'] as const).some((zero) => blockedAfter(normalise(name, zero)))
}

function blockedAfter(text: string): boolean {
  const pieces = text.split(/[^a-z]+/).filter(Boolean)
  const words = pieces.join(' ')
  if (ALLOWED_NAMES.includes(words)) return false
  if (PHRASES.some((re) => re.test(words))) return true
  const candidates: string[] = []
  let run = ''
  for (const p of pieces) {
    if (p.length <= 2) run += p
    else {
      if (run) candidates.push(run)
      run = ''
      candidates.push(p)
    }
  }
  if (run) candidates.push(run)
  for (const c of candidates) {
    const rest = cut(c)
    if (variants(rest).some((v) => ANYWHERE.some((re) => re.test(v)) || SLUR_PATTERNS.some((re) => re.test(v)))) return true
    const word = rest.trim()
    if ([word, word.replace(/^x+|x+$/g, '')].some((w) => variants(w, [...SWAPS, ...WORD_SWAPS]).some((v) => WHOLE.some((re) => re.test(v))))) return true
  }
  const joined = cut(pieces.join(''))
  if (variants(joined).some((v) => BLOCKED_ANYWHERE.some((w, i) => w.length >= 5 && ANYWHERE[i]!.test(v)))) return true
  // A name split over several pieces ("fuc k", "d.ick") also gets the four-letter strong words; a single word keeps the stricter whole-word rule (Cockney), and so does a name of only longer pieces (Shi Tomasi).
  return pieces.length > 1 && pieces.some((p) => p.length <= 2) && variants(joined).some((v) => JOINED_SHORT.some((re) => re.test(v)))
}

export function checkName(raw: unknown): NameCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a name.' }
  const name = raw.replace(/\s+/g, ' ').trim()
  if (name.length === 0) return { ok: false, error: 'Enter a name.' }
  if (name.includes('@') || /:\/\//.test(name) || /\bwww\./i.test(name) || /\.(com|net|org|io|app|dev|gg|ly)\b/i.test(name)) return { ok: false, error: 'Just a name, no links or emails.' }
  if (name.length > NAME_MAX) return { ok: false, error: `Keep it to ${NAME_MAX} characters.` }
  if (!ALLOWED.test(name)) return { ok: false, error: 'Letters, numbers, spaces and . _ - only.' }
  if (isReserved(name)) return { ok: false, error: 'That name is reserved.' }
  if (isBlocked(name)) return { ok: false, error: 'Pick a different name.' }
  return { ok: true, name }
}

/** What a board shows for a player who never gave a name: "guest" and the last 4 characters of the id. */
export function guestLabel(id: string): string {
  return `guest ${id.replace(/[^0-9a-f]/gi, '').slice(-4) || '0000'}`
}

/** Adds " 2", " 3" to a repeated name, in the order the rows are given (the first keeps the plain name). */
export function withSuffixes(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const key = n.toLowerCase()
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    return count === 1 ? n : `${n} ${count}`
  })
}
