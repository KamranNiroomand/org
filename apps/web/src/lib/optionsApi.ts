import { api } from './api';

/**
 * Types and helpers for the options corpus and paper book.
 *
 * One conversion matters throughout this file: the options side of the
 * server stores money as **E4** (integer ten-thousandths of a dollar — see
 * `apps/server/src/db/market/schema.ts`), not the cents every other part of
 * this app uses via `@org/shared`'s `money()`. `e4ToUsd` is the one place
 * that boundary is crossed, so a mismatch shows up in one function instead
 * of at every call site that touches a paper order or a captured quote.
 */
export const E4 = 10_000;

/** E4 → whole US dollars, for `money()`/`formatMoney()` from `@org/shared`. */
export function e4ToUsd(e4: number): number {
  return e4 / E4;
}

export interface OptionsStatusDay {
  day: string;
  quotes: number;
  liquid: number;
  priced: number;
}

export interface CaptureRun {
  id: string;
  kind: 'nightly' | 'backfill';
  status: 'running' | 'done' | 'degraded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  /** Attempted, not necessarily written — see `symbolsFailed` for the gap. */
  symbolsDone: number;
  contractsSeen: number;
  quotesWritten: number;
  errors: string[];
  /** Of `symbolsDone`, how many wrote zero quotes (usually rate-limited). */
  symbolsFailed: number;
}

export interface CaptureJobResult {
  startedAt: string;
  finishedAt: string;
  universe: number;
  symbols: number;
  contracts: number;
  quotes: number;
  liquid: number;
  priced: number;
  rateRows: number;
  quantAvailable: boolean;
  errors: string[];
}

export interface TextSyncResult {
  startedAt: string;
  finishedAt: string;
  documentsWritten: number;
  mentionsWritten: number;
  filingsWritten: number;
  classified: number;
  errors: string[];
}

export interface PullJobResult {
  ok: boolean;
  message: string;
}

export interface OptionsStatus {
  configured: boolean;
  role: 'runner' | 'reader';
  dataDir: string;
  quantUp: boolean;
  nextCapture: string | null;
  lastCapture: CaptureJobResult | null;
  nextTextSync: string | null;
  lastTextSync: TextSyncResult | null;
  lastRun: CaptureRun | null;
  universe: Record<string, number>;
  totals: { quotes: number; firstDay: string | null; lastDay: string | null };
  days: OptionsStatusDay[];
}

/**
 * The nightly re-evaluation of an open position against today's forecast
 * and today's news — see `apps/server/src/lib/options/positionHealth.ts`.
 * Null until the nightly job has scored this order at least once.
 * `current*` fields are null together when no current view could be
 * computed (expired, no quote today) — not the same as "the position is
 * fine".
 */
export interface PositionHealth {
  day: string;
  currentEv: number | null;
  currentEvPerRisk: number | null;
  currentProbProfit: number | null;
  currentForecastVol: number | null;
  currentForecastDrift: number | null;
  newDocumentsCount: number;
  latestDocumentTitle: string | null;
  latestDocumentEventType: string | null;
  latestDocumentPublishedAt: string | null;
  computedAt: string;
}

export interface ExitRevision {
  id: number;
  orderId: string;
  revisedAt: string;
  oldTargetExitPriceE4: number | null;
  newTargetExitPriceE4: number | null;
  oldTargetExitDate: string | null;
  newTargetExitDate: string | null;
  reason: string;
  triggeredBy: 'rule' | 'llm';
}

export interface PaperOrder {
  id: string;
  occSymbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryPriceE4: number;
  entryBasis: 'measured' | 'modelled';
  status: 'open' | 'closed';
  exitPriceE4: number | null;
  /** Latest nightly mark — the same rows the equity curve is built from.
   * Null until the first marking after open. */
  markPriceE4: number | null;
  markTradingDay: string | null;
  markBasis: string | null;
  exitBasis: 'measured' | 'modelled' | null;
  source: 'manual' | 'model';
  notes: string | null;
  /** Present only on a `source: 'model'` order the exit engine manages — see exitEngine.ts. */
  targetExitPriceE4: number | null;
  stopLossPriceE4: number | null;
  targetExitDate: string | null;
  entryEv: number | null;
  exitUpdatedAt: string | null;
  openedAt: string;
  closedAt: string | null;
  health: PositionHealth | null;
  exitRevisions: ExitRevision[];
}

export interface PaperEquityPoint {
  day: string;
  cashE4: number;
  openPositionsValueE4: number;
  totalEquityE4: number;
  realizedPlToDateE4: number;
  dayReturnPct: number | null;
  cumulativeReturnPct: number;
}

export interface PaperEquityResponse {
  startingBalanceE4: number;
  equity: PaperEquityPoint[];
  orders: PaperOrder[];
}

export interface RankedContract {
  occ_symbol: string;
  underlying: string;
  expiry: string;
  type: string;
  strike: number;
  dte: number;
  market_price: number;
  market_iv: number | null;
  forecast_vol: number;
  forecast_drift: number;
  forecast_value: number;
  ev: number;
  ev_per_risk: number;
  prob_profit: number;
}

