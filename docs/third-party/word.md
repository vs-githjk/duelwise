# Word Duel: third-party data

## SCOWL (Spell Checking Oriented Word Lists)

- Release 2020.12.07 by Kevin Atkinson, from https://downloads.sourceforge.net/wordlist/scowl-2020.12.07.tar.gz (archive SHA-256 5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc).
- Used for: the answer list (SCOWL size 35 or less) and the allowed guess list (size 70 or less), five-letter lowercase words only, minus our own exclude list. See packages/core/src/games/word/lists/SOURCE.md for the exact build and list checksums.
- Licence: SCOWL notice licence. Copyright 2000-2018 by Kevin Atkinson. Permission to use, copy, modify, distribute and sell these word lists, the associated scripts, the output created from the scripts, and its documentation for any purpose is hereby granted without fee, provided that the above copyright notice appears in all copies and that both that copyright notice and this permission notice appear in supporting documentation. Kevin Atkinson makes no representations about the suitability of this array for any purpose. It is provided "as is" without express or implied warranty.
- SCOWL is built from several sources, among them 12Dicts and ENABLE (public domain), Moby Words II (public domain) and others; the archive's Copyright file lists each with its terms and is reproduced in full in the SCOWL notice section of THIRD_PARTY.md.

## Not used

No list from any newspaper or game site and no web-frequency data. Commonness ranking comes from SCOWL's own size tiers.
