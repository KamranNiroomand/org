import { config } from '../../../config.js';
import { QuantUnavailable } from '../../quant.js';
import type { ComputedFinancials, PropertyInput } from './types.js';

/**
 * Client for the Python sidecar's `/realestate/compute` endpoint — the
 * deterministic mortgage/tax/appreciation math lives there
 * (`services/quant/app/realestate.py`), not in TypeScript, following the
 * exact boundary discipline `quant.ts` already established for options
 * pricing: dollars cross the wire, cents live everywhere else in this app.
 * Reuses `quant.ts`'s own `QuantUnavailable` rather than a parallel class —
 * a caller that only knows "the sidecar is down" shouldn't need to
 * distinguish which feature was asking.
 */

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

interface RawLandTransferTax {
  provincial: number;
  municipal: number;
  total: number;
  modeled: boolean;
}

interface RawCashFlow {
  net: number;
  breakdown: Record<string, number>;
}

interface RawHorizon {
  year: number;
  projected_value: number;
  remaining_balance: number;
  equity: number;
  accumulated_after_tax_cash_flow: number;
  sale_selling_costs: number;
  capital_gains_tax: number;
  sale_equity_after_tax: number;
  total_net_proceeds_after_tax: number;
}

interface RawComputedFinancials {
  purchase_price: number;
  down_payment_amount: number;
  loan_principal: number;
  monthly_mortgage_payment: number;
  cmhc_premium: number;
  cmhc_premium_pst: number;
  cmhc_note: string | null;
  land_transfer_tax: RawLandTransferTax;
  total_closing_costs: number;
  total_cash_invested: number;
  monthly_cash_flow: RawCashFlow;
  annual_noi: number;
  cap_rate_pct: number;
  cash_on_cash_return_pct: number;
  cash_flow_axis_score: number;
  assumed_annual_appreciation_rate: number;
  horizons: RawHorizon[];
}

function centsBreakdown(breakdown: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, toCents(v)]));
}

/**
 * Rounds once per independent quantity, then derives every value that's
 * arithmetically dependent on another by integer arithmetic on the
 * already-rounded cents — never by independently rounding the Python side's
 * float twice. Two fields rounded separately from a shared float can
 * disagree by a cent (e.g. `equity = value - balance` holds exactly in
 * `realestate.py`, but `toCents(value) - toCents(balance)` need not equal
 * `toCents(equity)`), and those exact fields sit side by side in the
 * horizons table in `AnalysisResult.tsx` — a discrepancy there reads as a
 * real bug, not a rounding artifact.
 */
function toComputedFinancials(raw: RawComputedFinancials): ComputedFinancials {
  const breakdownCents = centsBreakdown(raw.monthly_cash_flow.breakdown);
  const netCents = Object.values(breakdownCents).reduce((sum, v) => sum + v, 0);

  const provincialCents = toCents(raw.land_transfer_tax.provincial);
  const municipalCents = toCents(raw.land_transfer_tax.municipal);

  return {
    purchasePriceCents: toCents(raw.purchase_price),
    downPaymentAmountCents: toCents(raw.down_payment_amount),
    loanPrincipalCents: toCents(raw.loan_principal),
    monthlyMortgagePaymentCents: toCents(raw.monthly_mortgage_payment),
    cmhcPremiumCents: toCents(raw.cmhc_premium),
    cmhcPremiumPstCents: toCents(raw.cmhc_premium_pst),
    cmhcNote: raw.cmhc_note,
    landTransferTax: {
      provincialCents,
      municipalCents,
      totalCents: provincialCents + municipalCents,
      modeled: raw.land_transfer_tax.modeled,
    },
    totalClosingCostsCents: toCents(raw.total_closing_costs),
    totalCashInvestedCents: toCents(raw.total_cash_invested),
    monthlyCashFlow: { netCents, breakdown: breakdownCents },
    annualNoiCents: toCents(raw.annual_noi),
    capRatePct: raw.cap_rate_pct,
    cashOnCashReturnPct: raw.cash_on_cash_return_pct,
    cashFlowAxisScore: raw.cash_flow_axis_score,
    assumedAnnualAppreciationRate: raw.assumed_annual_appreciation_rate,
    horizons: raw.horizons.map((h) => {
      const projectedValueCents = toCents(h.projected_value);
      const remainingBalanceCents = toCents(h.remaining_balance);
      const equityCents = projectedValueCents - remainingBalanceCents;
      const accumulatedAfterTaxCashFlowCents = toCents(h.accumulated_after_tax_cash_flow);
      const saleSellingCostsCents = toCents(h.sale_selling_costs);
      const capitalGainsTaxCents = toCents(h.capital_gains_tax);
      const saleEquityAfterTaxCents = equityCents - saleSellingCostsCents - capitalGainsTaxCents;
      return {
        year: h.year,
        projectedValueCents,
        remainingBalanceCents,
        equityCents,
        accumulatedAfterTaxCashFlowCents,
        saleSellingCostsCents,
        capitalGainsTaxCents,
        saleEquityAfterTaxCents,
        totalNetProceedsAfterTaxCents: accumulatedAfterTaxCashFlowCents + saleEquityAfterTaxCents,
      };
    }),
  };
}

export async function computeFinancials(input: PropertyInput): Promise<ComputedFinancials> {
  const body = {
    purchase_price: input.askingPriceCents / 100,
    down_payment_pct: input.downPaymentPct,
    mortgage_rate: input.mortgageRatePct / 100,
    amortization_years: input.amortizationYears,
    expected_monthly_rent: input.expectedMonthlyRentCents / 100,
    annual_property_tax: input.estimatedAnnualPropertyTaxCents / 100,
    hoa_monthly: input.hoaFeeCentsMonthly / 100,
    annual_insurance: input.estimatedAnnualInsuranceCents / 100,
    marginal_tax_rate: input.marginalTaxRatePct / 100,
    province: input.province,
    city: input.city,
    is_primary_residence: input.isPrimaryResidence,
    realtor_commission_pct: input.realtorCommissionPct,
    legal_fees: input.legalFeesCents / 100,
    other_closing_costs: input.otherClosingCostsCents / 100,
    maintenance_reserve_pct: input.maintenanceReservePct,
    vacancy_allowance_pct: input.vacancyAllowancePct,
    property_mgmt_fee_pct: input.propertyMgmtFeePct,
  };

  let res: Response;
  try {
    res = await fetch(`${config.market.quantUrl}/realestate/compute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new QuantUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new QuantUnavailable(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  try {
    const raw = (await res.json()) as RawComputedFinancials;
    return toComputedFinancials(raw);
  } catch (err) {
    // A 200 with an unparseable or shape-drifted body is still "the sidecar
    // isn't giving usable results" from this caller's perspective — the
    // route only special-cases QuantUnavailable into a clean 503, so an
    // ordinary SyntaxError/TypeError here would otherwise surface as a
    // generic 500.
    throw new QuantUnavailable(`malformed response body: ${err instanceof Error ? err.message : String(err)}`);
  }
}
