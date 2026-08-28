"""Sizing: same dollars at every stop, clamped so a tilt never becomes a
lever. Crowding: correlated tapes score high, independent ones low, and
the guard abstains rather than guessing from thin data."""

import math
import random

import polars as pl
import pytest

from app.crowding import MIN_HELD, crowding_scores
from app.sizing import REFERENCE_STOP, SIZE_CLAMP, equal_risk_capital


class TestEqualRiskCapital:
    BOOK = 200_000_0000  # $200k in E4
    SLOTS = 8

    def _size(self, stop):
        return equal_risk_capital(self.BOOK, self.SLOTS, [{"symbol": "X", "stop_pct": stop}])["X"]

    def test_reference_stop_fills_exactly_one_slice(self):
        assert self._size(REFERENCE_STOP) == self.BOOK // self.SLOTS

    def test_dollar_risk_is_equal_across_stops_inside_the_clamp(self):
        # capital * stop = dollars lost at the stop — flat by design.
        for stop in (0.12, 0.15, 0.20):
            assert self._size(stop) * stop == pytest.approx(
                (self.BOOK / self.SLOTS) * REFERENCE_STOP, rel=1e-6
            )

    def test_clamps_bound_the_tilt(self):
        slice_e4 = self.BOOK / self.SLOTS
        assert self._size(0.05) == int(round(SIZE_CLAMP[1] * slice_e4))  # tight stop, capped up
        assert self._size(0.30) == int(round(SIZE_CLAMP[0] * slice_e4))  # wide stop, floored

    def test_unknown_risk_gets_the_neutral_slice_never_a_levered_one(self):
        for bad in (None, 0.0, 1.5):
            got = equal_risk_capital(self.BOOK, self.SLOTS, [{"symbol": "X", "stop_pct": bad}])["X"]
            assert got == self.BOOK // self.SLOTS

    def test_degenerate_book_sizes_to_zero(self):
        assert equal_risk_capital(0, 8, [{"symbol": "X", "stop_pct": 0.15}])["X"] == 0
        assert equal_risk_capital(self.BOOK, 0, [{"symbol": "X", "stop_pct": 0.15}])["X"] == 0


def _bars(series: dict[str, list[float]]) -> pl.DataFrame:
    rows = []
    for sym, closes in series.items():
        for i, c in enumerate(closes):
            rows.append({"symbol": sym, "day": f"d{i:04d}", "close": c})
    return pl.DataFrame(rows)


class TestCrowdingScores:
    def _tapes(self):
        rng = random.Random(7)
        factor = [rng.gauss(0, 0.02) for _ in range(80)]

        def px(loading, noise):
            p, out = 100.0, []
            for f in factor:
                p *= math.exp(loading * f + rng.gauss(0, noise))
                out.append(p)
            return out

        return {
            "H1": px(1.0, 0.004),
            "H2": px(1.0, 0.004),
            "H3": px(1.0, 0.004),
            "TWIN": px(1.0, 0.004),   # same factor: crowded
            "LONER": px(0.0, 0.02),   # pure noise: diversifying
        }

    def test_a_factor_twin_scores_high_and_a_loner_low(self):
        tapes = self._tapes()
        scores = crowding_scores(_bars(tapes), ["H1", "H2", "H3"], ["TWIN", "LONER"])
        assert scores["TWIN"]["avg_corr"] > 0.8
        assert scores["LONER"]["avg_corr"] < 0.3
        assert scores["TWIN"]["n_held_used"] == 3

    def test_abstains_below_min_held(self):
        tapes = self._tapes()
        scores = crowding_scores(_bars(tapes), ["H1"], ["TWIN"])
        assert "TWIN" not in scores
        assert MIN_HELD > 1

    def test_abstains_on_missing_history(self):
        tapes = self._tapes()
        scores = crowding_scores(_bars(tapes), ["H1", "H2", "H3"], ["GHOST"])
        assert scores == {}
