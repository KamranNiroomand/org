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
    """Pearson correlation between predicted and realized, over whatever rows
    it is given.

    **Not the headline metric, and not safe to call on a whole panel.** Called
    on every symbol-day at once it measures the wrong thing: most of the
    variance in a pooled panel is *time-series* (the whole market up on up
    days), so a model that only knows "stocks tend to rise" scores well
    without any ability to tell one stock from another — which is the only
    ability this system actually uses when it picks a contract to buy. It also
    destroys the per-day series needed to put a standard error on the result,
    so a pooled number invites the naive `1/sqrt(n_rows)` reading, which
    treats 560 same-day symbols as 560 independent observations.

    Retained because it is what `ic_summary` applies *within* a single day,
    and because the metric under this name is stored on every historical
    `model_runs` row — redefining it in place would silently corrupt that
    series. New work should read `ic_summary`.
    """
    a, p = np.asarray(actual, dtype=float), np.asarray(predicted, dtype=float)
    if a.size < 2 or np.std(a) == 0 or np.std(p) == 0:
        return 0.0
    return float(np.corrcoef(a, p)[0, 1])


def _rankdata(x: np.ndarray) -> np.ndarray:
    """Average ranks, ties shared — `scipy.stats.rankdata`'s default, done
    here to keep this module dependency-free like the rest of it."""
    order = np.argsort(x, kind="mergesort")
    ranks = np.empty(len(x), dtype=float)
    ranks[order] = np.arange(1, len(x) + 1, dtype=float)
    # Average the ranks within each group of tied values.
    sorted_x = x[order]
    start = 0
    for i in range(1, len(x) + 1):
        if i == len(x) or sorted_x[i] != sorted_x[start]:
            if i - start > 1:
                ranks[order[start:i]] = ranks[order[start:i]].mean()
            start = i
    return ranks


def rank_information_coefficient(actual: np.ndarray, predicted: np.ndarray) -> float:
    """Spearman correlation — the headline form of IC.

    Preferred over Pearson on raw forward returns because those are
    fat-tailed: a couple of earnings gaps can set the sign of a Pearson IC
    outright. Rank correlation also matches how the forecast is used — the
    system buys the *top-ranked* contract, so monotone ordering is what
    matters, not whether the predicted magnitude is calibrated.
    """
    a, p = np.asarray(actual, dtype=float), np.asarray(predicted, dtype=float)
    if a.size < 2:
        return 0.0
    return information_coefficient(_rankdata(a), _rankdata(p))


def _group_by_day(
    days: np.ndarray, actual: np.ndarray, predicted: np.ndarray, min_names_per_day: int
) -> list[tuple[str, np.ndarray, np.ndarray]]:
    """Bucket rows by trading day, once, dropping unusable rows and thin days.

    Two things worth being explicit about:

    * Days are normalized to `str` **before** grouping, and the grouping key
      comes from the same normalized array the buckets are built from. An
      earlier version stringified the key but matched against the raw values,
      so a non-string day dtype would have matched nothing, dropped every
      day, and reported a skill-less model rather than an error.
    * Non-finite pairs are dropped here. A single NaN otherwise reaches
      `np.corrcoef`, returns NaN, and propagates through every summary
      statistic into `manifest.json` — where `json.dumps` writes a bare
      `NaN` literal that the Node side's `JSON.parse` rejects outright,
      breaking model registration and `/rank` rather than degrading.
    """
    day_keys = np.asarray([str(d) for d in np.asarray(days, dtype=object)], dtype=object)
    a = np.asarray(actual, dtype=float)
    p = np.asarray(predicted, dtype=float)
    usable = np.isfinite(a) & np.isfinite(p)

    buckets: dict[str, list[int]] = {}
    for idx in np.flatnonzero(usable):
        buckets.setdefault(day_keys[idx], []).append(int(idx))

    grouped: list[tuple[str, np.ndarray, np.ndarray]] = []
    for day in sorted(buckets):
        rows = np.asarray(buckets[day], dtype=int)
        if rows.size < min_names_per_day:
            continue
        grouped.append((day, a[rows], p[rows]))
    return grouped


def daily_ic_series(
    days: np.ndarray,
    actual: np.ndarray,
    predicted: np.ndarray,
    rank: bool = True,
    min_names_per_day: int = 5,
) -> tuple[list[str], np.ndarray]:
    """One cross-sectional IC per trading day, in day order.

    This is the standard construction: correlate predictions against outcomes
    *within* each day, across the names available that day, and treat the
    resulting series as the sample. Days with fewer than `min_names_per_day`
    names are dropped rather than contributing a correlation over two or
    three points, which is mostly noise and would inflate the series' own
    variance.
    """
    measure = rank_information_coefficient if rank else information_coefficient
    grouped = _group_by_day(days, actual, predicted, min_names_per_day)
    out_days = [day for day, _, _ in grouped]
    out_ics = [measure(a, p) for _, a, p in grouped]
    return out_days, np.asarray(out_ics, dtype=float)


