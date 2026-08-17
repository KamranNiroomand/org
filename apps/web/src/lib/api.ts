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
  income: number;
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
