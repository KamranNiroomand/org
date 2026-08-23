"""db.py tests, against a hand-built temporary SQLite file rather than the
real local corpus — deliberately, unlike test_train.py/test_rank.py/
test_backtest.py, which skip when the real corpus is absent. The
deduplication `read_quotes`/`read_contract_history` do is a correctness
guarantee this suite should never lose just because a fresh checkout has no
captured data yet: the bug it guards against (a recaptured day silently
double-counted in every sum-based feature) was found against real data, but
the regression test for it must not depend on real data existing to run.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from app.db import read_contract_history, read_quotes

_E4 = 10_000


def _build_market_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE option_contracts (
            occ_symbol TEXT PRIMARY KEY,
            underlying TEXT NOT NULL,
            expiry TEXT NOT NULL,
            type TEXT NOT NULL,
            strike_e4 INTEGER NOT NULL,
            multiplier INTEGER NOT NULL DEFAULT 100
        );
        CREATE TABLE option_quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            occ_symbol TEXT NOT NULL,
            as_of TEXT NOT NULL,
            trading_day TEXT NOT NULL,
            bid_e4 INTEGER,
            ask_e4 INTEGER,
            close_e4 INTEGER,
            volume INTEGER NOT NULL DEFAULT 0,
            open_interest INTEGER NOT NULL DEFAULT 0,
            underlying_e4 INTEGER NOT NULL,
            iv_bps INTEGER,
            delta REAL,
            gamma REAL,
            vega REAL,
            theta REAL,
            liquid INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    conn.commit()
    conn.close()


def _insert_contract(
    conn: sqlite3.Connection, occ_symbol: str, underlying: str, expiry: str, type_: str, strike: float
) -> None:
    conn.execute(
        "INSERT INTO option_contracts (occ_symbol, underlying, expiry, type, strike_e4) VALUES (?, ?, ?, ?, ?)",
        (occ_symbol, underlying, expiry, type_, round(strike * _E4)),
    )


def _insert_quote(
    conn: sqlite3.Connection,
    occ_symbol: str,
    as_of: str,
    trading_day: str,
    close: float,
    underlying_price: float,
    volume: int = 100,
    open_interest: int = 500,
    iv: float | None = 0.30,
    liquid: bool = True,
) -> None:
    conn.execute(
        """
        INSERT INTO option_quotes
            (occ_symbol, as_of, trading_day, close_e4, volume, open_interest,
             underlying_e4, iv_bps, liquid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            occ_symbol,
            as_of,
            trading_day,
            round(close * _E4),
            volume,
            open_interest,
            round(underlying_price * _E4),
            round(iv * 10_000) if iv is not None else None,
            1 if liquid else 0,
        ),
    )


@pytest.fixture
def market_db(tmp_path, monkeypatch):
    db_path = tmp_path / "market.db"
    _build_market_db(db_path)
    monkeypatch.setenv("MARKET_DB_PATH", str(db_path))
    conn = sqlite3.connect(db_path)
    yield conn
    conn.close()


