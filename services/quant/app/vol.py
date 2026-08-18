"""Realized volatility from daily OHLC bars.

Close-to-close volatility — the naive estimator most tutorials reach for —
throws away the overnight gap, which is most of the move around earnings and
other after-hours events. **Yang-Zhang** (Yang & Zhang, 2000) uses the full
open-high-low-close bar and is unbiased in the presence of both an opening
jump and intraday drift, which is why it is the only estimator this module
implements rather than one of several.

A note on the annualization convention, because it does not match
`pricing.py`, and that mismatch is a decision rather than an oversight.
`pricing.py` solves implied volatility using **calendar days over 365** —
validated, in `tests/test_pricing.py`, against a real broker's chain, where it
beat every trading-day alternative by an order of magnitude. That convention
answers "what volatility reproduces this market price", and calendar time is
empirically what brokers use for that.

Realized volatility answers a different question — "how much did the
underlying actually move" — and returns only exist on trading days. A weekend
contributes to calendar time but not, in general, to price variance, so
annualizing by the count of trading days (252) rather than calendar days (365)
is the standard, unbiased choice for measuring the return process itself.

The two conventions are therefore not directly comparable, and subtracting one
from the other — which is exactly what the volatility-risk-premium label does
— carries a small, day-count-dependent wedge on the order of
`sqrt(365/252) ≈ 1.20x`. That is flagged rather than "fixed" here, because
fixing it means picking a specific reconciliation and there is not yet enough
captured implied-vol history to validate one empirically, the way the
calendar-day choice above was validated. See `labels.py::vrp_label`.
"""

from __future__ import annotations

import math

import numpy as np
import polars as pl

TRADING_DAYS_PER_YEAR = 252


def yang_zhang_variance(
    open_: np.ndarray, high: np.ndarray, low: np.ndarray, close: np.ndarray
) -> float:
    """Daily (non-annualized) Yang-Zhang variance over the given window.

    All four arrays must be aligned and cover the same set of consecutive
    trading days, with at least two rows — the overnight term needs a prior
    close. Raises rather than returning `nan` on too little data: a silent
    `nan` propagates into a feature column and is far harder to trace back to
    "this window was too short" than an exception raised at the source.
    """
    n = len(close)
    if not (len(open_) == len(high) == len(low) == n):
        raise ValueError("open/high/low/close must be the same length")
    if n < 2:
        raise ValueError(f"Yang-Zhang needs at least 2 bars, got {n}")

    prev_close = close[:-1]
    o = open_[1:]
    h = high[1:]
    l = low[1:]
    c = close[1:]
    m = n - 1  # number of return observations

    overnight = np.log(o / prev_close)
    open_to_close = np.log(c / o)
    # Rogers-Satchell: unbiased per-period regardless of drift, so it is
    # averaged directly rather than measured as a variance around a mean.
    rs = np.log(h / c) * np.log(h / o) + np.log(l / c) * np.log(l / o)

    # ddof=1: these are sample variances estimated from the window, not the
    # population parameters.
    var_overnight = float(np.var(overnight, ddof=1)) if m > 1 else 0.0
    var_open_close = float(np.var(open_to_close, ddof=1)) if m > 1 else 0.0
    var_rs = float(np.mean(rs))

    # The Yang-Zhang weight, minimizing the estimator's variance for a window
    # of m periods. Reduces to close-to-close-like weighting as m grows.
    k = 0.34 / (1.34 + (m + 1) / (m - 1)) if m > 1 else 0.34

    variance = var_overnight + k * var_open_close + (1 - k) * var_rs
    # A pathological window (e.g. a zero-volume halt repeating the same OHLC)
    # can drive this fractionally negative through floating-point error in the
    # Rogers-Satchell term; volatility is never negative.
    return max(variance, 0.0)


def yang_zhang_vol(
    open_: np.ndarray, high: np.ndarray, low: np.ndarray, close: np.ndarray
) -> float:
    """Annualized Yang-Zhang volatility — the square root of the variance above."""
    return math.sqrt(yang_zhang_variance(open_, high, low, close) * TRADING_DAYS_PER_YEAR)


def rolling_realized_vol(bars: pl.DataFrame, window: int) -> pl.DataFrame:
    """Trailing annualized Yang-Zhang vol per symbol, one row per trading day.

    `bars` must have the columns produced by `db.read_bars`. The first
    `window` rows of each symbol have no full window behind them and are
    dropped rather than computed on a partial one — a vol estimate from three
    days when the window calls for twenty-one is not a noisier version of the
    same number, it is a different, unlabelled estimator.
    """
    if window < 2:
        raise ValueError(f"window must be at least 2, got {window}")

    out_symbols: list[str] = []
    out_days: list[str] = []
    out_vols: list[float] = []

    for symbol, group in bars.sort("day").group_by("symbol", maintain_order=True):
        g = group.sort("day")
        o = g["open"].to_numpy()
        h = g["high"].to_numpy()
        l = g["low"].to_numpy()
        c = g["close"].to_numpy()
        days = g["day"].to_list()

        # Window i covers bars[i - window + 1 .. i] inclusive, i.e. `window`
        # closes and `window - 1` return observations, matching the day the
        # label is stamped on to the last bar actually used.
        for i in range(window - 1, len(c)):
            lo = i - window + 1
            out_symbols.append(symbol[0] if isinstance(symbol, tuple) else symbol)
            out_days.append(days[i])
            out_vols.append(yang_zhang_vol(o[lo : i + 1], h[lo : i + 1], l[lo : i + 1], c[lo : i + 1]))

    return pl.DataFrame(
        {"symbol": out_symbols, "day": out_days, "realized_vol": out_vols},
        schema={"symbol": pl.Utf8, "day": pl.Utf8, "realized_vol": pl.Float64},
    )


def close_to_close_vol(close: np.ndarray) -> float:
    """The naive estimator, kept only as a comparison baseline in tests.

    Never used as a feature: it is close-to-close and so contributes nothing
    that Yang-Zhang does not already capture, while missing the overnight
    term entirely.
    """
    if len(close) < 2:
        raise ValueError("close-to-close vol needs at least 2 bars")
    log_returns = np.diff(np.log(close))
    return math.sqrt(float(np.var(log_returns, ddof=1)) * TRADING_DAYS_PER_YEAR)
