"""HAR-RV: a volatility *forecast*, where this project previously had a
volatility *measurement* standing in for one.

`rank.py` prices every contract against a view on future volatility, and
until now that view was "the last 21 days of realized vol, unchanged" — an
honest placeholder, flagged as such in `rank.py`'s own module docstring,
but a placeholder with a specific and well-documented bias: realized
volatility mean-reverts, so extrapolating the trailing window flat
overstates vol after a spike and understates it after a lull. Those are
exactly the moments an option is mispriced enough to be worth ranking, so
the placeholder was weakest where the system most needed it to be strong.

The Heterogeneous AutoRegressive model (Corsi, *A Simple Approximate
Long-Memory Model of Realized Volatility*, Journal of Financial
Econometrics 2009) is the standard answer and is deliberately simple: a
linear regression of future realized volatility on the trailing daily,
weekly, and monthly averages of realized volatility. Three regressors, one
OLS. Its power comes from the cascade it approximates — short-, medium-,
and long-horizon traders each acting on their own frequency — which
reproduces the long-memory decay of the volatility autocorrelation without
fitting a long-memory process. It is hard to beat and trivial to audit,
which for a system whose measured edge is one t-statistic away from noise
matters more than sophistication.

**Two deliberate departures from a textbook HAR, both forced by this
project's data rather than chosen:**

1. **Fit in logs.** Realized volatility is right-skewed and bounded below
   by zero; log RV is close to Gaussian (Andersen, Bollerslev, Diebold &
   Labys 2003), which is what makes OLS's own assumptions approximately
   true and stops one volatility explosion from dominating the fit. It
   also makes the forecast multiplicatively unbiased in a way a
   levels-fit is not, which matters because `rank.py` consumes this as a
   *ratio*.

2. **Pooled across symbols, not one fit per symbol.** Corsi fits a single
   long series; this corpus has ~500 trading days across 566 names, so a
   per-symbol fit would estimate four parameters from a few hundred
   overlapping observations each and overfit visibly. Pooling trades the
   ability to say "this name's vol is unusually persistent" for parameter
   estimates that are actually identified. The volatility cascade HAR
   models is a market-wide phenomenon, so a shared set of coefficients is
   a defensible restriction rather than a pure concession.

**What is deliberately not here yet: implied volatility as a regressor.**
That is the single most valuable addition — IV is forward-looking where
every regressor here is backward-looking, and the literature is
consistent that it carries information beyond historical RV. It is not
included because it cannot be: `option_quotes` holds **4 trading days** of
solved IV against 500 days of bars, so adding it would drop 496 of 500
training days. This is the same "the corpus needs to age" gate that
already blocks the `vrp` target and the sentiment features, and the same
answer applies — the seam is left open (`fit_har` takes its design matrix
from `har_features`, which a caller can widen) rather than the feature
being faked from four days of history.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import polars as pl

from .vol import TRADING_DAYS_PER_YEAR, yang_zhang_vol

#: Corsi's original cascade: one day, one week, one month of trading days.
DAILY_WINDOW = 2  # Yang-Zhang needs a prior close, so "daily" is the shortest honest window
WEEKLY_WINDOW = 5
MONTHLY_WINDOW = 22

#: Forecast horizon in trading days. Matches `rank.py`'s existing 21-day
#: vol window, so this is a drop-in replacement for the number it fed —
#: not a different quantity that happens to live in the same slot.
DEFAULT_FORECAST_HORIZON = 21

#: Floor applied before taking logs. A genuinely zero realized vol is a
#: halted or untraded name, not a calm one, and log(0) would poison the
#: whole fit.
_MIN_VOL = 1e-6


@dataclass(frozen=True)
class HarCoefficients:
    """A fitted HAR-RV model. Coefficients are on **log** volatility."""

    intercept: float
    beta_daily: float
    beta_weekly: float
    beta_monthly: float
    n_observations: int
    #: In-sample R² on log RV. Reported so a caller can see the fit is real
    #: rather than assuming it: HAR on log RV typically lands around
    #: 0.4-0.6, and a value near zero means something is wrong with the
    #: panel, not that volatility became unforecastable.
    r_squared: float

    def predict_log(self, daily: float, weekly: float, monthly: float) -> float:
        return (
            self.intercept
            + self.beta_daily * math.log(max(daily, _MIN_VOL))
            + self.beta_weekly * math.log(max(weekly, _MIN_VOL))
            + self.beta_monthly * math.log(max(monthly, _MIN_VOL))
        )

    def predict(self, daily: float, weekly: float, monthly: float) -> float:
        """Forecast volatility in levels.

        Includes the Jensen correction that a naive `exp(fitted)` omits.
        `E[exp(x)] > exp(E[x])` for any non-degenerate x, so exponentiating
        a log-scale forecast returns the *median*, not the mean, and is
        biased low by roughly `exp(sigma^2 / 2)`. Left uncorrected, every
        forecast vol would sit systematically under the truth, and since
        `rank.py` divides this by market IV, that bias would translate
        directly into a standing "options look expensive" tilt — a bias
        with the shape of a trading signal, which is the worst kind.
        """
        return math.exp(self.predict_log(daily, weekly, monthly) + self.residual_variance / 2.0)

    #: Residual variance of the log-scale fit, carried for the Jensen
    #: correction above.
    residual_variance: float = 0.0


def har_features(bars: pl.DataFrame) -> pl.DataFrame:
    """Per symbol-day daily/weekly/monthly realized-vol components.

    Each component is the Yang-Zhang volatility over its own trailing
    window ending on that day, which is what makes them a *cascade* rather
    than three copies of one number: the daily term reacts immediately, the
    monthly term barely moves, and the regression learns how much weight
    each frequency deserves.

    Rows without a full monthly window behind them are dropped rather than
    computed on a partial one — the same rule `rolling_realized_vol`
    already applies, and for the same reason: a 22-day estimator run over 6
    days is a different, unlabelled estimator, not a noisier version of the
    same one.
    """
    out_symbol: list[str] = []
    out_day: list[str] = []
    out_daily: list[float] = []
    out_weekly: list[float] = []
    out_monthly: list[float] = []

    for symbol, group in bars.sort("day").group_by("symbol", maintain_order=True):
        g = group.sort("day")
        o = g["open"].to_numpy()
        h = g["high"].to_numpy()
        low = g["low"].to_numpy()
        c = g["close"].to_numpy()
        days = g["day"].to_list()
        name = symbol[0] if isinstance(symbol, tuple) else symbol

        for i in range(MONTHLY_WINDOW - 1, len(c)):
            def vol_over(window: int) -> float:
                lo = i - window + 1
                return yang_zhang_vol(o[lo : i + 1], h[lo : i + 1], low[lo : i + 1], c[lo : i + 1])

            out_symbol.append(name)
            out_day.append(days[i])
            out_daily.append(vol_over(DAILY_WINDOW))
            out_weekly.append(vol_over(WEEKLY_WINDOW))
            out_monthly.append(vol_over(MONTHLY_WINDOW))

    return pl.DataFrame(
        {
            "symbol": out_symbol,
            "day": out_day,
            "rv_daily": out_daily,
            "rv_weekly": out_weekly,
            "rv_monthly": out_monthly,
        },
        schema={
            "symbol": pl.Utf8,
            "day": pl.Utf8,
            "rv_daily": pl.Float64,
            "rv_weekly": pl.Float64,
            "rv_monthly": pl.Float64,
        },
    )


def har_targets(features: pl.DataFrame, horizon: int = DEFAULT_FORECAST_HORIZON) -> pl.DataFrame:
    """Attaches the forward realized vol each row is trying to predict.

    The target is the **monthly component `horizon` days ahead** — that is,
    the realized vol actually observed over the window starting after this
    row's day. Using the already-computed monthly column rather than
    recomputing keeps the target on exactly the same estimator as the
    regressors, so a fitted coefficient means what it appears to mean.

    Rows within `horizon` days of the end of a symbol's history have no
    observable future and are dropped. That is the one place a leak could
    enter this file, so it is done by construction — shifting within each
    symbol — rather than by a filter a later edit could quietly widen.
    """
    if horizon < 1:
        raise ValueError(f"horizon must be at least 1, got {horizon}")
    return (
        features.sort(["symbol", "day"])
        .with_columns(
            pl.col("rv_monthly").shift(-horizon).over("symbol").alias("rv_forward"),
        )
        .drop_nulls("rv_forward")
    )


def fit_har(panel: pl.DataFrame) -> HarCoefficients:
    """OLS of log forward RV on the log cascade, pooled across symbols.

    `panel` must carry `rv_daily`/`rv_weekly`/`rv_monthly`/`rv_forward` —
    i.e. the output of `har_targets`. Solved with `lstsq` rather than a
    normal-equation inverse: the three regressors are strongly collinear by
    construction (a month of vol contains the week that contains the day),
    and the normal equations square that condition number where the
    least-squares solver does not.
    """
    if panel.height < 4:
        raise ValueError(f"HAR needs at least 4 observations to fit 4 parameters, got {panel.height}")

    def logs(col: str) -> np.ndarray:
        return np.log(np.maximum(panel[col].to_numpy().astype(float), _MIN_VOL))

    x = np.column_stack([np.ones(panel.height), logs("rv_daily"), logs("rv_weekly"), logs("rv_monthly")])
    y = logs("rv_forward")

    coefs, *_ = np.linalg.lstsq(x, y, rcond=None)
    residuals = y - x @ coefs
    ss_res = float(np.sum(residuals**2))
    ss_tot = float(np.sum((y - y.mean()) ** 2))

    return HarCoefficients(
        intercept=float(coefs[0]),
        beta_daily=float(coefs[1]),
        beta_weekly=float(coefs[2]),
        beta_monthly=float(coefs[3]),
        n_observations=panel.height,
        r_squared=1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0,
        # ddof for the four fitted parameters.
        residual_variance=ss_res / max(1, panel.height - 4),
    )


def forecast_vol_by_symbol(
    bars: pl.DataFrame,
    trading_day: str,
    horizon: int = DEFAULT_FORECAST_HORIZON,
) -> tuple[dict[str, float], HarCoefficients]:
    """The whole pipeline, as `rank.py` consumes it: fit on history strictly
    before `trading_day`, then forecast each symbol from its latest
    components on or before that day.

    **The fit uses only rows whose forward window has already closed by
    `trading_day`.** That is the leak guard, and it is stricter than it may
    look: a row dated `trading_day - 5` has a target that runs 21 days
    *past* it and so is still unobservable, even though the row's own date
    is comfortably in the past. Filtering on the row date instead of the
    target's end date is the classic overlapping-label leak, and it would
    flatter this forecast with information from the very window it is
    predicting.
    """
    features = har_features(bars)
    if features.height == 0:
        raise ValueError("No HAR features could be built — not enough trailing bars.")

    targets = har_targets(features, horizon)
    # `rv_forward` on a row dated d is realized over the window ending
    # `horizon` trading days after d, so the row is only usable once that
    # end date is itself in the past. Approximating trading days with a
    # generous calendar span keeps this conservative rather than clever.
    usable = targets.filter(pl.col("day") <= _shift_back(trading_day, horizon))
    if usable.height < 4:
        raise ValueError(
            f"Only {usable.height} HAR observation(s) close before {trading_day} — "
            f"not enough history to fit a volatility forecast."
        )

    coefs = fit_har(usable)

    latest = (
        features.filter(pl.col("day") <= trading_day)
        .sort("day")
        .group_by("symbol", maintain_order=True)
        .last()
    )
    out: dict[str, float] = {}
    for row in latest.iter_rows(named=True):
        out[row["symbol"]] = coefs.predict(row["rv_daily"], row["rv_weekly"], row["rv_monthly"])
    return out, coefs


def _shift_back(day: str, trading_days: int) -> str:
    """`day` minus roughly `trading_days` trading days, as a date string.

    Deliberately approximate and deliberately generous: 7/5 converts
    trading days to calendar days and the extra week absorbs holidays. This
    only ever *excludes* borderline rows from the fit, so erring long costs
    a few observations while erring short would admit a leak.
    """
    from datetime import date, timedelta

    calendar_days = int(trading_days * 7 / 5) + 7
    return (date.fromisoformat(day) - timedelta(days=calendar_days)).isoformat()


def annualized(daily_variance: float) -> float:
    """Kept explicit so the 252 convention is visible at the call site —
    see `vol.py`'s module docstring on why realized vol annualizes by
    trading days while `pricing.py` uses calendar days."""
    return math.sqrt(daily_variance * TRADING_DAYS_PER_YEAR)
