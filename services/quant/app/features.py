"""Features: what the model actually sees.

Two families, and they are built differently because they answer to different
amounts of data.

**Underlying features** need only bars, which the backfill already provides
for the whole universe. They can be built and validated today.

**Chain surface features** need a captured option chain — validated against
the real corpus now that one exists (see `tests/test_features.py`'s
`TestChainFeaturesOnRealMultiExpiryChain`), not just the synthetic panel they
shipped unit-tested against. That validation caught a real bug: `db.py`'s
`read_quotes` did not dedupe a day recaptured after an interrupted run,
silently double-counting roughly 16% of contracts in `put_call_ratios`' sums
— fixed at the source rather than here.

It also surfaced something that is not a code bug but is worth knowing before
using these: **near-zero-DTE ATM IV can be dominated by a stale trade
print.** A 1-day AAPL call solved to 84% IV against every neighbouring
strike sitting near 30-40% — not a real term-structure event, but a `close`
price captured from a trade that happened earlier in the day than the
underlying price recorded alongside it, on a contract this data plan has no
live quote to sanity-check against. `term_slope` and `risk_reversal_25d` will
faithfully compute a number from whatever `atm_iv_by_expiry` selects, noise
included — filtering to a minimum DTE before calling them, once there is
enough captured history to pick a threshold from evidence rather than a
guess, is the next honest step here, not a silent clamp added now.
"""

from __future__ import annotations

import polars as pl

MOMENTUM_WINDOWS = (1, 5, 10, 21, 63)
VOLUME_Z_WINDOW = 21


def underlying_features(bars: pl.DataFrame) -> pl.DataFrame:
    """Momentum, realized-vol context, and volume anomaly, per symbol per day.

    Built with Polars window expressions rather than a Python loop over
    windows — this runs over the whole universe's history at once, and a
    hundred-symbol, two-year backfill is millions of row-operations if done
    one window at a time in pure Python.

    Rows before the longest window (63 trading days, roughly a quarter) has
    accumulated are dropped, for the same reason `rolling_realized_vol` drops
    its unwindowed head: a momentum figure computed on eight days when the
    label calls for sixty-three is a different, unlabelled quantity, not a
    noisier version of the same one.
    """
    if bars.height == 0:
        return pl.DataFrame(
            schema={
                "symbol": pl.Utf8,
                "day": pl.Utf8,
                **{f"momentum_{w}d": pl.Float64 for w in MOMENTUM_WINDOWS},
                "volume_zscore_21d": pl.Float64,
            }
        )

    df = bars.sort(["symbol", "day"])
    exprs = [
        (pl.col("close") / pl.col("close").shift(w).over("symbol") - 1.0).alias(f"momentum_{w}d")
        for w in MOMENTUM_WINDOWS
    ]

    vol_mean = pl.col("volume").rolling_mean(VOLUME_Z_WINDOW).over("symbol")
    vol_std = pl.col("volume").rolling_std(VOLUME_Z_WINDOW).over("symbol")
    # A std of exactly zero (a halted or illiquid name with identical volume
    # for 21 straight days) would divide to +/-inf. Null reads downstream as
    # "no signal here", which is closer to the truth than an infinity a model
    # would happily treat as the most extreme observation in the dataset.
    volume_z = (
        pl.when(vol_std > 0)
        .then((pl.col("volume") - vol_mean) / vol_std)
        .otherwise(None)
        .alias("volume_zscore_21d")
    )

    out = df.with_columns(exprs + [volume_z]).select(
        ["symbol", "day"] + [f"momentum_{w}d" for w in MOMENTUM_WINDOWS] + ["volume_zscore_21d"]
    )

    max_window = max(MOMENTUM_WINDOWS + (VOLUME_Z_WINDOW,))
    row_index = pl.int_range(pl.len()).over("symbol")
    return out.filter(row_index >= max_window)


