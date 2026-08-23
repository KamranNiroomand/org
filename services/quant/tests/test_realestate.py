"""Real-estate math tests, mirroring test_pricing.py's style: known-table
checks, boundary checks on every bracket/tier, and internal-consistency
checks (schedule sums, compounding identities)."""

from __future__ import annotations

import pytest

from app.realestate import (
    ASSUMED_ANNUAL_APPRECIATION_RATE,
    CMHC_PREMIUM_TIERS,
    ONTARIO_LTT_BRACKETS,
    TORONTO_MLTT_BRACKETS,
    HorizonInputs,
    amortization_schedule,
    annual_interest_paid,
    annual_rental_income_tax,
    capital_gains_tax,
    cash_flow_axis_score,
    cash_on_cash_return_pct,
    cap_rate_pct,
    cmhc_premium,
    cmhc_premium_pst,
    land_transfer_tax,
    monthly_cash_flow,
    monthly_mortgage_payment,
    project_horizons,
    projected_value,
    remaining_balance,
)


# ---------------------------------------------------------------------------
# Mortgage
# ---------------------------------------------------------------------------


def test_monthly_payment_matches_the_amortization_formula_by_hand() -> None:
    # $500,000 principal, 5.5%/yr, 25-year amortization, computed from the
    # textbook annuity formula independently of monthly_mortgage_payment's
    # own implementation — not just the same code checking itself.
    principal, annual_rate, n = 500_000.0, 0.055, 25 * 12
    r = annual_rate / 12.0
    expected = principal * r * (1 + r) ** n / ((1 + r) ** n - 1)
    assert monthly_mortgage_payment(principal, annual_rate, 25) == pytest.approx(expected, rel=1e-9)
    assert expected == pytest.approx(3070.44, abs=0.5)


def test_zero_rate_is_a_plain_division() -> None:
    assert monthly_mortgage_payment(240_000.0, 0.0, 20) == pytest.approx(1000.0)


def test_schedule_balance_reaches_zero_at_term() -> None:
    schedule = amortization_schedule(400_000.0, 0.045, 25, 25 * 12)
    assert schedule[-1].balance == pytest.approx(0.0, abs=1e-6)


def test_schedule_principal_plus_interest_equals_payment_each_month() -> None:
    payment = monthly_mortgage_payment(400_000.0, 0.045, 25)
    schedule = amortization_schedule(400_000.0, 0.045, 25, 12)
    for row in schedule:
        assert row.principal + row.interest == pytest.approx(payment, abs=1e-6)


def test_remaining_balance_matches_schedule_tail() -> None:
    principal, rate, term = 350_000.0, 0.06, 25
    schedule = amortization_schedule(principal, rate, term, 84)
    assert remaining_balance(principal, rate, term, 84) == pytest.approx(schedule[-1].balance, abs=1e-6)


def test_remaining_balance_is_full_principal_at_month_zero() -> None:
    assert remaining_balance(300_000.0, 0.05, 25, 0) == pytest.approx(300_000.0)


def test_remaining_balance_is_zero_past_term() -> None:
    assert remaining_balance(300_000.0, 0.05, 25, 25 * 12 + 12) == 0.0


def test_annual_interest_paid_sums_the_right_twelve_months() -> None:
    schedule = amortization_schedule(400_000.0, 0.05, 25, 24)
    year1 = annual_interest_paid(schedule, 1)
    year2 = annual_interest_paid(schedule, 2)
    assert year1 == pytest.approx(sum(m.interest for m in schedule[:12]))
    assert year2 == pytest.approx(sum(m.interest for m in schedule[12:24]))
    # Interest declines over time as principal amortizes.
    assert year2 < year1


def test_annual_interest_paid_is_zero_past_the_schedule() -> None:
    schedule = amortization_schedule(400_000.0, 0.05, 25, 12)
    assert annual_interest_paid(schedule, 5) == 0.0


# ---------------------------------------------------------------------------
# CMHC
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "down_pct,expected_rate",
    [(5.0, 0.0400), (9.99, 0.0400), (10.0, 0.0310), (14.99, 0.0310), (15.0, 0.0280), (19.99, 0.0280)],
)
def test_cmhc_premium_tier_boundaries(down_pct: float, expected_rate: float) -> None:
    principal = 300_000.0
    assert cmhc_premium(principal, down_pct) == pytest.approx(principal * expected_rate)


