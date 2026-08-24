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
from pydantic import BaseModel, Field, model_validator

from app.classify import SymbolRow, classify_universe
from app.exit import ExitTarget, compute_initial_exit_target, evaluate_exit
from app.pricing import american_price, bsm_greeks, implied_vol
from app.rank import (
    RankedContract,
    latest_model_dir,
    load_model,
    rank_day,
    score_held_contracts,
    select_entries,
)
from app.realestate import (
    CashFlowResult,
    HorizonInputs,
    HorizonProjection,
    LandTransferTax,
    cap_rate_pct,
    cash_flow_axis_score,
    cash_on_cash_return_pct,
    cmhc_premium,
    cmhc_premium_pst,
    land_transfer_tax,
    monthly_cash_flow,
    monthly_mortgage_payment,
    project_horizons,
)

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


def _try_compute_exit_target(
    market_price: float, expiry: str, entry_day: str, horizon: int
) -> ExitTarget | None:
    """`compute_initial_exit_target` refuses (raises `ValueError`) when a
    contract's remaining life leaves no day that both exists and clears its
    DTE floor — see exit.py's own docstring. That is the same "no honest
    target exists" case as `entry_day`/`horizon` being unknown, so it gets
    the same treatment here: null suggested fields, not a crash of the
    entire `/rank` response over one contract too close to expiry.
    """
    try:
        return compute_initial_exit_target(market_price, expiry, entry_day, horizon)
    except ValueError:
        return None


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
            _try_compute_exit_target(c.market_price, c.expiry, entry_day, horizon)
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


class ExitTargetResponse(BaseModel):
    target_exit_price: float
    stop_loss_price: float
    target_exit_date: str


class ComputeExitTargetRequest(BaseModel):
    """An exit plan for a position that is already open.

    The entry-time path (`/rank`, `/select-entries`) attaches a plan to
    every contract it suggests, so this exists for the positions that
    somehow have none — opened before the exit engine existed, or opened
    through a code path whose plan-write did not land. Those positions are
    invisible to `managedOpenOrders()` and are therefore never managed at
    all, which is strictly worse than a plan computed a few days late.

    `horizon` is read from the registered model rather than supplied, for
    the same reason `/select-entries` reads it: the forecast horizon is a
    property of the model, and a caller passing its own number could
    silently produce a target date the model's prediction says nothing
    about.
    """

    entry_price: float = Field(gt=0)
    expiry: str = Field(description="Contract expiry, YYYY-MM-DD.")
    #: The day the plan is anchored to. For an adopted position this is
    #: normally *today*, not the original entry day: a horizon measured
    #: from an entry several days past could land a target date already in
    #: the past, which is not a plan, just a stale number.
    anchor_day: str


class ComputeExitTargetResponse(BaseModel):
    #: Null when the contract's remaining life leaves no date that clears
    #: the DTE floor — the caller must leave such a position unmanaged
    #: rather than invent a target inside the floor. See exit.py.
    target: ExitTargetResponse | None
    refusal: str | None
    horizon: int
    model_run_id: str


@app.post("/exit-target", response_model=ComputeExitTargetResponse)
def compute_exit_target(request: ComputeExitTargetRequest) -> ComputeExitTargetResponse:
    """Compute a first-pass exit plan for an already-open position."""
    try:
        model_dir = latest_model_dir()
        _, manifest = load_model(model_dir)
    except SystemExit as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    horizon = manifest.get("horizon")
    if horizon is None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Model {manifest['run_id']} has no `horizon` in its manifest, so no exit plan "
                f"can be computed for any position."
            ),
        )

    try:
        target = compute_initial_exit_target(
            request.entry_price, request.expiry, request.anchor_day, horizon
        )
    except ValueError as e:
        return ComputeExitTargetResponse(
            target=None, refusal=str(e), horizon=horizon, model_run_id=manifest["run_id"]
        )

    return ComputeExitTargetResponse(
        target=ExitTargetResponse(
            target_exit_price=target.target_exit_price,
            stop_loss_price=target.stop_loss_price,
            target_exit_date=target.target_exit_date,
        ),
        refusal=None,
        horizon=horizon,
        model_run_id=manifest["run_id"],
    )


