"""exit.py — adaptive exit management, tested as pure arithmetic (see the
module docstring for why `evaluate_exit` deliberately never touches the
model or the database).
"""

from __future__ import annotations

import pytest

from app.exit import (
    DEFAULT_STOP_LOSS_PCT,
    MAX_STOP_PCT,
    MIN_STOP_PCT,
    vol_scaled_stop_pct,
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


class TestHorizonTimeStop:
    """The thesis has a shelf life: the model predicts a 5-day return, and
    target_exit_date was set from exactly that horizon. Before this rule a
    position drifted past its date until the DTE floor forced the issue
    weeks later, paying theta the whole way on a prediction that had fully
    played out."""

    def _target(self, **overrides):
        base = dict(
            target_exit_price=15.0,
            stop_loss_price=5.0,
            target_exit_date="2026-08-20",
            reason="",
        )
        base.update(overrides)
        return ExitTarget(**base)

    def test_past_the_date_with_negative_ev_exits(self) -> None:
        d = evaluate_exit(10.0, dte=40, target=self._target(),
                          current_ev=-12.0, today="2026-08-24")
        assert d.action == "exit_now"
        assert d.triggered_by == "thesis_expired"

    def test_past_the_date_with_positive_ev_extends_one_horizon(self) -> None:
        d = evaluate_exit(10.0, dte=40, target=self._target(),
                          current_ev=30.0, today="2026-08-24")
        assert d.action == "hold"
        assert d.triggered_by == "target_extended"
        assert d.new_target_exit_date == "2026-08-29"

    def test_past_the_date_with_no_ev_view_holds_unchanged(self) -> None:
        # Acting on missing data turns a transient scoring gap into a
        # forced sale; the DTE floor stays the backstop.
        d = evaluate_exit(10.0, dte=40, target=self._target(),
                          current_ev=None, today="2026-08-24")
        assert d.action == "hold"
        assert d.triggered_by == "unchanged"

    def test_the_extension_never_reaches_inside_the_dte_floor(self) -> None:
        d = evaluate_exit(10.0, dte=5, target=self._target(),
                          current_ev=30.0, today="2026-08-24")
        assert d.triggered_by == "target_extended"
        # dte 5, floor 3: at most 2 days out, not the full 5-day horizon.
        assert d.new_target_exit_date == "2026-08-26"

    def test_a_winner_past_its_date_keeps_the_raised_trail_on_extension(self) -> None:
        d = evaluate_exit(20.0, dte=40, target=self._target(),
                          current_ev=30.0, today="2026-08-24")
        assert d.triggered_by == "target_extended"
        assert d.new_stop_loss_price == pytest.approx(14.0)  # 30% below 20

    def test_the_stop_and_dte_floor_outrank_the_time_stop(self) -> None:
        stopped = evaluate_exit(4.0, dte=40, target=self._target(),
                                current_ev=-12.0, today="2026-08-24")
        assert stopped.triggered_by == "stop_loss"
        expiring = evaluate_exit(10.0, dte=2, target=self._target(),
                                 current_ev=30.0, today="2026-08-24")
        assert expiring.triggered_by == "dte_floor"

    def test_no_today_keeps_the_old_behavior(self) -> None:
        d = evaluate_exit(10.0, dte=40, target=self._target(), current_ev=-12.0)
        assert d.action == "hold"


class TestVolScaledStop:
    """The systematic-desk convention: every stop the same number of
    sigmas away, not the same number of percent."""

    def test_high_vol_options_get_wider_stops_than_low_vol_ones(self) -> None:
        # ATM-ish call on an 80%-vol name vs a 15%-vol name, same price
        # and delta: the stop distance must order by volatility.
        wild = vol_scaled_stop_pct(5.0, spot=100.0, delta=0.5, sigma=0.80, horizon_days=5)
        calm = vol_scaled_stop_pct(5.0, spot=100.0, delta=0.5, sigma=0.15, horizon_days=5)
        assert wild > calm

    def test_clamped_to_the_documented_band(self) -> None:
        extreme = vol_scaled_stop_pct(0.5, spot=500.0, delta=0.9, sigma=1.5, horizon_days=5)
        assert extreme == MAX_STOP_PCT
        sleepy = vol_scaled_stop_pct(50.0, spot=100.0, delta=0.9, sigma=0.04, horizon_days=5)
        assert sleepy == MIN_STOP_PCT

    def test_missing_inputs_degrade_to_the_flat_default_not_no_stop(self) -> None:
        assert vol_scaled_stop_pct(5.0, None, 0.5, 0.3, 5) == DEFAULT_STOP_LOSS_PCT
        assert vol_scaled_stop_pct(5.0, 100.0, None, 0.3, 5) == DEFAULT_STOP_LOSS_PCT
        assert vol_scaled_stop_pct(5.0, 100.0, 0.5, None, 5) == DEFAULT_STOP_LOSS_PCT

    def test_deep_itm_low_elasticity_gets_a_tighter_stop(self) -> None:
        # A deep-ITM call (delta ~0.95, big premium) moves like stock —
        # small relative vol — so its stop sits near the floor, where a
        # cheap OTM lottery ticket's sits near the cap.
        itm = vol_scaled_stop_pct(60.0, spot=450.0, delta=0.95, sigma=0.35, horizon_days=5)
        otm = vol_scaled_stop_pct(1.2, spot=450.0, delta=0.15, sigma=0.35, horizon_days=5)
        assert itm < otm


class TestBreakevenRatchet:
    def _target(self):
        return ExitTarget(
            target_exit_price=15.0, stop_loss_price=5.0,
            target_exit_date="2026-12-01", reason="",
        )

    def test_halfway_to_target_raises_the_stop_to_entry(self) -> None:
        # entry 10, target 15 -> armed at 12.5. At 12.6 the stop becomes
        # entry: the trade can now end flat but never give back a gain.
        d = evaluate_exit(12.6, dte=40, target=self._target(), entry_price=10.0)
        assert d.new_stop_loss_price == pytest.approx(10.0)

    def test_below_halfway_the_original_stop_stands(self) -> None:
        d = evaluate_exit(12.0, dte=40, target=self._target(), entry_price=10.0)
        assert d.new_stop_loss_price is None

    def test_the_trail_wins_once_it_exceeds_breakeven(self) -> None:
        # At 20 the 30% trail (14.0) is above entry (10.0) — the higher
        # ratchet governs.
        d = evaluate_exit(20.0, dte=40, target=self._target(), entry_price=10.0)
        assert d.new_stop_loss_price == pytest.approx(14.0)


class TestHorizonReentryBar:
    def _target(self):
        return ExitTarget(
            target_exit_price=15.0, stop_loss_price=5.0,
            target_exit_date="2026-08-20", reason="",
        )

    def test_positive_but_below_bar_ev_exits_at_the_horizon(self) -> None:
        # The professional test is "would I put this on today", not "is
        # EV above zero": +30 EV against a 100 re-entry bar is a position
        # the model would not open, so past the horizon it goes.
        d = evaluate_exit(10.0, dte=40, target=self._target(),
                          current_ev=30.0, today="2026-08-24", horizon_ev_floor=100.0)
        assert d.action == "exit_now"
        assert d.triggered_by == "thesis_expired"

    def test_above_bar_ev_still_extends(self) -> None:
        d = evaluate_exit(10.0, dte=40, target=self._target(),
                          current_ev=150.0, today="2026-08-24", horizon_ev_floor=100.0)
        assert d.triggered_by == "target_extended"

    def test_zero_floor_reproduces_the_old_sign_test(self) -> None:
        d = evaluate_exit(10.0, dte=40, target=self._target(),
                          current_ev=30.0, today="2026-08-24")
        assert d.triggered_by == "target_extended"


class TestScaleOut:
    """At the target: bank half, trail the rest. quantity < initial_quantity
    is the durable already-scaled fact, so a restart can never bank the
    same half twice."""

    def _target(self):
        return ExitTarget(
            target_exit_price=15.0, stop_loss_price=5.0,
            target_exit_date="2026-12-01", reason="",
        )

    def test_first_touch_of_the_target_banks_half(self) -> None:
        d = evaluate_exit(15.5, dte=40, target=self._target(),
                          quantity=8, initial_quantity=8)
        assert d.action == "reduce"
        assert d.triggered_by == "scale_out"
        assert d.reduce_contracts == 4

    def test_an_already_scaled_position_trails_instead(self) -> None:
        d = evaluate_exit(15.5, dte=40, target=self._target(),
                          quantity=4, initial_quantity=8)
        assert d.action == "hold"
        assert d.triggered_by == "trail_raised"

    def test_a_one_lot_cannot_split_and_trails_as_before(self) -> None:
        d = evaluate_exit(15.5, dte=40, target=self._target(),
                          quantity=1, initial_quantity=1)
        assert d.action == "hold"
        assert d.triggered_by == "trail_raised"

    def test_odd_lots_bank_the_floor_half(self) -> None:
        d = evaluate_exit(15.5, dte=40, target=self._target(),
                          quantity=7, initial_quantity=7)
        assert d.reduce_contracts == 3

    def test_the_raised_stop_travels_with_the_reduction(self) -> None:
        d = evaluate_exit(20.0, dte=40, target=self._target(),
                          quantity=8, initial_quantity=8, entry_price=10.0)
        assert d.action == "reduce"
        assert d.new_stop_loss_price == pytest.approx(14.0)

    def test_the_stop_and_dte_floor_still_outrank_the_scale_out(self) -> None:
        below_stop = evaluate_exit(4.0, dte=40, target=self._target(),
                                   quantity=8, initial_quantity=8)
        assert below_stop.triggered_by == "stop_loss"
        expiring = evaluate_exit(15.5, dte=2, target=self._target(),
                                 quantity=8, initial_quantity=8)
        assert expiring.triggered_by == "dte_floor"

    def test_missing_quantity_keeps_the_old_all_or_nothing_path(self) -> None:
        d = evaluate_exit(15.5, dte=40, target=self._target())
        assert d.action == "hold"
        assert d.triggered_by == "trail_raised"