def test_cmhc_premium_is_zero_at_and_above_20_percent_down() -> None:
    assert cmhc_premium(300_000.0, 20.0) == 0.0
    assert cmhc_premium(300_000.0, 35.0) == 0.0


def test_cmhc_premium_below_five_percent_falls_back_to_richest_tier() -> None:
    principal = 300_000.0
    assert cmhc_premium(principal, 4.99) == pytest.approx(principal * CMHC_PREMIUM_TIERS[0][2])


def test_cmhc_premium_pst_applies_only_in_ontario() -> None:
    premium = 10_000.0
    assert cmhc_premium_pst(premium, "ON") == pytest.approx(800.0)
    assert cmhc_premium_pst(premium, "OTHER") == 0.0


# ---------------------------------------------------------------------------
# Land transfer tax
# ---------------------------------------------------------------------------


def test_ontario_ltt_at_each_bracket_edge() -> None:
    # $54,999 stays entirely in the first bracket: 0.5%.
    assert land_transfer_tax(54_999.0, "ON", None).provincial == pytest.approx(54_999.0 * 0.005)
    # $250,000 exactly: 0.5% of 55k + 1.0% of 195k.
    expected_250k = 55_000 * 0.005 + (250_000 - 55_000) * 0.010
    assert land_transfer_tax(250_000.0, "ON", None).provincial == pytest.approx(expected_250k)
    # $2,500,000: full progression through every bracket including the top.
    expected_2_5m = (
        55_000 * 0.005
        + (250_000 - 55_000) * 0.010
        + (400_000 - 250_000) * 0.015
        + (2_000_000 - 400_000) * 0.020
        + (2_500_000 - 2_000_000) * 0.025
    )
    assert land_transfer_tax(2_500_000.0, "ON", None).provincial == pytest.approx(expected_2_5m)


def test_toronto_adds_municipal_ltt_on_top_of_provincial() -> None:
    result = land_transfer_tax(600_000.0, "ON", "Toronto")
    assert result.municipal > 0
    assert result.total == pytest.approx(result.provincial + result.municipal)
    # Non-Toronto Ontario purchase: no municipal component.
    elsewhere = land_transfer_tax(600_000.0, "ON", "Ottawa")
    assert elsewhere.municipal == 0.0


def test_unmodeled_province_returns_zero_and_says_so() -> None:
    result = land_transfer_tax(500_000.0, "OTHER", None)
    assert result.modeled is False
    assert result.total == 0.0


# ---------------------------------------------------------------------------
# Appreciation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("years", [7, 10, 15])
def test_projected_value_compounds_at_the_fixed_rate(years: int) -> None:
    price = 800_000.0
    assert projected_value(price, years) == pytest.approx(price * (1 + ASSUMED_ANNUAL_APPRECIATION_RATE) ** years)


# ---------------------------------------------------------------------------
# Cash flow / yield
# ---------------------------------------------------------------------------


def test_monthly_cash_flow_breakdown_sums_to_net() -> None:
    result = monthly_cash_flow(
        rent=3000.0,
        mortgage_pi=2200.0,
        property_tax_annual=6000.0,
        insurance_annual=1200.0,
        hoa_monthly=0.0,
        maintenance_reserve_pct=5.0,
        vacancy_allowance_pct=4.0,
        property_mgmt_fee_pct=0.0,
    )
    assert sum(result.breakdown.values()) == pytest.approx(result.net)


def test_cap_rate_excludes_debt_service() -> None:
    # $18,000 NOI on a $600,000 purchase = 3% cap rate, independent of any
    # mortgage payment (NOI never includes one).
    assert cap_rate_pct(18_000.0, 600_000.0) == pytest.approx(3.0)


def test_cash_on_cash_return() -> None:
    assert cash_on_cash_return_pct(6_000.0, 100_000.0) == pytest.approx(6.0)


# ---------------------------------------------------------------------------
# Canadian tax
# ---------------------------------------------------------------------------


def test_rental_income_tax_hand_computed_year() -> None:
    # $30,000 rent, $18,000 interest + $6,000 tax + $1,200 insurance +
    # $2,000 maintenance + $0 mgmt + $0 HOA = $27,200 deductible.
    # Taxable = $2,800, at 35% marginal = $980.
    tax = annual_rental_income_tax(30_000.0, 18_000.0, 6_000.0, 1_200.0, 2_000.0, 0.0, 0.0, 0.35)
    assert tax == pytest.approx(980.0)


