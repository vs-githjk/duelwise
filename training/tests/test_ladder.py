import pytest

from trainer.ladder import Z99, check_monotone, interim_look, ladder_to_elo, promotion_gate, wilson


def test_wilson_220_of_400_matches_the_ts_harness_to_four_decimals():
    # packages/agents/src/measure/ladder.ts: wilson(220, 400) -> [0.5010009981940384, 0.5980477723576684]
    lo, hi = wilson(220, 400)
    assert round(lo, 4) == 0.5010 and round(hi, 4) == 0.5980
    lo99, hi99 = wilson(220, 400, Z99)
    assert round(lo99, 4) == 0.4856 and round(hi99, 4) == 0.6127


def test_wilson_edges():
    assert wilson(0, 0) == (0.0, 1.0)
    assert wilson(400, 400)[1] == 1.0 and round(wilson(400, 400)[0], 4) == 0.9905
    assert wilson(0, 10)[0] == 0.0


def test_interim_look_stops_only_at_a_planned_count_with_a_strong_bound():
    assert interim_look(80, 100, [100, 200])
    assert not interim_look(80, 101, [100, 200])  # not a planned look
    assert not interim_look(55, 100, [100, 200])  # bound too weak


def pair(lower, upper, points, n=400):
    return {"lower": lower, "upper": upper, "points": points, "n": n}


def test_check_monotone_accepts_separated_levels_and_names_the_failure_otherwise():
    ok, failures = check_monotone([pair("easy", "medium", 280), pair("medium", "hard", 290), pair("hard", "champion", 300)])
    assert ok and failures == []
    ok, failures = check_monotone([pair("easy", "medium", 280), pair("medium", "hard", 205), pair("hard", "champion", 300)])
    assert not ok
    assert failures[0].startswith("hard does not beat medium: score 0.5125 over 400 games")


def test_ladder_to_elo_anchors_easy_at_1000_and_chains_gaps():
    elo = ladder_to_elo([pair("easy", "medium", 280), pair("medium", "hard", 280)])
    assert elo["easy"] == 1000 and elo["medium"] > 1000 and elo["hard"] > elo["medium"]
    with pytest.raises(ValueError):
        ladder_to_elo([pair("easy", "hard", 280)])


@pytest.mark.parametrize(
    "points,n,passed",
    [(240, 400, True), (220, 400, True), (219, 400, False), (208, 400, False), (300, 399, False), (600, 800, True)],
)
def test_promotion_gate(points, n, passed):
    g = promotion_gate(points, n)
    assert g["passed"] is passed
    assert bool(g["reasons"]) is (not passed)


def test_promotion_gate_requires_the_lower_bound_not_just_the_score():
    g = promotion_gate(8, 10, min_games=10)  # 0.8 on 10 games: lower bound 0.49
    assert not g["passed"] and "lower bound" in g["reasons"][0]
