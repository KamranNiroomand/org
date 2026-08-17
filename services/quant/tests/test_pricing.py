"""Pricing tests.

Three layers, in increasing order of how much they would hurt to get wrong:

1. Internal consistency — parity, monotonicity, round-trips.
2. Analytic greeks against finite differences of our own prices.
3. Our closed forms against an independent slow reference: a 500-step
   binomial tree for American exercise, and a real broker's published chain
   for the whole stack at once.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from app.pricing import (
    MAX_VOL,
    american_price,
    binomial_american_price,
    bivariate_norm_cdf,
    bsm_greeks,
    bsm_price,
    implied_vol,
    intrinsic,
    norm_cdf,
)

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "options"
NVDA = json.loads((FIXTURES / "nvda-chain.json").read_text())

YEARS_2D = 2 / 365


# ---------------------------------------------------------------------------
# Golden test — a real broker's chain
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("row", NVDA["rows"], ids=lambda r: f"K{r['strike']}")
def test_reproduces_broker_greeks(row: dict) -> None:
    """Our greeks must match a broker's on genuinely liquid contracts.

    Evaluated at the broker's own stated implied vol, so this isolates the
    greeks from the vol solver — if both were free the test could pass with
    two compensating errors.
    """
    spot = NVDA["spot"]
    rate = NVDA["assumedRate"]
    q = NVDA["assumedDividendYield"]
    g = bsm_greeks(spot, row["strike"], YEARS_2D, rate, q, row["iv"], True)

    assert g.delta == pytest.approx(row["delta"], abs=0.01)
    assert g.gamma == pytest.approx(row["gamma"], abs=0.005)
    # Broker display units: vega per vol point, theta per calendar day.
    assert g.vega / 100.0 == pytest.approx(row["vega"], abs=0.002)
    assert g.theta / 365.0 == pytest.approx(row["theta"], abs=0.02)


def _iv(price: float, strike: float) -> float | None:
    return implied_vol(
        price,
        NVDA["spot"],
        strike,
        YEARS_2D,
        NVDA["assumedRate"],
        NVDA["assumedDividendYield"],
        True,
        american=True,
    )


@pytest.mark.parametrize("row", NVDA["rows"], ids=lambda r: f"K{r['strike']}")
def test_broker_implied_vol_lies_inside_the_bid_ask_band(row: dict) -> None:
    """The broker's implied vol must fall between the vol of its own bid and ask.

    This, not closeness to the mid, is the honest assertion. Implied vol is
    only ever as precise as the spread that produced it: the $220 row is
    quoted $5.55 / $5.80, and that quarter of a dollar spans 31.57% to 37.28%
    — nearly six vol points. Demanding our mid-derived vol land within one
    point of the broker's would be asserting a precision the market never
    provided, and it would fail for reasons that say nothing about the solver.
    """
    iv_bid = _iv(row["bid"], row["strike"])
    iv_ask = _iv(row["ask"], row["strike"])
    assert iv_bid is not None and iv_ask is not None
    # Half a vol point of slack on each edge. The broker's rate, dividend
    # assumption and exact spot at quote time are not ours, and measured
    # against this chain those choices move implied vol by at most 0.48 of a
    # point — well under the spread, and straddling zero rather than leaning
    # one way, which is what rules out a systematic error on our side.
    slack = 0.005
    assert iv_bid - slack <= row["iv"] <= iv_ask + slack


@pytest.mark.parametrize("row", NVDA["rows"], ids=lambda r: f"K{r['strike']}")
def test_our_implied_vol_lies_inside_the_bid_ask_band(row: dict) -> None:
    """And so must ours — the band is the whole of what the quote determines."""
    mid = (row["bid"] + row["ask"]) / 2.0
    iv_mid = _iv(mid, row["strike"])
    iv_bid = _iv(row["bid"], row["strike"])
    iv_ask = _iv(row["ask"], row["strike"])
    assert iv_mid is not None and iv_bid is not None and iv_ask is not None
    assert iv_bid <= iv_mid <= iv_ask


def test_tight_spreads_pin_implied_vol_closely() -> None:
    """Where the market *is* precise, we must be too.

    The $227.50 row is quoted a penny wide either side of a $1.12 mid, which
    leaves almost no room for interpretation — so here an absolute tolerance
    is a fair test, and one vol point is a real constraint rather than a
    generous one.
    """
    row = next(r for r in NVDA["rows"] if r["strike"] == 227.5)
    iv = _iv((row["bid"] + row["ask"]) / 2.0, row["strike"])
    assert iv is not None
    assert iv == pytest.approx(row["iv"], abs=0.01)


def test_chain_shows_a_volatility_smile() -> None:
    """Sanity on the fixture itself: wings price above the money.

    If this ever fails, the fixture was transcribed wrong — a flat or
    inverted smile at two days to expiry on a name like this would be the
    anomaly, not the baseline.
    """
    by_strike = {r["strike"]: r["iv"] for r in NVDA["rows"]}
    assert by_strike[235.0] > by_strike[227.5]
    assert by_strike[220.0] > by_strike[227.5]


# ---------------------------------------------------------------------------
# Internal consistency
# ---------------------------------------------------------------------------


def test_put_call_parity() -> None:
    s, k, t, r, q, v = 225.05, 227.5, 0.5, 0.0425, 0.01, 0.32
    call = bsm_price(s, k, t, r, q, v, True)
    put = bsm_price(s, k, t, r, q, v, False)
    lhs = call - put
    rhs = s * math.exp(-q * t) - k * math.exp(-r * t)
    assert lhs == pytest.approx(rhs, abs=1e-10)


def test_price_is_monotone_in_vol() -> None:
    prev = -1.0
    for vol in (0.05, 0.1, 0.2, 0.4, 0.8, 1.6):
        p = bsm_price(225.05, 227.5, 0.25, 0.0425, 0.0, vol, True)
        assert p > prev
        prev = p


def test_price_collapses_to_intrinsic_at_expiry() -> None:
    assert bsm_price(230.0, 227.5, 0.0, 0.0425, 0.0, 0.3, True) == pytest.approx(2.5)
    assert bsm_price(225.0, 227.5, 0.0, 0.0425, 0.0, 0.3, True) == 0.0
    assert bsm_price(225.0, 227.5, 0.0, 0.0425, 0.0, 0.3, False) == pytest.approx(2.5)


@pytest.mark.parametrize("is_call", [True, False])
@pytest.mark.parametrize("strike", [200.0, 225.0, 250.0])
def test_implied_vol_round_trips(is_call: bool, strike: float) -> None:
    truth = 0.42
    price = american_price(225.05, strike, 0.25, 0.0425, 0.015, truth, is_call)
    solved = implied_vol(price, 225.05, strike, 0.25, 0.0425, 0.015, is_call, american=True)
    assert solved is not None
    assert solved == pytest.approx(truth, abs=1e-4)


# ---------------------------------------------------------------------------
# Greeks against finite differences
# ---------------------------------------------------------------------------


def test_greeks_match_finite_differences() -> None:
    s, k, t, r, q, v = 225.05, 227.5, 0.25, 0.0425, 0.01, 0.32
    g = bsm_greeks(s, k, t, r, q, v, True)

    h = 1e-4
    up = bsm_price(s + h, k, t, r, q, v, True)
    down = bsm_price(s - h, k, t, r, q, v, True)
    mid = bsm_price(s, k, t, r, q, v, True)

    assert g.delta == pytest.approx((up - down) / (2 * h), abs=1e-6)
    assert g.gamma == pytest.approx((up - 2 * mid + down) / (h * h), abs=1e-4)

    hv = 1e-6
    dv = (
        bsm_price(s, k, t, r, q, v + hv, True) - bsm_price(s, k, t, r, q, v - hv, True)
    ) / (2 * hv)
    assert g.vega == pytest.approx(dv, abs=1e-4)

    ht = 1e-6
    # Theta is the derivative with respect to calendar time, which runs
    # opposite to time-to-expiry — hence the sign flip.
    dt = (
        bsm_price(s, k, t + ht, r, q, v, True) - bsm_price(s, k, t - ht, r, q, v, True)
    ) / (2 * ht)
    assert g.theta == pytest.approx(-dt, abs=1e-3)


# ---------------------------------------------------------------------------
# American exercise against the binomial oracle
# ---------------------------------------------------------------------------


def test_american_call_without_dividend_is_exactly_european() -> None:
    """Not an approximation — early exercise of such a call is never optimal."""
    for strike in (200.0, 225.0, 250.0):
        a = american_price(225.05, strike, 0.5, 0.0425, 0.0, 0.35, True)
        e = bsm_price(225.05, strike, 0.5, 0.0425, 0.0, 0.35, True)
        assert a == pytest.approx(e, abs=1e-10)


@pytest.mark.parametrize("is_call", [True, False])
@pytest.mark.parametrize("strike", [190.0, 210.0, 225.0, 240.0, 260.0])
@pytest.mark.parametrize("years", [0.08, 0.5, 1.5])
def test_american_matches_binomial(is_call: bool, strike: float, years: float) -> None:
    """Bjerksund-Stensland against 500 steps of Cox-Ross-Rubinstein.

    A dividend yield of 3% is used deliberately: with no dividend the call
    branch is exact by identity and the test proves nothing about the
    approximation itself.
    """
    spot, rate, q, vol = 225.05, 0.0425, 0.03, 0.35
    approx = american_price(spot, strike, years, rate, q, vol, is_call)
    exact = binomial_american_price(spot, strike, years, rate, q, vol, is_call, steps=500)

    # Bjerksund-Stensland is a lower bound on the true American value, and the
    # binomial converges from below too. Half a cent on a ~$225 underlying is
    # far inside the one-cent tick these contracts actually quote in.
    assert approx == pytest.approx(exact, abs=0.005 * max(1.0, exact))


@pytest.mark.parametrize("strike", [210.0, 225.0, 240.0])
def test_american_put_is_worth_at_least_european(strike: float) -> None:
    a = american_price(225.05, strike, 1.0, 0.0425, 0.0, 0.35, False)
    e = bsm_price(225.05, strike, 1.0, 0.0425, 0.0, 0.35, False)
    assert a >= e - 1e-9


@pytest.mark.parametrize("strike", [210.0, 225.0, 240.0])
def test_american_never_worth_less_than_intrinsic(strike: float) -> None:
    for is_call in (True, False):
        p = american_price(225.05, strike, 0.25, 0.0425, 0.03, 0.35, is_call)
        assert p >= intrinsic(225.05, strike, is_call) - 1e-9


# ---------------------------------------------------------------------------
# The bivariate normal, which only the American path exercises
# ---------------------------------------------------------------------------


def test_bivariate_normal_degenerates_correctly() -> None:
    # Independent: the joint is the product of the marginals.
    for a in (-2.0, -0.5, 0.0, 0.5, 2.0):
        for b in (-2.0, -0.5, 0.0, 0.5, 2.0):
            assert bivariate_norm_cdf(a, b, 0.0) == pytest.approx(
                norm_cdf(a) * norm_cdf(b), abs=1e-6
            )
    # Perfectly correlated: the joint is the smaller marginal.
    assert bivariate_norm_cdf(-0.5, 1.0, 1.0) == pytest.approx(norm_cdf(-0.5), abs=1e-9)


def test_bivariate_normal_stays_a_probability() -> None:
    for rho in (-0.9, -0.4, 0.0, 0.4, 0.9):
        for a in (-3.0, -1.0, 0.0, 1.0, 3.0):
            for b in (-3.0, -1.0, 0.0, 1.0, 3.0):
                v = bivariate_norm_cdf(a, b, rho)
                assert -1e-9 <= v <= 1.0 + 1e-9
                assert v <= min(norm_cdf(a), norm_cdf(b)) + 1e-6


# ---------------------------------------------------------------------------
# The refusals — the whole reason this module computes its own IV
# ---------------------------------------------------------------------------


def test_implied_vol_refuses_the_penny_quote() -> None:
    """The real $390 NVDA call: $0.00 / $0.01, and a vendor-printed 435.84%.

    A decade of volatility reprices this contract to the same penny, so there
    is no implied vol to report. A number here would become a feature.
    """
    iv = implied_vol(0.005, 225.05, 390.0, YEARS_2D, 0.0425, 0.0, True, american=True)
    assert iv is None


def test_implied_vol_refuses_prices_outside_no_arbitrage_bounds() -> None:
    s, k, t, r = 225.05, 207.5, YEARS_2D, 0.0425
    # The real $207.50 row bid $15.05 against $17.55 of intrinsic value.
    assert implied_vol(15.05, s, k, t, r, 0.0, True, american=True) is None
    # Above the ceiling: a call cannot be worth more than the stock.
    assert implied_vol(s + 1.0, s, k, t, r, 0.0, True, american=True) is None


def test_implied_vol_refuses_degenerate_inputs() -> None:
    assert implied_vol(1.12, 225.05, 227.5, 0.0, 0.0425, 0.0, True) is None
    assert implied_vol(0.0, 225.05, 227.5, YEARS_2D, 0.0425, 0.0, True) is None
    assert implied_vol(-1.0, 225.05, 227.5, YEARS_2D, 0.0425, 0.0, True) is None
    assert implied_vol(float("nan"), 225.05, 227.5, YEARS_2D, 0.0425, 0.0, True) is None


def test_implied_vol_handles_the_extreme_but_solvable() -> None:
    """A genuinely high-vol contract must still solve rather than give up."""
    price = bsm_price(225.05, 300.0, 0.25, 0.0425, 0.0, 1.8, True)
    iv = implied_vol(price, 225.05, 300.0, 0.25, 0.0425, 0.0, True, american=False)
    assert iv is not None
    assert iv == pytest.approx(1.8, abs=1e-4)
    assert iv < MAX_VOL


def test_calendar_day_time_basis_is_the_one_the_chain_agrees_with() -> None:
    """Pins ``yearsToExpiry`` to calendar days over 365.

    Trading-day conventions (252) and intraday-fraction conventions are both
    defensible in the abstract, so this is settled empirically instead: solve
    every liquid row under several assumed maturities and see which reproduces
    the broker's published implied vols. Two calendar days wins by an order of
    magnitude — about 3 vol points of total disagreement across six strikes,
    against 24 or more for anything else.

    The test exists because switching this convention later would look like a
    harmless cleanup while silently biasing every implied vol in the corpus,
    and a bias applied to history but not to live data teaches the model a
    regime change that never happened.
    """
    def total_gap(days: float) -> float:
        gap = 0.0
        for row in NVDA["rows"]:
            mid = (row["bid"] + row["ask"]) / 2.0
            iv = implied_vol(
                mid,
                NVDA["spot"],
                row["strike"],
                days / 365,
                NVDA["assumedRate"],
                NVDA["assumedDividendYield"],
                True,
                american=True,
            )
            assert iv is not None
            gap += abs(row["iv"] - iv)
        return gap

    best = total_gap(2.0)
    assert best < 0.05  # under 5 vol points summed over six strikes
    for alternative in (1.5, 2.5, 3.0):
        assert total_gap(alternative) > 3 * best
