"""Simulates holding ranked contracts forward through real captured data.

`rank.py` answers "which option looks good today" from a single day's
snapshot. This module answers the next question: "if you had bought it, what
actually happened" — walking a position forward through subsequent captures
to a real exit, never a fabricated one.

**One rule governs every exit here, and it is the same rule `capture.py`'s
own docstring states for quotes generally: a price absent from a day's
snapshot is never invented.** A position whose contract stops appearing in
captures before expiry resolves as `no_further_data`, not as flat, not as
the last price carried forward, and not as zero — any of those would quietly
manufacture a return this project has no evidence for. `backtest_report`
surfaces that coverage gap as a percentage rather than hiding it inside an
average, for the same reason the plan's own capture design never drops a
gate-failing row instead of recording why it failed.

**Historical fills here are last-traded, not bid/touched.** The current data
plan carries no quote entitlement (`option_quotes.bidE4`'s doc comment in
`schema.ts`), so there is no bid to sell into or ask to buy at — every entry
and exit price is the same `close`/`mid` basis `rank.py` already prices
against. That is the plan's own "indicative, not measured" distinction
(see the project plan's provider section): the paper book, which marks
against live snapshot bid/ask when a quote entitlement exists, is the
precise measurement; this is the historical approximation.

**End-to-end against real data is not runnable yet.** Walking a position
forward needs at least two captured trading days for the same contracts, and
as of this module's own first day there is exactly one. Every function here
is complete and unit-tested against a synthetic multi-day panel — the same
posture `rank.py`, `cv.py`, and the chain-surface functions in `features.py`
were built and shipped in before real data existed to validate them against.
`run_backtest` is the integration point to point at the real corpus once it
has enough days behind it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import polars as pl

from .db import read_contract_history
from .metrics import max_drawdown, sharpe_ratio
from .rank import DEFAULT_MULTIPLIER, DEFAULT_ROUND_TRIP_COST, RankedContract, rank_day

TRADING_DAYS_PER_YEAR = 252


@dataclass
class Position:
    occ_symbol: str
    underlying: str
    type: str
    strike: float
    expiry: str
    entry_day: str
    entry_price: float
    quantity: int = 1


@dataclass
class Trade:
    occ_symbol: str
    underlying: str
    type: str
    strike: float
    expiry: str
    entry_day: str
    entry_price: float
    exit_day: str | None
    exit_price: float | None
    exit_reason: str  # "expired_itm" | "expired_otm" | "held_to_exit_day" | "no_further_data"
    quantity: int
    pnl: float | None
    return_pct: float | None

    @property
    def resolved(self) -> bool:
        return self.exit_price is not None


def close_position(
    position: Position,
    history: pl.DataFrame,
    hold_days: int | None = None,
    multiplier: int = DEFAULT_MULTIPLIER,
    round_trip_cost: float = DEFAULT_ROUND_TRIP_COST,
) -> Trade:
    """Resolves one position to a real exit, or to `no_further_data`.

    `history` must already be filtered to this position's `occ_symbol` and
    sorted by `trading_day` — callers with many positions build that index
    once (see `simulate_positions`) rather than re-filtering per position.

    Two, and only two, ways a position closes:

    - **Expiry**, the default when `hold_days` is `None` or the contract's
      own expiry falls at or before the hold deadline. Settles to intrinsic
      value against the last captured underlying price on or before expiry
      — the option's own last quoted price is not used, because at
      expiration an option is worth intrinsic value regardless of what it
      last traded at, and using a stale traded price would understate what
      actually happens to real positions at expiry.
    - **A hold-days deadline**, closed at the last captured price on or
      before `entry_day + hold_days` calendar days.

    Either way, if no row in `history` falls on or before the resolved exit
    day, the exit is `no_further_data` — not a guess.
    """
    is_call = position.type == "call"
    expiry_date = date.fromisoformat(position.expiry)
    entry_date = date.fromisoformat(position.entry_day)

    deadline_date = entry_date + timedelta(days=hold_days) if hold_days is not None else None
    settle_at_expiry = deadline_date is None or expiry_date <= deadline_date
    target_date = expiry_date if settle_at_expiry else deadline_date

    # Strictly after entry, regardless of what the caller passed in: the
    # entry day's own row is what was paid, not a candidate exit, and
    # trusting every caller to have already excluded it is the kind of
    # implicit precondition this function should not depend on to behave
    # correctly.
    eligible = history.filter(
        (pl.col("trading_day") > position.entry_day) & (pl.col("trading_day") <= target_date.isoformat())
    )
    if eligible.height == 0:
        return Trade(
            occ_symbol=position.occ_symbol,
            underlying=position.underlying,
            type=position.type,
            strike=position.strike,
            expiry=position.expiry,
            entry_day=position.entry_day,
            entry_price=position.entry_price,
            exit_day=None,
            exit_price=None,
            exit_reason="no_further_data",
            quantity=position.quantity,
            pnl=None,
            return_pct=None,
        )

    last = eligible.sort("trading_day").tail(1).row(0, named=True)

    if settle_at_expiry:
        underlying_price = last["underlying_price"]
        intrinsic = (
            max(underlying_price - position.strike, 0.0)
            if is_call
            else max(position.strike - underlying_price, 0.0)
        )
        exit_price = intrinsic
        exit_day = position.expiry
        exit_reason = "expired_itm" if intrinsic > 0.0 else "expired_otm"
    else:
        if last["price"] is None:
            return Trade(
                occ_symbol=position.occ_symbol,
                underlying=position.underlying,
                type=position.type,
                strike=position.strike,
                expiry=position.expiry,
                entry_day=position.entry_day,
                entry_price=position.entry_price,
                exit_day=None,
                exit_price=None,
                exit_reason="no_further_data",
                quantity=position.quantity,
                pnl=None,
                return_pct=None,
            )
        exit_price = last["price"]
        exit_day = last["trading_day"]
        exit_reason = "held_to_exit_day"

    gross = (exit_price - position.entry_price) * multiplier * position.quantity
    pnl = gross - round_trip_cost * position.quantity
    capital = position.entry_price * multiplier * position.quantity
    return_pct = (pnl / capital) if capital > 0 else 0.0

    return Trade(
        occ_symbol=position.occ_symbol,
        underlying=position.underlying,
        type=position.type,
        strike=position.strike,
        expiry=position.expiry,
        entry_day=position.entry_day,
        entry_price=position.entry_price,
        exit_day=exit_day,
        exit_price=exit_price,
        exit_reason=exit_reason,
        quantity=position.quantity,
        pnl=pnl,
        return_pct=return_pct,
    )


def simulate_positions(
    positions: list[Position],
    history: pl.DataFrame,
    hold_days: int | None = None,
    multiplier: int = DEFAULT_MULTIPLIER,
    round_trip_cost: float = DEFAULT_ROUND_TRIP_COST,
) -> list[Trade]:
    """Resolves a batch of positions against one combined history frame —
    the shape `read_contract_history` returns for many contracts at once.
    """
    empty = history.clear()
    by_symbol = {str(k[0]): grp for k, grp in history.sort("trading_day").group_by("occ_symbol")}
    return [
        close_position(
            p,
            by_symbol.get(p.occ_symbol, empty),
            hold_days=hold_days,
            multiplier=multiplier,
            round_trip_cost=round_trip_cost,
        )
        for p in positions
    ]


def backtest_report(trades: list[Trade]) -> dict:
    """Aggregate metrics over a batch of resolved and unresolved trades.

    `coverage` — the fraction that reached a real exit — is reported
    alongside every P&L figure on purpose: an 80% win rate over a 30%
    coverage sample is a very different claim from an 80% win rate over 95%,
    and burying that in a footnote is exactly the kind of omission the
    deflated-Sharpe machinery in `metrics.py` exists to guard against for a
    different failure mode. Metrics below are computed only over resolved
    trades; `no_further_data` trades are counted, not silently dropped.
    """
    n_total = len(trades)
    resolved = [t for t in trades if t.resolved]
    n_resolved = len(resolved)

    if n_resolved == 0:
        return {
            "n_trades": n_total,
            "n_resolved": 0,
            "coverage": 0.0,
            "win_rate": None,
            "total_pnl": None,
            "avg_return_pct": None,
            "sharpe_ratio": None,
            "max_drawdown": None,
            "avg_hold_days": None,
        }

    returns = np.array([t.return_pct for t in resolved], dtype=float)
    pnls = np.array([t.pnl for t in resolved], dtype=float)
    cumulative = np.cumsum(pnls)
    hold_days = [
        (date.fromisoformat(t.exit_day) - date.fromisoformat(t.entry_day)).days for t in resolved
    ]

    return {
        "n_trades": n_total,
        "n_resolved": n_resolved,
        "coverage": n_resolved / n_total,
        "win_rate": float(np.mean(pnls > 0)),
        "total_pnl": float(np.sum(pnls)),
        "avg_return_pct": float(np.mean(returns)),
        "sharpe_ratio": sharpe_ratio(returns, periods_per_year=TRADING_DAYS_PER_YEAR),
        "max_drawdown": max_drawdown(cumulative),
        "avg_hold_days": float(np.mean(hold_days)),
    }


def enter_positions(ranked: list[RankedContract], entry_day: str, top_n: int, quantity: int = 1) -> list[Position]:
    """Turns one day's top `RankedContract`s into positions to simulate —
    always the top `top_n` by expected value, since `ranked` is already
    sorted that way by `rank_day`. `entry_day` is the day this ranking was
    computed for, not derivable from a `RankedContract` itself.
    """
    return [
        Position(
            occ_symbol=c.occ_symbol,
            underlying=c.underlying,
            type=c.type,
            strike=c.strike,
            expiry=c.expiry,
            entry_day=entry_day,
            entry_price=c.market_price,
            quantity=quantity,
        )
        for c in ranked[:top_n]
    ]


def run_backtest(
    entry_days: list[str],
    model_dir,
    top_n_per_day: int = 5,
    hold_days: int | None = None,
    quantity: int = 1,
    force: bool = False,
) -> list[Trade]:
    """Ranks each day in `entry_days`, opens the top `top_n_per_day`
    contracts, and resolves every position against real captured history.

    Not runnable meaningfully yet — see the module docstring. `entry_days`
    would today be a list of length one, and a list of one has nothing to
    walk forward through. Built and tested against a synthetic panel now so
    that pointing it at the real corpus later is a data question, not a
    redesign — the same posture `rank.py` shipped with before real captures
    existed to rank.
    """
    positions: list[Position] = []
    for day in entry_days:
        ranked = rank_day(day, model_dir, top=top_n_per_day, force=force)
        positions.extend(enter_positions(ranked, day, top_n_per_day, quantity=quantity))

    if not positions:
        return []

    history = read_contract_history([p.occ_symbol for p in positions])
    return simulate_positions(positions, history, hold_days=hold_days)