class TestReadQuotesDeduplication:
    def test_a_recaptured_day_collapses_to_one_row_per_contract(self, market_db) -> None:
        _insert_contract(market_db, "A", "AAA", "2026-09-01", "call", 100.0)
        # Same contract, same day, two capture attempts hours apart —
        # exactly what an interrupted-then-rerun nightly job leaves behind.
        _insert_quote(market_db, "A", "2026-08-18T16:00:00Z", "2026-08-18", 5.0, 100.0)
        _insert_quote(market_db, "A", "2026-08-18T20:00:00Z", "2026-08-18", 5.0, 100.0)
        market_db.commit()

        chain = read_quotes("AAA", "2026-08-18")
        assert chain.height == 1

    def test_keeps_the_latest_as_of_when_captures_disagree(self, market_db) -> None:
        # A contract whose price genuinely moved between the two capture
        # attempts — the later snapshot is the more final observation of
        # the day and must be what survives, not an arbitrary pick.
        _insert_contract(market_db, "A", "AAA", "2026-09-01", "call", 100.0)
        _insert_quote(market_db, "A", "2026-08-18T16:00:00Z", "2026-08-18", 5.0, 100.0)
        _insert_quote(market_db, "A", "2026-08-18T20:00:00Z", "2026-08-18", 5.5, 101.0)
        market_db.commit()

        chain = read_quotes("AAA", "2026-08-18")
        assert chain.height == 1
        assert chain["close"][0] == pytest.approx(5.5)
        assert chain["underlying_price"][0] == pytest.approx(101.0)

    def test_different_days_are_not_treated_as_duplicates(self, market_db) -> None:
        _insert_contract(market_db, "A", "AAA", "2026-09-01", "call", 100.0)
        _insert_quote(market_db, "A", "2026-08-18T20:00:00Z", "2026-08-18", 5.0, 100.0)
        _insert_quote(market_db, "A", "2026-08-19T20:00:00Z", "2026-08-19", 5.2, 100.5)
        market_db.commit()

        assert read_quotes("AAA", "2026-08-18").height == 1
        assert read_quotes("AAA", "2026-08-19").height == 1

    def test_liquid_only_filters_after_deduplication(self, market_db) -> None:
        _insert_contract(market_db, "A", "AAA", "2026-09-01", "call", 100.0)
        _insert_quote(market_db, "A", "2026-08-18T20:00:00Z", "2026-08-18", 5.0, 100.0, liquid=False)
        market_db.commit()

        assert read_quotes("AAA", "2026-08-18", liquid_only=False).height == 1
        assert read_quotes("AAA", "2026-08-18", liquid_only=True).height == 0


class TestReadContractHistoryDeduplication:
    def test_a_recaptured_day_collapses_to_one_row_per_contract_per_day(self, market_db) -> None:
        _insert_contract(market_db, "A", "AAA", "2026-09-01", "call", 100.0)
        _insert_quote(market_db, "A", "2026-08-18T16:00:00Z", "2026-08-18", 5.0, 100.0)
        _insert_quote(market_db, "A", "2026-08-18T20:00:00Z", "2026-08-18", 5.5, 101.0)
        _insert_quote(market_db, "A", "2026-08-19T20:00:00Z", "2026-08-19", 6.0, 102.0)
        market_db.commit()

        history = read_contract_history(["A"])
        assert history.height == 2  # one per distinct day, not per capture
        by_day = {row["trading_day"]: row for row in history.iter_rows(named=True)}
        assert by_day["2026-08-18"]["price"] == pytest.approx(5.5)  # the later capture
        assert by_day["2026-08-19"]["price"] == pytest.approx(6.0)

    def test_empty_symbol_list_returns_empty_without_querying(self, market_db) -> None:
        assert read_contract_history([]).height == 0


class TestConnectionHygiene:
    """`with sqlite3.connect(...)` is a *transaction* context manager, not a
    closing one — the handle outlives the block. Harmless for a read;
    genuinely dangerous once anything writes, since a lingering write
    connection can hold the WAL write lock against the other process. These
    pin the two properties that make that safe.
    """

    def test_reading_closes_its_connection(self, market_db) -> None:
        from app.db import reading

        with reading() as conn:
            conn.execute("SELECT 1").fetchone()
        # A closed sqlite3 connection raises on any further use.
        with pytest.raises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")

    def test_connections_set_a_busy_timeout(self, market_db) -> None:
        from app.db import BUSY_TIMEOUT_MS, reading

        with reading() as conn:
            got = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        # SQLite's own default is 0 — fail instantly the moment Node holds
        # the write lock, rather than waiting the moment out.
        assert got == BUSY_TIMEOUT_MS

    def test_readers_still_cannot_write(self, market_db) -> None:
        from app.db import reading

        with reading() as conn, pytest.raises(sqlite3.OperationalError):
            conn.execute("CREATE TABLE nope (x INTEGER)")
