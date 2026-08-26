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


REVERSAL_WINDOW = 21
TURNOVER_WINDOW = 21
#: The baseline the reversal window's turnover is compared against. Must be
#: longer than TURNOVER_WINDOW or the ratio is one by construction — see
#: `reversal_and_liquidity`.
TURNOVER_BASELINE_WINDOW = 63
AMIHUD_WINDOW = 21


def reversal_and_liquidity(
    bars: pl.DataFrame,
    reversal_window: int = REVERSAL_WINDOW,
    turnover_window: int = TURNOVER_WINDOW,
    amihud_window: int = AMIHUD_WINDOW,
    turnover_baseline_window: int = TURNOVER_BASELINE_WINDOW,
) -> pl.DataFrame:
    """Short-term reversal, its turnover interaction, and Amihud
    illiquidity — three features aimed at the same underlying fact.

    The existing panel is almost entirely *momentum*: nine of its seventeen
    columns are a price change over some window. Momentum and reversal are
    the same measurement read with opposite sign at different horizons, so
    piling on more windows of one cannot express the other. These three
    add the axis the panel does not have — how a move is *funded* and how
    hard it is to trade against.

    **`reversal_21d`** is the negated trailing return (Jegadeesh, *Journal
    of Finance* 1990). It is deliberately the sign-flip of `momentum_21d`
    rather than a new number, which is worth stating plainly: as a lone
    feature it is exactly collinear with a column already in the panel and
    a tree model gains nothing from it. It exists to be *interacted*, below.

    **`reversal_x_turnover_21d`** is computed and joined into the panel but
    is **not** in `train.py`'s `FEATURE_COLS`, and that is a measured
    decision rather than an oversight — see the note at the end of this
    docstring. Reversal is not a constant effect: it is concentrated in
    high-turnover names, because turnover proxies for how much of the move
    was liquidity demand rather than news (Avramov, Chordia & Goyal,
    *Journal of Finance* 2006). A stock that fell 10% on quiet volume and
    one that fell 10% on frantic volume have the same momentum and very
    different expected reversals, and no window of `momentum_Xd` can tell
    them apart. True turnover needs shares outstanding, which this corpus
    does not carry, so volume stands in — a within-name measure, which is
    arguably the better conditioning variable anyway since it does not
    confound with size.

    The turnover ratio compares **the reversal window's own mean volume
    against a longer baseline**, and getting that wrong is subtle enough to
    be worth recording. The first version divided *today's* volume by its
    trailing 21-day mean, which conditions a 21-day reversal on a single
    bar and, because the denominator is the name's own recent average,
    normalizes a sustained elevation away completely. Measured on three
    constructed series with an identical 21-day decline: normal volume
    throughout scored 0.200, a spike on the final bar alone scored 0.969,
    and a decline genuinely funded by sustained 6x volume scored 0.200 —
    identical to normal. The case the feature exists to detect was
    invisible to it, and the case it flagged was an unrelated one-day event
    such as an index rebalance landing on the last bar.

    **`amihud_illiquidity_21d`** is mean `|return| / dollar volume`
    (Amihud, *Journal of Financial Markets* 2002) — price impact per dollar
    traded. It matters twice here. As a return predictor it is the standard
    illiquidity premium, and as a *filter* it is the honest reading of why
    an option on an illiquid underlying can look mispriced: the model's
    forecast edge is largest exactly where the edge cannot be captured.
    Scaled by 1e6 because raw values on liquid large caps are ~1e-10, and a
    feature whose entire range sits in the tenth decimal place is a
    needless invitation to floating-point noise in a tree split.

    **On the reversal interaction not being trained on.** It was added on a
    real and well-supported hypothesis, and the corpus declined to support
    it. Three walk-forward configurations, each counted against the
    multiple-testing hurdle:

        with the (buggy) interaction   rank IC 0.0380  ICIR 0.262  RMSE 0.11828
        with it corrected              rank IC 0.0371  ICIR 0.255  RMSE 0.11821
        without it                     rank IC 0.0366  ICIR 0.251  RMSE 0.11809

    An IC spread of 0.0014 against a per-period standard error near 0.021
    is noise; the three are indistinguishable. RMSE and hit rate are best
    without it, and its gain contribution was under 1% in every fit. So it
    is left out on the tie-break that a panel which just benefited from
    pruning should not carry a column that measurably does nothing.

    Note what the numbers would have licensed instead: the *buggy* version
    scored highest on the headline metric. Shipping it on that basis would
    have been keeping a feature that provably measures the wrong thing
    because it scored well — which is the failure this project's whole
    metrics apparatus exists to catch. The column is still computed here so
    the work is not lost and a future corpus can re-test it cheaply.
    """
    cols = {
        f"reversal_{reversal_window}d": pl.Float64,
        f"reversal_x_turnover_{turnover_window}d": pl.Float64,
        f"amihud_illiquidity_{amihud_window}d": pl.Float64,
    }
    schema = {"symbol": pl.Utf8, "day": pl.Utf8, **cols}
    if bars.height == 0:
        return pl.DataFrame(schema=schema)

    rev_col = f"reversal_{reversal_window}d"
    turn_col = f"reversal_x_turnover_{turnover_window}d"
    amihud_col = f"amihud_illiquidity_{amihud_window}d"

    df = bars.sort(["symbol", "day"]).with_columns(
        (pl.col("close") / pl.col("close").shift(1).over("symbol") - 1.0).alias("_ret"),
        (pl.col("close") * pl.col("volume")).alias("_dollar_volume"),
    )

    df = df.with_columns(
        # Negated trailing return: a fall becomes a positive reversal signal.
        (-(pl.col("close") / pl.col("close").shift(reversal_window).over("symbol") - 1.0)).alias(rev_col),
        # Mean volume over the reversal window itself, and over a longer
        # baseline to compare it against.
        pl.col("volume")
        .rolling_mean(window_size=turnover_window)
        .over("symbol")
        .alias("_window_volume"),
        pl.col("volume")
        .rolling_mean(window_size=turnover_baseline_window)
        .over("symbol")
        .alias("_baseline_volume"),
        # Amihud's per-day ratio. Guarded because dollar volume is zero on
        # a halted bar and float division by zero is `inf`, not null — and
        # `drop_nulls` below removes nulls only, so an unguarded inf would
        # survive into the panel and then into LightGBM. Reproduced: one
        # zero-volume bar among thirty put `inf` into every surviving row.
        # It failed on exactly the illiquid names this feature describes.
        pl.when(pl.col("_dollar_volume") > 0)
        .then(pl.col("_ret").abs() / pl.col("_dollar_volume"))
        .otherwise(None)
        .rolling_mean(window_size=amihud_window)
        .over("symbol")
        .alias("_amihud_raw"),
    )

    df = df.with_columns(
        # A zero or missing baseline is a name that did not trade over the
        # window, where the ratio is undefined rather than 1.0 — claiming
        # "normal turnover" for a stock that did not trade would be a
        # fabricated conditioning value, and it would fabricate it for
        # precisely the illiquid names this function exists to flag.
        pl.when(pl.col("_baseline_volume") > 0)
        .then(pl.col("_window_volume") / pl.col("_baseline_volume"))
        .otherwise(None)
        .alias("_turnover_ratio"),
    )

    df = df.with_columns(
        (pl.col(rev_col) * pl.col("_turnover_ratio")).alias(turn_col),
        (pl.col("_amihud_raw") * 1e6).alias(amihud_col),
    )

    return df.select(["symbol", "day", rev_col, turn_col, amihud_col]).drop_nulls()


