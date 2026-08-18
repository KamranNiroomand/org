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
    deflated_sharpe_ratio,
    information_coefficient,
    log_loss,
    mae,
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
