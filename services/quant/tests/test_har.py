"""HAR-RV tests.

Three layers, mirroring `test_rank.py`'s own structure: the algebra checked
against constructed series where the right answer is known independently;
the leak guard, which is the one defect that would make every downstream
number look better than it is; and a real-corpus layer that skips
gracefully where the data does not exist, the same pattern `test_train.py`
already uses.
"""

from __future__ import annotations

import math

import numpy as np
import polars as pl
import pytest

from app.har import (
    DEFAULT_FORECAST_HORIZON,
    MONTHLY_WINDOW,
    HarCoefficients,
    _shift_back,
    fit_har,
    forecast_vol_by_symbol,
    har_features,
    har_targets,
)
from app.db import read_bars


def _bars(symbol: str, closes: list[float], start_day: str = "2026-01-01") -> pl.DataFrame:
    """Synthetic OHLC where high/low straddle the close by a fixed fraction,
    so Yang-Zhang has a real intraday range to work with rather than a
    degenerate zero-variance bar."""
    from datetime import date, timedelta

    d0 = date.fromisoformat(start_day)
    rows = []
    for i, c in enumerate(closes):
        prev = closes[i - 1] if i else c
        rows.append(
            {
                "symbol": symbol,
                "day": (d0 + timedelta(days=i)).isoformat(),
                "open": prev,
                "high": max(prev, c) * 1.01,
                "low": min(prev, c) * 0.99,
                "close": c,
            }
        )
    return pl.DataFrame(rows)


def _walk(n: int, vol: float, seed: int) -> list[float]:
    rng = np.random.default_rng(seed)
    return list(100.0 * np.exp(np.cumsum(rng.normal(0.0, vol, n))))


class TestHarFeatures:
    def test_emits_one_row_per_day_once_the_monthly_window_is_full(self) -> None:
        bars = _bars("AAA", _walk(60, 0.01, 1))
        feats = har_features(bars)
        # 60 bars, monthly window 22 → first usable index is 21, so 39 rows.
        assert feats.height == 60 - MONTHLY_WINDOW + 1
        assert set(feats.columns) == {"symbol", "day", "rv_daily", "rv_weekly", "rv_monthly"}

    def test_drops_a_symbol_with_too_little_history_rather_than_estimating_on_a_partial_window(
        self,
    ) -> None:
        # A 22-day estimator run over 6 days is a different, unlabelled
        # estimator — not a noisier version of the same one.
        bars = _bars("SHORT", _walk(6, 0.01, 2))
        assert har_features(bars).height == 0

    def test_the_three_components_are_genuinely_different_series(self) -> None:
        # If they collapsed to the same number the regression would have one
        # regressor wearing three hats, and the cascade would be fiction.
        # One continuous series — calm for a month, violent for the last
        # three days — so the divergence comes from a real change in
        # volatility rather than a discontinuity between two spliced walks.
        rng = np.random.default_rng(3)
        steps = list(rng.normal(0.0, 0.002, 40)) + list(rng.normal(0.0, 0.08, 5))
        closes = list(100.0 * np.exp(np.cumsum(steps)))

        feats = har_features(_bars("SPIKE", closes)).sort("day")
        last = feats.tail(1).to_dicts()[0]

        # The weekly window sits entirely inside the spike while the monthly
        # one is still mostly calm, so it must be the larger of the two.
        assert last["rv_weekly"] > last["rv_monthly"]
        # ...and the three are genuinely distinct series, which is the
        # property the cascade depends on.
        assert len({last["rv_daily"], last["rv_weekly"], last["rv_monthly"]}) == 3

        # No ordering is asserted for the daily term, and that is a finding
        # rather than a gap. With only daily OHLC, Yang-Zhang needs two bars
        # to see an overnight gap, so the "daily" component is a two-bar
        # estimator — noisy enough that in this very fixture it reads 0.20
        # against a 0.34 monthly *during* the spike, purely because the last
        # two bars happened to be a small move. Asserting an ordering here
        # would pin the seed, not the behaviour. The regression reaches the
        # same conclusion on real data unaided: the fitted beta_daily is
        # ~0.06 against ~0.50 monthly, i.e. it learns to mostly ignore this
        # term. That is the cascade working, not failing.


