"""Mortgage, tax, and appreciation math for the real-estate investment
assistant.

Two conventions, stated once, mirroring `pricing.py`'s own header:

* **Rates are decimals per annum.** 5.5% is ``0.055``. A percentage typed by
  a user (e.g. "5.5") is converted to a decimal at the API boundary
  (`main.py`), never inside these functions.
* **Money is floats in dollars.** The integer-cents representation belongs
  to the database and the TypeScript side; converting at this boundary keeps
  the arithmetic here readable, the same reasoning `pricing.py` gives for
  keeping option prices in dollars rather than E4 integers.

Every number this module produces is handed to the LLM agents as *grounded
input*, never derived by them — the whole point of keeping this arithmetic
here rather than asking a model to do it.

Canadian tax specifics, and their honest limits:

* Land transfer tax is fully modeled only for Ontario (provincial LTT) plus
  Toronto's municipal LTT. Every other province/city returns ``modeled False``
  and a total of 0 — an admitted gap, not a silently wrong number.
* Capital gains tax assumes the Canadian principal residence exemption (PRE)
  applies in full when ``is_primary_residence`` is set, i.e. capital gains on
  sale are untaxed. CRA's change-in-use rules can partially void the PRE when
  a self-contained unit was rented out during ownership — not modeled here.
* Rental income tax deducts mortgage *interest* only (never principal),
  property tax, insurance, maintenance, management fees, and HOA. Negative
  net rental income is treated as 0 taxable income — no loss-carryforward
  modeled.
* CMHC premium tiers below are the published rates as of when this was
  written and should be spot-checked against CMHC's current rate card
  periodically, not treated as a permanent constant.
"""

from __future__ import annotations

from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Mortgage
# ---------------------------------------------------------------------------


def monthly_mortgage_payment(principal: float, annual_rate: float, term_years: int) -> float:
    """Fixed monthly principal-and-interest payment, standard amortization formula."""
    n = term_years * 12
    if n <= 0:
        raise ValueError(f"term_years must be positive, got {term_years}")
    monthly_rate = annual_rate / 12.0
    if monthly_rate == 0.0:
        return principal / n
    factor = (1.0 + monthly_rate) ** n
    return principal * monthly_rate * factor / (factor - 1.0)


class AmortizationMonth(BaseModel):
    month: int
    principal: float
    interest: float
    balance: float


def amortization_schedule(
    principal: float, annual_rate: float, term_years: int, months: int
) -> list[AmortizationMonth]:
    """The first `months` rows of the full amortization table.

    `months` is capped at the mortgage's own term in months — asking for a
    schedule past payoff returns a shorter list, not fabricated zero rows.
    """
    payment = monthly_mortgage_payment(principal, annual_rate, term_years)
    monthly_rate = annual_rate / 12.0
    total_months = min(months, term_years * 12)
    balance = principal
    rows: list[AmortizationMonth] = []
    for m in range(1, total_months + 1):
        interest = balance * monthly_rate
        principal_paid = min(payment - interest, balance)
        balance = max(balance - principal_paid, 0.0)
        rows.append(AmortizationMonth(month=m, principal=principal_paid, interest=interest, balance=balance))
    return rows


def remaining_balance(principal: float, annual_rate: float, term_years: int, months_elapsed: int) -> float:
    if months_elapsed <= 0:
        return principal
    if months_elapsed >= term_years * 12:
        return 0.0
    schedule = amortization_schedule(principal, annual_rate, term_years, months_elapsed)
    return schedule[-1].balance


def annual_interest_paid(schedule: list[AmortizationMonth], year: int) -> float:
    """Sum of interest across months `(year-1)*12+1` .. `year*12`.

    0 for a year entirely past the end of `schedule` (e.g. the mortgage was
    already paid off, or `schedule` wasn't built out that far) — not an
    error, since a caller projecting cash flow past payoff genuinely owes no
    more interest.
    """
    start, end = (year - 1) * 12 + 1, year * 12
    return sum(m.interest for m in schedule if start <= m.month <= end)


# ---------------------------------------------------------------------------
# CMHC mortgage default insurance (Canada)
# ---------------------------------------------------------------------------

#: (min_pct inclusive, max_pct exclusive, premium rate). >=20% down -> 0.
#: CMHC's actual minimum down payment is 5% — a request below that has no
#: real insured product behind it; this function still returns a number
#: (the 5-10% tier's rate) rather than raising, since the caller may want a
#: what-if figure, but that fallback is not a real quote.
CMHC_PREMIUM_TIERS: list[tuple[float, float, float]] = [
    (5.0, 10.0, 0.0400),
    (10.0, 15.0, 0.0310),
    (15.0, 20.0, 0.0280),
]


def cmhc_premium(principal: float, down_payment_pct: float) -> float:
    if down_payment_pct >= 20.0:
        return 0.0
    for lo, hi, rate in CMHC_PREMIUM_TIERS:
        if lo <= down_payment_pct < hi:
            return principal * rate
    # Below 5% down — no real tier; fall back to the richest (5-10%) rate as
    # a conservative estimate, not a real insurable quote.
    return principal * CMHC_PREMIUM_TIERS[0][2]


