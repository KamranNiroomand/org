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
