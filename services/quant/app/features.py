"""Features: what the model actually sees.

Two families, and they are built differently because they answer to different
amounts of data.

**Underlying features** need only bars, which the backfill already provides
for the whole universe. They can be built and validated today.

**Chain surface features** need a captured option chain, and none exists yet
— nightly capture only started running. Every chain function here is written
and unit-tested against realistic quote panels, but has not been validated
against a real multi-expiry, multi-type capture the way `pricing.py` was
validated against a real broker chain. That validation is still owed, and
belongs in a follow-up once the corpus has real data to check against — see
the tests in `tests/test_features.py` for exactly what is and is not proven
yet.
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
