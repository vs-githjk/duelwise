# data/

Raw and cached training data. `data/raw/` and `data/cache/` are gitignored and live in the common root
(the main checkout), shared by every worktree and job. Nothing here is committed except this file.

## Lichess (chess)

Source: the Lichess open database, https://database.lichess.org/. Licence, quoted from that page:

> Database exports are released under the Creative Commons CC0 license. Use them for research, commercial purpose, publication, anything you like.

Files used, both streamed (never stored whole) by `scripts/data/fetch-lichess.sh`:

- Standard rated games, one month: `https://database.lichess.org/standard/lichess_db_standard_rated_<YYYY-MM>.pgn.zst` (the newest listed in https://database.lichess.org/standard/list.txt; 2026-09 is 29.2 GB compressed).
- Engine evaluations: `https://database.lichess.org/lichess_db_eval.jsonl.zst` (22.4 GB compressed).

Transfer is capped by byte count before decompression: 14 GB for the games, 4 GB for the evaluations, 18 GB at most in total (the project budget is 20 GB). Both readers stop, and so stop the download, as soon as their targets are met.

### Policy shards: `data/cache/chess/{b1100,b1500,b1900}/`

Games where both players are within 100 of 1100, 1500 or 1900 and the base time is at least 180 s (`TimeControl`), with a real result and not abandoned. The first 8 plies are skipped, then up to 10 positions per game are sampled (seeded by the game id, so reruns pick the same ones). Target: 1,000,000 positions per bucket. Each bucket directory holds `shard-00000.bin ...` (100,000 records each) and `index.json` (record layout, shard list, counts), updated after every shard, so a stopped job leaves usable data.

Policy record, 600 bytes, little endian, everything from the mover's side (the board is flipped when black moves, so "own" pieces always start at the bottom; see `packages/core/src/games/chess/position.ts`):

| bytes | field |
|---|---|
| 0..63 | board, relative square (rank * 8 + file, a1 = 0) to piece code: 0 empty, 1..6 own P N B R Q K, 7..12 opponent |
| 64 | castling bits: own kingside 1, own queenside 2, opponent kingside 4, opponent queenside 8 |
| 65 | en passant target (relative square) or 255 |
| 66 | halfmove clock, clamped to 255 |
| 67 | game result for the mover: 0 loss, 1 draw, 2 win |
| 68..69 | u16 index of the move played (relative policy index, below 4168; `policy-index.ts`) |
| 70..71 | u16 ply of the position in its game |
| 72..592 | legal-move mask, 521 bytes: bit `i & 7` of byte `72 + (i >> 3)` set when relative move index `i` is legal |
| 593..599 | zero |

The plane input for a record is `encodeRel` in `encode.ts` (18 planes, documented there); the Python trainer rebuilds the same planes from the board, castling, en passant and halfmove fields.

### Value shards: `data/cache/chess/value/`

Positions from the evaluation database, target 3,000,000. For each line the deepest evaluation's first line is used. Scores are from White's point of view (checked on 5,000 lines: with black to move the best line has the lowest cp, and mate +1 with black to move is delivered by White). Target is the mover's expected score, `1 / (1 + 10^(-cp / 400))` for centipawns, 1 or 0 for mates. A few lines hold impossible positions (more than 32 pieces); they are skipped and counted in `value/stats.json`.

Value record, 68 bytes: 32 x u16 active features (768 features = 12 piece kinds x 64 relative squares, ascending, padded with 65535), then f32 target.

### Rates measured on this machine (2026-10-21, one core, 3-minute and 1-minute samples)

- Games: 3,940 positions per second, 1,830 games per second scanned. The rarest bucket (1100) fills at about 800 positions per second, so 1,000,000 per bucket takes about 21 minutes and about 0.75 GB transferred.
- Evaluations: 6,100 positions per second, so 3,000,000 takes about 8 minutes and about 0.3 GB transferred.

### Run

```
scripts/data/fetch-lichess.sh all            # the whole job (the supervisor runs this as chess-data)
scripts/data/fetch-lichess.sh all --sample   # about 4 minutes into data/cache/chess-sample, to measure rates
```