class SelectEntriesRequest(BaseModel):
    """Capital-constrained entry selection for the auto-entry job — see
    `select_entries`' own docstring for the allocation rule and the real
    $122k-contract incident that motivated it. The caller (autoEntry.ts)
    supplies the account's actual state; ranking happens here so the whole
    decision is one call, not a ranked list shipped over and back.
    """

    day: str = Field(description="Trading day, YYYY-MM-DD.")
    held_underlyings: list[str] = []
    #: Dollars actually available to deploy, after the caller's own reserve.
    available_capital: float = Field(ge=0)
    open_position_count: int = Field(ge=0, default=0)
    max_concurrent_positions: int = Field(gt=0)
    max_new_positions: int = Field(gt=0)
    min_ev_per_risk: float
    min_prob_profit: float = Field(ge=0, le=1)
    #: Maturity band the forecast can actually speak to — see
    #: `select_entries` for why a fixed-horizon drift model should not be
    #: pricing entries at arbitrary DTE in either direction.
    min_dte: int = Field(gt=0)
    max_dte: int = Field(gt=0)
    #: Far wider than `/rank`'s 25, deliberately. `rank_day` cuts to the
    #: top N by EV *before* `select_entries` dedups to one contract per
    #: underlying, so a narrow cut on a concentrated board leaves nothing
    #: to diversify into: on the real 2026-08-21 board, all 25 top-EV
    #: contracts were the same underlying (SNDK), which would cap this at
    #: one position no matter how much capital or how many slots were
    #: free. A wide cut is what lets the per-underlying dedup actually
    #: find distinct names.
    top: int = 400

    @model_validator(mode="after")
    def _dte_band_is_ordered(self) -> SelectEntriesRequest:
        if self.max_dte < self.min_dte:
            # An inverted band matches nothing, and the caller would read the
            # empty result as "the market offered nothing today" — the same
            # misattribution the missing-horizon 409 below exists to prevent.
            raise ValueError(f"max_dte ({self.max_dte}) is below min_dte ({self.min_dte})")
        return self


class SelectedEntry(BaseModel):
    """A chosen contract and the size to take in it — see `select_entries`
    for why sizing is equal-weight rather than proportional to EV."""

    contract: RankedContractResponse
    quantity: int
    cost: float


class SelectEntriesResponse(BaseModel):
    model_run_id: str
    model_beats_baseline: bool
    #: Every selected contract carries a non-null suggested exit plan —
    #: candidates whose plan can't be computed (see exit.py's refusal case)
    #: are excluded before selection rather than opened unmanaged.
    selected: list[SelectedEntry]


