/**
 * Typed API client.
 *
 * Everything goes through Vite's `/api` proxy in development, so requests are
 * same-origin and cookies work without CORS gymnastics.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* the body wasn't JSON; the status line will do */
    }
    throw new ApiError(message, res.status);
  }

  return (await res.json()) as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: (path: string) => request<void>(path, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Response shapes the client relies on
// ---------------------------------------------------------------------------

export interface Health {
  ok: boolean;
  version: string;
  defaultCalendar: 'miladi' | 'shamsi';
  baseCurrency: string;
  features: {
    plaid: boolean;
    plaidEnv: string;
    claude: boolean;
    encryption: boolean;
  };
  /** What commit the server process is actually running — see
   * `apps/server/src/lib/version.ts` and `StaleBuildBanner`. Every field is
   * nullable because outside a git checkout none of it is knowable, and
   * `drifted: null` must not be read as "no drift". */
  build: {
    bootSha: string | null;
    headSha: string | null;
    branch: string | null;
    drifted: boolean | null;
    dirty: boolean | null;
    startedAt: string;
  };
}

export interface TransactionRow {
  transaction: {
    id: string;
    accountId: string;
    date: string;
    amount: number;
    currency: string;
    name: string;
    merchantName: string | null;
    categoryId: string | null;
    pending: boolean;
    isTransfer: boolean;
    notes: string | null;
    source: 'plaid' | 'csv' | 'manual';
  };
  account: { id: string; name: string; mask: string | null; type: string } | null;
  category: { id: string; name: string; color: string; kind: string } | null;
}

export interface MonthSummary {
  month: string;
  /**
   * `null` means "not applicable" — no included account can produce this
   * figure, e.g. `income` when only credit cards are selected — never
   * "zero this month". A `null` tile should be hidden, not rendered as $0.
   */
  income: number | null;
  payments: number | null;
  refunds: number | null;
  interest: number | null;
  deposits: number | null;
  expense: number;
  net: number;
  transactionCount: number;
  byCategory: Array<{ id: string | null; name: string; color: string; total: number }>;
}

export interface CashflowPoint {
  month: string;
  income: number;
  expense: number;
}

export interface WatchlistRow {
  symbol: string;
  name: string | null;
  note: string | null;
  createdAt: string;
  price: number | null;
  currency: string | null;
  dayChangePercent: number | null;
}

export interface SignalEvent {
  id: string;
  symbol: string;
  ruleKey: 'day_change_up' | 'day_change_down' | 'new_52w_high' | 'new_52w_low' | 'volume_spike' | 'news_event';
  tradingDay: string;
  context: 'holding' | 'watchlist' | 'unwatched';
  direction: 'bullish' | 'bearish' | 'neutral';
  headline: string;
  detail: Record<string, unknown>;
  acknowledged: boolean;
  triggeredAt: string;
  createdAt: string;
}

export interface RadarScore {
  id: string;
  runId: string;
  tradingDay: string;
  symbol: string;
  rank: number;
  score: number;
  momentumZ: number | null;
  trendPct: number | null;
  newHigh: boolean;
  volumeRatio: number | null;
  volumeZ: number | null;
  sentimentZ: number | null;
  sentimentDocCount: number;
  inputsUsed: string[];
  createdAt: string;
}

export interface RadarResponse {
  day: string;
  disclaimer: string;
  items: RadarScore[];
}

export interface RadarRunSummary {
  runId: string | null;
  universeScored: number;
  shortlisted: number;
  errors: string[];
}

export interface RadarRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'failed';
  tradingDay: string;
  universeScored: number;
  shortlisted: number;
  errors: string[];
}

export interface RadarRunsResponse {
  lastRun: RadarRunSummary | null;
  nextRun: string | null;
  runs: RadarRun[];
}

export type Specialist = 'momentum' | 'fundamentals' | 'news_sentiment' | 'skeptic';

export interface PanelAgentTurn {
  id: string;
  analysisId: string;
  round: number;
  agent: Specialist;
  stance: 'bullish' | 'bearish' | 'neutral';
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  citedInputs: string[];
  respondingTo: Specialist[] | null;
  revisedPosition: boolean | null;
  createdAt: string;
}

export interface PanelSymbolAnalysis {
  id: string;
  runId: string;
  symbol: string;
  stance: 'notable' | 'mixed' | 'not_notable';
  summary: string;
  agreements: string[];
  disagreements: string[];
  openQuestions: string[];
  synthesisComplete: boolean;
  createdAt: string;
  turns: PanelAgentTurn[];
}

export interface PanelRun {
  id: string;
  trigger: 'nightly_radar' | 'box_query';
  query: string | null;
  resolutionMethod: 'ticker_match' | 'thematic_match' | 'radar_shortlist';
  symbols: string[];
  status: 'running' | 'done' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  model: string;
  callsMade: number;
  errors: string[];
}

export interface PanelRunDetail {
  run: PanelRun;
  analyses: PanelSymbolAnalysis[];
  disclaimer: string;
}

export interface BoxQueryResponse {
  runId: string;
  resolvedSymbols: string[];
  normalizedTheme: string | null;
  disclaimer: string;
}

export interface PanelRunsResponse {
  lastRunId: string | null;
  nextRun: string | null;
  runs: PanelRun[];
}

export interface PortfolioResponse {
  holdings: Array<{
    id: string;
    symbol: string;
    name: string | null;
    quantity: number;
    avgCost: number;
    currency: string;
    price: number | null;
    priceCurrency: string | null;
    priceAsOf: string | null;
    dayChangePercent: number | null;
    costBasis: number;
    costBasisBase: number | null;
    marketValue: number | null;
    marketValueBase: number | null;
    unrealizedPL: number | null;
    unrealizedPLPercent: number | null;
  }>;
  totals: {
    marketValue: number;
    costBasis: number;
    unrealizedPL: number;
    unrealizedPLPercent: number;
    pricedCount?: number;
    totalCount?: number;
  };
  baseCurrency: string;
  usdCad: number | null;
  stale: string[];
}

// ---------------------------------------------------------------------------
// Real-estate investment assistant
// ---------------------------------------------------------------------------

export type Province = 'ON' | 'OTHER';

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
  mortgageRatePct: number;
  amortizationYears: number;
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

export interface ComputedFinancials {
  purchasePriceCents: number;
  downPaymentAmountCents: number;
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

export interface LocationAgentResult {
  areaAssessment: 'strong' | 'average' | 'weak';
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  schoolsAndCrimeSummary: string;
  comparableSalesSummary: string;
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
  confidence: 'low' | 'medium' | 'high';
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
  appreciationScore: number | null;
}

export interface RealEstateRun {
  id: string;
  status: 'running' | 'done' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  model: string;
  callsMade: number;
  webSearchesUsed: number;
  errors: string[];
  propertyInput: PropertyInput;
  computedFinancials: ComputedFinancials;
  locationRound1: LocationAgentResult | null;
  locationRound2: LocationAgentResult | null;
  rentalRound1: RentalAgentResult | null;
  rentalRound2: RentalAgentResult | null;
  managerResult: ManagerSynthesisResult | null;
  balancePlacement: BalancePlacement | null;
  synthesisComplete: boolean;
}

export interface RealEstateRunDetail {
  run: RealEstateRun;
  disclaimer: string;
}

export interface AnalyzePropertyResponse {
  runId: string;
  disclaimer: string;
}

export interface RealEstateRunsResponse {
  runs: RealEstateRun[];
}