class TestHarTargets:
    def test_target_is_the_forward_window_not_the_current_one(self) -> None:
        feats = har_features(_bars("AAA", _walk(80, 0.01, 5)))
        panel = har_targets(feats, horizon=21)
        joined = panel.sort("day")
        first = joined.head(1).to_dicts()[0]
        # The row's own monthly vol and its target must be different
        # numbers: if they matched, the "forecast" would be predicting a
        # quantity it already has.
        assert first["rv_forward"] != first["rv_monthly"]

    def test_rows_with_no_observable_future_are_dropped(self) -> None:
        feats = har_features(_bars("AAA", _walk(60, 0.01, 6)))
        panel = har_targets(feats, horizon=21)
        assert panel.height == feats.height - 21

    def test_the_shift_never_crosses_a_symbol_boundary(self) -> None:
        # Without `.over("symbol")` the last rows of one symbol would take
        # their target from the first rows of the next — a silent
        # cross-contamination that no downstream metric would reveal.
        bars = pl.concat([_bars("AAA", _walk(50, 0.01, 7)), _bars("BBB", _walk(50, 0.20, 8))])
        panel = har_targets(har_features(bars), horizon=5)
        per_symbol = panel.group_by("symbol").len().sort("symbol")
        assert per_symbol["len"].to_list() == [50 - MONTHLY_WINDOW + 1 - 5] * 2

    def test_a_non_positive_horizon_is_refused(self) -> None:
        feats = har_features(_bars("AAA", _walk(40, 0.01, 9)))
        with pytest.raises(ValueError, match="horizon must be at least 1"):
            har_targets(feats, horizon=0)


class TestFitHar:
    def test_recovers_a_known_linear_relationship(self) -> None:
        # If the solver cannot recover coefficients it generated itself,
        # nothing downstream of it means anything.
        rng = np.random.default_rng(11)
        n = 4000
        d, w, m = (np.exp(rng.normal(-1.5, 0.4, n)) for _ in range(3))
        true = (0.10, 0.20, 0.30, 0.40)  # intercept, daily, weekly, monthly
        fwd = np.exp(
            true[0] + true[1] * np.log(d) + true[2] * np.log(w) + true[3] * np.log(m)
            + rng.normal(0, 0.01, n)
        )
        panel = pl.DataFrame({"rv_daily": d, "rv_weekly": w, "rv_monthly": m, "rv_forward": fwd})

        c = fit_har(panel)

        assert c.intercept == pytest.approx(true[0], abs=0.02)
        assert c.beta_daily == pytest.approx(true[1], abs=0.02)
        assert c.beta_weekly == pytest.approx(true[2], abs=0.02)
        assert c.beta_monthly == pytest.approx(true[3], abs=0.02)
        assert c.r_squared > 0.95

    def test_refuses_to_fit_four_parameters_to_fewer_observations(self) -> None:
        panel = pl.DataFrame(
            {"rv_daily": [0.2, 0.3], "rv_weekly": [0.2, 0.3], "rv_monthly": [0.2, 0.3], "rv_forward": [0.2, 0.3]}
        )
        with pytest.raises(ValueError, match="at least 4 observations"):
            fit_har(panel)

    def test_zero_volatility_does_not_poison_the_fit_with_negative_infinity(self) -> None:
        # A halted or untraded name yields a genuinely zero realized vol,
        # and log(0) would take the whole panel's fit to nan.
        rng = np.random.default_rng(12)
        n = 200
        d = np.concatenate([[0.0], np.exp(rng.normal(-1.5, 0.3, n - 1))])
        panel = pl.DataFrame(
            {"rv_daily": d, "rv_weekly": d + 0.01, "rv_monthly": d + 0.02, "rv_forward": d + 0.015}
        )
        c = fit_har(panel)
        assert math.isfinite(c.intercept)
        assert math.isfinite(c.beta_daily)
        assert math.isfinite(c.r_squared)


class TestJensenCorrection:
    def test_the_level_forecast_exceeds_the_naive_exponential(self) -> None:
        # exp(E[log x]) is the median, not the mean, and understates it by
        # exp(sigma^2/2). Since rank.py divides this by market IV, an
        # uncorrected forecast becomes a standing "options look expensive"
        # tilt — a bias shaped like a trading signal.
        c = HarCoefficients(
            intercept=0.0, beta_daily=0.0, beta_weekly=0.0, beta_monthly=1.0,
            n_observations=100, r_squared=0.5, residual_variance=0.20,
        )
        naive = math.exp(c.predict_log(0.3, 0.3, 0.3))
        corrected = c.predict(0.3, 0.3, 0.3)
        assert corrected > naive
        assert corrected == pytest.approx(naive * math.exp(0.10), rel=1e-9)

    def test_a_perfect_fit_needs_no_correction(self) -> None:
        c = HarCoefficients(
            intercept=0.0, beta_daily=0.0, beta_weekly=0.0, beta_monthly=1.0,
            n_observations=100, r_squared=1.0, residual_variance=0.0,
        )
        assert c.predict(0.25, 0.25, 0.25) == pytest.approx(0.25, rel=1e-9)


