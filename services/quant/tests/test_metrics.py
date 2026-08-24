"""Metrics tests. log_loss and brier_score are cross-checked against
scikit-learn's own implementations rather than only hand-computed, since a
scoring function that silently disagrees with the library everyone else
uses is worse than one that is merely wrong in an obvious way.
"""

from __future__ import annotations

import numpy as np
import pytest
from sklearn.metrics import brier_score_loss
from sklearn.metrics import log_loss as sk_log_loss

from app.metrics import (
    brier_score,
    daily_ic_series,
    deflated_sharpe_ratio,
    ic_summary,
    information_coefficient,
    log_loss,
    mae,
    max_drawdown,
    rank_information_coefficient,
    rmse,
    sharpe_ratio,
)


class TestRegressionMetrics:
    def test_rmse_matches_hand_computation(self) -> None:
        actual = np.array([1.0, 2.0, 3.0])
        predicted = np.array([1.0, 2.0, 5.0])
        # errors: 0, 0, 2 -> mse = 4/3 -> rmse = sqrt(4/3)
        assert rmse(actual, predicted) == pytest.approx(np.sqrt(4 / 3))

    def test_mae_matches_hand_computation(self) -> None:
        actual = np.array([1.0, 2.0, 3.0])
        predicted = np.array([1.0, 0.0, 5.0])
        # |0| + |2| + |2| = 4 -> mean 4/3
        assert mae(actual, predicted) == pytest.approx(4 / 3)

    def test_zero_error_gives_zero_of_both(self) -> None:
        x = np.array([1.0, 2.0, 3.0])
        assert rmse(x, x) == 0.0
        assert mae(x, x) == 0.0


class TestInformationCoefficient:
    def test_perfect_agreement_is_one(self) -> None:
        x = np.array([1.0, 2.0, 3.0, 4.0])
        assert information_coefficient(x, x) == pytest.approx(1.0)

    def test_perfect_inversion_is_minus_one(self) -> None:
        x = np.array([1.0, 2.0, 3.0, 4.0])
        assert information_coefficient(x, -x) == pytest.approx(-1.0)

    def test_constant_predictions_are_zero_not_nan(self) -> None:
        # A model that always predicts the same value carries no rank
        # information; correlation against a constant is undefined
        # (division by zero std), and 0 is the honest answer, not NaN
        # propagating silently into an aggregate metric.
        actual = np.array([1.0, 2.0, 3.0])
        predicted = np.array([5.0, 5.0, 5.0])
        assert information_coefficient(actual, predicted) == 0.0


class TestClassificationMetrics:
    def test_log_loss_matches_sklearn(self) -> None:
        actual = np.array([0, 0, 1, 1])
        predicted = np.array([0.1, 0.4, 0.6, 0.9])
        assert log_loss(actual, predicted) == pytest.approx(
            sk_log_loss(actual, predicted), rel=1e-6
        )

    def test_brier_matches_sklearn(self) -> None:
        actual = np.array([0, 0, 1, 1])
        predicted = np.array([0.1, 0.4, 0.6, 0.9])
        assert brier_score(actual, predicted) == pytest.approx(
            brier_score_loss(actual, predicted), rel=1e-6
        )

    def test_log_loss_does_not_blow_up_at_the_extremes(self) -> None:
        # A prediction of exactly 0 or 1 that turns out wrong would be -inf
        # under the raw formula; clipping keeps it large but finite.
        actual = np.array([1, 0])
        predicted = np.array([0.0, 1.0])  # maximally wrong on both
        value = log_loss(actual, predicted)
        assert np.isfinite(value)
        assert value > 10  # still a severe penalty, just not infinite

    def test_perfect_predictions_score_near_zero(self) -> None:
        actual = np.array([0, 1, 0, 1])
        predicted = np.array([0.001, 0.999, 0.001, 0.999])
        assert log_loss(actual, predicted) < 0.01
        assert brier_score(actual, predicted) < 0.001


class TestSharpeRatio:
    def test_matches_hand_computation(self) -> None:
        returns = np.array([0.01, -0.01, 0.02, 0.0])
        expected = np.mean(returns) / np.std(returns) * np.sqrt(252)
        assert sharpe_ratio(returns) == pytest.approx(expected)

    def test_zero_volatility_is_zero_not_infinity(self) -> None:
        assert sharpe_ratio(np.array([0.01, 0.01, 0.01])) == 0.0


