import { expect, test } from 'bun:test'
import { checkName, guestLabel, isBlocked, withSuffixes } from './display-name'

test('trims, collapses spaces and keeps the typed case', () => {
  expect(checkName('  Mika   R.  ')).toEqual({ ok: true, name: 'Mika R.' })
})
test('rejects empty, too long and odd characters', () => {
  expect(checkName('   ').ok).toBe(false)
  expect(checkName('a'.repeat(25)).ok).toBe(false)
  expect(checkName('a'.repeat(24)).ok).toBe(true)
  expect(checkName('hi <b>').ok).toBe(false)
  expect(checkName(42).ok).toBe(false)
})
test('rejects links and emails with the plain sentence', () => {
  for (const bad of ['me@example.com', 'https://x.io', 'www.thing', 'cool.com']) expect(checkName(bad)).toEqual({ ok: false, error: 'Just a name, no links or emails.' })
})
test('blocklist catches spaced and leet spellings but not innocent names', () => {
  expect(isBlocked('f u c k')).toBe(true)
  expect(isBlocked('sh1t')).toBe(true)
  expect(isBlocked('Dickens')).toBe(false)
  expect(isBlocked('Cumin')).toBe(false)
  expect(isBlocked('Scunthorpe')).toBe(false)
  expect(isBlocked('Mika')).toBe(false)
  expect(isBlocked('Ines K.')).toBe(false)
  expect(isBlocked('KKK')).toBe(true)
  expect(isBlocked('k k k')).toBe(true)
  expect(isBlocked('Tomás R.')).toBe(false)
})
test('blocklist catches embedded words, repeats, separators, leetspeak and look-alike letters', () => {
  const bad = [
    'Nigga', 'n1gg4', 'N.i.g.g.e.r', 'niiiigga', 'Nigger', 'fucker', 'fuckyou', 'xXfuckXx', 'fuuuuck', 'f_u_c_k', 'f.u.c.k', 'phuck', 'Shitty', 'sh1thead',
    'bullshit', 'Pornstar', 'pornstar99', 'p0rnstar', 'nazis', 'Nazi', 'hitler', 'HITLER', 'Hitler_Fan', 'f u c k er', 'a s s h o l e', 'cunt', 'c u n t',
    'Bitches', 'b1tch', 'whore', 'slutty', 'pussy', 'penis', 'vagina', 'faggot', 'f4ggot', 'retard', 'Retarded', 'tranny', 'chinky', 'wetback', 'Wanker',
    'dickhead', 'Dick', 'dicks', 'cock', 'cocksucker', 'rapist', 'rape', 'rapes', 'cum', 'cumshot', 'jizz', 'porn', 'sex', 'Kike', 'spic', 'coon', 'paki',
    'KKK', 'k k k', 'k.k.k', 'kkkk', 'fuck', '\u0455hit', 'fu\u0441k', '\u03b1sshole', 'f\u200buck', 'ｆｕｃｋ', 'FUCK', 'masturbator', 'bollocks', 'dildo',
    'fuc k', 'shi t', 'd.ick', 'c ock', 'cun t', 'fucc', 'phuk', 'fuq', 'fuxk', 'cvnt', 'kunt', 'bytch', 'azzhole', 'c0ckz', 'whoar', 'nigr', 'biatch', 'dlck', 'suckmydick',
  ]
  for (const name of bad) expect([name, isBlocked(name)]).toEqual([name, true])
})
test('blocklist leaves ordinary names, places and words alone', () => {
  const ok = [
    'Grape', 'Spicy Pete', 'Spice', 'Peacock', 'Hancock', 'Hitchcock', 'Woodcock', 'Shiitake', 'Cocktail', 'Cockpit', 'Rapha', 'Pedro', 'Cocoon', 'Raccoon',
    'Nigel', 'Niger', 'Nigeria', 'Nigerian', 'Nigam', 'Dickens', 'Dickinson', 'Cassidy', 'Cumin', 'Cucumber', 'Scunthorpe', 'Penistone', 'Therapist',
    'Assist', 'Classic', 'Assassin', 'Massimo', 'Hassan', 'Essex', 'Sussex', 'Arsenal', 'Titan', 'Title', 'Pakistan', 'Nazir', 'Nazia', 'Pornthip',
    'Mika', 'Priya', 'Ines K.', 'Tom\u00e1s R.', 'Jos\u00e9', 'Zo\u00eb', 'Bj\u00f6rn', 'Ben Iggy', 'Ron Iggins', 'Higgins', 'Fukuda', 'Fukushima', 'Mikey',
    'Cooper', 'Cook', 'Kai', 'KK', 'Kim Kay', 'Dyer', 'Sasha', 'Shi Tomasi', 'Class Act', 'Pass Hold', 'Mississippi', 'Player 1', 'Bot 2000', 'xX_Ninja_Xx',
    'Ivan Petrov', '\u0418\u0432\u0430\u043d', '\u5c71\u7530', 'Rocky', 'Tracy', 'Chin Lee', 'Chinook', 'Analyst', 'Mishit', 'Bastille',
    'Shitake', 'Phuket', 'Cockney', 'Dickson', 'Cass Idy', 'Scun Thorpe',
  ]
  for (const name of ok) expect([name, isBlocked(name)]).toEqual([name, false])
})
test('checkName refuses a blocked name with the plain sentence', () => {
  expect(checkName('Shitty')).toEqual({ ok: false, error: 'Pick a different name.' })
  expect(checkName('Cassidy')).toEqual({ ok: true, name: 'Cassidy' })
})
test('guest label and collision suffixes', () => {
  expect(guestLabel('0a1b2c3d-1111-2222-3333-4444555566ab')).toBe('guest 66ab')
  expect(withSuffixes(['Mika', 'Priya', 'mika', 'Mika'])).toEqual(['Mika', 'Priya', 'mika 2', 'Mika 3'])
})