def build_feature_panel(
    bars: pl.DataFrame, option_panel: pl.DataFrame | None = None
) -> pl.DataFrame:
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
        reversal_and_liquidity(bars),
    ):
        features = features.join(extra, on=["symbol", "day"], how="inner")
    if option_panel is not None and option_panel.height > 0:
        # Left, not inner: the chain corpus is days old against two years
        # of bars, and an inner join here would silently shrink the whole
        # training panel to the handful of days options exist for. Rows
        # without a chain carry nulls, which LightGBM treats as their own
        # branch — the columns only earn a place in FEATURE_COLS once
        # coverage justifies the trial (see OPTION_FEATURE_COLS).
        features = features.join(option_panel, on=["symbol", "day"], how="left")
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


def cpiv_spread(chain: pl.DataFrame) -> float | None:
    """Call-put implied vol spread across matched (expiry, strike) pairs,
    open-interest weighted — Cremers & Weinbaum (JFQA 2010).

    Under put-call parity a call and put on the same strike and expiry
    must carry the same implied vol; a persistent gap is deviation the
    literature reads as informed-trading pressure, and its sign predicts
    the underlying's return over the following weeks (positive spread —
    calls rich — precedes outperformance). Weighted by the *pair's*
    smaller open interest so a gap only counts in proportion to the
    positioning actually behind both legs; a one-sided strike where only
    the call ever trades is parity evidence about nothing.

    Null when no strike has both legs with solved IVs — a spread needs
    pairs, and averaging unpaired IVs would rediscover the skew that
    `risk_reversal_25d` already measures on purpose.
    """
    both = chain.filter(pl.col("iv").is_not_null())
    calls = both.filter(pl.col("type") == "call").select(
        "expiry", "strike", pl.col("iv").alias("_call_iv"), pl.col("open_interest").alias("_call_oi")
    )
    puts = both.filter(pl.col("type") == "put").select(
        "expiry", "strike", pl.col("iv").alias("_put_iv"), pl.col("open_interest").alias("_put_oi")
    )
    pairs = calls.join(puts, on=["expiry", "strike"], how="inner").with_columns(
        pl.min_horizontal("_call_oi", "_put_oi").alias("_w")
    )
    if pairs.height == 0:
        return None
    weights = pairs["_w"].sum()
    if weights <= 0:
        # Every pair exists but nobody holds either leg — equal-weight is
        # the honest fallback for a chain that is quoted but unowned.
        return float((pairs["_call_iv"] - pairs["_put_iv"]).mean())
    weighted = ((pairs["_call_iv"] - pairs["_put_iv"]) * pairs["_w"]).sum() / weights
    return float(weighted)