# ---------------------------------------------------------------------------
# Second-generation bars-only features
#
# Proposed by agents/hypotheses.ts, dogfooded against the real, full-
# universe direction model (563 symbols, 432 days): it does not beat its
# own mean baseline (IC ~0.01) on the six columns above, and hypotheses.ts's
# own diagnosis was that raw momentum on a wide cross-sectional panel is
# mostly a market-beta loading, which dilutes whatever stock-specific signal
# momentum might otherwise carry. Every function below targets a distinct,
# named economic mechanism rather than a rescaling of what underlying_features
# already computes — see each docstring for which one and why it should
# differ in sign or timing from plain momentum.
# ---------------------------------------------------------------------------

OVERNIGHT_INTRADAY_WINDOWS = (5, 21)


def overnight_intraday_returns(
    bars: pl.DataFrame, windows: tuple[int, ...] = OVERNIGHT_INTRADAY_WINDOWS
) -> pl.DataFrame:
    """Splits each day's total return into close-to-open (overnight) and
    open-to-close (intraday) components, cumulated over each window.

    `momentum_Xd` in `underlying_features` is these two added together, and
    adding them together is exactly what cancels their signal: overnight
    returns are news- and earnings-driven and tend to persist, while
    intraday returns are dominated by market-maker inventory and liquidity
    provision and tend to mean-revert. A plain momentum column carries both
    at once with no way to tell them apart.
    """
    schema = {"symbol": pl.Utf8, "day": pl.Utf8}
    for w in windows:
        schema[f"overnight_ret_{w}d"] = pl.Float64
        schema[f"intraday_ret_{w}d"] = pl.Float64
    if bars.height == 0:
        return pl.DataFrame(schema=schema)

    df = bars.sort(["symbol", "day"]).with_columns(
        (pl.col("open") / pl.col("close").shift(1).over("symbol") - 1.0).alias("_overnight"),
        (pl.col("close") / pl.col("open") - 1.0).alias("_intraday"),
    )

    cols: list[str] = []
    exprs = []
    for w in windows:
        oc, ic = f"overnight_ret_{w}d", f"intraday_ret_{w}d"
        cols += [oc, ic]
        exprs.append(pl.col("_overnight").rolling_sum(window_size=w).over("symbol").alias(oc))
        exprs.append(pl.col("_intraday").rolling_sum(window_size=w).over("symbol").alias(ic))

    out = df.with_columns(exprs).select(["symbol", "day"] + cols)
    longest = f"overnight_ret_{max(windows)}d"
    return out.filter(pl.col(longest).is_not_null())


CLV_WINDOWS = (1, 5)


def close_location_value(bars: pl.DataFrame, windows: tuple[int, ...] = CLV_WINDOWS) -> pl.DataFrame:
    """Where the close sits inside the day's own range, `(close-low)/(high-low)`,
    averaged over each window — a proxy for end-of-day order imbalance.

    A close pinned at the low means the day's sellers were still hitting
    bids into the close (index rebalancing, forced liquidation, redemption
    flow); a liquidity provider who absorbed that flow needs compensating
    for it, which shows up as a short-horizon bounce. This is pressure, not
    price change — a stock can close at its low on a flat day, which no
    momentum window sees at all.
    """
    schema = {"symbol": pl.Utf8, "day": pl.Utf8}
    for w in windows:
        schema[f"close_location_value_{w}d"] = pl.Float64
    if bars.height == 0:
        return pl.DataFrame(schema=schema)

    df = bars.sort(["symbol", "day"]).with_columns(
        pl.when(pl.col("high") > pl.col("low"))
        .then((pl.col("close") - pl.col("low")) / (pl.col("high") - pl.col("low")))
        # A day with zero range (a halt, or a name that trades once): the
        # close is trivially "in the middle" rather than an inf/nan.
        .otherwise(0.5)
        .alias("_clv")
    )

    cols = [f"close_location_value_{w}d" for w in windows]
    exprs = [pl.col("_clv").rolling_mean(window_size=w).over("symbol").alias(c) for w, c in zip(windows, cols)]
    out = df.with_columns(exprs).select(["symbol", "day"] + cols)
    return out.filter(pl.col(cols[-1]).is_not_null())


MAX_RETURN_WINDOW = 21