test('blocklist catches extremist, ethnic, sexual and misspelt hostile names (reviewer probe, round 2)', () => {
  const bad = [
    // extremist
    '1488', 'Heil14_88', 'WP 1488', '88', 'Sieg Heil', 'SiegHeil', 'Adolf', 'Gas the jews', 'Kill jews', 'Kill All Jews', 'Auschwitz', 'Holocaust Hoax', 'Whitepower',
    'White Power', 'White Pride', 'Aryan Nation', 'AryanBrotherhood', 'Kill Yourself', 'KillUrSelf', 'Hang Yourself', 'Die in a fire', 'Gas Chamber', 'Lynch Mob', 'Camel Jockey', 'Sambo', 'Redskin', 'Chinaman', 'Libtard', 'Rimjob', 'Ballsack', 'Kurwa', 'Puta', 'Hurensohn', 'Cyka Blyat', 'Vaffanculo', 'Sturmfuhrer', 'Zionist Pig', 'Third Reich', 'Third_Reich', 'SS Officer', 'Goebbels', 'Blood and Soil',
    // ethnic
    'Niqqer', 'Jigaboo', 'Porchmonkey', 'Chingchong', 'Ching Chong', 'Slanteye', 'Spick', 'Kyke', 'Injun', 'Jap', 'Jappo', 'Kebab Remover', 'Muzzie', 'Mudslime',
    // lgbtq and sexual
    'Fagit', 'Trannie', 'Sodomite', 'Fudgepacker', 'Poofter', 'Poof', 'Batty boy', 'Cumdump', 'Cumguzzler', 'B1owjob', 'BigD1ck', 'Asswipe', 'DickSlap', 'Mutha fukka',
    // variants
    'Raep', 'Rapeface', 'shlt', 'shxt', '\u0192uck', 'f0ck', 'fugk', 'fock', 'efff u', 'Fahk', 'Shyte', 'Shiat', 'Sheeit', 'Beyatch', 'Biotch', 'Kvnt', 'Pusay', 'Pussi',
    'Fcuk', 'Dikhead', 'Dikk', 'Dik', 'Diq', 'u r a f a g', 'xxfagxx', 'FagLord',
  ]
  for (const name of bad) expect([name, checkName(name).ok]).toEqual([name, false])
})
test('names that only look like a blocked word stay allowed', () => {
  const ok = [
    'Aryan', 'Aryan Sharma', 'Aryana', 'Staffan', 'Rooney', 'Rootsy', 'Dikshit', 'Shittu', 'Shitij', 'Pennis', 'Kuntz', 'Dick Van Dyke', 'Paki Raza', 'Scunthorpe', 'Dickens', 'Cassidy', 'Cockney', 'Phuket', 'Shitake',
    'Moe', 'Ada', 'Nazia', 'Aryana', 'Jasper', 'Kim', 'Mohammed', 'Priya', 'Hans', 'Dominic',
  ]
  for (const name of ok) expect([name, checkName(name).ok]).toEqual([name, true])
})
test('reserved names get their own message, as a word or a prefix', () => {
  const reserved = ['Admin', 'Administrator', 'Duelwise', 'Duelwise Staff', 'Moderator', 'Mod', 'Support', 'Official', 'System', 'Root', 'Staff Team', 'The Duelwise Team', 'Adm1n', 'Admin_42', 'SupportBot', 'Mod Squad']
  for (const name of reserved) expect([name, checkName(name)]).toEqual([name, { ok: false, error: 'That name is reserved.' }])
  for (const name of ['Modi', 'Mika', 'Staffan', 'Rooney', 'Modesto']) expect([name, checkName(name).ok]).toEqual([name, true])
})