#: The option-derived feature columns `option_feature_panel` produces.
#: **Deliberately absent from train.py's FEATURE_COLS today.** The chain
#: corpus is days old while the bars panel spans two years; a column that
#: is null for 99% of training rows adds a trial's worth of multiple-
#: testing cost for no realistic gain. The plumbing ships now so history
#: needs no backfill and the switch later is one reviewed line: add these
#: to FEATURE_COLS once the corpus holds ~60 trading days of chains, and
#: count that configuration change against the trial hurdle like any
#: other.
OPTION_FEATURE_COLS = [
    "cpiv_spread",
    "iv_term_slope",
    "risk_reversal_25d",
    "put_call_oi_ratio",
    "put_call_volume_ratio",
]


#: (corpus fingerprint) -> built panel. One nightly training pays the
#: build once; a process that trains repeatedly (the test suite, a
#: multi-target retrain) reuses it as long as the corpus is unchanged.
#: Keyed on (row count, latest as_of) because option_quotes is
#: append-only: any write moves at least one of the two.
_option_panel_cache: dict[tuple[int, str | None], pl.DataFrame] = {}


def option_feature_panel() -> pl.DataFrame:
    """Per-(symbol, day) option-derived features from the captured corpus.

    IV-based features (CPIV, term slope, risk reversal) are computed on the
    **screened** chain — the same `screen_quotes` hygiene the ranking uses,
    because a frozen 447% print distorts a parity spread exactly like it
    distorts an EV. The put/call ratios are computed on the **whole** chain
    on purpose — see `put_call_ratios`' own docstring: thin strikes still
    reflect real positioning.

    Reads the corpus directly (the one features function that does),
    because these features are *derived retroactively* — no nightly
    accrual job, no persistence: the chain history already stored is the
    single source, so a fixed bug re-derives corrected history for free.
    """
    from .db import prior_trading_day, read_all_quotes, read_day_stats
    from .screens import screen_quotes

    # One bulk read for the whole corpus, partitioned in polars — not a
    # read_quotes call per (symbol, day). The first version did exactly
    # that, and 1,300 pairs x two queries each turned every training run
    # (and so the whole test suite) into a half-hour of SQL round-trips
    # for data one scan returns.
    from .db import reading

    with reading() as conn:
        row = conn.execute("SELECT COUNT(*) n, MAX(as_of) m FROM option_quotes").fetchone()
    fingerprint = (row["n"], row["m"])
    cached = _option_panel_cache.get(fingerprint)
    if cached is not None:
        return cached

    all_quotes = read_all_quotes()
    if all_quotes.height == 0:
        return pl.DataFrame(
            schema={
                "symbol": pl.Utf8,
                "day": pl.Utf8,
                **{c: pl.Float64 for c in OPTION_FEATURE_COLS},
            }
        )

    stats_by_day: dict[str, tuple[str | None, pl.DataFrame | None]] = {}
    rows: list[dict] = []
    for (symbol, day), chain in sorted(
        all_quotes.partition_by(["underlying", "trading_day"], as_dict=True).items()
    ):
        if day not in stats_by_day:
            prior = prior_trading_day(day)
            stats_by_day[day] = (prior, read_day_stats(prior) if prior else None)
        prior, stats = stats_by_day[day]

        ratios = put_call_ratios(chain)

        screened = screen_quotes(chain, stats, trading_day=day, prior_day=prior).passed
        front_expiry = (
            screened["expiry"].min() if screened.height > 0 else None
        )
        rows.append(
            {
                "symbol": symbol,
                "day": day,
                "cpiv_spread": cpiv_spread(screened) if screened.height else None,
                "iv_term_slope": term_slope(screened) if screened.height else None,
                "risk_reversal_25d": (
                    risk_reversal_25d(screened, front_expiry) if front_expiry else None
                ),
                "put_call_oi_ratio": ratios["put_call_oi_ratio"],
                "put_call_volume_ratio": ratios["put_call_volume_ratio"],
            }
        )

    schema = {
        "symbol": pl.Utf8,
        "day": pl.Utf8,
        **{c: pl.Float64 for c in OPTION_FEATURE_COLS},
    }
    panel = pl.DataFrame(rows, schema=schema)
    _option_panel_cache.clear()  # one corpus, one entry — never a leak
    _option_panel_cache[fingerprint] = panel
    return panel