def max_daily_return(bars: pl.DataFrame, window: int = MAX_RETURN_WINDOW) -> pl.DataFrame:
    """The single largest one-day return in the trailing window — the "MAX
    effect": retail buyers overpay for names that have recently printed a
    large single-day jackpot, leaving those names overpriced and
    subsequently underperforming (Bali, Cakici & Whitelaw, 2011). Expected
    to be a *negative* predictor, which is exactly why it is orthogonal in
    sign to `momentum_21d` computed over the same window: momentum averages
    the jackpot day into a plain return and cannot see the difference
    between "one +18% day and nothing else" and a steady grind to the same
    total.
    """
    schema = {"symbol": pl.Utf8, "day": pl.Utf8, f"max_daily_return_{window}d": pl.Float64}
    if bars.height == 0:
        return pl.DataFrame(schema=schema)

    col = f"max_daily_return_{window}d"
    df = bars.sort(["symbol", "day"]).with_columns(
        (pl.col("close") / pl.col("close").shift(1).over("symbol") - 1.0).alias("_daily_ret")
    )
    out = df.with_columns(
        pl.col("_daily_ret").rolling_max(window_size=window).over("symbol").alias(col)
    ).select(["symbol", "day", col])
    return out.filter(pl.col(col).is_not_null())


SVI_WINDOWS = (10, 21)


def signed_volume_imbalance(bars: pl.DataFrame, windows: tuple[int, ...] = SVI_WINDOWS) -> pl.DataFrame:
    """An accumulation/distribution proxy: `((close-open)/(high-low)) * volume`,
    summed over each window and normalized by that window's total volume.

    `volume_zscore_21d` in `underlying_features` is unsigned — it fires
    identically on a panic sell-off and a buying stampede. Pairing volume
    magnitude with the direction the price moved *within* the same day
    (not close-to-close, which momentum already covers) is genuinely new
    information, not a rescaling of the existing column.
    """
    schema = {"symbol": pl.Utf8, "day": pl.Utf8}
    for w in windows:
        schema[f"signed_volume_imbalance_{w}d"] = pl.Float64
    if bars.height == 0:
        return pl.DataFrame(schema=schema)

    df = bars.sort(["symbol", "day"]).with_columns(
        pl.when(pl.col("high") > pl.col("low"))
        .then(((pl.col("close") - pl.col("open")) / (pl.col("high") - pl.col("low"))) * pl.col("volume"))
        .otherwise(0.0)
        .alias("_signed_vol")
    )

    cols = [f"signed_volume_imbalance_{w}d" for w in windows]
    exprs = []
    for w, c in zip(windows, cols):
        num = pl.col("_signed_vol").rolling_sum(window_size=w).over("symbol")
        den = pl.col("volume").rolling_sum(window_size=w).over("symbol")
        exprs.append(pl.when(den > 0).then(num / den).otherwise(None).alias(c))

    out = df.with_columns(exprs).select(["symbol", "day"] + cols)
    return out.filter(pl.col(cols[-1]).is_not_null())


RESIDUAL_MOMENTUM_BETA_WINDOW = 126
RESIDUAL_MOMENTUM_WINDOW = 63
IDIO_VOL_WINDOW = 21


