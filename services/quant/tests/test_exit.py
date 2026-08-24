"""exit.py — adaptive exit management, tested as pure arithmetic (see the
module docstring for why `evaluate_exit` deliberately never touches the
model or the database).
"""

from __future__ import annotations

import pytest

from app.exit import (
    MIN_DTE_FLOOR,
    ExitTarget,
    compute_initial_exit_target,
    evaluate_exit,
)


class TestComputeInitialExitTarget:
    def test_profit_target_and_stop_loss_are_symmetric_fractions_of_entry(self) -> None:
        target = compute_initial_exit_target(
            entry_price=2.00,
            expiry="2026-03-20",
            entry_day="2026-01-01",
            forecast_horizon_days=5,
            profit_target_pct=0.5,
            stop_loss_pct=0.5,
        )
        assert target.target_exit_price == pytest.approx(3.00)
        assert target.stop_loss_price == pytest.approx(1.00)

    def test_target_date_follows_the_forecast_horizon(self) -> None:
        target = compute_initial_exit_target(
            entry_price=2.00,
            expiry="2026-06-19",
            entry_day="2026-01-01",
            forecast_horizon_days=5,
        )
        assert target.target_exit_date == "2026-01-06"

    def test_target_date_is_capped_clear_of_expiry_for_a_short_dated_contract(self) -> None:
        # A 30-day forecast horizon against a contract expiring in 5 days:
        # the raw horizon would land past expiry, so the DTE floor wins.
        target = compute_initial_exit_target(
            entry_price=2.00,
            expiry="2026-01-06",
            entry_day="2026-01-01",
            forecast_horizon_days=30,
            min_dte_floor=3,
        )
        # (Jan 6 - Jan 1) - 3 day floor = 2 days out from entry.
        assert target.target_exit_date == "2026-01-03"

    def test_rejects_a_non_positive_entry_price(self) -> None:
        with pytest.raises(ValueError):
            compute_initial_exit_target(
                entry_price=0.0, expiry="2026-03-20", entry_day="2026-01-01", forecast_horizon_days=5
            )

    def test_refuses_a_target_when_the_contracts_entire_life_is_inside_the_floor(self) -> None:
        # 2 days to expiry against a 3-day floor: no day exists that both
        # exists and clears the floor. Regression test for a version that
        # silently clamped horizon_days back up to 1, landing the target
        # date *inside* the floor it was supposed to guarantee.
        with pytest.raises(ValueError):
            compute_initial_exit_target(
                entry_price=2.00,
                expiry="2026-01-03",
                entry_day="2026-01-01",
                forecast_horizon_days=5,
                min_dte_floor=3,
            )

    def test_refuses_a_target_when_expiry_lands_exactly_on_the_floor(self) -> None:
        # (expiry - entry).days == min_dte_floor exactly: latest_sensible_day
        # is 0, still no day clears the floor.
        with pytest.raises(ValueError):
            compute_initial_exit_target(
                entry_price=2.00,
                expiry="2026-01-04",
                entry_day="2026-01-01",
                forecast_horizon_days=5,
                min_dte_floor=3,
            )

    def test_computes_a_target_at_the_one_day_boundary_clear_of_the_floor(self) -> None:
        # (expiry - entry).days = 4, min_dte_floor = 3: exactly one real day
        # (entry_day + 1) clears the floor, and this must not raise.
        target = compute_initial_exit_target(
            entry_price=2.00,
            expiry="2026-01-05",
            entry_day="2026-01-01",
            forecast_horizon_days=5,
            min_dte_floor=3,
        )
        assert target.target_exit_date == "2026-01-02"


