"""Ranks gate-passing contracts by expected value under a forecast distribution.

This is the piece the project plan calls "the piece that answers 'which
option to buy'": predict the underlying's distribution, price every
liquid contract under it, subtract real costs, rank by expected value. It is
also, honestly, a v1 — the plan calls for three forecast models (direction,
volatility, and a learned vol-risk-premium correction); only the direction
model is trainable today, because the volatility-premium target needs a real
trailing history of *our own* captured implied vol, and capture only started
producing that history this week (see `train.py`'s module docstring). Two
real simplifications follow from that, both flagged rather than hidden:

1. **The volatility forecast is trailing realized vol, not a trained model.**
   "Tomorrow's vol looks like the last `vol_window` days'" is a naive but
   standard starting point — an honest floor, not a claimed edge. The vol
   *premium* signal the plan actually wants (is this contract's IV rich or
   cheap versus a learned forecast, not just versus trailing RV) is the
   natural v2 once there is a year of captured IV to train against.

2. **A fixed-horizon direction model prices contracts of every DTE.** The
   model predicts a return over its own training horizon (e.g. 5 trading
   days); annualizing that into a continuous drift and using it to price a
   90-day contract assumes the signal holds at a constant rate across
   maturities. It probably decays. Flagged in `_annualize_horizon_return`,
   not corrected — correcting it needs a term-structure-aware model this
   project does not have yet.

The pricing itself is a closed-form **real-world (physical-measure)**
expectation, not the risk-neutral price `pricing.py` solves implied vol
from — see `forecast_value`'s docstring for exactly how the two differ and
why both matter here. American early-exercise value is not modelled in the
forecast (see the same docstring); the market side of every comparison
still uses the real American-priced IV market_iv only.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import lightgbm as lgb
import polars as pl

from .db import (
    prior_trading_day,
    read_bars,
    read_champion_run,
    read_day_stats,
    read_quotes,
    read_risk_free_curve,
)
from .features import NEWS_FEATURE_COLS, build_feature_panel
from .pricing import bsm_price, norm_cdf
from .screens import screen_quotes
from .har import InsufficientHistory, forecast_vol_by_symbol
from .vol import rolling_realized_vol

TRADING_DAYS_PER_YEAR = 252
# $0.65/contract each way, matching the round-trip commission assumption in
# the project plan's backtest design. Never includes a bid-ask spread cost —
# the current data plan carries no quote entitlement, so there is no spread
# to charge (see `option_quotes.bidE4`'s doc comment in schema.ts). Every
# result here is priced against the contract's own close, and is therefore
# indicative in the same sense the plan already flags historical fills as
# indicative without real NBBO.
DEFAULT_ROUND_TRIP_COST = 1.30
DEFAULT_MULTIPLIER = 100
DEFAULT_VOL_WINDOW = 21
# Caps the multiplicative vol-forecast ratio (see the module docstring's
# first flagged simplification) at this multiple. See
# _vol_forecast_ratio's docstring for why.
MAX_VOL_FORECAST_RATIO = 2.0
# Caps the annualized drift (see the module docstring's second flagged
# simplification) at this magnitude, +/-. See
# _annualize_horizon_return's docstring for why.
MAX_ANNUALIZED_DRIFT = 1.0
#: Entry guard: reject any candidate whose modelled P(profit) exceeds this.
#: See the `implausible_certainty` rejection in `select_entries` — the COST
#: sigma=3bps incident, generalized. Genuine single-leg long-option
#: candidates on a weak-edge 5-day forecast live far below this line
#: (a deep-ITM near-stock position tops out around ~0.8 against its own
#: breakeven); only degenerate inputs reach past it.
MAX_PLAUSIBLE_PROB_PROFIT = 0.95
_MIN_YEARS = 1e-9
_MIN_VOL = 1e-9


def _interpolate_rate(curve: list[tuple[int, float]], days: float) -> float | None:
    """Linear interpolation over (tenor_days, rate) pairs.

    Mirrors `interpolateRate` in `apps/server/src/lib/options/rates.ts` —
    same flat extrapolation past either end of the published curve.
    """
    if not curve:
        return None
    if len(curve) == 1:
        return curve[0][1]
    first_days, first_rate = curve[0]
    last_days, last_rate = curve[-1]
    if days <= first_days:
        return first_rate
    if days >= last_days:
        return last_rate
    for i in range(1, len(curve)):
        lo_days, lo_rate = curve[i - 1]
        hi_days, hi_rate = curve[i]
        if days <= hi_days:
            span = hi_days - lo_days
            if span <= 0:
                return lo_rate
            weight = (days - lo_days) / span
            return lo_rate + weight * (hi_rate - lo_rate)
    return last_rate


def _forecast_d1_d2(
    spot: float, strike: float, years: float, drift: float, div_yield: float, vol: float
) -> tuple[float, float]:
    vt = vol * math.sqrt(years)
    d1 = (math.log(spot / strike) + (drift - div_yield + 0.5 * vol * vol) * years) / vt
    return d1, d1 - vt


def forecast_value(
    spot: float,
    strike: float,
    years: float,
    drift: float,
    rate: float,
    div_yield: float,
    vol: float,
    is_call: bool,
) -> float:
    """Expected discounted payoff under the caller's own forecast for the
    underlying, at whatever `drift`/`vol` it supplies — the real-world
    (physical-measure) option value, not the risk-neutral price `pricing.py`
    solves implied vol from.

    The distinction is the entire point of this module: the risk-neutral
    price answers "what does the market's own no-arbitrage assumption say
    this is worth", using the risk-free rate as the growth rate because that
    is the only rate consistent with no arbitrage. This function instead
    substitutes the caller's own forecast `drift` for that growth rate — a
    genuinely different, and generally wrong-under-no-arbitrage, quantity —
    because the entire premise of ranking contracts is "the market's
    assumption and mine disagree, and I want to know how much that is worth."
    The result is still discounted at the true risk-free `rate`, never at
    `drift`: a dollar of expected payoff tomorrow is worth less than a dollar
    today for time-value reasons regardless of whose forecast produced the
    expectation.

    American early-exercise value is not modelled. For a zero-dividend call
    that costs nothing — `pricing.american_price` returns exactly the
    European price in that case too, an identity rather than an
    approximation — and zero dividend yield is the default for most of this
    project's universe. It is a real, uncorrected underestimate for puts,
    where early exercise carries genuine value even without dividends.
    """
    if years <= _MIN_YEARS or vol <= _MIN_VOL:
        terminal = spot * math.exp((drift - div_yield) * max(years, 0.0))
        payoff = max(terminal - strike, 0.0) if is_call else max(strike - terminal, 0.0)
        return math.exp(-rate * years) * payoff

    d1, d2 = _forecast_d1_d2(spot, strike, years, drift, div_yield, vol)
    growth = math.exp((drift - div_yield) * years)
    discount = math.exp(-rate * years)
    if is_call:
        undiscounted = spot * growth * norm_cdf(d1) - strike * norm_cdf(d2)
    else:
        undiscounted = strike * norm_cdf(-d2) - spot * growth * norm_cdf(-d1)
    return discount * max(undiscounted, 0.0)


def horizon_value_and_prob(
    spot: float,
    strike: float,
    years: float,
    horizon_years: float,
    drift: float,
    rate: float,
    div_yield: float,
    vol: float,
    is_call: bool,
    breakeven: float,
    remaining_vol: float | None = None,
) -> tuple[float, float] | None:
    """Expected option VALUE at the model's own horizon, not payoff at expiry
    — with P(that value clears `breakeven`) from the same integral.

    `forecast_value` compounds the model's drift over the contract's whole
    remaining life, which prices a plan nobody has: the engine's target
    exit date is the model's horizon (~5 trading days out), not expiry.
    Extrapolating a 5-day edge across 52 days is how a $24.50 GWW call
    printed EV $12,859/contract, got sized to 8 contracts by EV-greedy
    selection, and led the book's losers within a day — the same
    magnitude-worship the stock board banned when it switched to sigma
    units. Here the drift is applied ONLY over the horizon the model was
    trained on; the value at that point is the market's own risk-neutral
    price for the remaining life (edge beyond your horizon is not yours
    to book).

    Gauss-Hermite quadrature over the lognormal horizon spot — not exact
    (american_price is no polynomial in z) but highly accurate at 41
    nodes, and free of sampling noise. Returns None
    when the horizon reaches past the contract's life or vol is
    degenerate; the caller falls back to terminal valuation, which is
    then honest (drift over DTE <= drift over horizon).

    The probability is capped at 0.995: a printed "P(profit) 100%" is a
    calibration bug wearing a suit (found live: a COST put entered at
    exactly that number), and no five-day equity forecast earns three
    nines.

    `remaining_vol` is the vol the REMAINING life is priced at — the
    market's own implied vol, not the forecast. The forecast vol's only
    honest job is the width of the horizon spot distribution (our view
    of how far S moves in five days). Pricing the sale-at-horizon with
    forecast vol quietly bets that the market re-marks IV to our number
    — found live when a 1.8x HAR-over-market vol ratio printed a FICO
    call at 'EV 206% of risk' with every drift honestly bounded: the
    drift channel was fixed and the vega channel was still smuggling
    magnitude. Defaults to `vol` for callers that mean held-to-model
    consistency (tests, degenerate cases).
    """
    h = min(horizon_years, years)
    remaining = years - h
    if h <= 0.0 or remaining <= 1.0 / 3650.0 or vol <= _MIN_VOL:
        return None
    from numpy.polynomial.hermite_e import hermegauss

    z, w = hermegauss(41)
    w = w / w.sum()
    m = math.log(spot) + (drift - div_yield - 0.5 * vol * vol) * h
    scale = vol * math.sqrt(h)
    ev_acc = 0.0
    p_acc = 0.0
    sell_vol = remaining_vol if remaining_vol is not None and remaining_vol > 0 else vol
    # The sale is priced by the SAME model the IV was solved from — the
    # nightly solve inverts american_price, and plugging its IV into the
    # European formula undervalues anything with early-exercise premium
    # (ITM puts especially), tilting the board toward calls (review
    # finding). Symmetry of model, not just of vol.
    from .pricing import american_price

    for zi, wi in zip(z, w):
        s_h = math.exp(m + scale * zi)
        v = american_price(s_h, strike, remaining, rate, div_yield, sell_vol, is_call)
        ev_acc += wi * v
        if v > breakeven:
            p_acc += wi
    return math.exp(-rate * h) * ev_acc, min(p_acc, 0.995)


def probability_above(
    spot: float, threshold: float, years: float, drift: float, div_yield: float, vol: float
) -> float:
    """P(S_T > threshold) under the same forecast lognormal distribution."""
    if threshold <= 0:
        # A non-positive threshold (a put priced at or above its own
        # strike — a bad print) is certainly exceeded by a positive
        # price; without this, log(spot/threshold) kills the whole
        # day's board on one corrupt row (review finding).
        return 1.0
    if years <= _MIN_YEARS or vol <= _MIN_VOL:
        terminal = spot * math.exp((drift - div_yield) * max(years, 0.0))
        return 1.0 if terminal > threshold else 0.0
    _, d2 = _forecast_d1_d2(spot, threshold, years, drift, div_yield, vol)
    return norm_cdf(d2)


def probability_of_profit(
    spot: float,
    strike: float,
    price_paid: float,
    years: float,
    drift: float,
    div_yield: float,
    vol: float,
    is_call: bool,
) -> float:
    """P(payoff at expiry exceeds the price paid) — ignores time value of
    money on the premium itself, a standard simplification for a
    probability-of-profit figure rather than a full net-present-value one.
    """
    if is_call:
        return probability_above(spot, strike + price_paid, years, drift, div_yield, vol)
    return 1.0 - probability_above(spot, strike - price_paid, years, drift, div_yield, vol)


@dataclass
class RankedContract:
    occ_symbol: str
    underlying: str
    expiry: str
    type: str
    strike: float
    dte: int
    market_price: float
    market_iv: float | None
    forecast_vol: float
    forecast_drift: float
    forecast_value: float
    ev: float
    ev_per_risk: float
    prob_profit: float
    #: Spot and delta at ranking time, threaded through for the vol-scaled
    #: stop (see exit.vol_scaled_stop_pct). Optional so older serialized
    #: contracts and thin test fixtures keep constructing.
    spot: float | None = None
    delta: float | None = None


def _atm_reference_iv(quotes: pl.DataFrame) -> float | None:
    """Median market IV over the fixed 0.8-1.2 moneyness band — the one
    per-underlying vol reference shared by `_vol_forecast_ratio` and the
    physical horizon distribution (see the forecast_vol comment in the
    ranking loop for why those two must agree)."""
    atm = quotes.filter(
        (pl.col("strike") / pl.col("underlying_price")).is_between(0.8, 1.2)
    )
    ivs = atm["iv"].drop_nulls()
    if ivs.len() == 0:
        ivs = quotes["iv"].drop_nulls()
    if ivs.len() == 0:
        return None
    return float(ivs.median())


def _vol_forecast_ratio(
    realized_vol: float, quotes: pl.DataFrame, max_ratio: float = MAX_VOL_FORECAST_RATIO
) -> float:
    """The multiplicative view `rank_underlying` applies to every
    contract's own market IV, derived from trailing realized vol versus
    this underlying's own median market-implied vol for the day.

    **Deliberately multiplicative, scaling each contract's own IV — not a
    single flat vol substituted across the whole chain.** An earlier
    version of this function returned one replacement `forecast_vol` for
    the whole underlying, and it was wrong in a way a live case exposed:
    SNDK's real chain (confirmed against the raw quotes, a smooth, genuine
    skew — not noise) ran from ~30% IV at a deep-ITM strike to ~70% IV six
    hundred dollars further out. Comparing every strike in that chain
    against one flat forecast number structurally guarantees the lowest
    point on any real skew curve looks like the biggest "opportunity",
    regardless of whether the skew itself is justified — a bias with
    nothing to do with genuine mispricing. Scaling each contract's own IV
    by a shared ratio instead preserves the skew shape: a genuine view
    that vol is elevated moves every strike up together, rather than
    flattening the smile into a single, wrong number.

    The ratio is still capped at `max_ratio`, for the reason the original,
    single-vol version of this cap existed: trailing RV is a naive floor
    (see the module docstring's first flagged simplification) that does
    not know vol mean-reverts after a spike, and an extreme, unbounded
    ratio is more likely that floor's own blind spot than a real,
    tradeable view. A ratio of 1.0 (no view) is the safe fallback whenever
    there is no market IV to compare against.
    """
    # The median is taken over the fixed 0.8–1.2 ATM band, not the whole
    # screened chain. The screens' admission band now scales with this
    # same `realized_vol` (screens.py), so a whole-chain median would put
    # the forecast on both sides of its own ratio: a lower forecast
    # narrows the band, drops the smile's high-IV wings, lowers the
    # median, and pushes the ratio back toward 1 — damping exactly the
    # signal this function exists to express, symmetrically in both
    # directions. A fixed-band reference cannot move when the forecast
    # moves, and it is the same ATM reference the screens themselves
    # standardize against.
    reference = _atm_reference_iv(quotes)
    if reference is None or reference <= 0:
        return 1.0
    # Symmetric by the cap's own reasoning: an extreme ratio in EITHER
    # direction is more likely a blind spot than a real view. Uncapped
    # BELOW, a post-spike HAR forecast of 8% against a chain still
    # marked at 50% crushes every forecast vol to 0.16x IV, collapsing
    # the horizon distribution's width and manufacturing near-certain
    # P(profit) — the FICO vega incident's mirror image (review finding).
    ratio = realized_vol / reference
    return min(max(ratio, 1.0 / max_ratio), max_ratio)


def _solve_missing_iv(
    quotes: pl.DataFrame,
    trading_day: str,
    rate_curve: list[tuple[int, float]],
    dividend_yield: float,
) -> pl.DataFrame:
    """Fill null `iv` on a small frame by solving from its own price/spot.

    Exists for held contracts (see the call site) — never for whole
    chains, where the nightly reprice with its capture-time rates is the
    single writer of record. Rows whose solve honestly fails stay null.
    """
    if quotes.height == 0 or quotes["iv"].null_count() == 0:
        return quotes
    from .pricing import implied_vol, years_to_expiry

    rows = quotes.to_dicts()
    for r in rows:
        if r["iv"] is not None or r["price"] is None or r["underlying_price"] is None:
            continue
        years = years_to_expiry(r["expiry"], trading_day)
        if years <= 0:
            continue
        rate = _interpolate_rate(rate_curve, years * 365.0)
        solved = implied_vol(
            r["price"],
            r["underlying_price"],
            r["strike"],
            years,
            rate if rate is not None else 0.0,
            dividend_yield,
            is_call=r["type"] == "call",
        )
        if solved is not None:
            r["iv"] = solved
    return pl.DataFrame(rows, schema=quotes.schema)


def rank_underlying(
    quotes: pl.DataFrame,
    trading_day: str,
    forecast_drift: float,
    vol_ratio: float,
    rate_curve: list[tuple[int, float]],
    horizon_years: float | None = None,
    dividend_yield: float = 0.0,
    round_trip_cost: float = DEFAULT_ROUND_TRIP_COST,
    multiplier: int = DEFAULT_MULTIPLIER,
    max_capital: float | None = None,
    atm_ref_iv: float | None = None,
) -> list[RankedContract]:
    """Ranks one underlying's contracts by expected value under the given
    forecast. `quotes` is expected to already be `liquid`-filtered (pass
    `liquid_only=True` to `db.read_quotes`) — this only additionally skips
    rows with no solved `iv`/`price`, since those have no basis for
    comparison regardless of the gate's own verdict.

    `vol_ratio` (see `_vol_forecast_ratio`) is multiplied against **each
    contract's own market IV** to get that contract's forecast vol — not a
    single flat number reused across the whole chain. This is what keeps
    the ranking skew-aware: two contracts on the same underlying can and
    should get two different forecast vols if the market itself prices
    them differently.

    `max_capital`, if given, drops any contract costing more than that to
    buy one contract of (`price * multiplier`) **before** EV is used to
    rank anything. Filtering by EV alone would never surface an affordable
    contract on its own: EV scales with the same multiplier capital does,
    so the cheapest contracts are structurally never the biggest absolute
    EV regardless of how good a deal they are relative to their own cost —
    that comparison is what `ev_per_risk` is for, but it never gets a
    chance to matter if the expensive rows were never excluded first.
    """
    out: list[RankedContract] = []
    # Callers scoring a SUBSET of the chain (score_held_contracts) pass
    # the full-chain reference explicitly, so the monitor and the ranker
    # hold one definition of the underlying's physical vol — the same
    # two-definitions trap the vol_ratio reference already fell into once.
    if atm_ref_iv is None:
        atm_ref_iv = _atm_reference_iv(quotes)
    for row in quotes.iter_rows(named=True):
        if row["iv"] is None or row["price"] is None or row["price"] <= 0:
            continue
        dte = (date.fromisoformat(row["expiry"]) - date.fromisoformat(trading_day)).days
        if dte <= 0:
            continue
        years = dte / 365.0  # matches pricing.py's calendar-day convention
        rate = _interpolate_rate(rate_curve, dte)
        if rate is None:
            continue

        is_call = row["type"] == "call"
        spot = row["underlying_price"]
        strike = row["strike"]
        price = row["price"]
        capital = price * multiplier
        if max_capital is not None and capital > max_capital:
            continue
        # ONE physical vol per underlying (review finding, 2026-09-02):
        # the horizon distribution of the underlying's spot is a fact
        # about the underlying and cannot differ by strike — priced with
        # each contract's own IV, a 70%-IV wing put was given a spot
        # distribution 2.4x wider than the ATM contract on the same name,
        # overstating its chance of paying off ~2.5x and tilting EV
        # toward the smile's wings. The SNDK flat-vol lesson (see
        # _vol_forecast_ratio) still holds where it was learned: the
        # sale-at-horizon is priced at each contract's own market IV via
        # `remaining_vol`, preserving the skew. Only the physical measure
        # is shared.
        forecast_vol = (atm_ref_iv if atm_ref_iv is not None else row["iv"]) * vol_ratio

        cost_per_share = round_trip_cost / multiplier
        # Horizon-consistent by default: drift over the model's own
        # horizon, market pricing for the rest — see horizon_value_and_prob.
        # Terminal valuation remains only as the short-DTE fallback, where
        # it is the same statement.
        hv = (
            horizon_value_and_prob(
                spot, strike, years, horizon_years, forecast_drift, rate,
                dividend_yield, forecast_vol, is_call, price + cost_per_share,
                remaining_vol=row["iv"],
            )
            if horizon_years is not None
            else None
        )
        if hv is not None:
            value, prob = hv
        else:
            value = forecast_value(spot, strike, years, forecast_drift, rate, dividend_yield, forecast_vol, is_call)
            prob = min(
                probability_of_profit(spot, strike, price, years, forecast_drift, dividend_yield, forecast_vol, is_call),
                0.995,
            )
        ev = (value - price - cost_per_share) * multiplier

        out.append(
            RankedContract(
                occ_symbol=row["occ_symbol"],
                underlying=row["underlying"],
                expiry=row["expiry"],
                type=row["type"],
                strike=strike,
                dte=dte,
                market_price=price,
                market_iv=row["iv"],
                forecast_vol=forecast_vol,
                forecast_drift=forecast_drift,
                forecast_value=value,
                ev=ev,
                ev_per_risk=(ev / capital) if capital > 0 else 0.0,
                prob_profit=prob,
                spot=spot,
                delta=row.get("delta"),
            )
        )
    return out


def _annualize_horizon_return(
    predicted_return: float, horizon_days: int, max_abs_drift: float = MAX_ANNUALIZED_DRIFT
) -> float:
    """Converts a fixed-horizon predicted return into a continuously
    compounded annual drift, so one model can price contracts at any DTE.

    This is the extrapolation flagged in the module docstring: it assumes
    the model's edge, once annualized, applies at a constant rate regardless
    of how far a contract's own DTE sits from the model's training horizon.
    `1 + predicted_return` is clamped above zero before the log — a model
    predicting a return at or below -100% is already nonsensical, and this
    keeps that failure a `ValueError`-free `-inf` drift (a certainty of
    total loss) rather than a `math.log` domain error crashing the whole run.

    The result is then clamped to `±max_abs_drift`. Found live, the same
    session the vol ratio's cap was added: a raw 5-day prediction of a
    perfectly ordinary +4.85% — for BRK.B, a low-volatility name where
    nothing about that number looks alarming on its own — annualizes to a
    239% continuously-compounded drift once extrapolated out to a 59-day
    contract, and drove a single underlying to an implied 100% probability
    of profit and thousand-percent expected values. The exponential in the
    annualization is exact arithmetic; the *extrapolation* it is applied
    to is the known-flagged assumption, and this is what that assumption
    breaking looks like on a real, otherwise-unremarkable prediction, not
    only on an extreme one.
    """
    growth = max(1.0 + predicted_return, 1e-6)
    annualized = math.log(growth) / (horizon_days / TRADING_DAYS_PER_YEAR)
    return max(-max_abs_drift, min(max_abs_drift, annualized))


def load_model(run_dir: Path) -> tuple[lgb.Booster, dict]:
    booster = lgb.Booster(model_file=str(run_dir / "model.txt"))
    manifest = json.loads((run_dir / "manifest.json").read_text())
    features = json.loads((run_dir / "features.json").read_text())
    return booster, {**manifest, "feature_cols": features["feature_cols"]}


@dataclass(frozen=True)
class ModelChoice:
    """Which model was selected, and on what grounds."""

    directory: Path
    run_id: str
    #: "champion" when the registry named it, "newest" when nothing is
    #: promoted and this fell back to the most recently written artifact.
    source: str
    #: Why the registry could not be consulted, when that is the reason for
    #: a fallback. Carried rather than swallowed: an operator seeing
    #: "newest" while the registry plainly shows a champion needs the
    #: exception text to know why, and discarding it repeats in miniature
    #: the defect this whole selector exists to fix.
    fallback_reason: str | None = None


def active_model_dir(base_dir: Path | None = None, target: str = "dir") -> Path:
    """The model the system should actually serve.

    **The registry's champion, if there is one.** That sounds obvious and
    was not the case: `model_runs` has carried a `champion` status and a
    manual promote route since the project plan's champion/challenger
    policy was written, and nothing on the serving path read either. This
    function picked `max(candidates, key=lambda d: d.name)` instead, on the
    reasoning — true in the comment, false in practice — that a
    date-prefixed run_id sorts chronologically. It does across dates. Within
    a date the suffix is a config hash, so three runs trained the same day
    order arbitrarily.

    The consequence was a database that could say one model was live while
    the ranker served another, silently. On 2026-08-24 three runs were
    trained in an afternoon and the promoted one was served only because
    its hash happened to begin with `f`; a hash beginning `0` would have
    left the champion promoted and unused, with nothing anywhere reporting
    it. That is the same class of divergence — believed state versus
    running state — that cost a day earlier in the same week.

    Falling back to **most recently written**, not last alphabetically,
    when nothing is promoted: the fallback had the identical bug and no
    reason to keep it.
    """
    return resolve_model(base_dir, target).directory


def resolve_model(base_dir: Path | None = None, target: str = "dir") -> ModelChoice:
    """`active_model_dir` with the reasoning attached — see its docstring.

    Callers that surface which model answered a request should use this;
    a selection nobody can observe is how the divergence above went
    unnoticed in the first place.
    """
    base = base_dir or (Path.home() / ".org" / "market" / "models")
    candidates = [d for d in base.iterdir() if d.is_dir() and (d / "manifest.json").exists()] if base.exists() else []
    if not candidates:
        raise SystemExit(f"No trained models found under {base} — run `python -m app.train` first.")

    by_name = {d.name: d for d in candidates}
    reason: str | None = None
    try:
        champion = read_champion_run(target)
    except Exception as e:
        # A registry that cannot be read must not take ranking down with
        # it: market.db may be mid-sync, or predate the model_runs table.
        # Falling back is correct; falling back *silently* is not, so both
        # the source and the reason travel with the answer.
        champion = None
        reason = f"registry unreadable: {e}"

    if champion is not None:
        directory = by_name.get(champion["artifact_dir"]) or by_name.get(champion["run_id"])
        if directory is not None:
            return ModelChoice(directory=directory, run_id=champion["run_id"], source="champion")
        reason = f"champion {champion['run_id']} is registered but its artifact is missing"
    elif reason is None:
        reason = f"no {target} model is promoted"

    # The fallback must stay inside the requested target: run dirs embed
    # "-{target}-h" in their names, and picking the globally newest
    # artifact once served a 126-day stock model to a caller that asked
    # for the 21-day one — same shape as the champion bug PR #53 fixed,
    # one layer down.
    of_target = [d for d in candidates if f"-{target}-h" in d.name]
    if not of_target:
        raise SystemExit(f"No trained model exists for target {target!r} under {base}.")
    newest = max(of_target, key=lambda d: (d / "manifest.json").stat().st_mtime)
    return ModelChoice(directory=newest, run_id=newest.name, source="newest", fallback_reason=reason)


#: Retained so existing callers and tests keep working; `active_model_dir`
#: is the name that says what it does.
latest_model_dir = active_model_dir


def _forecast_inputs(
    trading_day: str,
    model_dir: Path,
    vol_window: int,
    force: bool,
) -> tuple[dict[str, float], dict[str, float], list[tuple[int, float]], dict, dict[str, float]]:
    """Everything both `rank_day` (every gate-passing contract) and
    `score_held_contracts` (specific, already-held contracts) need before
    they can price anything: a per-symbol drift forecast, a per-symbol
    realized-vol floor, and the day's rate curve. Split out so a held
    position gets scored against the exact same forecast machinery a fresh
    ranking would use — two different formulas for "what does the model
    think" would be its own, worse bug.

    Refuses to run against a model that did not beat the mean baseline
    out-of-fold, unless `force=True` — ranking real candidates against a
    model with no demonstrated edge is not a conservative default, it is
    trading on noise wearing a model's confidence. This is the same
    "the harness must say so, not paper over it" rule `models.py` and
    `train.py` already enforce; this is where it would otherwise stop
    mattering, because it is the one place a bad model's output looks like
    an actionable recommendation instead of a metric.
    """
    booster, manifest = load_model(model_dir)
    metrics = manifest["metrics"]
    if not metrics["beats_baseline"] and not force:
        raise SystemExit(
            f"Model {manifest['run_id']} does not beat the mean baseline out-of-fold "
            f"(RMSE {metrics['model_rmse']:.5f} vs baseline {metrics['baseline_rmse']:.5f}, "
            f"information coefficient {metrics['information_coefficient']:.4f}). "
            f"Pass force=True to rank against it anyway."
        )

    horizon = manifest["horizon"]
    feature_cols = manifest["feature_cols"]

    # Serving needs only enough trailing history to compute the longest
    # feature window (residual momentum's 126-day beta) plus headroom for
    # holidays and the vol window — NOT the whole corpus. Unbounded, the
    # 10-year backfill (2026-09-04) turned every cold board build into a
    # multi-minute scan of 1.35M rows; training keeps reading everything,
    # because depth is exactly what training is for.
    from datetime import date as _date, timedelta as _td

    serve_start = (_date.fromisoformat(trading_day) - _td(days=420)).isoformat()
    bars = read_bars(start=serve_start, end=trading_day)
    if bars.height == 0:
        raise SystemExit("No bars in market.db.")

    all_features = build_feature_panel(bars).filter(pl.col("day") <= trading_day)
    # A model trained with news columns must be scored with them — the
    # manifest's feature list is the single statement of what the model
    # eats, so the join is keyed off it rather than off a target name.
    if any(c in feature_cols for c in NEWS_FEATURE_COLS):
        from .features import news_feature_panel

        news = news_feature_panel()
        if news.height > 0:
            all_features = all_features.join(news, on=["symbol", "day"], how="left")
        else:
            for c in NEWS_FEATURE_COLS:
                if c in feature_cols:
                    all_features = all_features.with_columns(
                        pl.lit(None, dtype=pl.Float64).alias(c)
                    )
    # Same discipline for the sector and earnings panels: the manifest's
    # feature list is the single statement of what the model eats, and a
    # panel joined at training but not at scoring is train/serve skew —
    # caught in PR review (the trial-24 stk_short model would have taken
    # stock_rank down on its four sector_* columns the day it served).
    from .features import EARNINGS_FEATURE_COLS, OPTION_FEATURE_COLS, SECTOR_FEATURE_COLS

    if any(c in feature_cols for c in SECTOR_FEATURE_COLS):
        from .features import sector_feature_panel

        sector = sector_feature_panel(bars)
        if sector.height > 0:
            all_features = all_features.join(sector, on=["symbol", "day"], how="left")
        else:
            for c in SECTOR_FEATURE_COLS:
                if c in feature_cols:
                    all_features = all_features.with_columns(pl.lit(None, dtype=pl.Float64).alias(c))
    if any(c in feature_cols for c in OPTION_FEATURE_COLS):
        from .features import option_feature_panel

        options_panel = option_feature_panel()
        if options_panel.height > 0:
            all_features = all_features.join(
                options_panel.select(["symbol", "day", *OPTION_FEATURE_COLS]),
                on=["symbol", "day"],
                how="left",
            )
        else:
            for c in OPTION_FEATURE_COLS:
                if c in feature_cols:
                    all_features = all_features.with_columns(pl.lit(None, dtype=pl.Float64).alias(c))
    if any(c in feature_cols for c in EARNINGS_FEATURE_COLS):
        from .features import earnings_feature_panel

        earnings = earnings_feature_panel()
        if earnings.height > 0:
            all_features = all_features.join(earnings, on=["symbol", "day"], how="left")
        else:
            for c in EARNINGS_FEATURE_COLS:
                if c in feature_cols:
                    all_features = all_features.with_columns(pl.lit(None, dtype=pl.Float64).alias(c))

    # Preprocessing must mirror training exactly, and the manifest is the
    # single source of what that was — a model trained on per-day feature
    # ranks scored on raw levels (or vice versa) is garbage that still
    # returns numbers. Older manifests carry neither key and score raw,
    # unchanged.
    if manifest.get("rank_features", False):
        from .features import rank_features_per_day

        all_features = rank_features_per_day(all_features, feature_cols)
    latest_features = all_features.sort("day").group_by("symbol", maintain_order=True).last()
    if latest_features.height == 0:
        raise SystemExit(f"No features available on or before {trading_day} — not enough trailing bars yet.")

    predicted = booster.predict(latest_features.select(feature_cols).to_numpy())

    label_cfg = manifest.get("label") or {}
    if label_cfg.get("kind") == "vol_scaled":
        # The model predicted the horizon return in trailing-sigma units;
        # multiplying back by each symbol's *current* trailing sigma —
        # same estimator, same window as the label's denominator —
        # recovers a return. A symbol without enough vol history has no
        # honest scale and gets no drift, exactly as it had no label.
        from .vol import TRADING_DAYS_PER_YEAR, rolling_realized_vol

        window = int(label_cfg.get("vol_window", 21))
        vols = rolling_realized_vol(bars, window).filter(pl.col("day") <= trading_day)
        latest_sigma = {
            row["symbol"]: row["realized_vol"] * (horizon / TRADING_DAYS_PER_YEAR) ** 0.5
            for row in vols.sort("day").group_by("symbol", maintain_order=True).last().iter_rows(named=True)
        }
        horizon_ret_by_symbol = {
            row["symbol"]: float(pred) * latest_sigma[row["symbol"]]
            for row, pred in zip(latest_features.iter_rows(named=True), predicted)
            if row["symbol"] in latest_sigma and latest_sigma[row["symbol"]] > 0
        }
    else:
        horizon_ret_by_symbol = {
            row["symbol"]: float(pred)
            for row, pred in zip(latest_features.iter_rows(named=True), predicted)
        }
    # The clamped annualized drift feeds option pricing; the raw horizon
    # return keeps full resolution for per-symbol *ranking* — the clamp
    # once flattened a whole stock ranking into ties, and ties sort
    # alphabetically, which this project has already been burned by.
    drift_by_symbol = {
        sym: _annualize_horizon_return(r, horizon) for sym, r in horizon_ret_by_symbol.items()
    }

    # A volatility *forecast*, not a volatility measurement carried flat.
    # See har.py: realized vol mean-reverts, so extrapolating the trailing
    # window unchanged overstates it after a spike and understates it after
    # a lull — precisely the moments a contract is mispriced enough to be
    # worth ranking. Measured against the placeholder it replaces, on a
    # held-out period of this corpus: 7.7% lower RMSE on log vol (0.3075 vs
    # 0.3331) and a better-calibrated level.
    #
    # The trailing estimator remains the fallback, not because it is good
    # but because a machine with too little history to fit HAR should still
    # rank something rather than refuse: this is the one input where a
    # crude number beats no number, since every contract's EV depends on it.
    #
    # `InsufficientHistory` specifically, not `ValueError`: the latter is
    # also what `yang_zhang_vol` raises on a malformed bar, and catching it
    # here would silently revert *every* symbol's forecast to the
    # placeholder on one bad row, with nothing logged and no way to tell a
    # degraded run from a normal one.
    try:
        vol_by_symbol, har_fit = forecast_vol_by_symbol(bars, trading_day)
        # Printed rather than discarded because a forecast that quietly
        # stopped working looks exactly like one that is working: R² is
        # computed for this and had no reader. Typical fitted shape is
        # betas rising 0.06/0.20/0.50 with R² ~0.57.
        print(
            f"  vol forecast: HAR-RV betas {har_fit.beta_daily:.3f}/{har_fit.beta_weekly:.3f}/"
            f"{har_fit.beta_monthly:.3f}, R² {har_fit.r_squared:.3f}, n={har_fit.n_observations}"
        )
    except InsufficientHistory as e:
        print(f"  vol forecast: falling back to trailing realized vol — {e}")
        all_vols = rolling_realized_vol(bars, vol_window).filter(pl.col("day") <= trading_day)
        latest_vols = all_vols.sort("day").group_by("symbol", maintain_order=True).last()
        vol_by_symbol = {row["symbol"]: row["realized_vol"] for row in latest_vols.iter_rows(named=True)}

    rate_curve = read_risk_free_curve(trading_day)
    if not rate_curve:
        raise SystemExit(f"No risk-free rate curve on or before {trading_day}.")

    return drift_by_symbol, vol_by_symbol, rate_curve, manifest, horizon_ret_by_symbol


#: Serve-time ensemble width for the options dir model — the same design
#: the stock targets adopted as trial #23: retrained-daily fits of one
#: configuration scatter (dir ICs ran 0.01-0.037 across a week), and the
#: mean of the last N fits is a steadier signal than any single one.
#: Counted as trial #26 in MODEL_TRIAL_COUNT's ledger (config.ts) by the
#: same precedent: serving an average is a configuration whose live
#: performance will be judged, and the hurdle must know it exists.
#: 1 disables ensembling.
DIR_ENSEMBLE_N = int(os.environ.get("DIR_ENSEMBLE_N", "5"))


def _ensemble_forecast_inputs(
    trading_day: str,
    model_dir: Path,
    vol_window: int,
    force: bool,
    target: str,
    n: int,
) -> tuple[dict[str, float], dict[str, float], list[tuple[int, float]], dict, dict[str, float]]:
    """`_forecast_inputs` averaged across the newest `n` same-target
    artifacts, `model_dir` always a member and always the manifest of
    record — mirrors `stock_rank`'s member loop exactly: every member
    votes with its own full forecast pass (its OWN manifest's feature
    list, preserving train/serve symmetry per member), the mean horizon
    return per symbol is re-annualized into the drift, and a member that
    cannot score simply loses its vote. The realized-vol floor and rate
    curve are identical across members by construction, so the primary's
    are returned."""
    drift_by_symbol, vol_by_symbol, rate_curve, manifest, raw_by_symbol = _forecast_inputs(
        trading_day, model_dir, vol_window, force
    )
    if n <= 1:
        return drift_by_symbol, vol_by_symbol, rate_curve, manifest, raw_by_symbol

    base = model_dir.parent
    siblings = sorted(
        (
            d
            for d in (base.iterdir() if base.exists() else [])
            if d.is_dir() and (d / "manifest.json").exists() and f"-{target}-h" in d.name and d != model_dir
        ),
        key=lambda d: (d / "manifest.json").stat().st_mtime,
        reverse=True,
    )
    sums: dict[str, float] = dict(raw_by_symbol)
    counts: dict[str, int] = {k: 1 for k in raw_by_symbol}
    voted = 1
    for member in siblings:
        if voted >= n:
            break
        try:
            _d, _v, _c, _m, member_raw = _forecast_inputs(trading_day, member, vol_window, force=True)
        except SystemExit:
            continue
        voted += 1
        for sym, val in member_raw.items():
            sums[sym] = sums.get(sym, 0.0) + val
            counts[sym] = counts.get(sym, 0) + 1
    raw_by_symbol = {sym: sums[sym] / counts[sym] for sym in sums}
    drift_by_symbol = {
        sym: _annualize_horizon_return(ret, manifest["horizon"]) for sym, ret in raw_by_symbol.items()
    }
    return drift_by_symbol, vol_by_symbol, rate_curve, manifest, raw_by_symbol


#: KNOWN SIMPLIFICATION (review finding, accepted): dividend yield is 0
#: through the whole ranking path — internally consistent (the IV solve
#: uses q=0 too), but call EVs on high-yield names are overstated near
#: ex-div dates. The universe is predominantly low-yield; revisit if a
#: yield-heavy name ever tops the board suspiciously.
def rank_day(
    trading_day: str,
    model_dir: Path,
    vol_window: int = DEFAULT_VOL_WINDOW,
    top: int = 25,
    dividend_yield: float = 0.0,
    round_trip_cost: float = DEFAULT_ROUND_TRIP_COST,
    force: bool = False,
    max_capital: float | None = None,
    min_dte: int | None = None,
    max_dte: int | None = None,
    screen_audit: list[dict] | None = None,
) -> list[RankedContract]:
    """The full pipeline: load a model, forecast every underlying, price
    every underlying's gate-passing chain against that forecast, and return
    the top `top` contracts by expected value. See `rank_underlying`'s own
    docstring for why `max_capital` has to be applied per-contract here,
    before ranking, rather than by the caller filtering the result after.

    `min_dte`/`max_dte` are applied here for the same reason, and it
    matters more than it looks. `ev` is an absolute dollar figure, and
    `forecast_value` compounds a constant drift over the contract's whole
    life — so on one underlying the longer-dated contract carries the
    larger EV almost mechanically, and the top-`top` slice skews long.
    Leaving the maturity filter to the caller therefore does not just cost
    a few candidates: on a board with enough long-dated contracts to fill
    `top` on their own, every in-band candidate is cut before the caller
    ever sees one, and an empty selection reads as "the market offered
    nothing today" when it was really the truncation. Both bounds are
    inclusive; `None` disables that end (the Signal Board wants the whole
    board, unfiltered).
    """
    drift_by_symbol, vol_by_symbol, rate_curve, _manifest, _raw = _ensemble_forecast_inputs(
        trading_day, model_dir, vol_window, force, target="dir", n=DIR_ENSEMBLE_N
    )

    prior_day = prior_trading_day(trading_day)
    # One scan for the whole prior day, unfiltered by liquidity — see
    # read_day_stats on both choices. The per-symbol, liquid-only version
    # this replaces doubled rank_day's SQL and punched two holes in the
    # staleness screen: a contract whose liquidity verdict flipped
    # overnight had no prior row and passed as fresh, and a symbol that
    # missed a capture skipped the screen entirely with nothing in the
    # audit to say so.
    prior_stats = read_day_stats(prior_day) if prior_day else None
    screen_drops: dict[str, int] = {}
    ranked: list[RankedContract] = []
    for symbol, drift in drift_by_symbol.items():
        # A drift that landed exactly on the cap isn't a large-but-real
        # signal — it's the clamp itself firing, which only happens when
        # the raw extrapolation broke (see _annualize_horizon_return's
        # docstring). Live case that caught this: IEF, a Treasury bond ETF
        # with ~4-5% real IV, got a clamped +100%/year drift and combined
        # with its own near-zero volatility that made several of its calls
        # look like a mathematical certainty (prob_profit rounding to
        # 1.0) — an artifact of the extrapolation breaking, not a real
        # edge. Skipping the whole underlying rather than trusting a
        # number the model's own safety valve had to intervene on.
        if abs(drift) >= MAX_ANNUALIZED_DRIFT:
            continue
        vol = vol_by_symbol.get(symbol)
        if vol is None or vol <= 0:
            continue
        quotes = read_quotes(symbol, trading_day, liquid_only=True)
        if quotes.height == 0:
            continue
        # The literature's quote screens, applied before anything is priced
        # — see screens.py for the $122,440 stale-print incident that made
        # them non-optional and the papers the thresholds come from. The
        # vol-forecast ratio is computed on the *screened* chain too: a
        # 447% stale IV distorts the median exactly like it distorts a
        # ranking.
        screened = screen_quotes(
            quotes, prior_stats, trading_day=trading_day, prior_day=prior_day, symbol_vol=vol
        )
        for reason, n in screened.dropped.items():
            screen_drops[reason] = screen_drops.get(reason, 0) + n
        if not screened.staleness_ran:
            # "Could not screen" is a different fact from "screened,
            # nothing stale", and the audit must distinguish them — review
            # found the screen silently off for exactly the symbols with
            # the patchiest capture history.
            screen_drops["stale_screen_unavailable_symbols"] = (
                screen_drops.get("stale_screen_unavailable_symbols", 0) + 1
            )
        if screen_audit is not None:
            # Per-contract attribution, threaded out so a screened-out
            # contract still gets a decision-log row — "why didn't it buy
            # X?" must have an answer when the answer is "the screens
            # rejected its quote", which is now the single largest source
            # of exclusions.
            for reason, symbols in screened.dropped_rows.items():
                for occ in symbols:
                    screen_audit.append({"occ_symbol": occ, "underlying": symbol, "reason": reason})
        quotes = screened.passed
        if quotes.height == 0:
            continue
        vol_ratio = _vol_forecast_ratio(vol, quotes)
        ranked.extend(
            rank_underlying(
                quotes,
                trading_day,
                drift,
                vol_ratio,
                rate_curve,
                # horizon/252, matching _annualize_horizon_return's clock exactly
                # — the old 1.4/365 recovered only 96.6% of the predicted
                # horizon move (365/252 = 1.4486, not 1.4; review finding).
                horizon_years=_manifest["horizon"] / 252.0,
                dividend_yield=dividend_yield,
                round_trip_cost=round_trip_cost,
                max_capital=max_capital,
            )
        )

    # The screens' audit trail, printed rather than discarded: a screen
    # that suddenly eats half the board must be visible, not just produce a
    # mysteriously thin ranking. Same reasoning as the HAR fit line above.
    if screen_drops:
        total = sum(screen_drops.values())
        detail = ", ".join(f"{k}={v}" for k, v in sorted(screen_drops.items()))
        print(f"  quote screens dropped {total}: {detail}")

    # Before the sort and the cut, per the docstring above.
    if min_dte is not None:
        ranked = [c for c in ranked if c.dte >= min_dte]
    if max_dte is not None:
        ranked = [c for c in ranked if c.dte <= max_dte]

    ranked.sort(key=lambda c: c.ev, reverse=True)
    return ranked[:top]


@dataclass
class EntryRejection:
    """A candidate that was considered and not taken, and why.

    Every `continue` in `select_entries` used to discard this. The board is
    cut to the top few hundred by EV, a handful are opened, and the
    reasoning for every other one vanished when the function returned — so
    "why didn't it buy X?" had no answer at all, ever. Reconstructing one
    such decision by hand cost an afternoon on 2026-08-24, for a position
    that turned out to be a bad price print.

    `reason` is a fixed vocabulary rather than prose because the point is
    to be able to *count* these: "how often does the DTE band bind" and
    "how often do we run out of capital" are the questions that tell you
    which constraint is actually shaping the book.
    """

    contract: RankedContract
    reason: str
    #: The specific numbers behind the reason — the bar and the value that
    #: missed it — so a rejection can be re-judged later without rerunning
    #: the day.
    detail: dict


@dataclass
class EntrySelection:
    """One accepted candidate and how much of it to buy.

    Size is part of the selection, not an afterthought for the caller —
    which contract to buy and how much of the account to put behind it are
    the same decision, and splitting them is how the caller ended up
    hard-coding `quantity: 1` for every position regardless of price.
    """

    contract: RankedContract
    quantity: int
    #: Total dollars committed: `market_price * multiplier * quantity`. The
    #: caller needs this for its own reconciliation, and recomputing it
    #: from the contract risks drifting from the multiplier used here.
    cost: float


#: No single new position may take more than this fraction of the
#: day's investable cash. See the sizing comment below for the incident.
#: Cut from 0.25 after the August 2026 drawdown: the inflated-EV bugs did
#: their damage *through* this number — a model must earn back the right
#: to bet big, and a freshly repaired one has not. Revisit only with a
#: positive out-of-sample record on the honest EV chain.
MAX_POSITION_FRACTION = 0.08


def select_entries(
    candidates: list[RankedContract],
    held_underlyings: set[str],
    available_capital: float,
    open_position_count: int,
    max_concurrent_positions: int,
    max_new_positions: int,
    opened_today: int,
    min_ev_per_risk: float,
    min_prob_profit: float,
    min_dte: int,
    max_dte: int,
    multiplier: int = DEFAULT_MULTIPLIER,
) -> tuple[list[EntrySelection], list[EntryRejection]]:
    """Capital-constrained entry selection — how many positions to open
    today, *and how much of each*, decided by what the market actually
    offers rather than a fixed count and a hard-coded single contract.

    Replaces the original "pick exactly one winner" rule, which had a real
    hole found live: with no price cap anywhere, the top-ranked contract on
    a real day cost $122,440 for one contract — more than the whole paper
    account. Here a candidate is only accepted if its full cost fits within
    the capital still remaining after every earlier (higher-EV) acceptance,
    so the account can never be committed past what it actually has.

    **Order is greedy by EV; size is equal-weight, and that split is
    deliberate.** The ranked list is already sorted by the model's own
    preference, and a knapsack-optimal packing that skipped the model's
    best pick to squeeze in two lesser ones would substitute a
    capital-efficiency objective for the model's ranking. But *sizing* by
    EV would be a different and much worse idea: EV is a forecast mean, and
    forecast means carry by far the largest estimation error of any input a
    portfolio decision uses — an order of magnitude more consequential than
    errors in variance (Chopra & Ziemba 1993). Concentrating capital
    proportional to EV bets the book on the least reliable number in it.
    Equal weight across the day's available slots is the naive-1/N rule
    that repeatedly beats estimation-heavy optimizers out of sample
    (DeMiguel, Garlappi & Uppal 2009), and it is the honest choice for a
    model that has not yet cleared its own significance hurdle.

    The weight is one share of the *book*, not of the day: available
    capital is divided by the concurrent-position room, not by the
    per-day cap. Two consequences, both intentional and both easy to
    mistake for bugs. A day offering one qualifying candidate deploys
    roughly one slot's worth and leaves the rest in cash — a thin day is
    evidence for less exposure, not for a bigger bet on what little
    cleared the bar. And a day that fills its per-day cap still leaves
    room for later days at comparable size, instead of spending the whole
    account on whichever names happened to qualify first.

    One accepted contract per underlying per day, and never an underlying
    already held — the same one-position-per-underlying rule autoEntry.ts
    has enforced since it existed (doubling a name doubles exposure to one
    forecast, not diversification).

    **`min_dte`/`max_dte` confine entries to maturities the forecast can
    actually speak to.** The direction model predicts a return over one
    fixed horizon (5 trading days today) and `_annualize_horizon_return`
    turns that into a constant continuous drift so any DTE can be priced —
    an assumption the module docstring already flags as probably false,
    since signal decays with maturity. A 200-DTE contract ranked on that
    drift has almost all of its EV resting on extrapolation past anything
    the model measured. Below the floor the opposite problem: a contract
    expiring inside the forecast window cannot be held through it and
    still exited above `exit.py`'s DTE floor, so it is forced out on the
    calendar rather than on the signal. Both bounds are first-pass and
    untuned — a band, not a validated optimum.
    """
    remaining = available_capital
    room = max(0, max_concurrent_positions - open_position_count)
    # The daily cap counts what the *day* already opened, not what this
    # invocation opens. Found live: a server restart re-fired the entry
    # job for a trading day that had already spent its five slots, and
    # "max new positions" — enforced per call — happily allocated five
    # more, a second full risk budget on the same day's same board. The
    # caller reports how many model entries the day already has (from the
    # decision log, the same audit trail both runs wrote to), and this
    # subtracts them so a rerun is a no-op instead of a double-spend.
    budget_slots = min(room, max(0, max_new_positions - opened_today))
    if budget_slots <= 0 or remaining <= 0:
        # Still explain every candidate rather than returning silently: a
        # day that opened nothing because the book was full looks exactly
        # like a day the market offered nothing, and those call for
        # opposite responses.
        if budget_slots <= 0:
            reason = "daily_cap_spent" if opened_today >= max_new_positions else "no_slots_remaining"
        else:
            reason = "no_capital_remaining"
        detail = {
            "open_position_count": open_position_count,
            "max_concurrent_positions": max_concurrent_positions,
            "max_new_positions": max_new_positions,
            "opened_today": opened_today,
            "available_capital": available_capital,
        }
        return [], [EntryRejection(contract=c, reason=reason, detail=detail) for c in candidates]

    # Equal weight across every position the *book* can hold, not across
    # the ones this one day may open. Dividing by the daily cap instead
    # sizes each of today's picks as though today were the only day the
    # book will ever fill: at the shipped 10-concurrent/5-per-day defaults
    # that puts 100% of deployable capital into day one's five names, and
    # day two's five then arrive at a fifth the size — a 5:1 overweight
    # decided by which name happened to clear the bar first. Chronological
    # accident is not conviction, and concentrating on it is exactly what
    # the equal-weight rule above exists to prevent.
    per_slot_budget = available_capital / room

    taken_underlyings: set[str] = set()
    selected: list[EntrySelection] = []
    rejected: list[EntryRejection] = []

    def reject(c: RankedContract, reason: str, **detail: object) -> None:
        rejected.append(EntryRejection(contract=c, reason=reason, detail=dict(detail)))

    for c in sorted(candidates, key=lambda c: c.ev, reverse=True):
        if len(selected) >= budget_slots:
            # Not "it failed a bar" — it never got looked at, which is a
            # different fact and the one that says the cap was binding.
            reject(c, "day_full", slots=budget_slots)
            continue
        if c.ev_per_risk < min_ev_per_risk:
            reject(c, "ev_below_bar", ev_per_risk=c.ev_per_risk, bar=min_ev_per_risk)
            continue
        if c.prob_profit < min_prob_profit:
            reject(c, "prob_below_bar", prob_profit=c.prob_profit, bar=min_prob_profit)
            continue
        if c.prob_profit > MAX_PLAUSIBLE_PROB_PROFIT:
            # Too good to be true is a data defect, not alpha. Found live:
            # a put whose close sat below end-of-day intrinsic solved to
            # sigma = 3bps, the EV engine read sigma = 0 as "the underlying
            # cannot move", printed P(profit) = 100%, and sized the
            # position 4x. The solver now refuses that solve, but the
            # principle outlives the instance: a 5-day directional model
            # whose out-of-sample rank IC is ~0.04 cannot honestly assign
            # near-certainty to any single-leg long option — when the
            # arithmetic says it did, the input is broken somewhere, and
            # the right response is to walk away, not to size up.
            reject(c, "implausible_certainty", prob_profit=c.prob_profit,
                   bar=MAX_PLAUSIBLE_PROB_PROFIT)
            continue
        if c.dte < min_dte or c.dte > max_dte:
            reject(c, "dte_outside_band", dte=c.dte, min_dte=min_dte, max_dte=max_dte)
            continue
        if c.underlying in held_underlyings:
            reject(c, "underlying_already_held", underlying=c.underlying)
            continue
        if c.underlying in taken_underlyings:
            reject(c, "underlying_taken_today", underlying=c.underlying)
            continue
        cost_per_contract = c.market_price * multiplier
        if cost_per_contract <= 0:
            reject(c, "price_not_positive", market_price=c.market_price)
            continue
        if cost_per_contract > remaining:
            reject(c, "unaffordable", cost_per_contract=cost_per_contract, remaining=remaining)
            continue
        if cost_per_contract > available_capital * MAX_POSITION_FRACTION:
            # Under the probation cap the old "one contract stays allowed
            # above the cap" floor is exactly the loophole: a single
            # expensive contract IS a concentration in this account. A
            # candidate whose minimum position breaches the cap is not
            # bought smaller — it is not bought.
            reject(c, "exceeds_position_cap", cost_per_contract=cost_per_contract,
                   cap=available_capital * MAX_POSITION_FRACTION)
            continue
        # At least one contract — a candidate that fits in `remaining` at
        # all is worth a single unit even when one unit overshoots its
        # equal-weight slot, which is the common case for an expensive
        # contract in a small account.
        quantity = max(1, int(per_slot_budget // cost_per_contract))
        # ...but never more than MAX_POSITION_FRACTION of the day's
        # investable cash in one position. The equal-weight slot already
        # aims for this; what it cannot prevent is the last-slots case
        # where a nearly full book leaves one giant per-slot budget — DIA
        # took ten contracts, a fifth of the whole account, through
        # exactly that gap, and EV-greedy ordering guarantees the biggest
        # such bet is always placed on the single most extrapolated
        # forecast of the day. The cap is hard: candidates whose single
        # contract already breaches it were rejected above.
        quantity = min(quantity, int((available_capital * MAX_POSITION_FRACTION) // cost_per_contract))
        # ...and never more than the cash actually left.
        quantity = min(quantity, int(remaining // cost_per_contract))
        cost = cost_per_contract * quantity
        selected.append(EntrySelection(contract=c, quantity=quantity, cost=cost))
        taken_underlyings.add(c.underlying)
        remaining -= cost

    return selected, rejected


def score_held_contracts(
    contracts: list[dict],
    trading_day: str,
    model_dir: Path,
    vol_window: int = DEFAULT_VOL_WINDOW,
    dividend_yield: float = 0.0,
    round_trip_cost: float = DEFAULT_ROUND_TRIP_COST,
    force: bool = False,
) -> dict[str, RankedContract | None]:
    """Re-scores specific, already-held contracts against **today's**
    forecast — for a position monitor, not a fresh entry screen.

    `contracts` is `[{occ_symbol, underlying}, ...]`. Only those two fields
    are needed: strike, expiry, and type all come from today's captured
    quote row for that `occ_symbol` (the same source `rank_day` itself
    reads from), never from the caller — a held position's own contract
    details are a database fact, not something worth risking a second,
    possibly-stale copy of by threading them through the caller instead.

    Unlike `rank_day`, this never applies the liquidity gate or drops a
    clamped-drift underlying — a position you already hold needs an honest
    current view regardless of whether it would pass today's entry
    criteria; hiding it would just mean silence exactly when a position has
    gone the direction those checks exist to catch. A `None` result means
    "no current view could be computed" (contract expired, no quote today,
    no rate for its DTE), not "this position is fine".
    """
    # Same ensemble as rank_day — a held position's current view must
    # come from the exact machinery a fresh ranking would use.
    drift_by_symbol, vol_by_symbol, rate_curve, _manifest, _raw = _ensemble_forecast_inputs(
        trading_day, model_dir, vol_window, force, target="dir", n=DIR_ENSEMBLE_N
    )

    by_underlying: dict[str, list[str]] = {}
    for c in contracts:
        by_underlying.setdefault(c["underlying"], []).append(c["occ_symbol"])

    _prior = prior_trading_day(trading_day)
    prior_stats = read_day_stats(_prior) if _prior else None
    results: dict[str, RankedContract | None] = {c["occ_symbol"]: None for c in contracts}
    for underlying, occ_symbols in by_underlying.items():
        drift = drift_by_symbol.get(underlying)
        vol = vol_by_symbol.get(underlying)
        if drift is None or vol is None or vol <= 0:
            continue
        # liquid_only=False: an existing position still needs a current
        # view even on a day it wouldn't pass the entry gate.
        quotes = read_quotes(underlying, trading_day, liquid_only=False)
        if quotes.height == 0:
            continue
        # The vol-forecast ratio is measured on the same reference chain
        # rank_day uses — the liquid subset, screened, with the same prior
        # day for staleness. Review of the first version found it differed
        # on both axes (full chain, no staleness), so the monitor and the
        # ranker held two different definitions of "what does the model
        # think" for the same symbol on the same day, and the comment
        # claimed otherwise. Held contracts themselves are NOT screened
        # out: a position you hold must always get a verdict, even one
        # whose own quote is stale — that staleness is precisely what its
        # health check should surface.
        reference = screen_quotes(
            quotes.filter(pl.col("liquid")),
            prior_stats,
            trading_day=trading_day,
            prior_day=_prior,
            symbol_vol=vol,
        ).passed
        if reference.height > 0:
            vol_ratio = _vol_forecast_ratio(vol, reference)
            atm_ref = _atm_reference_iv(reference)
        else:
            atm_ref = None
            # An empty screened reference means the chain is at its most
            # corrupt — the first version fell back to the *unscreened*
            # median here, handing the fully-corrupt set to the exact
            # calculation the screens protect. 1.0 is the documented
            # no-view fallback _vol_forecast_ratio itself uses when there
            # is no market IV to compare against.
            vol_ratio = 1.0
        held_quotes = quotes.filter(pl.col("occ_symbol").is_in(occ_symbols))
        if held_quotes.height == 0:
            continue
        # A held position must always be priceable — the same principle as
        # "held contracts are never screened out", one layer down. The
        # nightly reprice targets `liquid` rows only, and a held contract
        # that has drifted deep ITM on a rally is exactly the row the
        # liquidity gate stops flagging (found live: four winning calls
        # whose health read "no current view" the morning after a +9%
        # day). Solving a handful of held contracts inline costs
        # microseconds and only ever fills gaps — a stored solve is never
        # overwritten, and a price the solver honestly refuses (below
        # intrinsic, unidentified vol) stays null and the position stays
        # visible as unscored rather than fictitiously priced.
        held_quotes = _solve_missing_iv(held_quotes, trading_day, rate_curve, dividend_yield)
        for scored in rank_underlying(
            held_quotes,
            trading_day,
            drift,
            vol_ratio,
            rate_curve,
            # horizon/252, matching _annualize_horizon_return's clock exactly
                # — the old 1.4/365 recovered only 96.6% of the predicted
                # horizon move (365/252 = 1.4486, not 1.4; review finding).
                horizon_years=_manifest["horizon"] / 252.0,
            dividend_yield=dividend_yield,
            round_trip_cost=round_trip_cost,
            # The full screened chain's reference, not the held subset's —
            # one physical vol per underlying, same number rank_day uses.
            atm_ref_iv=atm_ref,
        ):
            results[scored.occ_symbol] = scored

    return results


#: (trading day, target, champion run id) -> the full ranked board.
#: Rebuilding it costs ~20s — the whole two-year feature panel is
#: recomputed from bars — and a board is a *daily* quantity: it cannot
#: change until either the corpus or the serving model does, both of
#: which move the key. Without this the picks view spent twenty seconds
#: on every poll re-deriving a number it had already derived.
_stock_rank_cache: dict[tuple[str, str, str], list[dict]] = {}


#: How many of the target's most recent model artifacts vote in the
#: stock board's forecast. Daily refits of one configuration differ
#: only by their training window's trailing edge, and averaging them is
#: the cheapest known variance reduction for exactly that noise — a
#: name that tops the board under five consecutive fits is a steadier
#: signal than one that tops today's fit alone. Counted as trial #23 in
#: MODEL_TRIAL_COUNT's ledger (config.ts): serving an average is a new
#: configuration whose performance will be judged, and the hurdle must
#: know it exists. 1 disables ensembling.
STOCK_ENSEMBLE_N = int(os.environ.get("STOCK_ENSEMBLE_N", "5"))


def resolve_stock_ensemble(
    base_dir: Path | None, target: str, n: int
) -> tuple[ModelChoice, list[Path]]:
    """The champion plus the target's newest other artifacts, up to `n`.

    The champion is always a member — the ensemble refines the promoted
    choice, it never quietly replaces it — and the rest are the newest
    same-target runs by artifact mtime, which for a daily-retrained
    target means the last few days' refits.
    """
    primary = resolve_model(base_dir, target=target)
    base = base_dir or (Path.home() / ".org" / "market" / "models")
    of_target = sorted(
        (
            d
            for d in (base.iterdir() if base.exists() else [])
            if d.is_dir() and (d / "manifest.json").exists() and f"-{target}-h" in d.name
        ),
        key=lambda d: (d / "manifest.json").stat().st_mtime,
        reverse=True,
    )
    members = [primary.directory]
    for d in of_target:
        if len(members) >= max(1, n):
            break
        if d != primary.directory:
            members.append(d)
    return primary, members


def stock_rank(
    trading_day: str,
    target: str = "stk_short",
    top: int = 25,
    model_dir: Path | None = None,
) -> list[dict]:
    """Per-SYMBOL forecast ranking — the stock engine's answer to 'what
    should I buy', before any option ever enters the picture.

    Thin on purpose: `_forecast_inputs` already produces the per-symbol
    drift and vol dictionaries for whichever champion the registry holds
    for `target`; this orders them. `score` is the model's raw sigma-unit
    prediction re-expressed as the horizon return, and `annual_drift` is
    the same number annualized — the ranking key. Always `force=True`
    because both stock targets are unproven by construction at this
    corpus depth (stk_long has ONE independent validation period on two
    years of bars); the serving gate for stocks is the caller's banner
    and entry policy, not a refusal here that would leave the dashboard
    permanently blank.
    """
    choice, members = resolve_stock_ensemble(model_dir, target, STOCK_ENSEMBLE_N)
    ensemble_id = (
        choice.run_id
        if len(members) == 1
        else f"ens{len(members)}:{choice.run_id}"
    )
    cache_key = (trading_day, target, ensemble_id, tuple(d.name for d in members))
    cached = _stock_rank_cache.get(cache_key)
    if cached is not None:
        return cached[: max(1, top)]

    # Every member votes with its own full forecast pass; the board is
    # ranked on the MEAN sigma-unit prediction per symbol. Volatility and
    # the annualized drift are re-derived from the averaged forecast (the
    # vol floor is realized, identical across members by construction).
    drift_by_symbol, vol_by_symbol, _curve, manifest, raw_by_symbol = _forecast_inputs(
        trading_day, choice.directory, DEFAULT_VOL_WINDOW, force=True
    )
    if len(members) > 1:
        sums: dict[str, float] = dict(raw_by_symbol)
        counts: dict[str, int] = {k: 1 for k in raw_by_symbol}
        for member in members[1:]:
            try:
                _d, _v, _c, _m, member_raw = _forecast_inputs(
                    trading_day, member, DEFAULT_VOL_WINDOW, force=True
                )
            except SystemExit:
                continue  # a member that cannot score simply loses its vote
            for sym, val in member_raw.items():
                sums[sym] = sums.get(sym, 0.0) + val
                counts[sym] = counts.get(sym, 0) + 1
        raw_by_symbol = {sym: sums[sym] / counts[sym] for sym in sums}
        drift_by_symbol = {
            sym: _annualize_horizon_return(ret, manifest["horizon"])
            for sym, ret in raw_by_symbol.items()
        }
    # Ranked on the model's SIGMA-UNIT forecast — its native output —
    # not on the return that forecast implies.
    #
    # The two orderings are not the same, and the difference matters: the
    # return is prediction x that symbol's own volatility, so ordering by
    # it hands the top of the board to whatever is most volatile, which
    # is precisely the nuisance axis vol-scaling the label removed in the
    # first place. Verified on a live board: ranking by return produced a
    # top five whose forecast vols ran 111-184% while the universe median
    # is 37%. A stock picker compares risk-adjusted expectations across
    # names — the expected Sharpe, not the expected move — and sizes
    # separately. (The options ranker keeps the return-based drift: an
    # option pricer needs an actual drift, not a z-score.)
    horizon = manifest["horizon"]
    ranked_all = sorted(
        raw_by_symbol.items(),
        key=lambda kv: (
            kv[1] / (vol_by_symbol[kv[0]] * math.sqrt(horizon / 252.0))
            if vol_by_symbol.get(kv[0])
            else kv[1]
        ),
        reverse=True,
    )
    out = []
    # Built and cached whole, sliced per request: a caller asking for the
    # top 5 must not poison the cache for one asking for 25.
    for rank_pos, (symbol, horizon_return) in enumerate(ranked_all, start=1):
        vol = vol_by_symbol.get(symbol)
        sigma_h = vol * math.sqrt(horizon / 252.0) if vol else None
        out.append(
            {
                "symbol": symbol,
                "rank": rank_pos,
                "horizon_return": horizon_return,
                # The model's native output: the forecast in the symbol's
                # own volatility units. This — not the return it implies —
                # is the honest number to show and to reason with. At an
                # IC around 0.02 the *ordering* may carry information
                # while the *magnitude* does not, and a 21-day board whose
                # top name reads "+170%" is a weak model's noise wearing
                # a precise-looking percentage.
                "forecast_sigmas": (horizon_return / sigma_h) if sigma_h else None,
                "annual_drift": drift_by_symbol.get(symbol),
                "forecast_vol": vol,
                "model_run_id": ensemble_id,
                "horizon_days": horizon,
            }
        )
    _stock_rank_cache.clear()  # one board at a time; never an unbounded map
    _stock_rank_cache[cache_key] = out
    return out[: max(1, top)]


def main() -> None:
    parser = argparse.ArgumentParser(description="Rank gate-passing contracts by forecast expected value.")
    parser.add_argument("--day", required=True, help="Trading day, YYYY-MM-DD.")
    parser.add_argument("--model", type=Path, default=None, help="Model run directory; defaults to the latest.")
    parser.add_argument("--top", type=int, default=25)
    parser.add_argument("--vol-window", type=int, default=DEFAULT_VOL_WINDOW)
    parser.add_argument("--force", action="store_true", help="Rank even if the model did not beat baseline.")
    parser.add_argument("--max-capital", type=float, default=None, help="Drop contracts costing more than this to buy one of (price x multiplier).")
    args = parser.parse_args()

    model_dir = args.model or latest_model_dir()
    ranked = rank_day(
        args.day, model_dir, vol_window=args.vol_window, top=args.top, force=args.force, max_capital=args.max_capital
    )

    if not ranked:
        print("No ranked contracts — check that liquid, priced quotes exist for this day.")
        return

    print(f"\nTop {len(ranked)} by expected value, {args.day} (model: {model_dir.name})\n")
    for c in ranked:
        print(
            f"  {c.occ_symbol:<24} {c.type:<4} K={c.strike:>8.2f} dte={c.dte:>3d}  "
            f"px={c.market_price:>7.2f} iv={c.market_iv:.1%}  "
            f"EV=${c.ev:>7.2f} ({c.ev_per_risk:>+.1%} of capital)  P(profit)={c.prob_profit:.1%}"
        )
    print()


if __name__ == "__main__":
    main()
