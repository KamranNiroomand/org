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
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import lightgbm as lgb
import polars as pl

from .db import read_bars, read_quotes, read_risk_free_curve
from .features import build_feature_panel
from .pricing import norm_cdf
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


def probability_above(
    spot: float, threshold: float, years: float, drift: float, div_yield: float, vol: float
) -> float:
    """P(S_T > threshold) under the same forecast lognormal distribution."""
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
    ivs = quotes["iv"].drop_nulls()
    if ivs.len() == 0:
        return 1.0
    reference = float(ivs.median())
    if reference <= 0:
        return 1.0
    return min(realized_vol / reference, max_ratio)


def rank_underlying(
    quotes: pl.DataFrame,
    trading_day: str,
    forecast_drift: float,
    vol_ratio: float,
    rate_curve: list[tuple[int, float]],
    dividend_yield: float = 0.0,
    round_trip_cost: float = DEFAULT_ROUND_TRIP_COST,
    multiplier: int = DEFAULT_MULTIPLIER,
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
    """
    out: list[RankedContract] = []
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
        forecast_vol = row["iv"] * vol_ratio

        value = forecast_value(spot, strike, years, forecast_drift, rate, dividend_yield, forecast_vol, is_call)
        cost_per_share = round_trip_cost / multiplier
        ev = (value - price - cost_per_share) * multiplier
        capital = price * multiplier
        prob = probability_of_profit(spot, strike, price, years, forecast_drift, dividend_yield, forecast_vol, is_call)

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


def latest_model_dir(base_dir: Path | None = None) -> Path:
    base = base_dir or (Path.home() / ".org" / "market" / "models")
    candidates = [d for d in base.iterdir() if d.is_dir() and (d / "manifest.json").exists()] if base.exists() else []
    if not candidates:
        raise SystemExit(f"No trained models found under {base} — run `python -m app.train` first.")
    # run_id is date-prefixed (see train.py), so lexicographic order is
    # chronological order.
    return max(candidates, key=lambda d: d.name)


def rank_day(
    trading_day: str,
    model_dir: Path,
    vol_window: int = DEFAULT_VOL_WINDOW,
    top: int = 25,
    dividend_yield: float = 0.0,
    round_trip_cost: float = DEFAULT_ROUND_TRIP_COST,
    force: bool = False,
) -> list[RankedContract]:
    """The full pipeline: load a model, forecast every underlying, price
    every underlying's gate-passing chain against that forecast, and return
    the top `top` contracts by expected value.

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

    bars = read_bars()
    if bars.height == 0:
        raise SystemExit("No bars in market.db.")

    all_features = build_feature_panel(bars).filter(pl.col("day") <= trading_day)
    latest_features = all_features.sort("day").group_by("symbol", maintain_order=True).last()
    if latest_features.height == 0:
        raise SystemExit(f"No features available on or before {trading_day} — not enough trailing bars yet.")

    predicted = booster.predict(latest_features.select(feature_cols).to_numpy())
    drift_by_symbol = {
        row["symbol"]: _annualize_horizon_return(float(pred), horizon)
        for row, pred in zip(latest_features.iter_rows(named=True), predicted)
    }

    all_vols = rolling_realized_vol(bars, vol_window).filter(pl.col("day") <= trading_day)
    latest_vols = all_vols.sort("day").group_by("symbol", maintain_order=True).last()
    vol_by_symbol = {row["symbol"]: row["realized_vol"] for row in latest_vols.iter_rows(named=True)}

    rate_curve = read_risk_free_curve(trading_day)
    if not rate_curve:
        raise SystemExit(f"No risk-free rate curve on or before {trading_day}.")

    ranked: list[RankedContract] = []
    for symbol, drift in drift_by_symbol.items():
        vol = vol_by_symbol.get(symbol)
        if vol is None or vol <= 0:
            continue
        quotes = read_quotes(symbol, trading_day, liquid_only=True)
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
                dividend_yield=dividend_yield,
                round_trip_cost=round_trip_cost,
            )
        )

    ranked.sort(key=lambda c: c.ev, reverse=True)
    return ranked[:top]


def main() -> None:
    parser = argparse.ArgumentParser(description="Rank gate-passing contracts by forecast expected value.")
    parser.add_argument("--day", required=True, help="Trading day, YYYY-MM-DD.")
    parser.add_argument("--model", type=Path, default=None, help="Model run directory; defaults to the latest.")
    parser.add_argument("--top", type=int, default=25)
    parser.add_argument("--vol-window", type=int, default=DEFAULT_VOL_WINDOW)
    parser.add_argument("--force", action="store_true", help="Rank even if the model did not beat baseline.")
    args = parser.parse_args()

    model_dir = args.model or latest_model_dir()
    ranked = rank_day(args.day, model_dir, vol_window=args.vol_window, top=args.top, force=args.force)

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
