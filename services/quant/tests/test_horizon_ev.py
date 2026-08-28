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