def cmhc_premium_pst(premium: float, province: str) -> float:
    """Provincial sales tax on the CMHC premium itself — paid in cash at
    closing, never added to the financed principal. Ontario is 8%; every
    other province modeled here is 0 (not necessarily accurate, just not
    yet researched — see the module docstring's stance on admitted gaps)."""
    return premium * 0.08 if province == "ON" else 0.0


# ---------------------------------------------------------------------------
# Land transfer tax
# ---------------------------------------------------------------------------


class LandTransferTax(BaseModel):
    provincial: float
    municipal: float
    total: float
    #: False means "not modeled for this province/city", total is 0 by
    #: construction, not a real answer — see module docstring.
    modeled: bool


#: (bracket floor, rate) — marginal, applied progressively. The floor of the
#: next bracket is this bracket's ceiling.
ONTARIO_LTT_BRACKETS: list[tuple[float, float]] = [
    (0.0, 0.005),
    (55_000.0, 0.010),
    (250_000.0, 0.015),
    (400_000.0, 0.020),
    (2_000_000.0, 0.025),
]

#: Toronto's municipal LTT mirrors the province up to $2M, then adds its own
#: higher brackets above that — current published brackets as of writing.
TORONTO_MLTT_BRACKETS: list[tuple[float, float]] = [
    (0.0, 0.005),
    (55_000.0, 0.010),
    (250_000.0, 0.015),
    (400_000.0, 0.020),
    (2_000_000.0, 0.025),
    (3_000_000.0, 0.035),
    (4_000_000.0, 0.045),
    (5_000_000.0, 0.055),
    (10_000_000.0, 0.065),
    (20_000_000.0, 0.075),
]


def _marginal_bracket_tax(price: float, brackets: list[tuple[float, float]]) -> float:
    total = 0.0
    for i, (floor, rate) in enumerate(brackets):
        if price <= floor:
            break
        ceiling = brackets[i + 1][0] if i + 1 < len(brackets) else float("inf")
        total += (min(price, ceiling) - floor) * rate
    return total


def land_transfer_tax(purchase_price: float, province: str, city: str | None) -> LandTransferTax:
    if province != "ON":
        return LandTransferTax(provincial=0.0, municipal=0.0, total=0.0, modeled=False)
    provincial = _marginal_bracket_tax(purchase_price, ONTARIO_LTT_BRACKETS)
    municipal = _marginal_bracket_tax(purchase_price, TORONTO_MLTT_BRACKETS) if (city or "").strip().lower() == "toronto" else 0.0
    return LandTransferTax(provincial=provincial, municipal=municipal, total=provincial + municipal, modeled=True)


# ---------------------------------------------------------------------------
# Appreciation — fixed, settled, not user-editable
# ---------------------------------------------------------------------------

ASSUMED_ANNUAL_APPRECIATION_RATE = 0.035


def projected_value(purchase_price: float, years: int) -> float:
    return purchase_price * (1.0 + ASSUMED_ANNUAL_APPRECIATION_RATE) ** years


# ---------------------------------------------------------------------------
# Cash flow / yield
# ---------------------------------------------------------------------------


class CashFlowResult(BaseModel):
    net: float
    breakdown: dict[str, float]


def monthly_cash_flow(
    rent: float,
    mortgage_pi: float,
    property_tax_annual: float,
    insurance_annual: float,
    hoa_monthly: float,
    maintenance_reserve_pct: float,
    vacancy_allowance_pct: float,
    property_mgmt_fee_pct: float,
) -> CashFlowResult:
    maintenance = rent * maintenance_reserve_pct / 100.0
    vacancy = rent * vacancy_allowance_pct / 100.0
    mgmt_fee = rent * property_mgmt_fee_pct / 100.0
    property_tax = property_tax_annual / 12.0
    insurance = insurance_annual / 12.0
    breakdown = {
        "rent": rent,
        "mortgage_pi": -mortgage_pi,
        "property_tax": -property_tax,
        "insurance": -insurance,
        "hoa": -hoa_monthly,
        "maintenance_reserve": -maintenance,
        "vacancy_allowance": -vacancy,
        "property_mgmt_fee": -mgmt_fee,
    }
    net = sum(breakdown.values())
    return CashFlowResult(net=net, breakdown=breakdown)


def cap_rate_pct(annual_noi: float, purchase_price: float) -> float:
    """NOI excludes debt service by definition — a cap rate that includes
    the mortgage payment is not a cap rate."""
    if purchase_price <= 0:
        return 0.0
    return annual_noi / purchase_price * 100.0


def cash_on_cash_return_pct(annual_net_cash_flow: float, total_cash_invested: float) -> float:
    if total_cash_invested <= 0:
        return 0.0
    return annual_net_cash_flow / total_cash_invested * 100.0


# ---------------------------------------------------------------------------
# Canadian tax
# ---------------------------------------------------------------------------


