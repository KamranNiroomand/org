"""Labels: what the model is trained to predict.

All three targets described in the project plan are computed here, from the
same underlying data, because doing so is nearly free and directly answers
the question this project started with — "not sure which direction works
best" — by letting walk-forward evaluation rank them empirically instead of
guessing up front.

Every label here is a **forward-looking** quantity: it uses bars or quotes
from after the day it is stamped on. That is the entire point of a label, and
it is also exactly the shape of bug that leaks the future into training. This
module only *computes* the labels; it is `cv.py`'s purged, embargoed
walk-forward split that is responsible for making sure a training fold never
sees a label whose outcome window overlaps its test period. A label computed
correctly here and then joined naively into an unpurged cross-validation is
still a leak — the correctness of one does not imply the other.
"""

from __future__ import annotations

import polars as pl

from .vol import yang_zhang_vol

DIRECTION_BUCKETS = ("down", "flat", "up")


def forward_return(bars: pl.DataFrame, horizon: int) -> pl.DataFrame:
    """`close[t+horizon] / close[t] - 1`, stamped on day `t`.

    The tail `horizon` rows of each symbol have no future to look forward
    into and are dropped rather than left null — a null in a label column
    reads as "missing", and this is not missing, it is "not yet knowable",
    which a training pipeline must never be allowed to fill in.
    """
    if bars.height == 0:
        return pl.DataFrame(schema={"symbol": pl.Utf8, "day": pl.Utf8, f"fwd_ret_{horizon}d": pl.Float64})

    df = bars.sort(["symbol", "day"])
    label_col = f"fwd_ret_{horizon}d"
    with_label = df.with_columns(
        (pl.col("close").shift(-horizon).over("symbol") / pl.col("close") - 1.0).alias(label_col)
    )
    return with_label.filter(pl.col(label_col).is_not_null()).select(["symbol", "day", label_col])


def vol_scaled_forward_return(
    bars: pl.DataFrame, horizon: int, vol_window: int = 21
) -> pl.DataFrame:
    """`forward_return` divided by the symbol's own trailing volatility over
    the horizon — the return in *sigma units*, stamped on day `t`.

    Predicting raw returns hands a cross-sectional model an easier and
    useless question: most of the raw-return variance across 560 symbols
    is "which names are volatile", not "which names will go up", so model
    capacity is spent learning a vol ranking the HAR forecast already
    provides. Scaling each label by that symbol's trailing vol removes
    the nuisance axis and leaves the direction question — the standard
    normalization in the cross-sectional return-prediction literature
    (Gu, Kelly & Xiu 2020 and practitioner convention alike).

    The scale uses **only trailing** bars (`rolling_realized_vol` stamped
    on day `t` looks back, never forward), so nothing about the future
    leaks into the denominator. The scale itself (`label_sigma_h`) rides
    along per row: training divides by it, inference multiplies the
    prediction by the *current* trailing sigma to recover a return —
    symmetric by construction, and a symbol with no vol history yet drops
    out of training rather than entering with a fabricated scale.
    """
    from .vol import TRADING_DAYS_PER_YEAR, rolling_realized_vol

    raw = forward_return(bars, horizon)
    if raw.height == 0:
        return pl.DataFrame(
            schema={
                "symbol": pl.Utf8,
                "day": pl.Utf8,
                f"fwd_ret_{horizon}d": pl.Float64,
                "label_sigma_h": pl.Float64,
            }
        )
    vols = rolling_realized_vol(bars, vol_window)
    scale = (horizon / TRADING_DAYS_PER_YEAR) ** 0.5
    label_col = f"fwd_ret_{horizon}d"
    joined = raw.join(vols, on=["symbol", "day"], how="inner").with_columns(
        (pl.col("realized_vol") * scale).alias("label_sigma_h")
    )
    return (
        joined.filter(pl.col("label_sigma_h") > 0)
        .with_columns((pl.col(label_col) / pl.col("label_sigma_h")).alias(label_col))
        .select(["symbol", "day", label_col, "label_sigma_h"])
    )


def direction_bucket(
    bars: pl.DataFrame, horizon: int, flat_threshold: float = 0.01
) -> pl.DataFrame:
    """Buckets `forward_return` into down / flat / up.

    `flat_threshold` is a fraction of price, not of volatility — 1% by
    default. That is a real simplification: 1% in five days means something
    different for SPY than for a single stock running 60% annualized vol, and
    a volatility-scaled threshold would be the more defensible choice. Left
    as a fixed fraction for now because scaling it correctly needs the
    realized-vol feature already computed for the same row, which couples
    this function to `underlying_features` in a way not worth introducing
    before there is a trained model to show it matters.
    """
    ret = forward_return(bars, horizon)
    label_col = f"fwd_ret_{horizon}d"
    bucket = (
        pl.when(pl.col(label_col) > flat_threshold)
        .then(pl.lit("up"))
        .when(pl.col(label_col) < -flat_threshold)
        .then(pl.lit("down"))
        .otherwise(pl.lit("flat"))
        .alias(f"direction_{horizon}d")
    )
    return ret.with_columns(bucket).select(["symbol", "day", f"direction_{horizon}d"])


