"""backtest.py tests, against a synthetic multi-day panel — the real corpus
has exactly one captured trading day so far, which is not enough to walk a
single position forward through, let alone exercise the coverage-gap and
hold-days paths this module exists to get right. See the module docstring
for why that is the honest state of things rather than a gap in this file.
"""

from __future__ import annotations

import math

import polars as pl
import pytest

from app.backtest import (
    Position,
    Trade,
    backtest_report,
    close_position,
    enter_positions,
    run_backtest,
    simulate_positions,
)
from app.rank import RankedContract


def _history(rows: list[dict]) -> pl.DataFrame:
    schema = {
        "occ_symbol": pl.Utf8,
        "trading_day": pl.Utf8,
        "price": pl.Float64,
        "underlying_price": pl.Float64,
        "iv": pl.Float64,
        "liquid": pl.Boolean,
    }
    defaults = {"iv": 0.3, "liquid": True}
    filled = [{**defaults, **r} for r in rows]
    return pl.DataFrame(filled, schema=schema) if filled else pl.DataFrame(schema=schema)


def _position(**overrides: object) -> Position:
    base = dict(
        occ_symbol="TEST  260201C00100000",
        underlying="TEST",
        type="call",
        strike=100.0,
        expiry="2026-02-01",
        entry_day="2026-01-02",
        entry_price=5.0,
        quantity=1,
    )
    base.update(overrides)
    return Position(**base)  # type: ignore[arg-type]


class TestClosePositionAtExpiry:
    def test_settles_itm_against_the_last_known_underlying_price(self) -> None:
        pos = _position()
        history = _history(
            [
                {"occ_symbol": pos.occ_symbol, "trading_day": "2026-01-15", "price": 8.0, "underlying_price": 110.0},
                # Nothing captured exactly on 2026-02-01 — the last row on or
                # before expiry must still be used, not treated as missing.
                {"occ_symbol": pos.occ_symbol, "trading_day": "2026-01-30", "price": 12.0, "underlying_price": 115.0},
            ]
        )
        trade = close_position(pos, history)
        assert trade.exit_reason == "expired_itm"
        assert trade.exit_day == pos.expiry
        assert trade.exit_price == pytest.approx(15.0)  # intrinsic: 115 - 100

    def test_settles_otm_as_a_total_loss_of_premium(self) -> None:
        pos = _position(strike=200.0)
        history = _history(
            [{"occ_symbol": pos.occ_symbol, "trading_day": "2026-01-30", "price": 0.5, "underlying_price": 150.0}]
        )
        trade = close_position(pos, history)
        assert trade.exit_reason == "expired_otm"
        assert trade.exit_price == 0.0
        assert trade.pnl == pytest.approx((0.0 - pos.entry_price) * 100 - 1.30)

    def test_put_settles_against_the_opposite_side_of_intrinsic(self) -> None:
        pos = _position(type="put", strike=100.0)
        history = _history(
            [{"occ_symbol": pos.occ_symbol, "trading_day": "2026-01-30", "price": 20.0, "underlying_price": 70.0}]
        )
        trade = close_position(pos, history)
        assert trade.exit_reason == "expired_itm"
        assert trade.exit_price == pytest.approx(30.0)  # 100 - 70

    def test_no_further_data_when_nothing_captured_after_entry(self) -> None:
        pos = _position()
        history = _history([])
        trade = close_position(pos, history)
        assert trade.exit_reason == "no_further_data"
        assert trade.exit_price is None
        assert trade.pnl is None
        assert not trade.resolved

    def test_ignores_the_entry_days_own_row_even_if_the_caller_forgot_to_filter_it(self) -> None:
        # The entry row is what was paid, not a candidate exit. A caller
        # that hands close_position unfiltered history (including the entry
        # day) must not get a same-day "exit" back.
        pos = _position()
        history = _history(
            [{"occ_symbol": pos.occ_symbol, "trading_day": pos.entry_day, "price": pos.entry_price, "underlying_price": 100.0}]
        )
        trade = close_position(pos, history)
        assert trade.exit_reason == "no_further_data"


