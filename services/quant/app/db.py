"""Read-only access to the market research corpus.

Node owns every write to `market.db` — this module cannot write to it even by
accident. The connection is opened with SQLite's own `mode=ro` query parameter
rather than relying on file permissions or code discipline, so a bug here
fails loudly (a raised `OperationalError`) instead of silently corrupting a
database another process is writing to concurrently.

Millions of quote rows never cross the HTTP boundary to the sidecar's own
callers; this module is how the sidecar reads them directly off disk instead.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import polars as pl

_E4 = 10_000.0


def _market_db_path() -> Path:
    """Mirrors `config.market.dbPath` in `apps/server/src/config.ts`.

    Kept in sync by convention rather than by a shared file, because the two
    sides are different languages reading the same environment variables —
    there is no single source both could import from without a build step
    neither side otherwise needs.
    """
    explicit = os.environ.get("MARKET_DB_PATH")
    if explicit:
        return Path(explicit)
    data_dir = os.environ.get("MARKET_DATA_DIR") or str(Path.home() / ".org" / "market")
    return Path(data_dir) / "market.db"


def connect() -> sqlite3.Connection:
    path = _market_db_path()
    uri = f"file:{path}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.OperationalError as err:
        raise sqlite3.OperationalError(
            f"Cannot open {path} read-only ({err}). If it does not exist yet, "
            f"run `npm run db:migrate:market -w @org/server` on the runner machine."
        ) from err
    conn.row_factory = sqlite3.Row
    return conn


def read_bars(symbols: list[str] | None = None, start: str | None = None, end: str | None = None) -> pl.DataFrame:
    """Daily bars as a Polars DataFrame, prices converted from E4 to dollars.

    Conversion happens here, at the boundary, for the same reason `pricing.py`
    converts before any arithmetic: E4 integers are correct for storage and
    wrong for anything that divides or takes a logarithm.

    Returns an **empty but correctly-typed** frame when nothing matches,
    rather than `None` — every caller can chain `.filter()` / `.group_by()`
    without a null check, and an empty backfill reads as "no data for this
    range" instead of crashing three functions downstream.
    """
    schema = {
        "symbol": pl.Utf8,
        "day": pl.Utf8,
        "open": pl.Float64,
        "high": pl.Float64,
        "low": pl.Float64,
        "close": pl.Float64,
        "adj_close": pl.Float64,
        "volume": pl.Int64,
    }
    clauses: list[str] = []
    params: list[object] = []
    if symbols:
        clauses.append(f"symbol IN ({','.join('?' for _ in symbols)})")
        params.extend(symbols)
    if start:
        clauses.append("day >= ?")
        params.append(start)
    if end:
        clauses.append("day <= ?")
        params.append(end)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT symbol, day, open_e4, high_e4, low_e4, close_e4, adj_close_e4, volume
            FROM equity_bars
            {where}
            ORDER BY symbol, day
            """,
            params,
        ).fetchall()

    if not rows:
        return pl.DataFrame(schema=schema)

    return pl.DataFrame(
        {
            "symbol": [r["symbol"] for r in rows],
            "day": [r["day"] for r in rows],
            "open": [r["open_e4"] / _E4 for r in rows],
            "high": [r["high_e4"] / _E4 for r in rows],
            "low": [r["low_e4"] / _E4 for r in rows],
            "close": [r["close_e4"] / _E4 for r in rows],
            "adj_close": [
                (r["adj_close_e4"] / _E4) if r["adj_close_e4"] is not None else None for r in rows
            ],
            "volume": [r["volume"] for r in rows],
        },
        schema=schema,
    )


