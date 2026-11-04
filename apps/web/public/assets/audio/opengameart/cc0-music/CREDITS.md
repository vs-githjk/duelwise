# Music and stingers: sources and licences

Every file here was downloaded on 2026-10-30 from OpenGameArt (https://opengameart.org), where each page states the licence as CC0 1.0 Universal (public domain dedication). CC0 needs no attribution and no sign-up; we credit anyway. The licence text is in `LICENSE.txt` beside this file.

The files were re-encoded for the web (MP3, stereo, 44.1 kHz, 80 kbps for loops and 96 kbps for stingers, loudness normalised, tags removed). The stingers are cut short with a fade out. Nothing else was changed.

| File here | Title | Author | Source page | Original file | Licence |
|---|---|---|---|---|---|
| `music/board.mp3` | relax_background1 | joaquinton | https://opengameart.org/content/relaxbackground1 | `relax_background1.ogg` | CC0 1.0 |
| `music/poker.mp3` | jazz improvisation looped | Pro Sensory | https://opengameart.org/content/jazz-improvisation-looped | `jazz_improv_looped_1.mp3` | CC0 1.0 |
| `music/action.mp3` | Determined Pursuit (epic orchestra loop) | Emma_MA | https://opengameart.org/content/determined-pursuit-epic-orchestra-loop | `determined_pursuit_loop.wav` | CC0 1.0 |
| `stingers/win.mp3` | Win Jingle | Fupi | https://opengameart.org/content/win-jingle | `winfretless.ogg`, first 2.3 s | CC0 1.0 |
| `stingers/loss.mp3` | Game over short jingle | Kosmo The Cat | https://opengameart.org/content/game-over-short-jingle | `Game over jingle.mp3`, first 3 s | CC0 1.0 |

Music plays only during a match (from Start to the result); every other page is silent. Where each plays: board on Chess, Four in a Row, Word Duel, Stormglass and Crosscurrent; poker on Hold'em; action on Tinderbox, Coldstore and Twelve Yards; win and loss stingers on the result of all nine games.

Crosscurrent's other cues (a disc placed by you or by the opponent, the flip ripple, a corner, a pass, a draw) are not files: they are tones the page synthesises in the browser with Web Audio, so there is nothing to license or credit beyond the music and stingers above.

Twelve Yards' ball cues (the boot on the ball, the net, the keeper's glove, a ball past the goal) are not files: they are filtered noise and tones the page synthesises with Web Audio in `apps/web/src/games/penalty/sounds.ts`. Its crowd and whistle are the recordings in `../crowd/`, credited below. The same file also holds a synthesised version of each (a trilled pea whistle, a vowel-filtered crowd) that plays if a recording has not loaded or fails to load.

## Twelve Yards crowd and whistle (`../crowd/`)

Downloaded 2026-11-04. Each source page states CC0 (OpenGameArt: licence field "CC0"; Wikimedia Commons: licence "CC0 1.0 Universal Public Domain Dedication"). No sign-up or payment was needed. Re-encoded to mono 44.1 kHz MP3 at 64 kbps, trimmed, faded, mixed where noted, and levelled to the peak shown, tags removed. No cheer contains a spoken word: the cheers are a real stadium crowd and applause (checked with Whisper base speech recognition, see below).

| Source recording | Author | Source page | Licence |
|---|---|---|---|
| `Match amical France-USA - 58241 spectateurs - Action ratee sur faute 21h38.ogg` (a stadium crowd, 49.8 s) | Romainbehar | https://commons.wikimedia.org/wiki/File:Match_amical_France-USA_-_58241_spectateurs_-_Action_rat%C3%A9e_sur_faute_21h38.ogg | CC0 |
| `277021_sandermotions_applause-2.wav` (applause) | Sandermotions | https://commons.wikimedia.org/wiki/File:277021_sandermotions_applause-2.wav (from https://freesound.org/people/Sandermotions/sounds/277021/) | CC0 |
| `oooooooooo.ogg` (OoOoOoOoOoOoOo, a group "ooh", used for the two groans) | AuraVoice, posted by Nocturnal_Vanguard | https://opengameart.org/content/oooooooooooooo | CC0 |
| `218318_splicesound_referee-whistle-blow-gymnasium.wav` (Referee's whistle blowing inside a gymnasium) | SpliceSound | https://commons.wikimedia.org/wiki/File:218318_splicesound_referee-whistle-blow-gymnasium.wav (from https://freesound.org/people/SpliceSound/sounds/218318/) | CC0 |

| File here | Made from | Length | Size | Peak | Whisper (base) |
|---|---|---|---|---|---|
| `crowd/cheer.mp3` (your goal) | stadium crowd 33.5 s to 35.7 s mixed with applause 12 s to 14.2 s (at 0.8) | 2.2 s | 18.2 KB | -6.6 dBFS | empty |
| `crowd/cheerBig.mp3` (you win) | stadium crowd 32.5 s to 36.1 s mixed with applause 12 s to 15.6 s | 3.6 s | 29.3 KB | -4.3 dBFS | "Oh" |
| `crowd/cheerSave.mp3` (your save) | stadium crowd 12 s to 13.3 s | 1.3 s | 10.9 KB | -9.4 dBFS | empty |
| `crowd/groan.mp3` (your kick fails) | OoOoOo, 1.5 s from 0.15 s, low-passed at 3.8 kHz | 1.5 s | 12.6 KB | -9.5 dBFS | "Oh" / "Mmm" |
| `crowd/groanBig.mp3` (you lose) | OoOoOo from 0.1 s, slowed by 7 percent (deeper), 2.1 s | 2.1 s | 17.4 KB | -8.4 dBFS | empty / "Mmm" |
| `crowd/whistleStart.mp3` (kick-off) | the whistle's first blast (0.128 s to 0.548 s) | 0.42 s | 4.0 KB | -9.1 dBFS | empty |
| `crowd/whistleFull.mp3` (full time) | the same blast cut to two short ones (0.17 s) and a long one (0.42 s) | 1.04 s | 8.8 KB | -10.4 dBFS | empty |

Speech check: `whisper` base model, `transcribe(file, fp16=False, language='en')`, run three times per file (its default decoding is random when unsure, so it also invents stock phrases on any noisy clip, even pure applause). The vocables and empty results above were stable across runs. The page plays each file at a gain of 0.55 to 0.7 (`FILE_GAIN` in `sounds.ts`), so the loudest cue peaks at about 0.43 of full scale before the master volume, under the boot on the ball (0.5).
