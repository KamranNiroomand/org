"""The horizon-consistent valuation's contract: exact under the
martingale check, strictly humbler than terminal extrapolation on
long-DTE contracts, honest fallbacks at the edges, and no certainty
claims — ever."""

import math

import pytest

from app.pricing import bsm_price
from app.rank import forecast_value, horizon_value_and_prob

SPOT, STRIKE, RATE, VOL = 1188.0, 1380.0, 0.04, 0.35
YEARS = 52 / 365
H = 5 * 1.4 / 365


def test_drift_equal_to_rate_reproduces_the_market_price():
    # Under drift = r the horizon expectation must equal today's BSM
    # price exactly (martingale property) — this is the check that the
    # quadrature is right, not roughly right.
    got, _ = horizon_value_and_prob(SPOT, STRIKE, YEARS, H, RATE, RATE, 0.0, VOL, True, 24.50)
    want = bsm_price(SPOT, STRIKE, YEARS, RATE, 0.0, VOL, True)
    assert got == pytest.approx(want, rel=1e-6)


def test_horizon_valuation_is_humbler_than_terminal_extrapolation():
    # The GWW shape: strong drift, long DTE, OTM call. Terminal valuation
    # compounds the edge over the whole life; horizon valuation books it
    # only over the model's own horizon.
    terminal = forecast_value(SPOT, STRIKE, YEARS, 0.9, RATE, 0.0, VOL, True)
    horizon, _ = horizon_value_and_prob(SPOT, STRIKE, YEARS, H, 0.9, RATE, 0.0, VOL, True, 24.50)
    assert horizon < terminal * 0.5


def test_a_positive_drift_is_still_worth_something():
    flat, _ = horizon_value_and_prob(SPOT, STRIKE, YEARS, H, RATE, RATE, 0.0, VOL, True, 24.50)
    bull, _ = horizon_value_and_prob(SPOT, STRIKE, YEARS, H, 0.9, RATE, 0.0, VOL, True, 24.50)
    assert bull > flat


def test_probability_never_reaches_certainty():
    # A near-zero-vol, deep-ITM shape — the COST P(profit)=100% incident.
    _, prob = horizon_value_and_prob(200.0, 100.0, YEARS, H, 0.9, RATE, 0.0, 0.08, True, 1.0)
    assert prob <= 0.995


def test_falls_back_when_the_horizon_swallows_the_contract():
    # 3 calendar days to expiry, 7-day horizon: nothing left to hold
    # after the horizon — terminal valuation is the honest one, and the
    # function abstains rather than integrating an empty remainder.
    assert horizon_value_and_prob(SPOT, STRIKE, 3 / 365, H, 0.9, RATE, 0.0, VOL, True, 5.0) is None


def test_falls_back_on_degenerate_vol():
    assert horizon_value_and_prob(SPOT, STRIKE, YEARS, H, 0.9, RATE, 0.0, 0.0, True, 5.0) is None


class TestPositionCap:
    def test_no_single_position_exceeds_a_quarter_of_investable_cash(self):
        from app.rank import MAX_POSITION_FRACTION, RankedContract, select_entries

        c = RankedContract(
            occ_symbol="GWW   261016C01380000", underlying="GWW", expiry="2026-10-16",
            type="call", strike=1380.0, dte=48, market_price=24.50, market_iv=0.4,
            forecast_vol=0.4, forecast_drift=0.5, forecast_value=30.0, ev=550.0,
            ev_per_risk=0.22, prob_profit=0.6, spot=1188.0, delta=0.3,
        )
        selected, _ = select_entries(
            [c], held_underlyings=set(), available_capital=100_000.0,
            open_position_count=9, max_concurrent_positions=10,
            max_new_positions=3, opened_today=0, min_ev_per_risk=0.05,
            min_prob_profit=0.5, min_dte=7, max_dte=90,
        )
        # One slot left, 100k cash: the old per-slot budget would buy 40
        # contracts. The cap holds it to a quarter of the pool.
        assert len(selected) == 1
        assert selected[0].cost <= 100_000.0 * MAX_POSITION_FRACTION

    def test_one_contract_is_always_allowed_even_above_the_cap(self):
        from app.rank import RankedContract, select_entries

        c = RankedContract(
            occ_symbol="BRK   261016C00700000", underlying="BRK", expiry="2026-10-16",
            type="call", strike=700.0, dte=48, market_price=300.0, market_iv=0.2,
            forecast_vol=0.2, forecast_drift=0.2, forecast_value=310.0, ev=800.0,
            ev_per_risk=0.06, prob_profit=0.6, spot=740.0, delta=0.6,
        )
        selected, _ = select_entries(
            [c], held_underlyings=set(), available_capital=40_000.0,
            open_position_count=0, max_concurrent_positions=10,
            max_new_positions=3, opened_today=0, min_ev_per_risk=0.05,
            min_prob_profit=0.5, min_dte=7, max_dte=90,
        )
        # $30k contract, 25% cap = $10k — but a minimum position of one
        # contract still opens; the cap bounds concentration, not entry.
        assert len(selected) == 1
        assert selected[0].quantity == 1
