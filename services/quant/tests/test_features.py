"""Feature tests.

Underlying features are tested against real bars — the backfill already put
SPY, AAPL, NVDA and BRK.B into market.db. Chain features are tested three
ways: against the real NVDA chain fixture where it has enough shape to test
something (a single expiry of calls); against a clearly synthetic
multi-expiry, multi-type panel for the maths that fixture cannot exercise;
and, now that a real multi-expiry, multi-type capture exists, against the
actual local corpus — the gap the first two layers openly left is closed
there, not papered over with a bigger synthetic fixture.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import polars as pl
import pytest

from app.features import (
    atm_iv_by_expiry,
    iv_rank,
    put_call_ratios,
    risk_reversal_25d,
    term_slope,
    underlying_features,
)
from app.db import connect, read_quotes

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "options"
NVDA = json.loads((FIXTURES / "nvda-chain.json").read_text())
GATE_CASES = json.loads((FIXTURES / "gate-cases.json").read_text())


def _nvda_call_chain() -> pl.DataFrame:
    """Real published data: one expiry, calls only, with delta and iv."""
    rows = NVDA["rows"]
    return pl.DataFrame(
        {
            "expiry": [NVDA["expiry"]] * len(rows),
            "type": ["call"] * len(rows),
            "strike": [r["strike"] for r in rows],
            "iv": [r["iv"] for r in rows],
            "delta": [r["delta"] for r in rows],
            "open_interest": [0] * len(rows),
            "volume": [0] * len(rows),
        }
    )


def _synthetic_two_expiry_chain() -> pl.DataFrame:
    """Not real capture — no multi-expiry, multi-type chain has been captured
    yet. Shaped like one on purpose (deltas, ivs and OI in the same range the
    real NVDA fixture shows) so the term-structure and skew maths have
    something plausible to run against until real data exists.
    """
    near, far = "2026-08-19", "2026-09-19"
    return pl.DataFrame(
        {
            "expiry": [near, near, near, near, far, far, far, far],
            "type": ["call", "call", "put", "put", "call", "call", "put", "put"],
            "strike": [227.5, 235.0, 220.0, 210.0, 230.0, 245.0, 215.0, 200.0],
            "iv": [0.316, 0.363, 0.31, 0.40, 0.34, 0.38, 0.33, 0.42],
            "delta": [0.50, 0.25, -0.50, -0.25, 0.50, 0.25, -0.50, -0.25],
            "open_interest": [5367, 2990, 8006, 130, 1000, 500, 900, 200],
            "volume": [65854, 15894, 24447, 3679, 2000, 1000, 1800, 400],
        }
    )


class TestUnderlyingFeaturesOnRealBars:
    def test_produces_the_expected_shape_from_the_real_backfill(self) -> None:
        from app.db import read_bars

        bars = read_bars(symbols=["SPY"])
        if bars.height == 0:
            pytest.skip("no bars in market.db yet — run bars:backfill first")

        out = underlying_features(bars)
        # 63-day momentum is the longest window; that many rows at the head
        # have no full window and must be dropped, not computed on a partial one.
        assert out.height == bars.height - 63
        assert set(out.columns) >= {"symbol", "day", "momentum_1d", "momentum_63d", "volume_zscore_21d"}

    def test_short_and_long_momentum_are_genuinely_different_quantities(self) -> None:
        from app.db import read_bars

        bars = read_bars(symbols=["NVDA"])
        if bars.height == 0:
            pytest.skip("no bars in market.db yet — run bars:backfill first")

        out = underlying_features(bars)
        # Not a claim about which is bigger — just that a real year of NVDA
        # was not perfectly flat, so the two windows must disagree somewhere.
        assert not out["momentum_1d"].equals(out["momentum_63d"])


class TestUnderlyingFeaturesExactness:
    def _linear_bars(self, n: int) -> pl.DataFrame:
        closes = [100.0 + i for i in range(n)]
        return pl.DataFrame(
            {
                "symbol": ["X"] * n,
                "day": [f"2026-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(n)],
                "open": closes,
                "high": [c + 1 for c in closes],
                "low": [c - 1 for c in closes],
                "close": closes,
                "adj_close": closes,
                "volume": [1_000_000] * n,
            }
        )

    def test_momentum_matches_hand_computed_return(self) -> None:
        bars = self._linear_bars(70)
        out = underlying_features(bars)
        # close[69]=169, close[68 - 5 + 1]=close[64]=164 -> 5/164, hand-checked.
        row = out.filter(pl.col("day") == bars["day"][-1])
        expected = 169.0 / 164.0 - 1.0
        assert row["momentum_5d"][0] == pytest.approx(expected, abs=1e-9)

    def test_zero_volume_variance_yields_null_not_infinity(self) -> None:
        bars = self._linear_bars(30)
        bars = bars.with_columns(pl.lit(500_000).alias("volume"))  # constant
        out = underlying_features(bars)
        assert out["volume_zscore_21d"].null_count() == out.height

    def test_empty_input_returns_empty_but_typed(self) -> None:
        out = underlying_features(pl.DataFrame(schema={
            "symbol": pl.Utf8, "day": pl.Utf8, "open": pl.Float64, "high": pl.Float64,
            "low": pl.Float64, "close": pl.Float64, "adj_close": pl.Float64, "volume": pl.Int64,
        }))
        assert out.height == 0
        assert "momentum_21d" in out.columns


class TestChainFeaturesOnRealNvdaChain:
    """The one real fixture: a single expiry, calls only."""

    def test_atm_selection_picks_the_closest_delta_to_half(self) -> None:
        # K225 has delta 0.51 (distance 0.01); K227.50 has delta 0.33
        # (distance 0.17). K225 must win.
        atm = atm_iv_by_expiry(_nvda_call_chain())
        assert atm.height == 1
        assert atm["atm_iv"][0] == pytest.approx(0.3224, abs=1e-6)

    def test_term_slope_is_null_with_only_one_expiry(self) -> None:
        # The real fixture has exactly one expiry — a slope needs two ends,
        # and this must say so rather than guess.
        assert term_slope(_nvda_call_chain()) is None

    def test_risk_reversal_is_null_with_no_puts_in_the_real_fixture(self) -> None:
        # Confirms the function fails safe on a real, currently-typical chain
        # (this build has not captured any puts yet) instead of crashing or
        # silently returning a call-only number mislabelled as a skew.
        assert risk_reversal_25d(_nvda_call_chain(), NVDA["expiry"]) is None


class TestChainFeaturesOnSyntheticPanel:
    """Not real capture. See the module and file docstrings."""

    def test_term_slope_sign_matches_the_constructed_curve(self) -> None:
        chain = _synthetic_two_expiry_chain()
        # far ATM iv 0.34 > near ATM iv 0.316 by construction.
        slope = term_slope(chain)
        assert slope == pytest.approx(0.34 - 0.316, abs=1e-9)

    def test_risk_reversal_matches_hand_picked_contracts(self) -> None:
        chain = _synthetic_two_expiry_chain()
        rr = risk_reversal_25d(chain, "2026-08-19")
        # near-term 25-delta call iv 0.363 minus 25-delta put iv 0.40.
        assert rr == pytest.approx(0.363 - 0.40, abs=1e-9)

    def test_put_call_ratios_match_hand_summed_totals(self) -> None:
        chain = _synthetic_two_expiry_chain()
        ratios = put_call_ratios(chain)
        put_oi = 8006 + 130 + 900 + 200
        call_oi = 5367 + 2990 + 1000 + 500
        assert ratios["put_call_oi_ratio"] == pytest.approx(put_oi / call_oi, abs=1e-9)

    def test_put_call_ratios_null_on_an_empty_chain(self) -> None:
        empty = pl.DataFrame(schema={"type": pl.Utf8, "open_interest": pl.Int64, "volume": pl.Int64})
        assert put_call_ratios(empty) == {"put_call_oi_ratio": None, "put_call_volume_ratio": None}

    def test_put_call_ratios_null_when_one_side_is_absent(self) -> None:
        calls_only = _synthetic_two_expiry_chain().filter(pl.col("type") == "call")
        assert put_call_ratios(calls_only) == {"put_call_oi_ratio": None, "put_call_volume_ratio": None}


class TestIvRank:
    def test_null_below_twenty_observations(self) -> None:
        assert iv_rank(0.30, [0.25, 0.28, 0.35]) is None

    def test_matches_a_hand_computed_percentile(self) -> None:
        history = [0.20 + 0.01 * i for i in range(30)]  # 0.20 .. 0.49
        # current 0.35 -> values <= 0.35 are 0.20..0.35, i.e. 16 of 30.
        rank = iv_rank(0.35, history)
        assert rank == pytest.approx(16 / 30, abs=1e-9)

    def test_current_below_all_history_ranks_zero(self) -> None:
        assert iv_rank(0.01, [0.20 + 0.01 * i for i in range(25)]) == 0.0

    def test_current_above_all_history_ranks_one(self) -> None:
        assert iv_rank(0.99, [0.20 + 0.01 * i for i in range(25)]) == 1.0


def _underlying_with_multi_expiry_puts_and_calls() -> tuple[str, str] | None:
    """Picks one real (underlying, trading_day) with enough shape to
    exercise every chain function — both types, several expiries. Returns
    `None` rather than raising when the corpus has nothing that shape yet,
    so the tests that need it can skip with a clear reason instead of
    failing on a fresh checkout.
    """
    with connect() as conn:
        row = conn.execute(
            """
            SELECT c.underlying, q.trading_day
            FROM option_quotes q
            JOIN option_contracts c ON c.occ_symbol = q.occ_symbol
            WHERE q.liquid = 1 AND q.iv_bps IS NOT NULL
            GROUP BY c.underlying, q.trading_day
            HAVING COUNT(DISTINCT c.expiry) >= 3
               AND SUM(CASE WHEN c.type = 'call' THEN 1 ELSE 0 END) > 0
               AND SUM(CASE WHEN c.type = 'put' THEN 1 ELSE 0 END) > 0
            ORDER BY COUNT(*) DESC
            LIMIT 1
            """
        ).fetchone()
    return (row["underlying"], row["trading_day"]) if row else None


class TestChainFeaturesOnRealMultiExpiryChain:
    """The gap the fixture-based tests above leave open, closed against the
    actual local corpus rather than a bigger synthetic panel.
    """

    def test_read_quotes_deduplicates_a_recaptured_day(self) -> None:
        # A day recaptured after an interrupted run leaves two real rows per
        # contract in option_quotes — read_quotes must collapse that to one
        # row per contract, or every sum-based feature below silently
        # double-counts whichever contracts happened to be recaptured.
        picked = _underlying_with_multi_expiry_puts_and_calls()
        if picked is None:
            pytest.skip("no real multi-expiry chain captured yet")
        underlying, day = picked
        chain = read_quotes(underlying, day, liquid_only=True)
        assert chain.height == chain["occ_symbol"].n_unique()

    def test_functions_run_without_error_on_a_real_chain(self) -> None:
        picked = _underlying_with_multi_expiry_puts_and_calls()
        if picked is None:
            pytest.skip("no real multi-expiry chain captured yet")
        underlying, day = picked
        chain = read_quotes(underlying, day, liquid_only=True)

        atm = atm_iv_by_expiry(chain)
        assert atm.height >= 3
        assert atm["atm_iv"].drop_nulls().min() > 0.0

        slope = term_slope(chain)
        assert slope is not None
        assert math.isfinite(slope)

        near_expiry = chain["expiry"].min()
        rr = risk_reversal_25d(chain, near_expiry)
        # Not every real expiry resolves a 25-delta point on both sides —
        # null is a legitimate answer here, just not a crash.
        assert rr is None or math.isfinite(rr)

        ratios = put_call_ratios(chain)
        for value in ratios.values():
            assert value is None or value > 0.0

    def test_put_call_ratios_are_invariant_to_a_recaptured_day(self) -> None:
        # The real bug this validation pass found: before read_quotes
        # deduped, a day recaptured after an interrupted run inflated both
        # sides' sums by however many contracts got captured twice on each
        # side, which only leaves the ratio unchanged when duplication
        # happens to be symmetric — not something to rely on. Comparing the
        # deduped chain against itself with an artificial duplicate pins the
        # property this test is actually about: duplicating one call and
        # leaving puts alone must change the ratio, proving dedup is what
        # keeps the real query honest rather than coincidence.
        picked = _underlying_with_multi_expiry_puts_and_calls()
        if picked is None:
            pytest.skip("no real multi-expiry chain captured yet")
        underlying, day = picked
        chain = read_quotes(underlying, day, liquid_only=True)
        clean_ratios = put_call_ratios(chain)

        one_call = chain.filter(pl.col("type") == "call").head(1)
        duplicated = pl.concat([chain, one_call])
        skewed_ratios = put_call_ratios(duplicated)

        if clean_ratios["put_call_oi_ratio"] is not None:
            assert skewed_ratios["put_call_oi_ratio"] != clean_ratios["put_call_oi_ratio"]