class TestMaxDrawdown:
    def test_matches_hand_computation(self) -> None:
        # Peak 100 at index 1, trough 60 at index 3 -> drawdown 40.
        cumulative = np.array([50.0, 100.0, 80.0, 60.0, 90.0])
        assert max_drawdown(cumulative) == pytest.approx(40.0)

    def test_returned_as_a_positive_magnitude_not_a_negative_delta(self) -> None:
        assert max_drawdown(np.array([100.0, 50.0])) == 50.0

    def test_monotonically_rising_series_has_zero_drawdown(self) -> None:
        assert max_drawdown(np.array([1.0, 2.0, 3.0, 4.0])) == 0.0

    def test_empty_series_is_zero(self) -> None:
        assert max_drawdown(np.array([])) == 0.0

    def test_single_point_is_zero(self) -> None:
        assert max_drawdown(np.array([42.0])) == 0.0


class TestDeflatedSharpeRatio:
    def test_a_real_edge_survives_a_single_trial(self) -> None:
        # A strong, consistently observed Sharpe with one trial and plenty of
        # observations should look genuinely likely to be real.
        p = deflated_sharpe_ratio(observed_sharpe=2.0, n_trials=1, n_returns=500)
        assert p > 0.9

    def test_more_trials_never_increases_confidence_for_the_same_result(self) -> None:
        """The property the whole function exists to enforce: searching
        harder to find the same Sharpe ratio must not make it look more
        real. Checked at several trial counts, strictly decreasing.
        """
        trial_counts = [1, 5, 20, 100, 500]
        probs = [
            deflated_sharpe_ratio(observed_sharpe=1.5, n_trials=n, n_returns=500)
            for n in trial_counts
        ]
        assert probs == sorted(probs, reverse=True)
        assert probs[0] > probs[-1]

    def test_a_zero_sharpe_found_after_many_trials_looks_like_noise(self) -> None:
        p = deflated_sharpe_ratio(observed_sharpe=0.0, n_trials=100, n_returns=500)
        assert p < 0.5

    def test_rejects_degenerate_inputs(self) -> None:
        with pytest.raises(ValueError, match="n_returns"):
            deflated_sharpe_ratio(1.0, n_trials=1, n_returns=1)
        with pytest.raises(ValueError, match="n_trials"):
            deflated_sharpe_ratio(1.0, n_trials=0, n_returns=100)


class TestRankInformationCoefficient:
    def test_perfect_monotone_but_nonlinear_relationship_scores_one(self) -> None:
        # Rank IC's whole point: the system buys the top-ranked contract, so
        # a forecast that orders names perfectly is perfect, even if its
        # magnitudes are wildly uncalibrated.
        actual = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        predicted = np.array([0.01, 0.02, 0.5, 0.51, 100.0])
        assert rank_information_coefficient(actual, predicted) == pytest.approx(1.0)
        assert information_coefficient(actual, predicted) < 0.8

    def test_one_outlier_can_flip_pearson_but_not_rank(self) -> None:
        # Five names ranked exactly right, plus one earnings-gap outlier the
        # model ranked last. Pearson follows the outlier; rank does not.
        actual = np.array([1.0, 2.0, 3.0, 4.0, 5.0, -50.0])
        predicted = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
        assert information_coefficient(actual, predicted) < 0
        assert rank_information_coefficient(actual, predicted) > 0

    def test_ties_share_averaged_ranks(self) -> None:
        actual = np.array([1.0, 1.0, 2.0, 3.0])
        predicted = np.array([5.0, 5.0, 6.0, 7.0])
        assert rank_information_coefficient(actual, predicted) == pytest.approx(1.0)