def annual_rental_income_tax(
    annual_rent: float,
    annual_interest_paid_amount: float,
    annual_property_tax: float,
    annual_insurance: float,
    annual_maintenance: float,
    annual_mgmt_fee: float,
    annual_hoa: float,
    marginal_tax_rate: float,
) -> float:
    """Principal repayment is never deductible — only interest. Negative net
    rental income is treated as 0 taxable, not a loss to carry forward or
    apply elsewhere (a real simplification, flagged in the module docstring)."""
    deductible = (
        annual_interest_paid_amount + annual_property_tax + annual_insurance + annual_maintenance + annual_mgmt_fee + annual_hoa
    )
    taxable = max(0.0, annual_rent - deductible)
    return taxable * marginal_tax_rate


def capital_gains_tax(
    sale_proceeds: float,
    selling_costs: float,
    adjusted_cost_base: float,
    marginal_tax_rate: float,
    is_primary_residence: bool,
) -> float:
    """0 whenever `is_primary_residence` — the principal residence exemption
    is assumed to apply for the full holding period. Otherwise the standard
    50% inclusion rate applies to the gain, taxed at the marginal rate."""
    if is_primary_residence:
        return 0.0
    gain = max(0.0, sale_proceeds - selling_costs - adjusted_cost_base)
    return gain * 0.5 * marginal_tax_rate


# ---------------------------------------------------------------------------
# Horizon projections
# ---------------------------------------------------------------------------


class HorizonInputs(BaseModel):
    purchase_price: float
    loan_principal: float
    mortgage_rate: float
    amortization_years: int
    monthly_pretax_cash_flow: float
    annual_rent: float
    annual_property_tax: float
    annual_insurance: float
    annual_maintenance: float
    annual_mgmt_fee: float
    annual_hoa: float
    marginal_tax_rate: float
    is_primary_residence: bool
    realtor_commission_pct: float
    legal_fees: float
    closing_costs_added_to_acb: float


class HorizonProjection(BaseModel):
    year: int
    projected_value: float
    remaining_balance: float
    equity: float
    accumulated_after_tax_cash_flow: float
    sale_selling_costs: float
    capital_gains_tax: float
    sale_equity_after_tax: float
    total_net_proceeds_after_tax: float


def project_horizons(inputs: HorizonInputs, years: tuple[int, ...] = (7, 10, 15)) -> list[HorizonProjection]:
    max_year = max(years)
    full_schedule = amortization_schedule(
        inputs.loan_principal, inputs.mortgage_rate, inputs.amortization_years, max_year * 12
    )

    results: list[HorizonProjection] = []
    for year in years:
        value = projected_value(inputs.purchase_price, year)
        balance = remaining_balance(inputs.loan_principal, inputs.mortgage_rate, inputs.amortization_years, year * 12)
        equity = value - balance

        accumulated_after_tax = 0.0
        for y in range(1, year + 1):
            interest_this_year = annual_interest_paid(full_schedule, y)
            tax_this_year = annual_rental_income_tax(
                inputs.annual_rent,
                interest_this_year,
                inputs.annual_property_tax,
                inputs.annual_insurance,
                inputs.annual_maintenance,
                inputs.annual_mgmt_fee,
                inputs.annual_hoa,
                inputs.marginal_tax_rate,
            )
            accumulated_after_tax += inputs.monthly_pretax_cash_flow * 12 - tax_this_year

        selling_costs = value * inputs.realtor_commission_pct / 100.0 + inputs.legal_fees
        acb = inputs.purchase_price + inputs.closing_costs_added_to_acb
        gains_tax = capital_gains_tax(value, selling_costs, acb, inputs.marginal_tax_rate, inputs.is_primary_residence)
        sale_equity_after_tax = equity - selling_costs - gains_tax

        results.append(
            HorizonProjection(
                year=year,
                projected_value=value,
                remaining_balance=balance,
                equity=equity,
                accumulated_after_tax_cash_flow=accumulated_after_tax,
                sale_selling_costs=selling_costs,
                capital_gains_tax=gains_tax,
                sale_equity_after_tax=sale_equity_after_tax,
                total_net_proceeds_after_tax=accumulated_after_tax + sale_equity_after_tax,
            )
        )
    return results


# ---------------------------------------------------------------------------
# Balance placement (the appreciation-vs-cash-flow chart)
# ---------------------------------------------------------------------------

BALANCE_ZONE = {"x_min": 40.0, "x_max": 75.0, "y_min": 40.0, "y_max": 75.0}

#: (cash-on-cash %, axis score) anchors, piecewise-linear between them,
#: clamped to [0, 100] outside the outer anchors.
_CASH_FLOW_ANCHORS: list[tuple[float, float]] = [(-5.0, 0.0), (0.0, 40.0), (4.0, 70.0), (8.0, 100.0)]


def cash_flow_axis_score(coc_return_pct: float) -> float:
    anchors = _CASH_FLOW_ANCHORS
    if coc_return_pct <= anchors[0][0]:
        return anchors[0][1]
    if coc_return_pct >= anchors[-1][0]:
        return anchors[-1][1]
    for (x0, y0), (x1, y1) in zip(anchors, anchors[1:]):
        if x0 <= coc_return_pct <= x1:
            frac = (coc_return_pct - x0) / (x1 - x0)
            return y0 + frac * (y1 - y0)
    return anchors[-1][1]  # unreachable, satisfies type checkers
