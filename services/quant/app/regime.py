"""Market regime from the index the whole book breathes with.

The most robust post-cost result in the volatility-management literature
(Moreira & Muir 2017; the 2024 international replications) is not a
stock-picking signal at all: it is that *market* and *momentum* exposure
taken during calm uptrends is worth systematically more than the same
exposure taken during volatile downtrends. This book's short horizon is
momentum-flavoured by construction, which makes it exactly the exposure
that evidence says to throttle when the tape turns.

Two classic, deliberately boring inputs on SPY:

- **trend**: close vs its 200-session mean. Below trend, drawdowns
  deepen and momentum crashes cluster.
- **volatility**: 21-session realized vol against its own trailing-year
  distribution. The top quintile is where vol-managed strategies cut.

Three regimes, one number each: risk_on (1.0) when the trend is up and
vol is ordinary; risk_off (0.5) when the trend is down AND vol is
elevated — the historically toxic quadrant; neutral (0.75) for the
mixed states. The engine spends the number on how many NEW positions a
day may open; it never touches existing positions, whose exits have
their own rules.

Pure function over a bars frame so tests hand it synthetic tapes.
"""

from __future__ import annotations

import math

import polars as pl

TREND_WINDOW = 200
VOL_WINDOW = 21
VOL_HISTORY = 252
HIGH_VOL_PCT = 0.8

REGIME_EXPOSURE = {"risk_on": 1.0, "neutral": 0.75, "risk_off": 0.5}


def market_regime(bars: pl.DataFrame, day: str) -> dict:
    """Classify the market regime as of `day` from index bars.

    `bars` needs `day` and `close` columns for one symbol (the index).
    Only rows at or before `day` are used — handing this the full corpus
    cannot leak the future. Returns regime 'unknown' (exposure 1.0, the
    do-no-harm default) when history is too short to say anything.
    """
    history = bars.filter(pl.col("day") <= day).sort("day")
    if history.height < TREND_WINDOW + 1:
        return {
            "day": day,
            "regime": "unknown",
            "exposure": 1.0,
            "detail": f"only {history.height} sessions of index history (need {TREND_WINDOW + 1})",
        }

    closes = history.get_column("close").to_list()
    close = closes[-1]
    sma = sum(closes[-TREND_WINDOW:]) / TREND_WINDOW
    trend_up = close >= sma

    rets = [math.log(closes[i + 1] / closes[i]) for i in range(len(closes) - 1)]

    def ann_vol(window: list[float]) -> float:
        mean = sum(window) / len(window)
        var = sum((r - mean) ** 2 for r in window) / max(1, len(window) - 1)
        return math.sqrt(var * 252)

    vol_now = ann_vol(rets[-VOL_WINDOW:])
    # The trailing-year distribution of the same 21-session measure —
    # "elevated" is defined against this index's own recent life, not a
    # magic constant that goes stale.
    history_vols = [
        ann_vol(rets[i - VOL_WINDOW : i])
        for i in range(max(VOL_WINDOW, len(rets) - VOL_HISTORY), len(rets) + 1)
    ]
    rank = sum(1 for v in history_vols if v <= vol_now) / len(history_vols)
    high_vol = rank >= HIGH_VOL_PCT

    if trend_up and not high_vol:
        regime = "risk_on"
    elif not trend_up and high_vol:
        regime = "risk_off"
    else:
        regime = "neutral"

    return {
        "day": day,
        "regime": regime,
        "exposure": REGIME_EXPOSURE[regime],
        "close": round(close, 4),
        "sma200": round(sma, 4),
        "trend_up": trend_up,
        "vol21_annualized": round(vol_now, 4),
        "vol_percentile": round(rank, 4),
        "high_vol": high_vol,
    }
