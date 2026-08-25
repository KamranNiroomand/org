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
from contextlib import closing, contextmanager
from collections.abc import Iterator
from pathlib import Path

import polars as pl

_E4 = 10_000.0

#: Wait this long for another process's write lock before raising
#: `SQLITE_BUSY`. SQLite's own default is 0 — fail instantly — which is the
#: wrong behaviour when Node is legitimately mid-write on the same file.
BUSY_TIMEOUT_MS = 5_000


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
    # Per-connection in SQLite, not a property of the file: without this a
    # read landing while Node holds the write lock fails instantly rather
    # than waiting the moment out.
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    return conn


@contextmanager
def reading() -> Iterator[sqlite3.Connection]:
    """A connection that is actually closed when the block exits.

    `with sqlite3.connect(...) as conn:` looks like it does this and does
    not — `Connection.__enter__` is a *transaction* context manager, so the
    handle survives the block and lives until garbage collection. Harmless
    enough for a read, genuinely dangerous the moment anything here writes,
    since a lingering write connection can sit on the WAL write lock and
    block the other process. Every reader below goes through this instead.
    """
    with closing(connect()) as conn:
        yield conn


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

    with reading() as conn:
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
    """One underlying's captured contracts on one day — one row per contract.

    `liquid_only` defaults to `False`: surface features like put/call ratios
    want the whole chain, since an illiquid strike still reflects real
    positioning even if it would never be offered as a trade candidate. Filter
    to `liquid_only=True` only at the point where a contract might actually be
    ranked or filled.

    **Liquidity is not reliability.** 40.4% of multi-day contracts in this
    corpus carry a completely frozen close that the gate does not catch —
    see `screens.py`, and pass any chain that will be *priced* through
    `screen_quotes` first. A caller that stops at `liquid_only=True` and
    believes it has done the documented due diligence is how the $122,440
    stale-print incident repeats one call site over.

    **Deduped to the latest `as_of` per contract.** `option_quotes` is
    append-only and keyed on `(occ_symbol, as_of)`, not `(occ_symbol,
    trading_day)` — a day recaptured after an interrupted run (a stale
    process, a restart) leaves two real, distinct rows for the same contract
    on the same day, both with the same close and same solved IV, but
    duplicated all the same. Left undeduped, that duplication is invisible
    row-by-row and silent in an aggregate: `put_call_ratios` sums volume and
    open interest, and a systematically over-represented side skews the
    ratio in whichever direction happened to get captured twice more often.
    Found by checking this function against the real corpus rather than
    only synthetic fixtures — see `tests/test_features.py`.
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
        "underlying_asof_day": pl.Utf8,
        "iv": pl.Float64,
        "delta": pl.Float64,
        "gamma": pl.Float64,
        "vega": pl.Float64,
        "theta": pl.Float64,
        "liquid": pl.Boolean,
    }
    query = """
        WITH ranked AS (
            SELECT c.underlying, c.expiry, c.type, c.strike_e4,
                   q.occ_symbol, q.bid_e4, q.ask_e4, q.close_e4, q.volume, q.open_interest,
                   q.underlying_e4, q.underlying_asof_day,
                   q.iv_bps, q.delta, q.gamma, q.vega, q.theta, q.liquid,
                   ROW_NUMBER() OVER (PARTITION BY q.occ_symbol ORDER BY q.as_of DESC) AS rn
            FROM option_quotes q
            JOIN option_contracts c ON c.occ_symbol = q.occ_symbol
            WHERE c.underlying = ? AND q.trading_day = ?
        )
        SELECT * FROM ranked WHERE rn = 1
    """
    params: list[object] = [underlying, trading_day]
    if liquid_only:
        query += " AND liquid = 1"

    with reading() as conn:
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
            # Null on rows captured before provenance existed — unknown, not
            # fresh. screens.py skips the stale-spot check on null rather
            # than treating absence as evidence either way.
            "underlying_asof_day": [r["underlying_asof_day"] for r in rows],
            "iv": [(r["iv_bps"] / 10_000.0) if r["iv_bps"] is not None else None for r in rows],
            "delta": [r["delta"] for r in rows],
            "gamma": [r["gamma"] for r in rows],
            "vega": [r["vega"] for r in rows],
            "theta": [r["theta"] for r in rows],
            "liquid": [bool(r["liquid"]) for r in rows],
        },
        schema=schema,
    )


def read_all_quotes() -> pl.DataFrame:
    """Every captured contract-day in one scan — `read_quotes`' columns plus
    `trading_day`, deduped to the latest `as_of` per (contract, day).

    Exists for `option_feature_panel`, which needs the whole corpus
    partitioned by (underlying, trading_day): calling `read_quotes` once
    per pair turned a single sequential scan into thousands of round
    trips, and the training suite paid for it in the tens of minutes.
    """
    schema = {
        "occ_symbol": pl.Utf8,
        "underlying": pl.Utf8,
        "trading_day": pl.Utf8,
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
        "underlying_asof_day": pl.Utf8,
        "iv": pl.Float64,
        "delta": pl.Float64,
        "gamma": pl.Float64,
        "vega": pl.Float64,
        "theta": pl.Float64,
        "liquid": pl.Boolean,
    }
    query = """
        WITH ranked AS (
            SELECT c.underlying, c.expiry, c.type, c.strike_e4,
                   q.occ_symbol, q.trading_day, q.bid_e4, q.ask_e4, q.close_e4,
                   q.volume, q.open_interest,
                   q.underlying_e4, q.underlying_asof_day,
                   q.iv_bps, q.delta, q.gamma, q.vega, q.theta, q.liquid,
                   ROW_NUMBER() OVER (
                       PARTITION BY q.occ_symbol, q.trading_day ORDER BY q.as_of DESC
                   ) AS rn
            FROM option_quotes q
            JOIN option_contracts c ON c.occ_symbol = q.occ_symbol
        )
        SELECT * FROM ranked WHERE rn = 1
    """
    with reading() as conn:
        rows = conn.execute(query).fetchall()
    if not rows:
        return pl.DataFrame(schema=schema)

    def mid(bid_e4: int | None, ask_e4: int | None) -> float | None:
        if bid_e4 is None or ask_e4 is None or bid_e4 <= 0:
            return None
        return (bid_e4 + ask_e4) / (2 * _E4)

    mids = [mid(r["bid_e4"], r["ask_e4"]) for r in rows]
    closes = [(r["close_e4"] / _E4) if r["close_e4"] is not None else None for r in rows]
    prices = [m if m is not None else c for m, c in zip(mids, closes)]
    return pl.DataFrame(
        {
            "occ_symbol": [r["occ_symbol"] for r in rows],
            "underlying": [r["underlying"] for r in rows],
            "trading_day": [r["trading_day"] for r in rows],
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
            "underlying_asof_day": [r["underlying_asof_day"] for r in rows],
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
    with reading() as conn:
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


def read_contract_history(occ_symbols: list[str]) -> pl.DataFrame:
    """One row per contract per trading day, across every day captured.

    For walking a position forward after entry — `backtest.py`'s reason to
    exist. One query for the whole list rather than one call per contract:
    a backtest over even a modest candidate set is thousands of contracts,
    and a query-per-contract there is the same anti-pattern `read_bars`
    already avoids for the whole universe.

    Deduped to the latest `as_of` per contract per day, for the same reason
    `read_quotes` is — a day recaptured after an interrupted run leaves two
    real rows for the same contract on the same day.
    """
    schema = {
        "occ_symbol": pl.Utf8,
        "trading_day": pl.Utf8,
        "price": pl.Float64,
        "underlying_price": pl.Float64,
        "iv": pl.Float64,
        "liquid": pl.Boolean,
    }
    if not occ_symbols:
        return pl.DataFrame(schema=schema)

    placeholders = ",".join("?" for _ in occ_symbols)
    with reading() as conn:
        rows = conn.execute(
            f"""
            WITH ranked AS (
                SELECT occ_symbol, trading_day, bid_e4, ask_e4, close_e4,
                       underlying_e4, iv_bps, liquid,
                       ROW_NUMBER() OVER (
                           PARTITION BY occ_symbol, trading_day ORDER BY as_of DESC
                       ) AS rn
                FROM option_quotes
                WHERE occ_symbol IN ({placeholders})
            )
            SELECT * FROM ranked WHERE rn = 1 ORDER BY occ_symbol, trading_day
            """,
            occ_symbols,
        ).fetchall()

    if not rows:
        return pl.DataFrame(schema=schema)

    def price(bid_e4: int | None, ask_e4: int | None, close_e4: int | None) -> float | None:
        if bid_e4 is not None and ask_e4 is not None and bid_e4 > 0:
            return (bid_e4 + ask_e4) / (2 * _E4)
        return (close_e4 / _E4) if close_e4 is not None else None

    return pl.DataFrame(
        {
            "occ_symbol": [r["occ_symbol"] for r in rows],
            "trading_day": [r["trading_day"] for r in rows],
            "price": [price(r["bid_e4"], r["ask_e4"], r["close_e4"]) for r in rows],
            "underlying_price": [r["underlying_e4"] / _E4 for r in rows],
            "iv": [(r["iv_bps"] / 10_000.0) if r["iv_bps"] is not None else None for r in rows],
            "liquid": [bool(r["liquid"]) for r in rows],
        },
        schema=schema,
    )


def read_champion_run(target: str = "dir") -> dict | None:
    """The run the registry says is live for `target`, or None.

    **Filtered by target, because promotion is per-target.** The promote
    route demotes only champions sharing the run's own target — its
    comment reads "Only one champion per target at a time" — so `dir` and
    `vrp` champions coexist by design. An unfiltered query would return
    whichever was promoted most recently across all targets, so promoting
    a vrp champion would silently hand `/rank` a model trained for a
    different quantity, with a different feature set. Only `dir` models
    exist today, but vrp is named throughout this codebase as the eventual
    primary target.

    Exists because promotion used to be pure bookkeeping. `model_runs` has
    carried a `champion` status and a manual promote route since the
    project plan's champion/challenger policy was written, and nothing on
    the serving path ever read either one — `latest_model_dir` picked by
    filename instead. So the database could say one model was live while
    the ranker served another, with no surface anywhere reporting the
    divergence. On 2026-08-24 the two happened to agree only because the
    promoted run's config hash sorted last.

    Returns the row rather than just a path so a caller can report *which*
    run it resolved and why, which is the other half of the fix: a
    selection nobody can observe is how the divergence went unnoticed.

    `model_runs` lives in `market.db`, which this module already opens
    read-only — this adds no write and no new concurrency surface.
    """
    with reading() as conn:
        row = conn.execute(
            """
            SELECT run_id, artifact_dir, status, promoted_at
            FROM model_runs
            WHERE status = 'champion' AND target = ?
            ORDER BY promoted_at DESC
            LIMIT 1
            """,
            (target,),
        ).fetchone()
    if row is None:
        return None
    return {"run_id": row[0], "artifact_dir": row[1], "status": row[2], "promoted_at": row[3]}


def prior_trading_day(trading_day: str) -> str | None:
    """The captured trading day immediately before `trading_day`, or None.

    Drives the staleness screen in `screens.py`: a quote is only provably
    stale relative to a previous capture, and "previous" must mean the
    corpus's own prior day rather than calendar arithmetic — weekends,
    holidays and missed captures all make calendar-yesterday a day with no
    data, which would silently disable the screen exactly when capture is
    patchy.
    """
    with reading() as conn:
        row = conn.execute(
            "SELECT MAX(trading_day) FROM option_quotes WHERE trading_day < ?",
            (trading_day,),
        ).fetchone()
    return row[0] if row and row[0] else None


def read_day_stats(trading_day: str) -> pl.DataFrame:
    """Every contract's close, volume and open interest for one day, in one
    query — the staleness screen's comparison basis.

    One scan for the whole day rather than one `read_quotes` per symbol:
    the per-symbol version doubled rank_day's SQL (a windowed join per
    underlying, ~566 extra queries per rank, multiplied again by every
    backtest day), to feed a screen that only needs three columns. Same
    anti-pattern `read_contract_history`'s docstring already names.

    Deliberately unfiltered by liquidity. The prior frame is only a
    history lookup for "did this print move", and gating it on
    *yesterday's* liquidity verdict punched a hole in the staleness
    screen: a contract that failed yesterday's gate had no prior row,
    joined to null, and passed as fresh — precisely the profile of a
    contract nobody is making a market in.
    """
    schema = {
        "occ_symbol": pl.Utf8,
        "close": pl.Float64,
        "volume": pl.Int64,
        "open_interest": pl.Int64,
    }
    with reading() as conn:
        rows = conn.execute(
            """
            WITH ranked AS (
                SELECT occ_symbol, close_e4, volume, open_interest,
                       ROW_NUMBER() OVER (PARTITION BY occ_symbol ORDER BY as_of DESC) AS rn
                FROM option_quotes WHERE trading_day = ?
            )
            SELECT occ_symbol, close_e4, volume, open_interest FROM ranked WHERE rn = 1
            """,
            (trading_day,),
        ).fetchall()
    return pl.DataFrame(
        {
            "occ_symbol": [r[0] for r in rows],
            "close": [r[1] / 10_000.0 if r[1] is not None else None for r in rows],
            "volume": [r[2] for r in rows],
            "open_interest": [r[3] for r in rows],
        },
        schema=schema,
    )