class TestLeakGuard:
    def test_the_fit_excludes_rows_whose_forward_window_has_not_closed(self) -> None:
        # The defect this exists to prevent: filtering on the row's own date
        # rather than its target's end date. A row dated `trading_day - 5`
        # looks safely historical but its 21-day target runs well past
        # `trading_day`, so training on it leaks the very window being
        # forecast — and every downstream metric would look better for it.
        cutoff = "2026-06-01"
        shifted = _shift_back(cutoff, DEFAULT_FORECAST_HORIZON)
        assert shifted < cutoff
        # Generous by construction: at least the horizon in calendar days,
        # so holidays cannot pull a still-open window into the fit.
        from datetime import date

        gap = (date.fromisoformat(cutoff) - date.fromisoformat(shifted)).days
        assert gap >= DEFAULT_FORECAST_HORIZON

    def test_forecast_never_reads_a_bar_after_the_trading_day(self) -> None:
        # End to end: truncating the corpus after the trading day must not
        # change the forecast. If it does, something downstream is reading
        # the future.
        bars = pl.concat([_bars(s, _walk(200, 0.015, i), "2025-06-01") for i, s in enumerate(["AAA", "BBB", "CCC"])])
        # Unique days, not raw rows: three symbols share every date, so
        # indexing the row list picks a day a third of the way into history
        # and no target window has closed yet.
        day = sorted(set(bars["day"].to_list()))[140]

        full, _ = forecast_vol_by_symbol(bars, day)
        truncated, _ = forecast_vol_by_symbol(bars.filter(pl.col("day") <= day), day)

        assert full.keys() == truncated.keys()
        for sym in full:
            assert full[sym] == pytest.approx(truncated[sym], rel=1e-12)

    def test_too_little_closed_history_refuses_rather_than_fitting_on_scraps(self) -> None:
        bars = _bars("AAA", _walk(40, 0.01, 20), "2026-01-01")
        with pytest.raises(ValueError, match="not enough history"):
            forecast_vol_by_symbol(bars, "2026-01-25")


class TestAgainstRealCorpus:
    def test_beats_the_trailing_placeholder_it_replaces_out_of_sample(self) -> None:
        """The claim that justifies this module existing, measured rather
        than asserted: HAR must forecast forward realized vol better than
        carrying the trailing monthly window flat, on data neither saw."""
        bars = read_bars()
        if bars.height == 0:
            pytest.skip("no bars in market.db yet — run bars:backfill first")

        panel = har_targets(har_features(bars), DEFAULT_FORECAST_HORIZON)
        days = sorted(panel["day"].unique().to_list())
        if len(days) < 200:
            pytest.skip(f"only {len(days)} days of HAR panel — too few to split")

        cut = int(len(days) * 0.7)
        # Embargo the overlapping-label window between train and test.
        train = panel.filter(pl.col("day") <= days[cut - 40])
        test = panel.filter(pl.col("day") > days[cut])

        c = fit_har(train)
        logs = lambda col: np.log(np.maximum(test[col].to_numpy().astype(float), 1e-6))
        d, w, m, fwd = (logs(k) for k in ("rv_daily", "rv_weekly", "rv_monthly", "rv_forward"))

        har_err = c.intercept + c.beta_daily * d + c.beta_weekly * w + c.beta_monthly * m - fwd
        naive_err = m - fwd  # the placeholder: trailing monthly RV, carried flat

        har_rmse = float(np.sqrt(np.mean(har_err**2)))
        naive_rmse = float(np.sqrt(np.mean(naive_err**2)))
        assert har_rmse < naive_rmse, f"HAR {har_rmse:.4f} did not beat naive {naive_rmse:.4f}"

    def test_the_fitted_cascade_has_the_shape_the_literature_reports(self) -> None:
        """Corsi's finding is not just "it fits" but a specific shape:
        weights increasing from daily to monthly at a monthly horizon, and
        summing below one so the forecast mean-reverts rather than
        extrapolating a spike forever. A fit that lost that shape would be
        numerically fine and economically wrong."""
        bars = read_bars()
        if bars.height == 0:
            pytest.skip("no bars in market.db yet")
        panel = har_targets(har_features(bars), DEFAULT_FORECAST_HORIZON)
        if panel.height < 1000:
            pytest.skip("not enough panel rows")

        c = fit_har(panel)

        assert c.beta_monthly > c.beta_weekly > c.beta_daily
        assert 0.0 < c.beta_daily + c.beta_weekly + c.beta_monthly < 1.0
        assert 0.3 < c.r_squared < 0.9