class TestEvaluateExit:
    def _target(self, **overrides) -> ExitTarget:
        base = dict(
            target_exit_price=3.00, stop_loss_price=1.00, target_exit_date="2026-01-10", reason="test"
        )
        base.update(overrides)
        return ExitTarget(**base)

    def test_reaching_the_target_raises_the_stop_instead_of_closing(self) -> None:
        # This asserted `exit_now` in v1. That rule cut every winner at the
        # target while losers still ran to the stop or to zero — capping the
        # one tail a long option is bought for. The target now activates a
        # trailing stop and the position keeps running.
        decision = evaluate_exit(current_price=3.00, dte=10, target=self._target())
        assert decision.action == "hold"
        assert decision.triggered_by == "trail_raised"
        assert decision.new_stop_loss_price == pytest.approx(3.00 * 0.7)

    def test_a_winner_still_escalates_on_news_and_keeps_its_raised_stop(self) -> None:
        # The bug this pins: the trail branch used to return before the
        # review checks. Under the old rule that cost nothing — the
        # position was closed at the target, so there was nothing left to
        # review. Now it holds above the target indefinitely, and an early
        # return meant a winning position could never escalate again: a
        # restatement would ride the trailing stop down with nobody
        # looking. The raised stop must survive the escalation too.
        decision = evaluate_exit(
            current_price=3.00, dte=10, target=self._target(), new_documents_count=2
        )
        assert decision.action == "needs_review"
        assert decision.triggered_by == "new_news"
        assert decision.new_stop_loss_price == pytest.approx(3.00 * 0.7)

    def test_a_winner_still_escalates_on_an_ev_sign_flip(self) -> None:
        decision = evaluate_exit(
            current_price=3.00, dte=10, target=self._target(), entry_ev=5.0, current_ev=-1.0
        )
        assert decision.action == "needs_review"
        assert decision.triggered_by == "ev_sign_flip"
        assert decision.new_stop_loss_price == pytest.approx(3.00 * 0.7)

    def test_the_trailing_stop_only_ever_ratchets_upward(self) -> None:
        # A stop that can move down is not a stop. At a price whose trail
        # would sit below the stop already in force, the existing stop
        # stands and nothing is written.
        decision = evaluate_exit(
            current_price=3.00, dte=10, target=self._target(stop_loss_price=2.50)
        )
        assert decision.action == "hold"
        assert decision.new_stop_loss_price is None

    def test_a_ratcheted_stop_is_what_later_closes_the_position(self) -> None:
        # The other half of the rule: once the stop has trailed up to 2.10,
        # a fall back to it exits — the give-back is bounded, the upside
        # was not.
        decision = evaluate_exit(
            current_price=2.10, dte=10, target=self._target(stop_loss_price=2.10)
        )
        assert decision.action == "exit_now"
        assert decision.triggered_by == "stop_loss"

    def test_a_bigger_winner_trails_from_a_higher_price(self) -> None:
        # The point of the whole change: a 5x move is not truncated at the
        # target, and its stop sits proportionally higher.
        decision = evaluate_exit(current_price=10.00, dte=10, target=self._target())
        assert decision.action == "hold"
        assert decision.new_stop_loss_price == pytest.approx(7.00)

    def test_exits_on_hitting_the_stop_loss(self) -> None:
        decision = evaluate_exit(current_price=1.00, dte=10, target=self._target())
        assert decision.action == "exit_now"
        assert decision.triggered_by == "stop_loss"

    def test_stop_loss_is_checked_even_when_price_is_deep_past_it(self) -> None:
        decision = evaluate_exit(current_price=0.10, dte=10, target=self._target())
        assert decision.action == "exit_now"
        assert decision.triggered_by == "stop_loss"

    def test_exits_when_inside_the_dte_floor_regardless_of_price(self) -> None:
        decision = evaluate_exit(current_price=2.00, dte=MIN_DTE_FLOOR, target=self._target())
        assert decision.action == "exit_now"
        assert decision.triggered_by == "dte_floor"

    def test_needs_review_on_an_ev_sign_flip(self) -> None:
        decision = evaluate_exit(
            current_price=2.00, dte=10, target=self._target(), entry_ev=5.0, current_ev=-2.0
        )
        assert decision.action == "needs_review"
        assert decision.triggered_by == "ev_sign_flip"

    def test_no_review_when_ev_stays_the_same_sign(self) -> None:
        decision = evaluate_exit(
            current_price=2.00, dte=10, target=self._target(), entry_ev=5.0, current_ev=1.0
        )
        assert decision.action == "hold"

    def test_needs_review_on_new_documents(self) -> None:
        decision = evaluate_exit(current_price=2.00, dte=10, target=self._target(), new_documents_count=2)
        assert decision.action == "needs_review"
        assert decision.triggered_by == "new_news"

    def test_holds_with_an_unchanged_target_when_nothing_triggers(self) -> None:
        target = self._target()
        decision = evaluate_exit(current_price=2.00, dte=10, target=target)
        assert decision.action == "hold"
        assert decision.new_target_exit_price == target.target_exit_price
        assert decision.new_target_exit_date == target.target_exit_date
        assert decision.triggered_by == "unchanged"

    def test_deterministic_rules_are_checked_before_any_review_trigger(self) -> None:
        # A stop-loss breach and a simultaneous EV sign flip: the cheap,
        # deterministic exit must win — no reason to spend an LLM call on a
        # position the price-based rule already resolves. (Used the profit
        # target before it stopped being an exit; the stop is now the
        # deterministic close.)
        decision = evaluate_exit(
            current_price=0.50, dte=10, target=self._target(), entry_ev=5.0, current_ev=-1.0
        )
        assert decision.action == "exit_now"
        assert decision.triggered_by == "stop_loss"
