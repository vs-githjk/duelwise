# Word Duel lists: provenance

Source: SCOWL (Spell Checking Oriented Word Lists) release 2020.12.07 by Kevin Atkinson, notice licence (see docs/third-party/word.md).
Download: https://downloads.sourceforge.net/wordlist/scowl-2020.12.07.tar.gz
Archive SHA-256: 5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc
SCOWL builds on public domain sources (12dicts and ENABLE among them); the copyright file in the archive lists each.

Built by scripts/data/build-wordlists.ts, deterministic:

- Members read: final/english-words.<size>, final/american-words.<size> for sizes 10, 20, 35, 40, 50, 55, 60, 70.
- Kept: lowercase a-z words of exactly five letters.
- answers.txt: sizes 10, 20, 35 (SCOWL size 35 or less), ordered from most common (lowest size) to least, alphabetical within a size. Line order is the commonness rank the Medium level uses.
- allowed.txt: sizes up to 70 (SCOWL size 70 or less), alphabetical. Every answer is also allowed.
- Inflections: a word that is a plural, third-person -s form, -ed form, comparative (-er), superlative (-est) or -ing form of a shorter SCOWL word (size 70 or less, stems of 3 to 5 letters) is dropped from answers.txt and stays in allowed.txt, so it is still a valid guess. keep-inflected.txt lists the hand-reviewed words that only look inflected and stay answers; drop-inflected.txt lists the hand-reviewed inflections the stem check misses.
- exclude.txt: hand-kept offensive words, removed from both lists.
- guess-only.txt: hand-kept, alphabetical. Words from exclude.txt that have an ordinary meaning (Nov 3 2026: owner's call) and may be guessed but never be an answer. Each is checked here to be in SCOWL size 70 or less (a miss stops the build; dicky was proposed and is not in those tiers, so it stays blocked). They sit after the last allowed.txt word in the action encoding, in file order (index = allowed.txt length + line), so every index in a stored match record is unchanged, and the solver, first-guesses and measure never see them (the AI's guess pool is allowed.txt only). Never reorder or remove a line: the index is part of stored records.
- No list from any game site or newspaper, and no web-frequency data.

| file | words | SHA-256 |
| --- | --- | --- |
| answers.txt | 1975 | f38852f396ae92dd72fb2c108ffef45e11aea4ab8583dfea18de7f6815b2486e |
| allowed.txt | 6377 | 37a8bd2e58b71f24fd0a0961dca88237c43239e64d32234b382fbd7103183328 |
| guess-only.txt | 9 | 46bf37bffa2407befbdefd838a947a766d3deff515b7fb73c69b018408e99a0d |
| exclude.txt | 71 | ac36133749dec9dc490debd3a9655dfeedb470a6f71cab0cc8fe8b1cd9152dad |
| keep-inflected.txt | 122 | f400a3efc26ef974e49087df90ea222723407b0ffcd0c9d9f0c6b2e5ee9ff9d4 |
| drop-inflected.txt | 23 | 5536faf7a01a900590c514b739d28306d5a04d3ad7620fe656a0a6e80b18f5ad |
