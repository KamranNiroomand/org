/**
 * Shared shapes for the real-estate investment assistant — mirrors
 * `agents/panel/types.ts`'s role: one vocabulary the other modules in this
 * directory agree on, plus the disclaimer and call-timeout constants that
 * travel with every run.
 */

/** Travels with every API response returning real-estate data, verbatim —
 * same discipline as `PANEL_DISCLAIMER`. */
export const RE_DISCLAIMER =
  'Reasoning from public data and web search by two AI specialists and a manager, plus deterministic ' +
  'mortgage/tax math — not financial or tax advice, not a recommendation, and not validated against ' +
  'outcomes. Appreciation is a fixed 3.5%/year assumption you set, not a forecast. Canadian tax rules are ' +
  'simplified (see each figure\'s own caveats) — verify anything material with a real accountant.';

/**
 * Search-enabled calls (location and rental agents, both rounds) need more
 * timeout headroom than a pure-reasoning call: the server-side `web_search`
 * tool does several round trips before the model emits its final token. The
 * panel's `ANTHROPIC_CALL_OPTIONS` (90s) was tuned for reasoning alone —
 * reusing it here would risk the same stalled-call failure mode that
 * constant was itself created to fix. The manager call (no search) reuses
 * `ANTHROPIC_CALL_OPTIONS` from `../panel/types.js` directly rather than a
 * duplicate.
 */
export const ANTHROPIC_SEARCH_CALL_OPTIONS = { timeout: 180_000, maxRetries: 1 };

export type Province = 'ON' | 'OTHER';

/** Everything the user supplied about one property — the form fields plus
 * the pasted listing text. Reused unchanged across every agent call for
 * this run, same as `SymbolContext` for the stock panel. */
export interface PropertyInput {
  address: string;
  askingPriceCents: number;
  propertyType: string;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  yearBuilt: number | null;
  hoaFeeCentsMonthly: number;
  estimatedAnnualPropertyTaxCents: number;
  estimatedAnnualInsuranceCents: number;
  downPaymentPct: number;
  /** A percentage, e.g. 5.5 — converted to a decimal only at the sidecar boundary. */
  mortgageRatePct: number;
  amortizationYears: number;
  /** 0 is valid — not every listing is meant to be rented. */
  expectedMonthlyRentCents: number;
  marginalTaxRatePct: number;
  province: Province;
  city: string | null;
  isPrimaryResidence: boolean;
  realtorCommissionPct: number;
  legalFeesCents: number;
  otherClosingCostsCents: number;
  maintenanceReservePct: number;
  vacancyAllowancePct: number;
  propertyMgmtFeePct: number;
  listingDescription: string | null;
}

export interface LandTransferTax {
  provincialCents: number;
  municipalCents: number;
  totalCents: number;
  modeled: boolean;
}

export interface MonthlyCashFlow {
  netCents: number;
  breakdown: Record<string, number>;
}

export interface HorizonProjection {
  year: number;
  projectedValueCents: number;
  remainingBalanceCents: number;
  equityCents: number;
  accumulatedAfterTaxCashFlowCents: number;
  saleSellingCostsCents: number;
  capitalGainsTaxCents: number;
  saleEquityAfterTaxCents: number;
  totalNetProceedsAfterTaxCents: number;
}

/** The full deterministic math for one property — assembled entirely by
 * the Python sidecar (`services/quant/app/realestate.py`), never re-derived
 * by Node or by any LLM agent. See `financials.ts`. */
export interface ComputedFinancials {
  purchasePriceCents: number;
  downPaymentAmountCents: number;
  /** Includes the financed CMHC premium, if any. */
  loanPrincipalCents: number;
  monthlyMortgagePaymentCents: number;
  cmhcPremiumCents: number;
  cmhcPremiumPstCents: number;
  cmhcNote: string | null;
  landTransferTax: LandTransferTax;
  totalClosingCostsCents: number;
  totalCashInvestedCents: number;
  monthlyCashFlow: MonthlyCashFlow;
  annualNoiCents: number;
  capRatePct: number;
  cashOnCashReturnPct: number;
  cashFlowAxisScore: number;
  assumedAnnualAppreciationRate: number;
  horizons: HorizonProjection[];
}

export type Confidence = 'low' | 'medium' | 'high';

/** Fields every round-2 turn adds, for both agents — kept separate from
 * each agent's own schema (which differ in substance, not just envelope)
 * rather than forced into one shared interface. */
export interface Round2Extras {
  revisedFromRound1: boolean;
  responseToOtherAgent: string;
}

export interface LocationAgentResult {
  areaAssessment: 'strong' | 'average' | 'weak';
  confidence: Confidence;
  reasoning: string;
  schoolsAndCrimeSummary: string;
  comparableSalesSummary: string;
  /** 0-100 rubric score — school trajectory, infrastructure, comparable-sales
   * trend, supply constraints. The only number this agent produces that the
   * server later reuses verbatim (as the balance chart's Y axis) — never
   * re-derived, never re-emitted by the manager. */
  appreciationOutlookScore: number;
  citedFindings: string[];
  sourcesUsed: string[];
  revisedFromRound1: boolean | null;
  responseToOtherAgent: string | null;
}

export interface RentalAgentResult {
  rentEstimateLowCents: number;
  rentEstimateHighCents: number;
  rentabilityAssessment: 'strong' | 'average' | 'weak';
  confidence: Confidence;
  reasoning: string;
  comparableRentsSummary: string;
  demandFactors: string[];
  citedFindings: string[];
  sourcesUsed: string[];
  revisedFromRound1: boolean | null;
  responseToOtherAgent: string | null;
}

export interface ManagerSynthesisResult {
  overallVerdict: 'strong_opportunity' | 'workable' | 'weak_fit';
  narrativeSummary: string;
  keyRisks: string[];
  conflicts: string[];
  horizonNotes: { year7: string; year10: string; year15: string };
}

export interface BalancePlacement {
  cashFlowScore: number;
  /** Null when the location agent produced no result at all (both its
   * rounds failed) — never fabricated as 0, which would misleadingly plot
   * as "poor appreciation outlook" rather than "unknown". */
  appreciationScore: number | null;
}