def multiple_testing_hurdle(n_trials: int, alpha: float = 0.05) -> float:
    """Two-sided critical t after Bonferroni-correcting for `n_trials`.

    `Z^-1(1 - alpha / (2 * n_trials))`. Degrades to the familiar 1.96 at a
    single trial and rises slowly: 2.24 at 2 trials, 2.87 at 12, 3.48 at 100.

    An earlier version multiplied the expected maximum of `n_trials` draws
    (`sqrt(2 ln N)`) by 2.0. That conflated two different things — the
    standard corrections *replace* the significance threshold with the
    multiple-testing one, they do not scale the 2.0 by it — and it came out
    roughly twice as strict as it should be (4.46 rather than 2.87 at twelve
    trials), which would reject a genuinely skilled model.
    """
    n = max(1, n_trials)
    return float(stats.norm.ppf(1.0 - alpha / (2.0 * n)))


def ic_summary(
    days: np.ndarray,
    actual: np.ndarray,
    predicted: np.ndarray,
    horizon: int = 1,
    n_trials: int = 1,
    min_names_per_day: int = 5,
    alpha: float = 0.05,
) -> dict[str, float | int | bool]:
    """Everything needed to judge whether an IC is real, in one place.

    Three corrections the pooled number cannot express:

    * **Effective sample size.** With a `horizon`-day forward label,
      consecutive daily ICs overlap and are not independent observations. The
      t-statistic here uses `n_days / horizon` — the count of genuinely
      non-overlapping periods — which for a 5-day label is 5x more
      conservative than counting days, and vastly more so than counting rows.
    * **Dispersion.** `ICIR = mean / std` of the daily series. Published
      cross-sectional IC series routinely have standard deviations several
      times their mean, so a respectable-looking mean IC can still be
      indistinguishable from zero.
    * **Multiple testing.** Every configuration tried is a chance to find
      noise that looks like signal, so `ic_t_hurdle` Bonferroni-corrects the
      critical value for `n_trials` — see `multiple_testing_hurdle`.
      `n_trials` must count every configuration *considered*, not every run
      saved.
    """
    # Grouped once and measured twice, rather than walking the panel twice:
    # the bucketing is the expensive half on a six-figure row count.
    grouped = _group_by_day(days, actual, predicted, min_names_per_day)
    day_list = [day for day, _, _ in grouped]
    ics = np.asarray([rank_information_coefficient(a, p) for _, a, p in grouped], dtype=float)
    ics_pearson = np.asarray([information_coefficient(a, p) for _, a, p in grouped], dtype=float)

    n_days = len(day_list)
    if n_days == 0:
        return {
            "ic_mean": 0.0, "ic_std": 0.0, "icir": 0.0, "ic_t_stat": 0.0,
            "ic_hit_rate": 0.0, "ic_n_days": 0, "ic_n_effective": 0,
            "ic_mean_pearson": 0.0,
            "ic_t_hurdle": multiple_testing_hurdle(n_trials, alpha),
            "ic_clears_hurdle": False,
        }

    mean = float(np.mean(ics))
    std = float(np.std(ics, ddof=1)) if n_days > 1 else 0.0
    icir = mean / std if std > 0 else 0.0
    n_eff = max(1, n_days // max(1, horizon))
    t_stat = icir * math.sqrt(n_eff)
    hurdle = multiple_testing_hurdle(n_trials, alpha)

    return {
        "ic_mean": mean,
        "ic_std": std,
        "icir": icir,
        "ic_t_stat": t_stat,
        "ic_hit_rate": float(np.mean(ics > 0)),
        "ic_n_days": n_days,
        "ic_n_effective": n_eff,
        # A large gap against the rank version means the Pearson number is
        # being driven by a handful of outlier returns.
        "ic_mean_pearson": float(np.mean(ics_pearson)),
        "ic_t_hurdle": hurdle,
        "ic_clears_hurdle": bool(abs(t_stat) >= hurdle),
    }


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


def max_drawdown(cumulative: np.ndarray) -> float:
    """Largest peak-to-trough decline in a cumulative P&L or equity series.

    Returned as a positive number — "the drawdown was 1200.0", not "-1200.0"
    — since every caller so far wants magnitude, and a stray missing minus
    sign turning a loss into a gain is exactly the kind of silent sign bug
    this project's conventions elsewhere (E4 money, explicit null vs. zero)
    exist to make impossible by construction.
    """
    c = np.asarray(cumulative, dtype=float)
    if c.size == 0:
        return 0.0
    running_peak = np.maximum.accumulate(c)
    drawdown = running_peak - c
    return float(np.max(drawdown))


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