export interface RankResponse {
  model_run_id: string;
  /** See rank.py's own module docstring — this is the fact that must never be hidden. */
  model_beats_baseline: boolean;
  model_information_coefficient: number;
  contracts: RankedContract[];
}

export interface StockPickRow {
  symbol: string;
  rank: number;
  horizonReturn: number;
  forecastSigmas: number | null;
  forecastVol: number | null;
}

export interface StockPicksResponse {
  book: 'short' | 'long';
  modelRunId: string;
  horizonDays: number;
  picks: StockPickRow[];
  stances: Record<string, { stance: string; summary: string; day: string; isToday: boolean }>;
}

export interface StockOrderRow {
  id: string;
  symbol: string;
  book: 'short' | 'long';
  quantity: number;
  entryPriceE4: number;
  entryDay: string;
  sector: string | null;
  stopPriceE4: number | null;
  targetPriceE4: number | null;
  targetExitDate: string | null;
  status: 'open' | 'closed';
  exitPriceE4: number | null;
  exitReason: string | null;
  notes: string | null;
  markPriceE4: number | null;
  markTradingDay: string | null;
}

export interface StockBookResponse {
  equity: {
    startingBalanceE4: number;
    cashE4: number;
    positionsValueE4: number;
    totalEquityE4: number;
    realizedPlE4: number;
  };
  orders: StockOrderRow[];
}

export interface StockDecision {
  id: number;
  day: string;
  book: 'short' | 'long';
  symbol: string;
  decision: string;
  reason: string;
  detail: Record<string, unknown>;
  panelStance: string | null;
  createdAt: string;
}

export const stocksApi = {
  decisions: () => api.get<{ day: string; decisions: StockDecision[] }>('/api/stocks/decisions'),
  picks: (book: 'short' | 'long') =>
    api.get<StockPicksResponse>(`/api/stocks/picks?book=${book}`),
  book: () => api.get<StockBookResponse>('/api/stocks/book'),
  runCycle: () => api.post<unknown>('/api/stocks/cycle', {}),
};

export interface SkewRow {
  symbol: string;
  sector: string | null;
  expiry: string;
  dte: number;
  atm_iv: number;
  put25_iv: number;
  call25_iv: number;
  skew_norm: number;
  skew_pts: number;
  ret_1m: number | null;
  ret_1m_vs_spy: number | null;
  rvol: number | null;
  delta_5d: number | null;
  sector_rank_pct: number | null;
  quadrant: 'contrarian_bid' | 'chase' | 'hedged_rally' | 'fear' | null;
  chain_ok: boolean;
  suspect: boolean;
  event_flag: boolean;
  held: boolean;
  sentence: string;
}

export interface SkewMapResponse {
  day: string;
  prior_day: string | null;
  rows: SkewRow[];
  sectors: Array<{ sector: string; mean_skew_pts: number; agreement: number; n: number; excluded: number }>;
  benchmarks: Array<{ symbol: string; skew_pts: number; skew_norm: number }>;
  median_skew_norm: number | null;
}

export const optionsApi = {
  skewMap: () => api.get<SkewMapResponse>('/api/options/skew'),
  status: () => api.get<OptionsStatus>('/api/options/status'),
  triggerCapture: () => api.post<CaptureJobResult>('/api/options/capture'),
  triggerTextSync: () => api.post<TextSyncResult>('/api/options/text-sync'),
  triggerPull: () => api.post<PullJobResult>('/api/options/pull'),

  paperEquity: () => api.get<PaperEquityResponse>('/api/paper/equity'),
  openOrder: (body: {
    occSymbol: string;
    quantity: number;
    entryPriceE4?: number;
    notes?: string;
    source?: 'manual' | 'model';
  }) => api.post<{ id: string }>('/api/paper/orders', body),
  closeOrder: (id: string, exitPriceE4?: number) =>
    api.post<{ ok: true }>(`/api/paper/orders/${id}/close`, exitPriceE4 !== undefined ? { exitPriceE4 } : {}),
  markNow: () => api.post<{ tradingDay: string; marked: number; skipped: unknown[] }>('/api/paper/mark'),
  checkHealthNow: () =>
    api.post<{ tradingDay: string; scored: number; skipped: unknown[] }>('/api/paper/health'),
  exitRecheckNow: () =>
    api.post<{ checked: number; closed: number; revised: number; escalated: number; status: string; errors: string[] }>(
      '/api/paper/exit-recheck',
    ),

  /** Most recent run first — see the `/api/quant/runs` route. `metrics.beats_baseline`
   * is the one field that must never be hidden, per rank.py's own module docstring. */
  modelRuns: (target: string) =>
    api.get<
      Array<{
        runId: string;
        target: string;
        /** 'champion' is the run resolve_model actually serves; everything
         * else is a challenger awaiting a promotion decision. */
        status: 'champion' | 'challenger' | string;
        metrics: { beats_baseline?: boolean };
      }>
    >(`/api/quant/runs?target=${target}`),

  rank: (day: string, top = 25, maxCapital?: number) =>
    api.get<RankResponse>(
      `/api/quant/rank?day=${day}&top=${top}${maxCapital !== undefined ? `&maxCapital=${maxCapital}` : ''}`,
    ),
};
