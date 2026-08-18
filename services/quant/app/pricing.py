"""Option pricing, greeks, and implied volatility.

Every number downstream of this module — every feature, every label, every
ranked candidate — is derived from it, so it is written to be checkable rather
than clever. A slow, obviously-correct binomial tree is included purely as a
test oracle for the fast closed forms.

Two conventions, stated once:

* **Vol, rates and yields are decimals per annum.** 31.60% is ``0.316``.
* **Prices are floats in dollars.** The E4 integer representation belongs to
  the database and to the TypeScript side; converting at this boundary keeps
  the numerics readable and avoids scaling bugs inside the solver.

We compute implied volatility ourselves rather than taking a vendor's field.
Two reasons. Historical and live rows then come from one model and stay
comparable, which matters because a feature that shifts meaning mid-sample
teaches the model a regime change that never happened. And a vendor prints a
number even when there isn't one: the real NVDA chain quoted a $390 call at
$0.00/$0.01 and reported 435.84% implied vol, when in truth *any* vol between
roughly 100% and 900% reprices that contract to a penny. Here that returns
``None``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

_SQRT_2 = math.sqrt(2.0)
_SQRT_2PI = math.sqrt(2.0 * math.pi)
_INV_SQRT_2PI = 1.0 / _SQRT_2PI

# Below this, time or volatility is treated as zero and the option is worth its
# intrinsic value. Chosen well under a single trading day (1/365 = 2.7e-3).
_EPS = 1e-12


def years_to_expiry(expiry: str, as_of_day: str) -> float:
    """Calendar days over 365, from `as_of_day` to `expiry` (both YYYY-MM-DD).

    Mirrors `yearsToExpiry` in `@org/shared`'s `options.ts` exactly — same
    convention, same reasoning, kept as one decision rather than two
    languages independently guessing the same rule. That convention was
    settled empirically, not assumed: solving a real broker's chain under
    competing time bases, calendar-days-over-365 matched published implied
    vols within about 3 vol points total across six strikes, while every
    trading-day alternative disagreed by 24 or more. See
    `test_pricing.py::test_calendar_day_time_basis_is_the_one_the_chain_agrees_with`.
    """
    from datetime import date

    y, m, d = (int(x) for x in expiry.split("-"))
    ay, am, ad = (int(x) for x in as_of_day[:10].split("-"))
    days = (date(y, m, d) - date(ay, am, ad)).days
    return days / 365.0


def norm_cdf(x: float) -> float:
    """Standard normal CDF.

    Uses ``erfc`` rather than ``0.5 * (1 + erf(x / sqrt(2)))`` because the
    latter loses all significant digits in the far left tail — exactly where
    deep out-of-the-money contracts live.
    """
    return 0.5 * math.erfc(-x / _SQRT_2)


def norm_pdf(x: float) -> float:
    return _INV_SQRT_2PI * math.exp(-0.5 * x * x)


@dataclass(frozen=True)
class Greeks:
    """First- and second-order sensitivities.

    Raw analytic units, not broker display units: ``vega`` is per 1.00 of
    volatility and ``theta`` is per year. Brokers divide both — vega by 100 to
    get "per vol point", theta by 365 to get "per day". Storing the raw values
    keeps the scaling decision at the display edge instead of baking a
    convention into the database.
    """

    delta: float
    gamma: float
    vega: float
    theta: float
    rho: float


def _d1_d2(
    spot: float, strike: float, years: float, rate: float, div_yield: float, vol: float
) -> tuple[float, float]:
    vt = vol * math.sqrt(years)
    d1 = (math.log(spot / strike) + (rate - div_yield + 0.5 * vol * vol) * years) / vt
    return d1, d1 - vt


def intrinsic(spot: float, strike: float, is_call: bool) -> float:
    return max(0.0, spot - strike) if is_call else max(0.0, strike - spot)


def bsm_price(
    spot: float,
    strike: float,
    years: float,
    rate: float,
    div_yield: float,
    vol: float,
    is_call: bool,
) -> float:
    """Black-Scholes-Merton European price with a continuous dividend yield."""
    if spot <= 0.0 or strike <= 0.0:
        raise ValueError(f"spot and strike must be positive, got {spot=} {strike=}")
    if years <= _EPS or vol <= _EPS:
        # At expiry, or with no uncertainty, the option is worth intrinsic.
        return intrinsic(spot, strike, is_call)

    d1, d2 = _d1_d2(spot, strike, years, rate, div_yield, vol)
    df_r = math.exp(-rate * years)
    df_q = math.exp(-div_yield * years)

    if is_call:
        return spot * df_q * norm_cdf(d1) - strike * df_r * norm_cdf(d2)
    return strike * df_r * norm_cdf(-d2) - spot * df_q * norm_cdf(-d1)


def bsm_greeks(
    spot: float,
    strike: float,
    years: float,
    rate: float,
    div_yield: float,
    vol: float,
    is_call: bool,
) -> Greeks:
    """Analytic European greeks."""
    if years <= _EPS or vol <= _EPS:
        # Degenerate but not undefined: delta is a step function at the strike,
        # everything else vanishes. Returning zeros here rather than raising
        # keeps expiry-day rows in the pipeline, where the gate can drop them.
        itm = intrinsic(spot, strike, is_call) > 0.0
        return Greeks(
            delta=(1.0 if is_call else -1.0) if itm else 0.0,
            gamma=0.0,
            vega=0.0,
            theta=0.0,
            rho=0.0,
        )

    d1, d2 = _d1_d2(spot, strike, years, rate, div_yield, vol)
    sqrt_t = math.sqrt(years)
    df_r = math.exp(-rate * years)
    df_q = math.exp(-div_yield * years)
    pdf_d1 = norm_pdf(d1)

    gamma = df_q * pdf_d1 / (spot * vol * sqrt_t)
    vega = spot * df_q * pdf_d1 * sqrt_t
    carry_term = -spot * df_q * pdf_d1 * vol / (2.0 * sqrt_t)

    if is_call:
        delta = df_q * norm_cdf(d1)
        theta = (
            carry_term
            - rate * strike * df_r * norm_cdf(d2)
            + div_yield * spot * df_q * norm_cdf(d1)
        )
        rho = strike * years * df_r * norm_cdf(d2)
    else:
        delta = -df_q * norm_cdf(-d1)
        theta = (
            carry_term
            + rate * strike * df_r * norm_cdf(-d2)
            - div_yield * spot * df_q * norm_cdf(-d1)
        )
        rho = -strike * years * df_r * norm_cdf(-d2)

    return Greeks(delta=delta, gamma=gamma, vega=vega, theta=theta, rho=rho)


# ---------------------------------------------------------------------------
# American exercise
# ---------------------------------------------------------------------------


def _sign(x: float) -> float:
    return math.copysign(1.0, x) if x != 0.0 else 0.0


def bivariate_norm_cdf(a: float, b: float, rho: float) -> float:
    """Standard bivariate normal CDF, Drezner-Wesolowsky quadrature.

    Needed only by the Bjerksund-Stensland two-boundary approximation. Split
    into quadrants because the quadrature below is only valid for
    ``a <= 0, b <= 0, rho <= 0``; the other cases reduce to it by reflection.
    """
    if rho >= 1.0:
        return norm_cdf(min(a, b))
    if rho <= -1.0:
        return max(0.0, norm_cdf(a) + norm_cdf(b) - 1.0)

    if a <= 0.0 and b <= 0.0 and rho <= 0.0:
        weights = (0.24840615, 0.39233107, 0.21141819, 0.033246660, 0.00082485334)
        nodes = (0.10024215, 0.48281397, 1.0609498, 1.7797294, 2.6697604)
        denom = math.sqrt(2.0 * (1.0 - rho * rho))
        a1 = a / denom
        b1 = b / denom
        total = 0.0
        for wi, yi in zip(weights, nodes):
            for wj, yj in zip(weights, nodes):
                total += (
                    wi
                    * wj
                    * math.exp(
                        a1 * (2.0 * yi - a1)
                        + b1 * (2.0 * yj - b1)
                        + 2.0 * rho * (yi - a1) * (yj - b1)
                    )
                )
        return math.sqrt(1.0 - rho * rho) / math.pi * total

    if a <= 0.0 <= b and rho >= 0.0:
        return norm_cdf(a) - bivariate_norm_cdf(a, -b, -rho)
    if b <= 0.0 <= a and rho >= 0.0:
        return norm_cdf(b) - bivariate_norm_cdf(-a, b, -rho)
    if a >= 0.0 and b >= 0.0 and rho <= 0.0:
        return norm_cdf(a) + norm_cdf(b) - 1.0 + bivariate_norm_cdf(-a, -b, rho)

    # Remaining case: a * b * rho > 0.
    denom = math.sqrt(a * a - 2.0 * rho * a * b + b * b)
    if denom <= _EPS:
        return max(0.0, min(1.0, norm_cdf(min(a, b))))
    rho1 = (rho * a - b) * _sign(a) / denom
    rho2 = (rho * b - a) * _sign(b) / denom
    delta = (1.0 - _sign(a) * _sign(b)) / 4.0
    return bivariate_norm_cdf(a, 0.0, rho1) + bivariate_norm_cdf(b, 0.0, rho2) - delta


def _phi(
    spot: float, years: float, gamma: float, h: float, x: float, rate: float, carry: float, vol: float
) -> float:
    v2 = vol * vol
    vt = vol * math.sqrt(years)
    lam = (-rate + gamma * carry + 0.5 * gamma * (gamma - 1.0) * v2) * years
    kappa = 2.0 * carry / v2 + (2.0 * gamma - 1.0)
    d = -(math.log(spot / h) + (carry + (gamma - 0.5) * v2) * years) / vt
    d2 = d - 2.0 * math.log(x / spot) / vt
    return math.exp(lam) * spot**gamma * (norm_cdf(d) - (x / spot) ** kappa * norm_cdf(d2))


def _psi(
    spot: float,
    years: float,
    gamma: float,
    h: float,
    x2: float,
    x1: float,
    t1: float,
    rate: float,
    carry: float,
    vol: float,
) -> float:
    v2 = vol * vol
    vt1 = vol * math.sqrt(t1)
    vt = vol * math.sqrt(years)

    e1 = (math.log(spot / x1) + (carry + (gamma - 0.5) * v2) * t1) / vt1
    e2 = (math.log(x2 * x2 / (spot * x1)) + (carry + (gamma - 0.5) * v2) * t1) / vt1
    e3 = (math.log(spot / x1) - (carry + (gamma - 0.5) * v2) * t1) / vt1
    e4 = (math.log(x2 * x2 / (spot * x1)) - (carry + (gamma - 0.5) * v2) * t1) / vt1

    f1 = (math.log(spot / h) + (carry + (gamma - 0.5) * v2) * years) / vt
    f2 = (math.log(x2 * x2 / (spot * h)) + (carry + (gamma - 0.5) * v2) * years) / vt
    f3 = (math.log(x1 * x1 / (spot * h)) + (carry + (gamma - 0.5) * v2) * years) / vt
    f4 = (math.log(spot * x1 * x1 / (h * x2 * x2)) + (carry + (gamma - 0.5) * v2) * years) / vt

    rho = math.sqrt(t1 / years)
    lam = -rate + gamma * carry + 0.5 * gamma * (gamma - 1.0) * v2
    kappa = 2.0 * carry / v2 + (2.0 * gamma - 1.0)

    return math.exp(lam * years) * spot**gamma * (
        bivariate_norm_cdf(-e1, -f1, rho)
        - (x2 / spot) ** kappa * bivariate_norm_cdf(-e2, -f2, rho)
        - (x1 / spot) ** kappa * bivariate_norm_cdf(-e3, -f3, -rho)
        + (x1 / x2) ** kappa * bivariate_norm_cdf(-e4, -f4, -rho)
    )


def bjerksund_stensland_call(
    spot: float, strike: float, years: float, rate: float, carry: float, vol: float
) -> float:
    """American call, Bjerksund-Stensland (2002) two-boundary approximation.

    When ``carry >= rate`` (equivalently, a non-positive dividend yield) early
    exercise of a call is never optimal and the American price *is* the
    European one — not an approximation but an identity, which is why most of
    our universe takes that branch exactly.
    """
    if years <= _EPS or vol <= _EPS:
        return intrinsic(spot, strike, True)
    if carry >= rate:
        return bsm_price(spot, strike, years, rate, rate - carry, vol, True)

    v2 = vol * vol
    beta = (0.5 - carry / v2) + math.sqrt((carry / v2 - 0.5) ** 2 + 2.0 * rate / v2)
    b_inf = beta / (beta - 1.0) * strike
    b_zero = max(strike, rate / (rate - carry) * strike)

    t1 = 0.5 * (math.sqrt(5.0) - 1.0) * years
    spread = b_inf - b_zero
    # As vol goes to zero the two boundaries collapse onto each other and the
    # trigger below divides by ~0. There is no early-exercise premium to
    # approximate in that limit anyway, so hand back the European value.
    if spread <= 1e-6 * b_zero:
        return bsm_price(spot, strike, years, rate, rate - carry, vol, True)

    def trigger(t: float) -> float:
        h = -(carry * t + 2.0 * vol * math.sqrt(t)) * strike * strike / (spread * b_zero)
        # h is negative throughout the region where this approximation is
        # derived. It can turn positive under strongly negative carry with
        # near-zero vol — reachable here because the vol solver probes down to
        # 0.01% — and exp() of a large positive number overflows outright.
        # Clamping to zero pins the trigger at its lower boundary, which is the
        # correct limiting behaviour rather than merely a safe one.
        return b_zero + spread * (1.0 - math.exp(min(h, 0.0)))

    x1 = trigger(t1)
    x2 = trigger(years)

    if spot >= x2:
        return spot - strike

    alpha1 = (x1 - strike) * x1 ** (-beta)
    alpha2 = (x2 - strike) * x2 ** (-beta)

    return (
        alpha2 * spot**beta
        - alpha2 * _phi(spot, t1, beta, x2, x2, rate, carry, vol)
        + _phi(spot, t1, 1.0, x2, x2, rate, carry, vol)
        - _phi(spot, t1, 1.0, x1, x2, rate, carry, vol)
        - strike * _phi(spot, t1, 0.0, x2, x2, rate, carry, vol)
        + strike * _phi(spot, t1, 0.0, x1, x2, rate, carry, vol)
        + alpha1 * _phi(spot, t1, beta, x1, x2, rate, carry, vol)
        - alpha1 * _psi(spot, years, beta, x1, x2, x1, t1, rate, carry, vol)
        + _psi(spot, years, 1.0, x1, x2, x1, t1, rate, carry, vol)
        - _psi(spot, years, 1.0, strike, x2, x1, t1, rate, carry, vol)
        - strike * _psi(spot, years, 0.0, x1, x2, x1, t1, rate, carry, vol)
        + strike * _psi(spot, years, 0.0, strike, x2, x1, t1, rate, carry, vol)
    )


def american_price(
    spot: float,
    strike: float,
    years: float,
    rate: float,
    div_yield: float,
    vol: float,
    is_call: bool,
) -> float:
    """American price for an equity option.

    Puts route through the Bjerksund-Stensland duality
    ``P(S, K, r, q) = C(K, S, q, r)`` — a put is a call on the other side of
    the exchange rate between the two assets — so one call routine covers both.
    """
    if years <= _EPS or vol <= _EPS:
        return intrinsic(spot, strike, is_call)
    carry = rate - div_yield
    if is_call:
        return bjerksund_stensland_call(spot, strike, years, rate, carry, vol)
    return bjerksund_stensland_call(strike, spot, years, div_yield, -carry, vol)


def binomial_american_price(
    spot: float,
    strike: float,
    years: float,
    rate: float,
    div_yield: float,
    vol: float,
    is_call: bool,
    steps: int = 500,
) -> float:
    """Cox-Ross-Rubinstein reference price.

    Slow and unused in production. It exists so the closed forms above have
    something independent to be wrong against: an approximation nobody checks
    is just a number.
    """
    if years <= _EPS or vol <= _EPS:
        return intrinsic(spot, strike, is_call)

    dt = years / steps
    up = math.exp(vol * math.sqrt(dt))
    down = 1.0 / up
    disc = math.exp(-rate * dt)
    p = (math.exp((rate - div_yield) * dt) - down) / (up - down)
    if not 0.0 <= p <= 1.0:
        raise ValueError(f"binomial tree is unstable for these inputs ({p=:.4f})")

    values = [
        intrinsic(spot * up**j * down ** (steps - j), strike, is_call)
        for j in range(steps + 1)
    ]
    for i in range(steps - 1, -1, -1):
        for j in range(i + 1):
            hold = disc * (p * values[j + 1] + (1.0 - p) * values[j])
            exercise = intrinsic(spot * up**j * down ** (i - j), strike, is_call)
            values[j] = max(hold, exercise)
    return values[0]


# ---------------------------------------------------------------------------
# Implied volatility
# ---------------------------------------------------------------------------

# Widest bracket the solver will consider. 1000% annualized is already absurd
# for anything with a maintained quote; beyond it the price is insensitive to
# vol and the "solution" is noise.
MIN_VOL = 1e-4
MAX_VOL = 10.0


def implied_vol(
    price: float,
    spot: float,
    strike: float,
    years: float,
    rate: float,
    div_yield: float,
    is_call: bool,
    american: bool = True,
    tol: float = 1e-8,
    max_iter: int = 100,
    price_tick: float = 0.01,
    max_iv_uncertainty: float = 0.05,
) -> float | None:
    """Invert the pricing model for volatility. ``None`` when there is no answer.

    Returning ``None`` liberally is the point of this function. A price at or
    below intrinsic value, at or above the no-arbitrage ceiling, or so small
    that a whole decade of volatility reprices to the same penny, does not
    determine a volatility — and a number invented for those rows becomes a
    feature the model will happily learn from. The real NVDA $390 call quoted
    $0.00/$0.01 is exactly this case.

    Brent's method on a bracketed monotone function: option value is strictly
    increasing in volatility, so once the bracket is established convergence is
    guaranteed, which bisection-with-a-cap cannot promise.

    Bracketing alone is not enough to call an answer real, though. A solution
    exists for the $390 call — about 221% — it simply means nothing, because
    the contract is quoted in one-cent ticks and one tick there moves implied
    vol by 32 points. So after solving we ask what a single tick of price is
    worth in vol terms, and refuse anything above ``max_iv_uncertainty``. On
    the liquid strikes of that same chain a tick moves vol by 0.17 to 0.53
    points, so the two regimes are separated by two orders of magnitude and the
    threshold is not delicate.
    """
    if not math.isfinite(price) or price <= 0.0:
        return None
    if years <= _EPS or spot <= 0.0 or strike <= 0.0:
        return None

    def value(vol: float) -> float:
        if american:
            return american_price(spot, strike, years, rate, div_yield, vol, is_call)
        return bsm_price(spot, strike, years, rate, div_yield, vol, is_call)

    # No-arbitrage bounds. Below the floor or above the ceiling the quote is
    # not a price this model can produce at any volatility.
    floor = value(MIN_VOL)
    ceiling = value(MAX_VOL)
    if price <= floor or price >= ceiling:
        return None

    # If the entire admissible vol range moves the price by less than a
    # hundredth of a cent, vol is unidentified regardless of bracketing.
    if ceiling - floor < 1e-4:
        return None

    lo, hi = MIN_VOL, MAX_VOL
    f_lo = floor - price
    f_hi = ceiling - price

    # Brent's method.
    a, b, fa, fb = lo, hi, f_lo, f_hi
    if abs(fa) < abs(fb):
        a, b, fa, fb = b, a, fb, fa
    c, fc = a, fa
    mflag = True
    d = 0.0

    def identified(vol: float) -> bool:
        """Is one tick of price small in volatility terms at this solution?"""
        step = 1e-4
        hi_v = vol + step
        lo_v = max(vol - step, MIN_VOL)
        vega = (value(hi_v) - value(lo_v)) / (hi_v - lo_v)
        if vega <= 0.0:
            return False
        return price_tick / vega <= max_iv_uncertainty

    def finish(vol: float) -> float | None:
        return vol if identified(vol) else None

    for _ in range(max_iter):
        if fb == 0.0 or abs(b - a) < tol:
            return finish(b)
        if fa != fc and fb != fc:
            s = (
                a * fb * fc / ((fa - fb) * (fa - fc))
                + b * fa * fc / ((fb - fa) * (fb - fc))
                + c * fa * fb / ((fc - fa) * (fc - fb))
            )
        else:
            s = b - fb * (b - a) / (fb - fa)

        lo_b, hi_b = sorted(((3.0 * a + b) / 4.0, b))
        conditions = (
            not (lo_b < s < hi_b)
            or (mflag and abs(s - b) >= abs(b - c) / 2.0)
            or (not mflag and abs(s - b) >= abs(c - d) / 2.0)
            or (mflag and abs(b - c) < tol)
            or (not mflag and abs(c - d) < tol)
        )
        if conditions:
            s = (a + b) / 2.0
            mflag = True
        else:
            mflag = False

        fs = value(s) - price
        d, c, fc = c, b, fb
        if fa * fs < 0.0:
            b, fb = s, fs
        else:
            a, fa = s, fs
        if abs(fa) < abs(fb):
            a, b, fa, fb = b, a, fb, fa

    return finish(b)