def residual_momentum(
    bars: pl.DataFrame,
    beta_window: int = RESIDUAL_MOMENTUM_BETA_WINDOW,
    mom_window: int = RESIDUAL_MOMENTUM_WINDOW,
    idio_window: int = IDIO_VOL_WINDOW,
) -> pl.DataFrame:
    """Beta-stripped momentum, and the idiosyncratic share of variance —
    the feature most directly aimed at the diagnosis above.

    Requires the **full cross-sectional panel** in `bars`, not one symbol —
    unlike every other function in this module, which is correct called on
    a single symbol's history. The market return each day is the
    equal-weighted mean return across every symbol present that day; a
    `bars` argument missing most of the universe produces a "market" return
    that is really just an average of whichever few names were passed in.

    Beta is a rolling OLS slope against that market return, computed from
    rolling sums rather than a built-in rolling covariance or correlation
    (neither exists as a Polars expression method in the version this
    project pins): `beta = (n*Sum(xy) - Sum(x)Sum(y)) / (n*Sum(x^2) - Sum(x)^2)`,
    the standard closed-form single-variable OLS slope. `residual_momentum`
    is the cumulative sum of each day's beta-unexplained return (Blitz,
    Huij & Martens, 2011); `idio_vol_ratio` is the idiosyncratic share of
    total return variance — high-idio-vol names are the ones arbitrageurs
    cannot cheaply correct, a separate, well-documented negative predictor
    that also conditions how much to trust the residual momentum figure.
    """
    mom_col = f"residual_momentum_{mom_window}d"
    idio_col = f"idio_vol_ratio_{idio_window}d"
    schema = {"symbol": pl.Utf8, "day": pl.Utf8, mom_col: pl.Float64, idio_col: pl.Float64}
    if bars.height == 0:
        return pl.DataFrame(schema=schema)

    df = bars.sort(["symbol", "day"]).with_columns(
        (pl.col("close") / pl.col("close").shift(1).over("symbol") - 1.0).alias("_ret")
    )
    market = df.group_by("day").agg(pl.col("_ret").mean().alias("_mkt_ret"))
    df = df.join(market, on="day", how="left")

    n = beta_window
    x, y = pl.col("_mkt_ret"), pl.col("_ret")
    sum_x = x.rolling_sum(window_size=n).over("symbol")
    sum_y = y.rolling_sum(window_size=n).over("symbol")
    sum_xy = (x * y).rolling_sum(window_size=n).over("symbol")
    sum_xx = (x * x).rolling_sum(window_size=n).over("symbol")
    denom = n * sum_xx - sum_x * sum_x

    df = df.with_columns(
        # A flat denominator means the market barely moved over the whole
        # window — no information to estimate a slope from, not a slope of
        # zero, which is a different and much stronger claim.
        pl.when(denom.abs() > 1e-12).then((n * sum_xy - sum_x * sum_y) / denom).otherwise(None).alias("_beta")
    )
    df = df.with_columns((pl.col("_ret") - pl.col("_beta") * pl.col("_mkt_ret")).alias("_resid"))

    total_std = pl.col("_ret").rolling_std(window_size=idio_window).over("symbol")
    resid_std = pl.col("_resid").rolling_std(window_size=idio_window).over("symbol")
    df = df.with_columns(
        pl.col("_resid").rolling_sum(window_size=mom_window).over("symbol").alias(mom_col),
        pl.when(total_std > 0).then(resid_std / total_std).otherwise(None).alias(idio_col),
    )

    out = df.select(["symbol", "day", mom_col, idio_col])
    return out.filter(pl.col(mom_col).is_not_null() & pl.col(idio_col).is_not_null())


def build_feature_panel(bars: pl.DataFrame) -> pl.DataFrame:
    """Every bars-only feature above, inner-joined into one panel.

    The single place `train.py` and `rank.py` both build their feature
    matrix from — they must never compute it independently. That
    independence is exactly how a real bug shipped: rank.py called
    `underlying_features(bars)` directly, so a model trained on this
    module's full column set threw `ColumnNotFoundError` the first time it
    tried to score a ranking day, because rank.py's own panel only ever had
    the original six columns. Caught immediately by `test_rank.py`'s
    real-corpus end-to-end test the moment train.py's feature set grew
    without rank.py's growing with it — which is the whole reason this
    function exists now instead of two call sites drifting apart again.
    """
    features = underlying_features(bars)
    for extra in (
        overnight_intraday_returns(bars),
        close_location_value(bars),
        max_daily_return(bars),
        signed_volume_imbalance(bars),
        residual_momentum(bars),  # needs the full cross-sectional panel — see its own docstring
    ):
        features = features.join(extra, on=["symbol", "day"], how="inner")
    return features


# ---------------------------------------------------------------------------
# Chain surface features — awaiting real captured data to validate against
# ---------------------------------------------------------------------------


def _closest_to_delta(chain: pl.DataFrame, target_delta: float, option_type: str) -> pl.DataFrame:
    """The single contract per expiry closest to a target delta, one type."""
    subset = chain.filter((pl.col("type") == option_type) & pl.col("delta").is_not_null())
    if subset.height == 0:
        return subset
    return (
        subset.with_columns((pl.col("delta") - target_delta).abs().alias("_dist"))
        .sort("_dist")
        .group_by("expiry", maintain_order=True)
        .first()
        .drop("_dist")
    )


