"""Label tests.

`forward_realized_vol` gets the most scrutiny here on purpose: its first
implementation had a real directional bug (see the module docstring), caught
only by hand-checking a small series rather than by a property test that
could have shared the same wrong assumption. The hand-check stays as a
regression test.
"""

from __future__ import annotations

import math

import numpy as np
import polars as pl
import pytest

from app.labels import (
    contract_return,
    direction_bucket,
    forward_realized_vol,
    forward_return,
    vrp_label,
)
from app.vol import TRADING_DAYS_PER_YEAR, yang_zhang_vol


def _bars(symbol: str, days: list[str], closes: list[float]) -> pl.DataFrame:
    """Bars with an open equal to the prior close and a fixed intraday range —
    enough structure for Yang-Zhang to be well-defined, not a claim about
    realistic intraday behaviour.
    """
    opens = [closes[0]] + closes[:-1]
    return pl.DataFrame(
        {
            "symbol": [symbol] * len(days),
            "day": days,
            "open": opens,
            "high": [max(o, c) * 1.01 for o, c in zip(opens, closes)],
            "low": [min(o, c) * 0.99 for o, c in zip(opens, closes)],
            "close": closes,
            "adj_close": closes,
            "volume": [1_000_000] * len(days),
        }
    )


class TestForwardReturn:
    def test_matches_hand_computed_return(self) -> None:
        days = [f"2026-01-{i + 1:02d}" for i in range(10)]
        closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]
        out = forward_return(_bars("X", days, [float(c) for c in closes]), horizon=3)
        # day 0: close[3]/close[0] - 1 = 103/100 - 1
        row0 = out.filter(pl.col("day") == days[0])
        assert row0[f"fwd_ret_3d"][0] == pytest.approx(103 / 100 - 1, abs=1e-9)

    def test_drops_the_tail_that_has_no_future(self) -> None:
        days = [f"2026-01-{i + 1:02d}" for i in range(10)]
        out = forward_return(_bars("X", days, [100.0 + i for i in range(10)]), horizon=3)
        assert out.height == 10 - 3
        assert days[-1] not in out["day"].to_list()

    def test_empty_input(self) -> None:
        out = forward_return(pl.DataFrame(schema={"symbol": pl.Utf8, "day": pl.Utf8, "close": pl.Float64}), horizon=5)
        assert out.height == 0
        assert "fwd_ret_5d" in out.columns


class TestDirectionBucket:
    def test_buckets_match_the_threshold(self) -> None:
        days = [f"2026-01-{i + 1:02d}" for i in range(4)]
        # day0->day1: +5% (up), day1->day2: -5% (down), day2->day3: +0.1% (flat)
        closes = [100.0, 105.0, 99.75, 99.85]
        out = direction_bucket(_bars("X", days, closes), horizon=1, flat_threshold=0.01)
        by_day = dict(zip(out["day"].to_list(), out["direction_1d"].to_list()))
        assert by_day[days[0]] == "up"
        assert by_day[days[1]] == "down"
        assert by_day[days[2]] == "flat"


