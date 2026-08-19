"""HTTP surface for the quant sidecar.

Deliberately thin. The sidecar's real work — feature building, training,
backtesting — reads the Parquet corpus off disk, because moving millions of
rows over HTTP to a process on the same machine would be absurd. What crosses
this boundary is only what Fastify cannot compute for itself, and today that is
implied volatility and greeks.

Node owns every database write; this service reads and returns JSON. That keeps
SQLite to a single writer and makes the ownership question unambiguous rather
than a convention someone has to remember.
"""

from __future__ import annotations

import sys

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from app.pricing import american_price, bsm_greeks, implied_vol
from app.rank import RankedContract, latest_model_dir, load_model, rank_day

app = FastAPI(title="org-quant", version="0.1.0")


class PriceRequest(BaseModel):
    """One contract to solve.

    Prices arrive as floats in dollars, not the E4 integers the database uses:
    converting at this boundary keeps scaling bugs out of the solver, and the
    payload is JSON either way.
    """

    key: str = Field(description="Caller's identifier, echoed back unchanged.")
    price: float = Field(description="Mid, or whichever price is being inverted.")
    spot: float
    strike: float
    years: float
    rate: float
    div_yield: float = 0.0
    is_call: bool
    american: bool = True


class PriceResult(BaseModel):
    key: str
    #: Basis points, or null when the quote determines no volatility. Null is a
    #: real answer here, not a failure — see pricing.implied_vol.
    iv_bps: int | None = None
    delta: float | None = None
    gamma: float | None = None
    vega: float | None = None
    theta: float | None = None
    #: Set when we declined to solve, so the caller can count reasons.
    skipped: str | None = None


class BatchRequest(BaseModel):
    rows: list[PriceRequest]


class BatchResponse(BaseModel):
    results: list[PriceResult]


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "service": "org-quant",
        "version": app.version,
        "python": sys.version.split()[0],
    }


@app.post("/price", response_model=BatchResponse)
def price(request: BatchRequest) -> BatchResponse:
    """Solve implied vol and greeks for a batch of contracts.

    Batched because a nightly capture solves a hundred thousand contracts and
    one HTTP round trip each would dominate the runtime.
    """
    results: list[PriceResult] = []

    for row in request.rows:
        try:
            vol = implied_vol(
                row.price,
                row.spot,
                row.strike,
                row.years,
                row.rate,
                row.div_yield,
                row.is_call,
                american=row.american,
            )
        except OverflowError:
            # The Bjerksund-Stensland approximation blows up at some vol
            # candidates the Brent search probes on its way to a real root —
            # e.g. `spot**beta` with beta pushed huge by a near-zero vol²
            # denominator. That candidate is not a solution, so this is the
            # same honest "no answer" as `vol is None`, not a batch failure —
            # one degenerate contract must never cost every other row in the
            # same request its price.
            results.append(PriceResult(key=row.key, skipped="pricing-overflow"))
            continue
        if vol is None:
            # No implied vol means no greeks either: greeks evaluated at an
            # invented volatility are invented numbers wearing a decimal point.
            results.append(PriceResult(key=row.key, skipped="unidentified-vol"))
            continue

        g = bsm_greeks(
            row.spot, row.strike, row.years, row.rate, row.div_yield, vol, row.is_call
        )
        results.append(
            PriceResult(
                key=row.key,
                iv_bps=round(vol * 10_000),
                delta=g.delta,
                gamma=g.gamma,
                vega=g.vega,
                theta=g.theta,
            )
        )

    return BatchResponse(results=results)


class TheoreticalRequest(BaseModel):
    """Price a contract at a stated volatility, rather than inverting for one."""

    spot: float
    strike: float
    years: float
    rate: float
    div_yield: float = 0.0
    vol: float
    is_call: bool


@app.post("/theoretical")
def theoretical(request: TheoreticalRequest) -> dict[str, float]:
    value = american_price(
        request.spot,
        request.strike,
        request.years,
        request.rate,
        request.div_yield,
        request.vol,
        request.is_call,
    )
    g = bsm_greeks(
        request.spot,
        request.strike,
        request.years,
        request.rate,
        request.div_yield,
        request.vol,
        request.is_call,
    )
    return {
        "price": value,
        "delta": g.delta,
        "gamma": g.gamma,
        "vega": g.vega,
        "theta": g.theta,
    }


class RankRequest(BaseModel):
    """Ranks gate-passing contracts by expected value under the current
    forecast model — see rank.py's own module docstring for the full
    scope and honest limitations of what that forecast actually is.
    """

    day: str = Field(description="Trading day, YYYY-MM-DD.")
    top: int = 25
    #: rank_day refuses to run against a model that hasn't beaten its own
    #: baseline out-of-fold, unless told to anyway — see rank.py. Defaults
    #: to True here because the caller (the UI) always needs a response to
    #: show, with the model's real metrics surfaced in it rather than
    #: hidden, not a silent refusal.
    force: bool = True
    #: Drops any contract costing more than this to buy one of, before
    #: ranking — see rank_underlying's own docstring for why this can't be
    #: a post-hoc filter on the response instead.
    max_capital: float | None = Field(default=None, gt=0)


class RankedContractResponse(BaseModel):
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

    @classmethod
    def from_ranked(cls, c: RankedContract) -> "RankedContractResponse":
        return cls(
            occ_symbol=c.occ_symbol, underlying=c.underlying, expiry=c.expiry, type=c.type,
            strike=c.strike, dte=c.dte, market_price=c.market_price, market_iv=c.market_iv,
            forecast_vol=c.forecast_vol, forecast_drift=c.forecast_drift,
            forecast_value=c.forecast_value, ev=c.ev, ev_per_risk=c.ev_per_risk,
            prob_profit=c.prob_profit,
        )


class RankResponse(BaseModel):
    model_run_id: str
    #: The single most important field in this response — see rank.py's
    #: own refusal-by-default design. A caller that only reads `contracts`
    #: and ignores this is exactly the mistake the whole harness exists to
    #: prevent.
    model_beats_baseline: bool
    model_information_coefficient: float
    contracts: list[RankedContractResponse]


@app.post("/rank", response_model=RankResponse)
def rank(request: RankRequest) -> RankResponse:
    try:
        model_dir = latest_model_dir()
        _, manifest = load_model(model_dir)
        ranked = rank_day(
            request.day, model_dir, top=request.top, force=request.force, max_capital=request.max_capital
        )
    except SystemExit as e:
        # rank_day and latest_model_dir raise SystemExit for every refusal
        # (no trained model, no bars, no rate curve, model doesn't beat
        # baseline) — the right behaviour for a CLI script exiting cleanly,
        # but SystemExit inherits from BaseException, not Exception, and
        # would otherwise escape straight past FastAPI's handling and take
        # this whole shared sidecar process down with it.
        raise HTTPException(status_code=409, detail=str(e)) from e

    return RankResponse(
        model_run_id=manifest["run_id"],
        model_beats_baseline=manifest["metrics"]["beats_baseline"],
        model_information_coefficient=manifest["metrics"]["information_coefficient"],
        contracts=[RankedContractResponse.from_ranked(c) for c in ranked],
    )