class TestDailyIcSeries:
    def test_pooling_manufactures_skill_that_daily_ic_correctly_reports_as_zero(self) -> None:
        # The bug this whole change exists to fix, as a fixture. Two days.
        # Within each day the model's ordering is exactly backwards — real
        # cross-sectional skill is negative. But day 2 is a market-wide up
        # day and the model predicted higher numbers that day, so pooling
        # every symbol-day into one correlation reports strong positive
        # "skill" that the system could never trade on.
        days = np.array(["d1"] * 5 + ["d2"] * 5, dtype=object)
        predicted = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 11.0, 12.0, 13.0, 14.0, 15.0])
        actual = np.array([0.05, 0.04, 0.03, 0.02, 0.01, 0.95, 0.94, 0.93, 0.92, 0.91])

        pooled = information_coefficient(actual, predicted)
        _, dailies = daily_ic_series(days, actual, predicted, min_names_per_day=5)

        assert pooled > 0.9  # looks excellent
        assert all(ic < 0 for ic in dailies)  # every single day is actually backwards

    def test_days_with_too_few_names_are_dropped(self) -> None:
        days = np.array(["d1"] * 5 + ["d2"] * 2, dtype=object)
        actual = np.arange(7, dtype=float)
        predicted = np.arange(7, dtype=float)
        kept, ics = daily_ic_series(days, actual, predicted, min_names_per_day=5)
        assert kept == ["d1"]
        assert len(ics) == 1

    def test_series_is_returned_in_day_order(self) -> None:
        days = np.array(["d3"] * 5 + ["d1"] * 5 + ["d2"] * 5, dtype=object)
        actual = np.tile(np.arange(5, dtype=float), 3)
        predicted = np.tile(np.arange(5, dtype=float), 3)
        kept, _ = daily_ic_series(days, actual, predicted, min_names_per_day=5)
        assert kept == ["d1", "d2", "d3"]


class TestIcSummary:
    def _perfect_days(self, n_days: int, n_names: int = 10):
        days, actual, predicted = [], [], []
        for d in range(n_days):
            days.extend([f"d{d:03d}"] * n_names)
            actual.extend(np.arange(n_names, dtype=float))
            predicted.extend(np.arange(n_names, dtype=float))
        return np.array(days, dtype=object), np.array(actual), np.array(predicted)

    def test_effective_sample_divides_by_the_label_horizon(self) -> None:
        # 50 daily ICs from a 5-day forward label are not 50 independent
        # observations — consecutive labels overlap. The t-statistic must be
        # built on the ~10 non-overlapping periods instead.
        days, actual, predicted = self._perfect_days(50)
        s = ic_summary(days, actual, predicted, horizon=5)
        assert s["ic_n_days"] == 50
        assert s["ic_n_effective"] == 10

    def test_hurdle_rises_with_the_number_of_configurations_tried(self) -> None:
        days, actual, predicted = self._perfect_days(50)
        one = ic_summary(days, actual, predicted, horizon=5, n_trials=1)
        many = ic_summary(days, actual, predicted, horizon=5, n_trials=100)
        assert many["ic_t_hurdle"] > one["ic_t_hurdle"] * 1.5
        # A model picked as the best of 100 attempts is held to a real bar.
        assert many["ic_t_hurdle"] > 5.0

    def test_a_pure_noise_forecast_does_not_clear_the_hurdle(self) -> None:
        rng = np.random.default_rng(0)
        n_days, n_names = 120, 30
        days = np.array([f"d{d:03d}" for d in range(n_days) for _ in range(n_names)], dtype=object)
        actual = rng.normal(size=n_days * n_names)
        predicted = rng.normal(size=n_days * n_names)
        s = ic_summary(days, actual, predicted, horizon=5, n_trials=10)
        assert abs(s["ic_t_stat"]) < s["ic_t_hurdle"]
        assert s["ic_clears_hurdle"] is False

    def test_hit_rate_and_dispersion_are_reported(self) -> None:
        days, actual, predicted = self._perfect_days(20)
        s = ic_summary(days, actual, predicted, horizon=1)
        assert s["ic_hit_rate"] == pytest.approx(1.0)
        assert s["ic_mean"] == pytest.approx(1.0)
        assert s["ic_std"] == pytest.approx(0.0)

    def test_empty_input_is_zeroed_rather_than_a_crash(self) -> None:
        s = ic_summary(np.array([], dtype=object), np.array([]), np.array([]))
        assert s["ic_n_days"] == 0
        assert s["ic_clears_hurdle"] is False