class TestClosePositionWithHoldDays:
    def test_exits_early_at_the_last_price_on_or_before_the_deadline(self) -> None:
        pos = _position(entry_day="2026-01-02", expiry="2026-06-01")
        history = _history(
            [
                {"occ_symbol": pos.occ_symbol, "trading_day": "2026-01-05", "price": 6.0, "underlying_price": 102.0},
                {"occ_symbol": pos.occ_symbol, "trading_day": "2026-01-20", "price": 9.0, "underlying_price": 108.0},
                # Past the 10-day deadline — must not be used.
                {"occ_symbol": pos.occ_symbol, "trading_day": "2026-03-01", "price": 40.0, "underlying_price": 300.0},
            ]
        )
        trade = close_position(pos, history, hold_days=10)
        assert trade.exit_reason == "held_to_exit_day"
        assert trade.exit_day == "2026-01-05"
        assert trade.exit_price == pytest.approx(6.0)

    def test_falls_through_to_expiry_settlement_when_expiry_precedes_the_deadline(self) -> None:
        pos = _position(entry_day="2026-01-02", expiry="2026-01-10")
        history = _history(
            [{"occ_symbol": pos.occ_symbol, "trading_day": "2026-01-09", "price": 7.0, "underlying_price": 120.0}]
        )
        trade = close_position(pos, history, hold_days=365)
        assert trade.exit_reason == "expired_itm"
        assert trade.exit_price == pytest.approx(20.0)

    def test_no_further_data_when_nothing_captured_before_the_deadline(self) -> None:
        pos = _position(entry_day="2026-01-02", expiry="2026-06-01")
        history = _history(
            [{"occ_symbol": pos.occ_symbol, "trading_day": "2026-03-01", "price": 40.0, "underlying_price": 300.0}]
        )
        trade = close_position(pos, history, hold_days=10)
        assert trade.exit_reason == "no_further_data"


class TestClosePositionCostsAndReturns:
    def test_round_trip_cost_reduces_pnl_by_exactly_its_value(self) -> None:
        pos = _position()
        history = _history(
            [{"occ_symbol": pos.occ_symbol, "trading_day": "2026-01-30", "price": 8.0, "underlying_price": 110.0}]
        )
        free = close_position(pos, history, round_trip_cost=0.0)
        costly = close_position(pos, history, round_trip_cost=1.30)
        assert costly.pnl == pytest.approx(free.pnl - 1.30)

    def test_return_pct_is_pnl_over_capital_at_risk(self) -> None:
        pos = _position(entry_price=5.0, quantity=2)
        history = _history(
            [{"occ_symbol": pos.occ_symbol, "trading_day": "2026-01-30", "price": 10.0, "underlying_price": 110.0}]
        )
        trade = close_position(pos, history, round_trip_cost=0.0)
        capital = 5.0 * 100 * 2
        assert trade.return_pct == pytest.approx(trade.pnl / capital)


class TestSimulatePositions:
    def test_resolves_each_position_against_its_own_contracts_history(self) -> None:
        pos_a = _position(occ_symbol="A", strike=100.0)
        pos_b = _position(occ_symbol="B", strike=100.0)
        history = _history(
            [
                {"occ_symbol": "A", "trading_day": "2026-01-30", "price": 8.0, "underlying_price": 150.0},
                {"occ_symbol": "B", "trading_day": "2026-01-30", "price": 1.0, "underlying_price": 50.0},
            ]
        )
        trades = simulate_positions([pos_a, pos_b], history)
        by_symbol = {t.occ_symbol: t for t in trades}
        assert by_symbol["A"].exit_reason == "expired_itm"
        assert by_symbol["B"].exit_reason == "expired_otm"

    def test_a_position_with_no_matching_symbol_in_history_is_unresolved(self) -> None:
        pos = _position(occ_symbol="LONELY")
        history = _history([{"occ_symbol": "SOMEONE_ELSE", "trading_day": "2026-01-30", "price": 1.0, "underlying_price": 1.0}])
        trades = simulate_positions([pos], history)
        assert trades[0].exit_reason == "no_further_data"


