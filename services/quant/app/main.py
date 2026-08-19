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

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app.pricing import american_price, bsm_greeks, implied_vol

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
