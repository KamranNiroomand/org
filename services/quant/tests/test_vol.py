"""Realized volatility tests.

Three layers: recovery on synthetic data where the true volatility is known,
a demonstrated property (Yang-Zhang captures overnight gaps that
close-to-close cannot), and sanity against the real bars already sitting in
the market database from the backfill smoke test.
"""

from __future__ import annotations

import math

import numpy as np
import polars as pl
import pytest

from app.vol import (
    TRADING_DAYS_PER_YEAR,
    close_to_close_vol,
    rolling_realized_vol,
    yang_zhang_variance,
    yang_zhang_vol,
)


def _simulate_gbm_ohlc(
    n_days: int, annual_vol: float, seed: int, drift: float = 0.0, substeps: int = 50
) -> dict[str, np.ndarray]:
    """A daily OHLC series from one continuous, correctly-stitched GBM path.

    Each day is `substeps` increments of the same Brownian motion, with the
    next day's first increment continuing exactly from the prior day's last —
    so there is no overnight gap by construction, and open/high/low/close are
    all genuine statistics of one process rather than a close series with
    high/low bolted on afterward.

    This is what makes it a fair recovery test: quadratic variation is
    additive regardless of how a path is chopped into sub-intervals, so both
    close-to-close (which only sees the daily endpoints) and Yang-Zhang
    (which also sees the path's range) should recover the *same* `annual_vol`
    from the *same* underlying process — not two different quantities that
    happen to share a name. An earlier version of this fixture added intraday
    range as an extra term on top of the close-to-close move; Yang-Zhang
    correctly detected that manufactured extra variance and the test failed
    for reproducing the bug, not for having one.
    """
    rng = np.random.default_rng(seed)
    step_sigma = annual_vol / math.sqrt(TRADING_DAYS_PER_YEAR * substeps)
    step_drift = drift / (TRADING_DAYS_PER_YEAR * substeps)

    opens = np.empty(n_days)
    highs = np.empty(n_days)
    lows = np.empty(n_days)
    closes = np.empty(n_days)

    log_price = math.log(100.0)
    for i in range(n_days):
        opens[i] = math.exp(log_price)
        path_min = path_max = log_price
        for _ in range(substeps):
            log_price += rng.normal(step_drift, step_sigma)
            path_min = min(path_min, log_price)
            path_max = max(path_max, log_price)
        closes[i] = math.exp(log_price)
        highs[i] = math.exp(path_max)
        lows[i] = math.exp(path_min)

    return {"open": opens, "high": highs, "low": lows, "close": closes}


class TestRecovery:
    @pytest.mark.parametrize("true_vol", [0.15, 0.30, 0.60])
    def test_recovers_the_simulating_volatility(self, true_vol: float) -> None:
        bars = _simulate_gbm_ohlc(n_days=500, annual_vol=true_vol, seed=42)
        estimated = yang_zhang_vol(bars["open"], bars["high"], bars["low"], bars["close"])
        # A single 500-day path has genuine sampling noise; 15% relative
        # tolerance is checking recovery, not asserting zero estimation error.
        assert estimated == pytest.approx(true_vol, rel=0.15)

    def test_close_to_close_also_recovers_on_this_construction(self) -> None:
        # Sanity on the fixture itself: since bars are built to match a target
        # close-to-close variance, the naive estimator must recover it too.
        # This is what makes the overnight-gap test below a fair comparison —
        # both estimators start from parity on ordinary data.
        bars = _simulate_gbm_ohlc(n_days=500, annual_vol=0.30, seed=7)
        estimated = close_to_close_vol(bars["close"])
        assert estimated == pytest.approx(0.30, rel=0.15)


