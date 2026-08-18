"""Scoring: how good a model actually is, and how much to trust the number.

Regression and classification metrics are the easy half — thin, tested
wrappers so every caller computes them the same way. The harder half is
`deflated_sharpe_ratio`, which exists because an ordinary Sharpe ratio
answers the wrong question when it comes from the *best* of several
configurations tried. Try twenty feature sets, keep the one with the highest
backtested Sharpe, and some of that Sharpe is real skill and some of it is
the twenty rolls of the dice — the deflated Sharpe is what is left after
subtracting the second part.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import stats


def rmse(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.sqrt(np.mean((np.asarray(actual) - np.asarray(predicted)) ** 2)))


def mae(actual: np.ndarray, predicted: np.ndarray) -> float:
    return float(np.mean(np.abs(np.asarray(actual) - np.asarray(predicted))))


def information_coefficient(actual: np.ndarray, predicted: np.ndarray) -> float:
    """Correlation between predicted and realized — the standard cross-
    sectional measure of whether a forecast carries any information at all,
    independent of its scale or calibration.
    """
    a, p = np.asarray(actual), np.asarray(predicted)
    if np.std(a) == 0 or np.std(p) == 0:
        return 0.0
    return float(np.corrcoef(a, p)[0, 1])


_EPS = 1e-15


def log_loss(actual: np.ndarray, predicted_prob: np.ndarray) -> float:
    """Binary log loss. `predicted_prob` clipped away from 0/1: a model that
    is wrong with 100% confidence should cost a large but finite penalty, not
    -inf, which would let one bad row dominate every aggregate metric.
    """
    a = np.asarray(actual, dtype=float)
    p = np.clip(np.asarray(predicted_prob, dtype=float), _EPS, 1 - _EPS)
    return float(-np.mean(a * np.log(p) + (1 - a) * np.log(1 - p)))


def brier_score(actual: np.ndarray, predicted_prob: np.ndarray) -> float:
    """Mean squared error of a probability forecast against the 0/1 outcome —
    the calibration counterpart to log loss, and less sensitive to the rare
    very-confident-and-wrong row that dominates log loss.
    """
    a = np.asarray(actual, dtype=float)
    p = np.asarray(predicted_prob, dtype=float)
    return float(np.mean((p - a) ** 2))


def sharpe_ratio(returns: np.ndarray, periods_per_year: int = 252) -> float:
    r = np.asarray(returns, dtype=float)
    if np.std(r) == 0:
        return 0.0
    return float(np.mean(r) / np.std(r) * math.sqrt(periods_per_year))


def deflated_sharpe_ratio(
    observed_sharpe: float,
    n_trials: int,
    n_returns: int,
    skew: float = 0.0,
    kurtosis: float = 3.0,
    periods_per_year: int = 252,
) -> float:
    """Probability the true Sharpe ratio exceeds the noise floor implied by
    having tried `n_trials` configurations (Bailey & Lopez de Prado, 2014).

    Returns a probability in [0, 1], not a Sharpe value — "the deflated
    Sharpe is 0.85" means an 85% chance the strategy has genuine positive
    skill after accounting for how many configurations were searched to find
    it, which is a more honest question than "is the Sharpe positive".

    `n_trials` is the number this function trusts least, because it is the
    easiest to get wrong by omission: it must count every configuration that
    was *tried and rejected*, not only the one that ended up promoted. A
    model registry that logs every run — not just the winner — is what makes
    this number meaningful rather than decorative; see `model_runs` in the
    project plan.

    The expected maximum Sharpe of `n_trials` independent noise strategies
    grows with `sqrt(2 * ln(n_trials))` (an extreme-value approximation),
    which is the benchmark the observed Sharpe is tested against, adjusted
    for the sampling distribution's own skew and kurtosis.
    """
    if n_returns < 2:
        raise ValueError(f"n_returns must be at least 2, got {n_returns}")
    if n_trials < 1:
        raise ValueError(f"n_trials must be at least 1, got {n_trials}")

    sr = observed_sharpe / math.sqrt(periods_per_year)  # per-period, not annualized, for this formula

    if n_trials == 1:
        sr0 = 0.0
    else:
        # Euler-Mascheroni constant, part of the extreme-value approximation
        # for the expected maximum of n_trials standard normal draws.
        gamma = 0.5772156649
        sr0 = math.sqrt(2 * math.log(n_trials)) - gamma / math.sqrt(2 * math.log(n_trials))
        sr0 = sr0 / math.sqrt(periods_per_year)

    # Standard error of the Sharpe estimator, adjusted for non-normal returns
    # — skewed or fat-tailed strategies (most option strategies) have a wider
    # sampling distribution than the Gaussian case assumes.
    denom = math.sqrt(1 - skew * sr + (kurtosis - 1) / 4 * sr * sr)
    if denom <= 0:
        return 0.0
    se_sr = denom / math.sqrt(n_returns - 1)

    z = (sr - sr0) / se_sr
    return float(stats.norm.cdf(z))