def atm_iv_by_expiry(chain: pl.DataFrame) -> pl.DataFrame:
    """At-the-money implied vol per expiry, from whichever call is closest to 0.5 delta.

    Calls rather than puts by convention only — put-call parity means the two
    should agree near the money, and picking one side consistently avoids
    silently averaging across a skew that the risk-reversal feature exists to
    measure separately.
    """
    atm = _closest_to_delta(chain, target_delta=0.5, option_type="call")
    return atm.select(["expiry", pl.col("iv").alias("atm_iv")]).sort("expiry")


def term_slope(chain: pl.DataFrame) -> float | None:
    """Longest-dated ATM IV minus shortest-dated ATM IV, across expiries present.

    Positive means the market prices more uncertainty further out — the
    ordinary state. Negative (inverted) concentrates uncertainty near-term,
    which is what a chain looks like heading into a known event. Null when
    fewer than two expiries have a resolvable ATM point, because a slope
    needs two ends.
    """
    atm = atm_iv_by_expiry(chain)
    if atm.height < 2:
        return None
    return float(atm["atm_iv"][-1] - atm["atm_iv"][0])


def risk_reversal_25d(chain: pl.DataFrame, expiry: str) -> float | None:
    """25-delta call IV minus 25-delta put IV, for one expiry.

    Positive means calls are relatively rich — the market is paying more for
    upside convexity than downside. Persistently negative is the ordinary
    equity-index state (investors pay up for downside protection); a shift
    toward positive is itself information. Delta on the put side is negative
    by convention, so the target for `_closest_to_delta` is `-0.25`.
    """
    day_chain = chain.filter(pl.col("expiry") == expiry)
    calls = _closest_to_delta(day_chain, target_delta=0.25, option_type="call")
    puts = _closest_to_delta(day_chain, target_delta=-0.25, option_type="put")
    if calls.height == 0 or puts.height == 0:
        return None
    call_iv = calls["iv"][0]
    put_iv = puts["iv"][0]
    if call_iv is None or put_iv is None:
        return None
    return float(call_iv - put_iv)


def put_call_ratios(chain: pl.DataFrame) -> dict[str, float | None]:
    """Open-interest and volume ratios, put over call, across the whole chain.

    Deliberately uses the **whole** chain rather than `liquid_only` quotes: a
    thin strike still reflects real positioning even when it would never be
    offered as a trade candidate, and filtering it out here would understate
    genuine put-side or call-side skew in demand.
    """
    if chain.height == 0:
        return {"put_call_oi_ratio": None, "put_call_volume_ratio": None}

    totals = chain.group_by("type").agg(
        pl.col("open_interest").sum().alias("oi"), pl.col("volume").sum().alias("vol")
    )
    by_type = {row["type"]: row for row in totals.to_dicts()}
    call = by_type.get("call")
    put = by_type.get("put")
    if call is None or put is None:
        return {"put_call_oi_ratio": None, "put_call_volume_ratio": None}

    oi_ratio = (put["oi"] / call["oi"]) if call["oi"] > 0 else None
    vol_ratio = (put["vol"] / call["vol"]) if call["vol"] > 0 else None
    return {"put_call_oi_ratio": oi_ratio, "put_call_volume_ratio": vol_ratio}


def iv_rank(current_iv: float, trailing_iv_history: list[float]) -> float | None:
    """Where `current_iv` sits in its own trailing distribution, 0 to 1.

    Takes the history as a parameter rather than reading it from the database
    directly, because a full year of daily ATM IV per underlying does not
    exist yet — capture only just started. The function is complete and
    tested against a synthetic history now; wiring it to real trailing IV is
    a one-line change once there is a year of it to rank against, not a
    redesign.

    Null with fewer than 20 trailing observations: a percentile computed
    against three data points is not a rank, it is a coin flip wearing a
    percentage sign.
    """
    if len(trailing_iv_history) < 20:
        return None
    below = sum(1 for v in trailing_iv_history if v <= current_iv)
    return below / len(trailing_iv_history)
