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
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  symbolsDone: number;
  contractsSeen: number;
  quotesWritten: number;
  errors: string[];
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

export interface OptionsStatus {
  configured: boolean;
  role: 'runner' | 'reader';
  dataDir: string;
  quantUp: boolean;
  nextCapture: string | null;
  lastCapture: CaptureJobResult | null;
  lastRun: CaptureRun | null;
  universe: Record<string, number>;
  totals: { quotes: number; firstDay: string | null; lastDay: string | null };
  days: OptionsStatusDay[];
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
  exitBasis: 'measured' | 'modelled' | null;
  source: 'manual' | 'model';
  notes: string | null;
  openedAt: string;
  closedAt: string | null;
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

export const optionsApi = {
  status: () => api.get<OptionsStatus>('/api/options/status'),
  triggerCapture: () => api.post<CaptureJobResult>('/api/options/capture'),

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

  rank: (day: string, top = 25) => api.get<RankResponse>(`/api/quant/rank?day=${day}&top=${top}`),
};