@app.post("/select-entries", response_model=SelectEntriesResponse)
def select_entries_endpoint(request: SelectEntriesRequest) -> SelectEntriesResponse:
    try:
        model_dir = latest_model_dir()
        _, manifest = load_model(model_dir)
        # The band goes into `rank_day`, not just into `select_entries`:
        # the top-`top` cut is by absolute EV, which grows with maturity,
        # so filtering afterwards can leave nothing in band on a board
        # whose long-dated contracts alone fill the cut. See rank_day's
        # docstring. `select_entries` re-applies it as a cheap invariant.
        ranked = rank_day(
            request.day,
            model_dir,
            top=request.top,
            force=True,
            min_dte=request.min_dte,
            max_dte=request.max_dte,
        )
    except SystemExit as e:
        raise HTTPException(status_code=409, detail=str(e)) from e

    horizon = manifest.get("horizon")
    if horizon is None:
        # Every candidate would be filtered out below, and the caller would
        # report it as "nothing cleared the bar today" — blaming the market
        # for what is actually a broken model artifact. Refuse loudly
        # instead, the same 409 shape rank_day's own refusals use.
        raise HTTPException(
            status_code=409,
            detail=(
                f"Model {manifest['run_id']} has no `horizon` in its manifest, so no exit plan "
                f"can be computed for any candidate. Auto-entry cannot run against it."
            ),
        )

    # A candidate with no computable exit plan can't be auto-managed —
    # opening it would leave a position the exit engine never sees again.
    # Excluded before allocation so it can't consume a selection slot.
    plannable = [
        c
        for c in ranked
        if _try_compute_exit_target(c.market_price, c.expiry, request.day, horizon) is not None
    ]

    selected = select_entries(
        plannable,
        held_underlyings=set(request.held_underlyings),
        available_capital=request.available_capital,
        open_position_count=request.open_position_count,
        max_concurrent_positions=request.max_concurrent_positions,
        max_new_positions=request.max_new_positions,
        min_ev_per_risk=request.min_ev_per_risk,
        min_prob_profit=request.min_prob_profit,
        min_dte=request.min_dte,
        max_dte=request.max_dte,
    )

    return SelectEntriesResponse(
        model_run_id=manifest["run_id"],
        model_beats_baseline=manifest["metrics"]["beats_baseline"],
        selected=[
            SelectedEntry(
                contract=RankedContractResponse.from_ranked(
                    s.contract, entry_day=request.day, horizon=horizon
                ),
                quantity=s.quantity,
                cost=s.cost,
            )
            for s in selected
        ],
    )


class PropertyComputeRequest(BaseModel):
    """One property's deterministic financials — see realestate.py's module
    docstring for the unit/rate conventions (dollars, decimal rates)."""

    purchase_price: float
    down_payment_pct: float = Field(ge=5, le=100)
    mortgage_rate: float
    amortization_years: int = 25
    #: 0 is a valid answer — not every listing is meant to be rented.
    expected_monthly_rent: float = 0.0
    annual_property_tax: float
    hoa_monthly: float = 0.0
    #: A rough Canadian home-insurance placeholder, editable in the UI —
    #: not a quote.
    annual_insurance: float = 1200.0
    marginal_tax_rate: float
    #: 'ON' fully models land transfer tax; anything else returns modeled=False.
    province: str = "OTHER"
    city: str | None = None
    is_primary_residence: bool = True
    realtor_commission_pct: float = 5.0
    legal_fees: float = 1500.0
    other_closing_costs: float = 800.0
    maintenance_reserve_pct: float = 5.0
    vacancy_allowance_pct: float = 4.0
    property_mgmt_fee_pct: float = 0.0


class ComputedFinancialsResponse(BaseModel):
    purchase_price: float
    down_payment_amount: float
    #: Includes the financed CMHC premium, if any — the actual amount owed
    #: month to month, not the pre-premium base loan.
    loan_principal: float
    monthly_mortgage_payment: float
    cmhc_premium: float
    cmhc_premium_pst: float
    #: Set only when the scenario isn't really CMHC-insurable as modeled —
    #: see realestate.py's cmhc_premium docstring.
    cmhc_note: str | None
    land_transfer_tax: LandTransferTax
    total_closing_costs: float
    total_cash_invested: float
    monthly_cash_flow: CashFlowResult
    annual_noi: float
    cap_rate_pct: float
    cash_on_cash_return_pct: float
    cash_flow_axis_score: float
    assumed_annual_appreciation_rate: float
    horizons: list[HorizonProjection]