def read_quotes(underlying: str, trading_day: str, liquid_only: bool = False) -> pl.DataFrame:
    """One underlying's captured contracts on one day.

    `liquid_only` defaults to `False`: surface features like put/call ratios
    want the whole chain, since an illiquid strike still reflects real
    positioning even if it would never be offered as a trade candidate. Filter
    to `liquid_only=True` only at the point where a contract might actually be
    ranked or filled.
    """
    schema = {
        "occ_symbol": pl.Utf8,
        "underlying": pl.Utf8,
        "expiry": pl.Utf8,
        "type": pl.Utf8,
        "strike": pl.Float64,
        "bid": pl.Float64,
        "ask": pl.Float64,
        "mid": pl.Float64,
        "close": pl.Float64,
        "price": pl.Float64,
        "volume": pl.Int64,
        "open_interest": pl.Int64,
        "underlying_price": pl.Float64,
        "iv": pl.Float64,
        "delta": pl.Float64,
        "gamma": pl.Float64,
        "vega": pl.Float64,
        "theta": pl.Float64,
        "liquid": pl.Boolean,
    }
    query = """
        SELECT c.underlying, c.expiry, c.type, c.strike_e4,
               q.occ_symbol, q.bid_e4, q.ask_e4, q.close_e4, q.volume, q.open_interest,
               q.underlying_e4, q.iv_bps, q.delta, q.gamma, q.vega, q.theta, q.liquid
        FROM option_quotes q
        JOIN option_contracts c ON c.occ_symbol = q.occ_symbol
        WHERE c.underlying = ? AND q.trading_day = ?
    """
    params: list[object] = [underlying, trading_day]
    if liquid_only:
        query += " AND q.liquid = 1"

    with connect() as conn:
        rows = conn.execute(query, params).fetchall()

    if not rows:
        return pl.DataFrame(schema=schema)

    def mid(bid_e4: int | None, ask_e4: int | None) -> float | None:
        if bid_e4 is None or ask_e4 is None or bid_e4 <= 0:
            return None
        return (bid_e4 + ask_e4) / (2 * _E4)

    mids = [mid(r["bid_e4"], r["ask_e4"]) for r in rows]
    closes = [(r["close_e4"] / _E4) if r["close_e4"] is not None else None for r in rows]
    # The same basis `enrichChain` (apps/server) solves implied vol from: mid
    # where a two-sided quote exists, the contract's own close otherwise.
    # Callers that price against `iv`/greeks must compare to *this* price,
    # not an independently-chosen one, or a rate mismatch masquerades as a
    # forecast disagreement.
    prices = [m if m is not None else c for m, c in zip(mids, closes)]

    return pl.DataFrame(
        {
            "occ_symbol": [r["occ_symbol"] for r in rows],
            "underlying": [r["underlying"] for r in rows],
            "expiry": [r["expiry"] for r in rows],
            "type": [r["type"] for r in rows],
            "strike": [r["strike_e4"] / _E4 for r in rows],
            "bid": [(r["bid_e4"] / _E4) if r["bid_e4"] is not None else None for r in rows],
            "ask": [(r["ask_e4"] / _E4) if r["ask_e4"] is not None else None for r in rows],
            "mid": mids,
            "close": closes,
            "price": prices,
            "volume": [r["volume"] for r in rows],
            "open_interest": [r["open_interest"] for r in rows],
            "underlying_price": [r["underlying_e4"] / _E4 for r in rows],
            "iv": [(r["iv_bps"] / 10_000.0) if r["iv_bps"] is not None else None for r in rows],
            "delta": [r["delta"] for r in rows],
            "gamma": [r["gamma"] for r in rows],
            "vega": [r["vega"] for r in rows],
            "theta": [r["theta"] for r in rows],
            "liquid": [bool(r["liquid"]) for r in rows],
        },
        schema=schema,
    )


def read_risk_free_curve(day: str) -> list[tuple[int, float]]:
    """The published curve on or before `day`, as (tenor_days, rate) pairs.

    Mirrors `curveFor` in `apps/server/src/lib/options/rates.ts` — same
    "latest day on or before" lookup, same tenor-sorted output — because
    Python has no import path into the TS side and re-deriving the query is
    cheaper and safer than sharing a schema module across languages here.
    """
    with connect() as conn:
        latest = conn.execute(
            "SELECT day FROM risk_free_rates WHERE day <= ? ORDER BY day DESC LIMIT 1",
            [day],
        ).fetchone()
        if latest is None:
            return []
        rows = conn.execute(
            "SELECT tenor_days, rate_bps FROM risk_free_rates WHERE day = ? ORDER BY tenor_days",
            [latest["day"]],
        ).fetchall()
    return [(r["tenor_days"], r["rate_bps"] / 10_000.0) for r in rows]