class TestBacktestReport:
    def test_empty_when_nothing_resolved(self) -> None:
        pos = _position()
        trades = simulate_positions([pos], _history([]))
        report = backtest_report(trades)
        assert report["n_trades"] == 1
        assert report["n_resolved"] == 0
        assert report["coverage"] == 0.0
        assert report["win_rate"] is None

    def test_coverage_counts_unresolved_trades_rather_than_dropping_them(self) -> None:
        resolved_pos = _position(occ_symbol="A")
        unresolved_pos = _position(occ_symbol="B")
        history = _history([{"occ_symbol": "A", "trading_day": "2026-01-30", "price": 8.0, "underlying_price": 150.0}])
        trades = simulate_positions([resolved_pos, unresolved_pos], history)
        report = backtest_report(trades)
        assert report["n_trades"] == 2
        assert report["n_resolved"] == 1
        assert report["coverage"] == pytest.approx(0.5)

    def test_win_rate_and_total_pnl_over_a_mixed_batch(self) -> None:
        winner = _position(occ_symbol="W", strike=100.0)
        loser = _position(occ_symbol="L", strike=500.0)
        history = _history(
            [
                {"occ_symbol": "W", "trading_day": "2026-01-30", "price": 20.0, "underlying_price": 150.0},
                {"occ_symbol": "L", "trading_day": "2026-01-30", "price": 1.0, "underlying_price": 150.0},
            ]
        )
        trades = simulate_positions([winner, loser], history, round_trip_cost=0.0)
        report = backtest_report(trades)
        assert report["win_rate"] == pytest.approx(0.5)
        assert report["total_pnl"] == pytest.approx(sum(t.pnl for t in trades))
        assert math.isfinite(report["sharpe_ratio"])
        assert report["max_drawdown"] >= 0.0


def _ranked(**overrides: object) -> RankedContract:
    base = dict(
        occ_symbol="TEST  260201C00100000",
        underlying="TEST",
        expiry="2026-02-01",
        type="call",
        strike=100.0,
        dte=30,
        market_price=5.0,
        market_iv=0.30,
        forecast_vol=0.30,
        forecast_drift=0.05,
        forecast_value=6.0,
        ev=100.0,
        ev_per_risk=0.2,
        prob_profit=0.4,
    )
    base.update(overrides)
    return RankedContract(**base)  # type: ignore[arg-type]


class TestEnterPositions:
    def test_takes_the_top_n_and_stamps_the_entry_day(self) -> None:
        ranked = [_ranked(occ_symbol=f"C{i}", ev=100.0 - i) for i in range(5)]
        positions = enter_positions(ranked, "2026-01-02", top_n=2)
        assert [p.occ_symbol for p in positions] == ["C0", "C1"]
        assert all(p.entry_day == "2026-01-02" for p in positions)


class TestRunBacktest:
    def test_ranks_each_day_and_resolves_against_real_history(self, monkeypatch) -> None:
        day_one_ranked = [_ranked(occ_symbol="A", strike=100.0, market_price=5.0)]
        day_two_ranked = [_ranked(occ_symbol="B", strike=100.0, market_price=3.0, expiry="2026-02-15")]

        def fake_rank_day(day, model_dir, top=25, force=False, **kw):
            return {"2026-01-02": day_one_ranked, "2026-01-05": day_two_ranked}[day]

        history = _history(
            [
                {"occ_symbol": "A", "trading_day": "2026-01-30", "price": 8.0, "underlying_price": 150.0},
                {"occ_symbol": "B", "trading_day": "2026-02-14", "price": 0.0, "underlying_price": 50.0},
            ]
        )

        monkeypatch.setattr("app.backtest.rank_day", fake_rank_day)
        monkeypatch.setattr("app.backtest.read_contract_history", lambda symbols: history)

        trades = run_backtest(["2026-01-02", "2026-01-05"], model_dir="unused", top_n_per_day=1, force=True)

        assert len(trades) == 2
        by_symbol = {t.occ_symbol: t for t in trades}
        assert by_symbol["A"].exit_reason == "expired_itm"
        assert by_symbol["B"].exit_reason == "expired_otm"

    def test_no_positions_returns_an_empty_list_without_touching_history(self, monkeypatch) -> None:
        monkeypatch.setattr("app.backtest.rank_day", lambda *a, **kw: [])
        called = {"count": 0}

        def fail_if_called(symbols):
            called["count"] += 1
            raise AssertionError("read_contract_history should not run with zero positions")

        monkeypatch.setattr("app.backtest.read_contract_history", fail_if_called)
        trades = run_backtest(["2026-01-02"], model_dir="unused", force=True)
        assert trades == []
        assert called["count"] == 0