@app.post("/realestate/compute", response_model=ComputedFinancialsResponse)
def realestate_compute(request: PropertyComputeRequest) -> ComputedFinancialsResponse:
    """Everything downstream of one property's numbers, assembled once here
    so neither Node nor the LLM agents ever re-derive them — see
    `apps/server/src/lib/agents/realestate/financials.ts` on the Node side."""
    down_payment_amount = request.purchase_price * request.down_payment_pct / 100.0
    base_loan = request.purchase_price - down_payment_amount

    premium = cmhc_premium(base_loan, request.down_payment_pct)
    premium_pst = cmhc_premium_pst(premium, request.province)
    # The premium is financed into the mortgage itself, not paid in cash —
    # only its PST is a closing-day cash cost. See realestate.py.
    loan_principal = base_loan + premium
    payment = monthly_mortgage_payment(loan_principal, request.mortgage_rate, request.amortization_years)

    cmhc_note = None
    if not request.is_primary_residence and request.down_payment_pct < 20.0:
        cmhc_note = (
            "Non-owner-occupied purchases are typically NOT CMHC-insurable and normally "
            "require at least 20% down regardless — this premium is a what-if figure, not a real quote."
        )

    ltt = land_transfer_tax(request.purchase_price, request.province, request.city)
    total_closing_costs = ltt.total + request.legal_fees + request.other_closing_costs + premium_pst
    total_cash_invested = down_payment_amount + total_closing_costs

    cash_flow = monthly_cash_flow(
        rent=request.expected_monthly_rent,
        mortgage_pi=payment,
        property_tax_annual=request.annual_property_tax,
        insurance_annual=request.annual_insurance,
        hoa_monthly=request.hoa_monthly,
        maintenance_reserve_pct=request.maintenance_reserve_pct,
        vacancy_allowance_pct=request.vacancy_allowance_pct,
        property_mgmt_fee_pct=request.property_mgmt_fee_pct,
    )

    annual_rent = request.expected_monthly_rent * 12
    annual_maintenance = annual_rent * request.maintenance_reserve_pct / 100.0
    annual_vacancy = annual_rent * request.vacancy_allowance_pct / 100.0
    annual_mgmt_fee = annual_rent * request.property_mgmt_fee_pct / 100.0
    annual_hoa = request.hoa_monthly * 12
    annual_noi = (
        annual_rent
        - request.annual_property_tax
        - request.annual_insurance
        - annual_hoa
        - annual_maintenance
        - annual_vacancy
        - annual_mgmt_fee
    )

    coc = cash_on_cash_return_pct(cash_flow.net * 12, total_cash_invested)
    cf_score = cash_flow_axis_score(coc)

    horizons = project_horizons(
        HorizonInputs(
            purchase_price=request.purchase_price,
            loan_principal=loan_principal,
            mortgage_rate=request.mortgage_rate,
            amortization_years=request.amortization_years,
            monthly_pretax_cash_flow=cash_flow.net,
            annual_rent=annual_rent,
            annual_property_tax=request.annual_property_tax,
            annual_insurance=request.annual_insurance,
            annual_maintenance=annual_maintenance,
            annual_mgmt_fee=annual_mgmt_fee,
            annual_hoa=annual_hoa,
            marginal_tax_rate=request.marginal_tax_rate,
            is_primary_residence=request.is_primary_residence,
            realtor_commission_pct=request.realtor_commission_pct,
            legal_fees=request.legal_fees,
            closing_costs_added_to_acb=ltt.total + request.legal_fees + request.other_closing_costs,
        )
    )

    return ComputedFinancialsResponse(
        purchase_price=request.purchase_price,
        down_payment_amount=down_payment_amount,
        loan_principal=loan_principal,
        monthly_mortgage_payment=payment,
        cmhc_premium=premium,
        cmhc_premium_pst=premium_pst,
        cmhc_note=cmhc_note,
        land_transfer_tax=ltt,
        total_closing_costs=total_closing_costs,
        total_cash_invested=total_cash_invested,
        monthly_cash_flow=cash_flow,
        annual_noi=annual_noi,
        cap_rate_pct=cap_rate_pct(annual_noi, request.purchase_price),
        cash_on_cash_return_pct=coc,
        cash_flow_axis_score=cf_score,
        assumed_annual_appreciation_rate=0.035,
        horizons=horizons,
    )
