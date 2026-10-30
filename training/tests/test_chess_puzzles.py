import json

from trainer.chess import puzzles


def row(i, rating, rd=50, plays=500, moves="e2e4 e7e5"):
    return {"PuzzleId": f"p{i:04d}", "FEN": "x", "Moves": moves, "Rating": str(rating), "RatingDeviation": str(rd), "NbPlays": str(plays), "Themes": "mate short"}


def test_band_edges():
    assert puzzles.band_of(399) is None
    assert puzzles.band_of(400) == 0
    assert puzzles.band_of(899) == 0
    assert puzzles.band_of(900) == 1
    assert puzzles.band_of(3999) == len(puzzles.BANDS) - 1
    assert puzzles.band_of(4000) is None


def test_sample_is_stratified_seeded_and_filtered():
    rows = [row(i, 400 + (i * 37) % 3000) for i in range(5000)]
    rows += [row(9000, 1000, rd=300), row(9001, 1000, plays=3), row(9002, 1000, moves="e2e4")]
    a = puzzles.sample_puzzles(rows, 20, seed=1)
    b = puzzles.sample_puzzles(rows, 20, seed=1)
    c = puzzles.sample_puzzles(rows, 20, seed=2)
    assert a == b and a != c
    for band in range(len(puzzles.BANDS)):
        got = [p for p in a if p["band"] == band]
        assert len(got) == 20
        lo, hi = puzzles.BANDS[band]
        assert all(lo <= p["rating"] < hi for p in got)
    assert not {"p9000", "p9001", "p9002"} & {p["id"] for p in a}
    assert json.dumps(a)
