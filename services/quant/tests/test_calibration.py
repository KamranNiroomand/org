"""The grader's contract: outcomes are sector-relative and leave-one-out,
immature turns stay pending rather than silently vanishing, and a
prophet beats a coin which beats a contrarian."""

import polars as pl

from app.calibration import brier_scores


def _bars():
    rows = []
    # 30 sessions; AAA doubles while its sector peers drift, BBB flat.
    for i in range(30):
        day = f"d{i:04d}"
        rows.append({"symbol": "AAA", "day": day, "close": 100.0 * (1.03 ** i)})
        for peer in ("P1", "P2", "P3"):
            rows.append({"symbol": peer, "day": day, "close": 100.0 * (1.005 ** i)})
        rows.append({"symbol": "BBB", "day": day, "close": 100.0})
    return pl.DataFrame(rows)


SECTORS = {"AAA": "Tech", "P1": "Tech", "P2": "Tech", "P3": "Tech", "BBB": "Tech"}


def test_prophet_beats_coin_beats_contrarian():
    turns = [
        {"specialist": "prophet", "symbol": "AAA", "day": "d0000", "prob_up": 0.9},
        {"specialist": "coin", "symbol": "AAA", "day": "d0000", "prob_up": 0.5},
        {"specialist": "contrarian", "symbol": "AAA", "day": "d0000", "prob_up": 0.1},
    ]
    out = brier_scores(turns, _bars(), SECTORS, horizon=21)
    s = out["specialists"]
    assert s["prophet"]["brier"] < s["coin"]["brier"] < s["contrarian"]["brier"]
    assert out["scoreable"] == 3


def test_immature_turns_are_pending_not_dropped():
    turns = [{"specialist": "x", "symbol": "AAA", "day": "d0025", "prob_up": 0.7}]
    out = brier_scores(turns, _bars(), SECTORS, horizon=21)
    assert out["scoreable"] == 0
    assert out["pending"] == 1


def test_weekend_reads_snap_to_the_next_session():
    # "d0000x" sorts between d0000 and d0001 — a non-session day.
    turns = [{"specialist": "x", "symbol": "AAA", "day": "d0000x", "prob_up": 0.9}]
    out = brier_scores(turns, _bars(), SECTORS, horizon=21)
    assert out["scoreable"] == 1


def test_underperformer_graded_against_its_sector_not_zero():
    # BBB is flat while peers (incl. the soaring AAA) rise: outcome 0,
    # so a bullish 0.8 grades badly and a bearish 0.2 grades well.
    turns = [
        {"specialist": "bull", "symbol": "BBB", "day": "d0000", "prob_up": 0.8},
        {"specialist": "bear", "symbol": "BBB", "day": "d0000", "prob_up": 0.2},
    ]
    out = brier_scores(turns, _bars(), SECTORS, horizon=21)
    assert out["specialists"]["bear"]["brier"] < out["specialists"]["bull"]["brier"]
