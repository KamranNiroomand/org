"""The regime classifier's contract: calm uptrend spends full budget,
volatile downtrend spends half, and too little history refuses to guess.
Synthetic tapes only — the rule must be checkable without a market."""

import math

import polars as pl
from app.regime import REGIME_EXPOSURE, TREND_WINDOW, market_regime


def _tape(closes: list[float]) -> pl.DataFrame:
    days = [f"2025-{(i // 28) % 12 + 1:02d}-{i % 28 + 1:02d}" for i in range(len(closes))]
    # Lexicographically increasing synthetic days matter more than real
    # calendar shape here; generate strictly sorted ISO strings instead.
    days = [f"d{i:05d}" for i in range(len(closes))]
    return pl.DataFrame({"day": days, "close": closes})


def test_steady_uptrend_is_risk_on() -> None:
    closes = [100.0 * (1.0006 ** i) * (1 + 0.001 * math.sin(i)) for i in range(300)]
    out = market_regime(_tape(closes), "d00299")
    assert out["regime"] == "risk_on"
    assert out["exposure"] == REGIME_EXPOSURE["risk_on"]
    assert out["trend_up"] is True


def test_crash_is_risk_off() -> None:
    # A year of calm up, then a violent slide well below the 200d mean:
    # big alternating daily swings put realized vol in its own top
    # quintile while the level breaks trend.
    closes = [100.0 * (1.0004 ** i) for i in range(260)]
    px = closes[-1]
    for i in range(60):
        px *= 0.94 if i % 2 == 0 else 1.01
        closes.append(px)
    out = market_regime(_tape(closes), f"d{len(closes) - 1:05d}")
    assert out["regime"] == "risk_off"
    assert out["exposure"] == REGIME_EXPOSURE["risk_off"]
    assert out["trend_up"] is False
    assert out["high_vol"] is True


def test_short_history_refuses_to_guess() -> None:
    closes = [100.0 + i for i in range(TREND_WINDOW // 2)]
    out = market_regime(_tape(closes), f"d{TREND_WINDOW // 2 - 1:05d}")
    assert out["regime"] == "unknown"
    assert out["exposure"] == 1.0


def test_future_bars_do_not_leak() -> None:
    # Same tape, asked about an early day: the crash that happens later
    # must not colour the answer.
    closes = [100.0 * (1.0006 ** i) for i in range(300)]
    crash = closes + [closes[-1] * (0.9 ** i) for i in range(1, 40)]
    early = market_regime(_tape(closes), "d00299")
    with_future = market_regime(_tape(crash), "d00299")
    assert early == with_future