class TestForwardRealizedVol:
    def test_matches_a_hand_computed_yang_zhang_window(self) -> None:
        """The regression test for the reversal bug.

        Six days, horizon 2 (a 3-bar window). The label on day 0 must equal
        Yang-Zhang computed **directly and in chronological order** over days
        0-2 — not some function of the reversed series.
        """
        days = [f"2026-01-{i + 1:02d}" for i in range(6)]
        closes = [100.0, 103.0, 99.0, 105.0, 102.0, 108.0]
        bars = _bars("X", days, closes)
        out = forward_realized_vol(bars, horizon=2)

        o = bars["open"].to_numpy()
        h = bars["high"].to_numpy()
        l = bars["low"].to_numpy()
        c = bars["close"].to_numpy()
        expected_day0 = yang_zhang_vol(o[0:3], h[0:3], l[0:3], c[0:3])
        expected_day1 = yang_zhang_vol(o[1:4], h[1:4], l[1:4], c[1:4])

        by_day = dict(zip(out["day"].to_list(), out["fwd_rv_2d"].to_list()))
        assert by_day[days[0]] == pytest.approx(expected_day0, rel=1e-9)
        assert by_day[days[1]] == pytest.approx(expected_day1, rel=1e-9)

    def test_stamped_days_align_with_forward_return(self) -> None:
        """Same feature row must have both labels or neither.

        If the two functions ever disagree about which days have a full
        forward window, a training join between them would silently drop or
        misalign rows.
        """
        days = [f"2026-01-{i + 1:02d}" for i in range(15)]
        closes = [100.0 + i + (i % 3) for i in range(15)]
        bars = _bars("X", days, closes)

        ret = forward_return(bars, horizon=5)
        rv = forward_realized_vol(bars, horizon=5)
        assert set(ret["day"].to_list()) == set(rv["day"].to_list())

    def test_drops_the_tail_with_no_full_forward_window(self) -> None:
        days = [f"2026-01-{i + 1:02d}" for i in range(10)]
        out = forward_realized_vol(_bars("X", days, [100.0 + i for i in range(10)]), horizon=4)
        assert out.height == 10 - 4
        assert days[-1] not in out["day"].to_list()

    def test_recovers_known_volatility_on_a_long_synthetic_series(self) -> None:
        """A second, independent check: not just internally consistent with
        `yang_zhang_vol`, but recovering the volatility that actually
        generated the series, the way `test_vol.py` validates the estimator
        itself.
        """
        rng = np.random.default_rng(5)
        n = 300
        true_vol = 0.40
        step_sigma = true_vol / math.sqrt(TRADING_DAYS_PER_YEAR)
        closes = [100.0]
        for _ in range(n - 1):
            closes.append(closes[-1] * math.exp(rng.normal(0, step_sigma)))
        days = [f"2026-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(n)]
        bars = _bars("X", days, closes)

        out = forward_realized_vol(bars, horizon=21)
        mean_estimate = out["fwd_rv_21d"].mean()
        assert mean_estimate == pytest.approx(true_vol, rel=0.2)

    def test_empty_input(self) -> None:
        out = forward_realized_vol(pl.DataFrame(schema={
            "symbol": pl.Utf8, "day": pl.Utf8, "open": pl.Float64, "high": pl.Float64,
            "low": pl.Float64, "close": pl.Float64,
        }), horizon=5)
        assert out.height == 0
        assert "fwd_rv_5d" in out.columns


class TestVrpLabel:
    def test_positive_when_iv_exceeds_what_materialized(self) -> None:
        assert vrp_label(current_iv=0.35, forward_realized_vol_value=0.28) == pytest.approx(0.07)

    def test_negative_when_the_market_undercharged(self) -> None:
        assert vrp_label(current_iv=0.20, forward_realized_vol_value=0.30) == pytest.approx(-0.10)

    def test_demonstrates_the_annualization_wedge_the_docstring_describes(self) -> None:
        """Not a correctness assertion — a demonstration, kept in the suite so
        the magnitude of the documented caveat is visible and re-checked
        automatically rather than only asserted in a comment.
        """
        wedge = math.sqrt(365 / 252)
        assert wedge == pytest.approx(1.204, abs=0.001)


class TestContractReturn:
    def test_matches_hand_computed_return(self) -> None:
        assert contract_return(entry_mid=1.12, exit_mid=1.68) == pytest.approx(0.5)

    def test_a_loss_is_negative(self) -> None:
        assert contract_return(entry_mid=2.00, exit_mid=0.50) == pytest.approx(-0.75)

    def test_rejects_a_nonpositive_entry(self) -> None:
        with pytest.raises(ValueError, match="positive"):
            contract_return(entry_mid=0.0, exit_mid=1.0)