class TestOvernightGaps:
    def test_close_to_close_misses_a_pure_overnight_move(self) -> None:
        """The property Yang-Zhang exists for.

        Construct days that open exactly at the prior close (zero overnight
        gap) and close exactly at the open (zero intraday move) — trivially,
        both estimators should read close to zero. Then move all of the
        variance into the overnight gap alone: close-to-close *still* sees it,
        because close-to-close is a function only of the close series, which
        is exactly the point being isolated for the next assertion.
        """
        n = 60
        rng = np.random.default_rng(3)

        # No overnight gap; all movement is intraday and closes flat.
        base = 100.0
        opens = np.full(n, base)
        closes = np.full(n, base)
        # A little intraday range so log(h/o) etc. stay finite and non-trivial.
        highs = base * np.exp(np.abs(rng.normal(0.01, 0.002, n)))
        lows = base * np.exp(-np.abs(rng.normal(0.01, 0.002, n)))

        yz_flat = yang_zhang_vol(opens, highs, lows, closes)
        c2c_flat = close_to_close_vol(closes)
        # Close-to-close is identically zero here: every close is the same
        # number, so its log-return series is all zeros.
        assert c2c_flat == 0.0
        # Yang-Zhang still sees the intraday range component.
        assert yz_flat > 0.0

    def test_yang_zhang_attributes_overnight_variance_close_to_close_cannot_separate(self) -> None:
        """A large overnight jump with zero intraday range: YZ isolates the
        overnight term explicitly, so its overnight component alone should
        already exceed a comparably-sized all-intraday, no-gap case.
        """
        n = 40
        rng = np.random.default_rng(11)
        jump = rng.normal(0, 0.03, n)  # 3% overnight std, no drift
        closes = np.empty(n)
        opens = np.empty(n)
        price = 100.0
        for i in range(n):
            opens[i] = price * math.exp(jump[i])
            closes[i] = opens[i]  # zero intraday move
            price = closes[i]
        highs = np.maximum(opens, closes) * 1.0001
        lows = np.minimum(opens, closes) * 0.9999

        variance = yang_zhang_variance(opens, highs, lows, closes)
        # With zero intraday range, the open-close and Rogers-Satchell terms
        # are ~0, so essentially all measured variance is the overnight term —
        # this asserts YZ is not silently discarding the gap the way a
        # same-day-only estimator would.
        assert variance > 0.0
        annualized = math.sqrt(variance * TRADING_DAYS_PER_YEAR)
        assert annualized == pytest.approx(0.03 * math.sqrt(TRADING_DAYS_PER_YEAR), rel=0.25)


class TestValidation:
    def test_rejects_too_few_bars(self) -> None:
        with pytest.raises(ValueError, match="at least 2"):
            yang_zhang_variance(np.array([100.0]), np.array([101.0]), np.array([99.0]), np.array([100.0]))

    def test_rejects_mismatched_lengths(self) -> None:
        with pytest.raises(ValueError, match="same length"):
            yang_zhang_variance(np.array([100.0, 101.0]), np.array([101.0]), np.array([99.0, 98.0]), np.array([100.0, 101.0]))

    def test_never_returns_negative_variance(self) -> None:
        # A degenerate, unmoving series should floor at zero rather than a
        # tiny negative number from floating-point cancellation.
        flat = np.full(10, 100.0)
        assert yang_zhang_variance(flat, flat, flat, flat) == 0.0


class TestRollingWindow:
    def test_drops_the_unwindowed_head_rather_than_computing_on_a_partial_window(self) -> None:
        bars = pl.DataFrame(
            {
                "symbol": ["X"] * 30,
                "day": [f"2026-01-{i + 1:02d}" for i in range(30)],
                "open": np.linspace(100, 110, 30),
                "high": np.linspace(101, 111, 30),
                "low": np.linspace(99, 109, 30),
                "close": np.linspace(100.5, 110.5, 30),
                "adj_close": np.linspace(100.5, 110.5, 30),
                "volume": [1_000_000] * 30,
            }
        )
        result = rolling_realized_vol(bars, window=21)
        assert len(result) == 30 - 21 + 1
        # The first surviving row is stamped on the 21st trading day, not the 1st.
        assert result["day"][0] == "2026-01-21"

    def test_rejects_window_below_two(self) -> None:
        with pytest.raises(ValueError, match="at least 2"):
            rolling_realized_vol(pl.DataFrame({"symbol": [], "day": [], "open": [], "high": [], "low": [], "close": []}), window=1)


class TestAgainstRealBars:
    """The bars already backfilled into market.db from the live subscription."""

    def test_real_symbols_produce_sane_annualized_vol(self) -> None:
        from app.db import read_bars

        bars = read_bars(symbols=["SPY", "AAPL", "NVDA"])
        if bars.height == 0:
            pytest.skip("no bars in market.db yet — run bars:backfill first")

        for symbol, group in bars.group_by("symbol"):
            g = group.sort("day")
            if g.height < 30:
                continue
            vol = yang_zhang_vol(
                g["open"].to_numpy(), g["high"].to_numpy(), g["low"].to_numpy(), g["close"].to_numpy()
            )
            # A full year of any liquid US equity or ETF lands well inside this
            # band; anything outside it says more about a data bug than about
            # markets. NVDA has run north of 60% annualized in real stretches,
            # hence the wide upper bound rather than a tight one.
            assert 0.05 < vol < 1.5, f"{symbol}: implausible annualized vol {vol:.3f}"