def forward_realized_vol(bars: pl.DataFrame, horizon: int) -> pl.DataFrame:
    """Annualized Yang-Zhang volatility realized over `(day, day + horizon]`.

    Stamped on `day`, using the `horizon + 1` consecutive closes from `day`
    through `day + horizon` — the same window `forward_return` uses, so a
    feature row's return label and its volatility label always describe the
    identical future interval.

    A **leading** window computed directly, day by day. An earlier version of
    this function tried to get a leading window for free by reversing the row
    order and reusing `rolling_realized_vol`'s trailing-window logic. That is
    wrong, not merely inelegant: Yang-Zhang's overnight and open-to-close
    terms are directional — `overnight[i] = log(open[i] / close[i-1])` assumes
    array order is chronological order. Reversing the rows makes "the previous
    array element" a *later* calendar day, so the reversed computation
    measures `log(open on day X / close on day X+1)`, a backwards-in-time
    quantity with no volatility interpretation at all. Caught by the test
    below, which checks the label against a hand-computed value on a small
    series small enough to verify by arithmetic.
    """
    if bars.height == 0:
        return pl.DataFrame(schema={"symbol": pl.Utf8, "day": pl.Utf8, f"fwd_rv_{horizon}d": pl.Float64})

    label_col = f"fwd_rv_{horizon}d"
    window = horizon + 1  # horizon returns need horizon + 1 closes.
    out_frames: list[pl.DataFrame] = []

    for symbol, group in bars.sort("day").group_by("symbol", maintain_order=True):
        g = group.sort("day")
        o = g["open"].to_numpy()
        h = g["high"].to_numpy()
        l = g["low"].to_numpy()
        c = g["close"].to_numpy()
        days = g["day"].to_list()
        sym = symbol[0] if isinstance(symbol, tuple) else symbol

        n = len(c)
        vols: list[float] = []
        stamped_days: list[str] = []
        for i in range(0, n - window + 1):
            vols.append(yang_zhang_vol(o[i : i + window], h[i : i + window], l[i : i + window], c[i : i + window]))
            stamped_days.append(days[i])

        if vols:
            out_frames.append(
                pl.DataFrame({"symbol": [sym] * len(vols), "day": stamped_days, label_col: vols})
            )

    if not out_frames:
        return pl.DataFrame(schema={"symbol": pl.Utf8, "day": pl.Utf8, label_col: pl.Float64})
    return pl.concat(out_frames).sort(["symbol", "day"])


def vrp_label(current_iv: float, forward_realized_vol_value: float) -> float:
    """Implied vol minus forward realized vol — the primary training target.

    Positive means the option was, in hindsight, priced above the volatility
    that actually materialized: the classic variance risk premium, and the
    best-documented persistent edge in options.

    **Annotation, not a fix.** `current_iv` comes from `pricing.py`, which
    solves under a calendar-day (365) time convention — validated against a
    real broker's chain. `forward_realized_vol_value` comes from
    `forward_realized_vol` above, which annualizes by trading days (252) — the
    standard convention for measuring a return process, since returns only
    occur on trading days. See the module docstring in `vol.py` for why both
    choices are individually correct and not the same choice.

    Subtracting them directly is correct to first order: under the same
    trading-time model the two annualizations compose — see `vol.py`'s
    module docstring for the algebra, and for why "reconciling" them with a
    `sqrt(365/252) ≈ 1.20x` multiplier (which an earlier version of this
    comment wrongly said was owed) would *introduce* a 20% error rather
    than remove one. What remains is second-order: holiday clustering and
    horizon-boundary effects make the trading-days-per-calendar-day ratio
    slightly non-constant across horizons, so treat comparisons of
    *absolute* VRP level across horizons with a little more caution than
    comparisons of its *sign* or its *rank* within one horizon.
    """
    return current_iv - forward_realized_vol_value


def contract_return(entry_mid: float, exit_mid: float) -> float:
    """A contract's own return from entry to exit.

    Never the primary training target — see the project plan's core design
    decision. A one-cent tick on a five-cent option is a twenty-percent move,
    and training on that noise is how a backtest manufactures an edge that
    evaporates on the first real fill. Kept here only as a **validation
    check**: after training on `vrp_label`, this is what actually would have
    happened to a position, for comparing against what the model predicted.

    Takes plain mid prices rather than reading quotes itself, because no
    option quotes have been captured yet — this is complete and tested
    against the arithmetic it performs, and wiring it to real entry/exit
    quotes is one call site, not a redesign.
    """
    if entry_mid <= 0:
        raise ValueError(f"entry_mid must be positive, got {entry_mid}")
    return exit_mid / entry_mid - 1.0