def test_rental_income_tax_floors_negative_net_at_zero() -> None:
    tax = annual_rental_income_tax(10_000.0, 20_000.0, 6_000.0, 1_200.0, 0.0, 0.0, 0.0, 0.35)
    assert tax == 0.0


def test_capital_gains_tax_is_zero_for_primary_residence() -> None:
    tax = capital_gains_tax(1_000_000.0, 50_000.0, 600_000.0, 0.45, is_primary_residence=True)
    assert tax == 0.0


def test_capital_gains_tax_applies_fifty_percent_inclusion_for_investment() -> None:
    # Gain = 1,000,000 - 50,000 - 600,000 = 350,000. 50% inclusion = 175,000
    # taxed at 45% = 78,750.
    tax = capital_gains_tax(1_000_000.0, 50_000.0, 600_000.0, 0.45, is_primary_residence=False)
    assert tax == pytest.approx(78_750.0)


def test_capital_gains_tax_floors_a_loss_at_zero() -> None:
    tax = capital_gains_tax(500_000.0, 50_000.0, 600_000.0, 0.45, is_primary_residence=False)
    assert tax == 0.0


# ---------------------------------------------------------------------------
# Horizon projections
# ---------------------------------------------------------------------------


def test_horizon_projection_primary_residence_pays_no_capital_gains_tax() -> None:
    inputs = HorizonInputs(
        purchase_price=700_000.0,
        loan_principal=560_000.0,
        mortgage_rate=0.05,
        amortization_years=25,
        monthly_pretax_cash_flow=-200.0,
        annual_rent=0.0,
        annual_property_tax=5_000.0,
        annual_insurance=1_200.0,
        annual_maintenance=0.0,
        annual_mgmt_fee=0.0,
        annual_hoa=0.0,
        marginal_tax_rate=0.40,
        is_primary_residence=True,
        realtor_commission_pct=5.0,
        legal_fees=1_500.0,
        closing_costs_added_to_acb=15_000.0,
    )
    results = project_horizons(inputs, years=(7, 10, 15))
    assert [r.year for r in results] == [7, 10, 15]
    for r in results:
        assert r.capital_gains_tax == 0.0
        assert r.equity == pytest.approx(r.projected_value - r.remaining_balance)
        assert r.total_net_proceeds_after_tax == pytest.approx(
            r.accumulated_after_tax_cash_flow + r.sale_equity_after_tax
        )
    # Equity strictly grows over the three horizons: value keeps
    # compounding and the balance keeps amortizing down.
    assert results[0].equity < results[1].equity < results[2].equity


def test_horizon_projection_investment_property_owes_capital_gains_tax() -> None:
    inputs = HorizonInputs(
        purchase_price=700_000.0,
        loan_principal=560_000.0,
        mortgage_rate=0.05,
        amortization_years=25,
        monthly_pretax_cash_flow=300.0,
        annual_rent=36_000.0,
        annual_property_tax=5_000.0,
        annual_insurance=1_200.0,
        annual_maintenance=0.0,
        annual_mgmt_fee=0.0,
        annual_hoa=0.0,
        marginal_tax_rate=0.40,
        is_primary_residence=False,
        realtor_commission_pct=5.0,
        legal_fees=1_500.0,
        closing_costs_added_to_acb=15_000.0,
    )
    results = project_horizons(inputs, years=(7,))
    assert results[0].capital_gains_tax > 0.0


# ---------------------------------------------------------------------------
# Balance placement
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "coc,expected",
    [(-10.0, 0.0), (-5.0, 0.0), (0.0, 40.0), (4.0, 70.0), (8.0, 100.0), (20.0, 100.0)],
)
def test_cash_flow_axis_score_anchors_and_clamping(coc: float, expected: float) -> None:
    assert cash_flow_axis_score(coc) == pytest.approx(expected)


def test_cash_flow_axis_score_interpolates_between_anchors() -> None:
    # Halfway between the (0, 40) and (4, 70) anchors.
    assert cash_flow_axis_score(2.0) == pytest.approx(55.0)
