"""Economic invariants — what numbers are ALLOWED TO MEAN, swept across
the input space rather than checked at hand-picked examples. Each rule
here is one this week's incidents proved a green unit-test suite does
not enforce on its own. A failure is never a stale test; it is a rule
that stopped meaning what it says."""

import math

import pytest

from app.pricing import bsm_price
from app.rank import (
    MAX_ANNUALIZED_DRIFT,
    MAX_POSITION_FRACTION,
    RankedContract,
    _annualize_horizon_return,
    forecast_value,
    horizon_value_and_prob,
    select_entries,
)
from app.regime import REGIME_EXPOSURE
from app.sizing import SIZE_CLAMP, equal_risk_capital

DRIFTS = [-0.9, -0.3, 0.0, 0.04, 0.3, 0.9]
VOLS = [0.1, 0.3, 0.6, 1.2]
SHAPES = [(100.0, 80.0), (100.0, 100.0), (100.0, 130.0), (1188.0, 1380.0)]


class TestValuationInvariants:
    def test_no_probability_ever_reaches_certainty(self):
        for drift in DRIFTS:
            for vol in VOLS:
                for spot, strike in SHAPES:
                    out = horizon_value_and_prob(
                        spot, strike, 60 / 365, 7 / 365, drift, 0.04, 0.0, vol, True, 5.0
                    )
                    if out is not None:
                        assert 0.0 <= out[1] <= 0.995

    def test_horizon_value_never_exceeds_terminal_extrapolation_under_positive_drift(self):
        # Booking less edge than the full-life extrapolation is the whole
        # point; if this flips, the humility is gone.
        for vol in VOLS:
            for spot, strike in SHAPES:
                terminal = forecast_value(spot, strike, 60 / 365, 0.9, 0.04, 0.0, vol, True)
                out = horizon_value_and_prob(
                    spot, strike, 60 / 365, 7 / 365, 0.9, 0.04, 0.0, vol, True, 5.0
                )
                assert out is not None
                assert out[0] <= terminal * (1 + 1e-9)

    def test_the_martingale_identity_holds_everywhere(self):
        # drift = r must reproduce today's price: the valuation may not
        # manufacture value out of no view.
        for vol in VOLS:
            for spot, strike in SHAPES:
                out = horizon_value_and_prob(
                    spot, strike, 60 / 365, 7 / 365, 0.04, 0.04, 0.0, vol, True, 5.0
                )
                want = bsm_price(spot, strike, 60 / 365, 0.04, 0.0, vol, True)
                assert out is not None
                assert out[0] == pytest.approx(want, rel=1e-5)

    def test_annualized_drift_is_always_bounded(self):
        for pred in [-0.99, -0.5, -0.1, 0.0, 0.1, 0.5, 3.0, 100.0]:
            assert abs(_annualize_horizon_return(pred, 5)) <= MAX_ANNUALIZED_DRIFT


def _contract(sym: str, price: float) -> RankedContract:
    return RankedContract(
        occ_symbol=f"{sym:<6}261016C00100000", underlying=sym, expiry="2026-10-16",
        type="call", strike=100.0, dte=48, market_price=price, market_iv=0.3,
        forecast_vol=0.3, forecast_drift=0.3, forecast_value=price * 1.2,
        ev=price * 10, ev_per_risk=0.1, prob_profit=0.6, spot=100.0, delta=0.5,
    )


class TestPortfolioInvariants:
    def test_selection_never_spends_more_than_the_available_capital(self):
        for capital in [500.0, 5_000.0, 50_000.0]:
            selected, _ = select_entries(
                [_contract(s, p) for s, p in [("AAA", 2.0), ("BBB", 8.0), ("CCC", 30.0)]],
                held_underlyings=set(), available_capital=capital,
                open_position_count=0, max_concurrent_positions=10,
                max_new_positions=5, opened_today=0, min_ev_per_risk=0.05,
                min_prob_profit=0.5, min_dte=7, max_dte=90,
            )
            assert sum(s.cost for s in selected) <= capital

    def test_no_position_beyond_one_contract_exceeds_the_concentration_cap(self):
        for capital in [5_000.0, 50_000.0, 200_000.0]:
            selected, _ = select_entries(
                [_contract(s, p) for s, p in [("AAA", 2.0), ("BBB", 8.0), ("CCC", 30.0)]],
                held_underlyings=set(), available_capital=capital,
                open_position_count=8, max_concurrent_positions=10,
                max_new_positions=5, opened_today=0, min_ev_per_risk=0.05,
                min_prob_profit=0.5, min_dte=7, max_dte=90,
            )
            for s in selected:
                if s.quantity > 1:
                    assert s.cost <= capital * MAX_POSITION_FRACTION + 1e-9

    def test_equal_risk_sizing_is_a_tilt_never_a_lever(self):
        book, slots = 200_000_0000, 8
        slice_e4 = book / slots
        for stop in [0.01, 0.05, 0.12, 0.15, 0.2, 0.3, 0.6]:
            got = equal_risk_capital(book, slots, [{"symbol": "X", "stop_pct": stop}])["X"]
            assert SIZE_CLAMP[0] * slice_e4 - 1 <= got <= SIZE_CLAMP[1] * slice_e4 + 1

    def test_every_regime_exposure_is_a_fraction_of_full_never_more(self):
        for exposure in REGIME_EXPOSURE.values():
            assert 0.0 < exposure <= 1.0
