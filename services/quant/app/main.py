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

from app.classify import SymbolRow, classify_universe
from app.exit import ExitTarget, compute_initial_exit_target, evaluate_exit
from app.pricing import american_price, bsm_greeks, implied_vol
from app.rank import RankedContract, latest_model_dir, load_model, rank_day, score_held_contracts

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


class UniverseSymbol(BaseModel):
    symbol: str
    #: Deliberately not `Field(min_length=1)`: this is a batch endpoint, and
    #: Pydantic validates the whole list atomically — rejecting the request
    #: over one blank name would fail classification for the other ~7,000
    #: rows too. `classify_universe`'s own length guard handles a blank name
    #: per-row instead, which is what a batch of this shape actually needs.
    name: str


class ClassifyUniverseRequest(BaseModel):
    symbols: list[UniverseSymbol]


class ClassifyUniverseResponse(BaseModel):
    #: Keyed by symbol; only warrants/units/rights are present — see
    #: classify_universe's own docstring for why absence, not a "common"
    #: value, is what marks a symbol as real common stock.
    excluded: dict[str, str]


@app.post("/classify-universe", response_model=ClassifyUniverseResponse)
def classify_universe_endpoint(request: ClassifyUniverseRequest) -> ClassifyUniverseResponse:
    """Separates SPAC-derivative warrants/units/rights from real common stock
    across a full exchange symbol directory — see classify.py's module
    docstring for why this can't be done by ticker shape alone.
    """
    rows = [SymbolRow(s.symbol, s.name) for s in request.symbols]
    return ClassifyUniverseResponse(excluded=classify_universe(rows))


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
    #: A first-pass exit plan, populated only for a fresh entry candidate
    #: (`/rank`, where `entry_day`/`horizon` are known) — null for a
    #: position-health re-score (`/position-health`), which reports EV
    #: against a target the position already has recorded elsewhere. See
    #: exit.py's own module docstring: explicitly a tunable starting rule,
    #: not a validated one.
    suggested_target_exit_price: float | None = None
    suggested_stop_loss_price: float | None = None
    suggested_target_exit_date: str | None = None

    @classmethod
    def from_ranked(
        cls, c: RankedContract, entry_day: str | None = None, horizon: int | None = None
    ) -> "RankedContractResponse":
        target = (
            compute_initial_exit_target(c.market_price, c.expiry, entry_day, horizon)
            if entry_day is not None and horizon is not None
            else None
        )
        return cls(
            occ_symbol=c.occ_symbol, underlying=c.underlying, expiry=c.expiry, type=c.type,
            strike=c.strike, dte=c.dte, market_price=c.market_price, market_iv=c.market_iv,
            forecast_vol=c.forecast_vol, forecast_drift=c.forecast_drift,
            forecast_value=c.forecast_value, ev=c.ev, ev_per_risk=c.ev_per_risk,
            prob_profit=c.prob_profit,
            suggested_target_exit_price=target.target_exit_price if target else None,
            suggested_stop_loss_price=target.stop_loss_price if target else None,
            suggested_target_exit_date=target.target_exit_date if target else None,
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

    horizon = manifest.get("horizon")
    return RankResponse(
        model_run_id=manifest["run_id"],
        model_beats_baseline=manifest["metrics"]["beats_baseline"],
        model_information_coefficient=manifest["metrics"]["information_coefficient"],
        contracts=[RankedContractResponse.from_ranked(c, entry_day=request.day, horizon=horizon) for c in ranked],
    )


class HeldContract(BaseModel):
    occ_symbol: str
    underlying: str


class PositionHealthRequest(BaseModel):
    """Re-scores specific, already-held contracts against today's forecast
    — see score_held_contracts's own docstring for why this is not just
    `/rank` called again.
    """

    day: str = Field(description="Trading day, YYYY-MM-DD.")
    contracts: list[HeldContract]
    #: Same reasoning as RankRequest.force — a position monitor that goes
    #: silent the moment the model stops beating baseline is worse than
    #: one that keeps reporting with the caveat attached.
    force: bool = True


class PositionHealthResponse(BaseModel):
    model_run_id: str
    model_beats_baseline: bool
    #: keyed by occ_symbol; a null value means no current view could be
    #: computed (expired, no quote today, no rate for its DTE) — never
    #: fabricated as "unchanged" or dropped from the response silently.
    contracts: dict[str, RankedContractResponse | None]


@app.post("/position-health", response_model=PositionHealthResponse)
def position_health(request: PositionHealthRequest) -> PositionHealthResponse:
    try:
        model_dir = latest_model_dir()
        _, manifest = load_model(model_dir)
        scored = score_held_contracts(
            [c.model_dump() for c in request.contracts],
            request.day,
            model_dir,
            force=request.force,
        )
    except SystemExit as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    return PositionHealthResponse(
        model_run_id=manifest["run_id"],
        model_beats_baseline=manifest["metrics"]["beats_baseline"],
        contracts={
            occ: (RankedContractResponse.from_ranked(c) if c is not None else None)
            for occ, c in scored.items()
        },
    )


class ExitTargetRequest(BaseModel):
    target_exit_price: float
    stop_loss_price: float
    target_exit_date: str


class ExitDecisionRequest(BaseModel):
    """Everything `evaluate_exit` needs, all of it already known to the
    caller — see exit.py's own module docstring for why this endpoint never
    touches the model or the database: Node already has a live price (from
    its own Polygon fetch) and today's EV/news view (from the once-daily
    `/position-health` call), and re-deriving either here on every intraday
    tick would be the unpaced-cost mistake this project has already made
    once with the options vendor itself.
    """

    current_price: float
    dte: int = Field(ge=0)
    target: ExitTargetRequest
    entry_ev: float | None = None
    current_ev: float | None = None
    new_documents_count: int = 0


class ExitDecisionResponse(BaseModel):
    action: str
    new_target_exit_price: float | None
    new_target_exit_date: str | None
    reason: str
    triggered_by: str


@app.post("/exit-decision", response_model=ExitDecisionResponse)
def exit_decision(request: ExitDecisionRequest) -> ExitDecisionResponse:
    """The recheck an open position gets every time the intraday exit job
    fires — see `apps/server/src/lib/options/exitEngine.ts`.
    """
    target = ExitTarget(
        target_exit_price=request.target.target_exit_price,
        stop_loss_price=request.target.stop_loss_price,
        target_exit_date=request.target.target_exit_date,
        reason="",
    )
    decision = evaluate_exit(
        current_price=request.current_price,
        dte=request.dte,
        target=target,
        entry_ev=request.entry_ev,
        current_ev=request.current_ev,
        new_documents_count=request.new_documents_count,
    )
    return ExitDecisionResponse(
        action=decision.action,
        new_target_exit_price=decision.new_target_exit_price,
        new_target_exit_date=decision.new_target_exit_date,
        reason=decision.reason,
        triggered_by=decision.triggered_by,
    )
