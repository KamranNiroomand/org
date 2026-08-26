import { config } from '../../config.js';

/**
 * Tradier quote overlay — real NBBO bid/ask for specific contracts.
 *
 * Deliberately NOT an `OptionsProvider`: Polygon remains the corpus
 * backbone (history, nightly whole-universe capture), and Tradier is a
 * brokerage API whose strength is the opposite shape — "the touchable
 * price for the contract in front of me, right now". This module asks
 * exactly that question, in one batched request per engine pass, for the
 * handful of open positions.
 *
 * A sandbox token (free, no brokerage account) serves 15-minute-delayed
 * quotes — the full integration works, just late; a production token
 * (brokerage account + market-data agreement) makes the same fields
 * real-time. Callers can't tell the difference and shouldn't: basis
 * 'measured' means "a price a counterparty was actually showing",
 * which both are.
 *
 * Never throws into the engine: a dead token, a rate limit, or an
 * unknown symbol degrades to an empty map, and the engine falls back to
 * the print-basis path it already has. Realism is an overlay, not a
 * dependency.
 */

export interface TradierQuote {
  bidE4: number | null;
  askE4: number | null;
  lastE4: number | null;
}

const HOSTS = {
  sandbox: 'https://sandbox.tradier.com',
  production: 'https://api.tradier.com',
} as const;

export function tradierConfigured(): boolean {
  return config.market.tradierApiKey !== null;
}

/** Our padded 21-char OCC symbol, in Tradier's unpadded spelling. */
export function toTradierSymbol(occSymbol: string): string {
  return occSymbol.replace(/\s+/g, '');
}

const toE4 = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 10_000) : null;

export async function fetchTradierQuotes(
  occSymbols: readonly string[],
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, TradierQuote>> {
  const out = new Map<string, TradierQuote>();
  if (!tradierConfigured() || occSymbols.length === 0) return out;

  const bySymbol = new Map(occSymbols.map((occ) => [toTradierSymbol(occ), occ]));
  const url =
    `${HOSTS[config.market.tradierEnv]}/v1/markets/quotes?symbols=` +
    encodeURIComponent([...bySymbol.keys()].join(','));

  let body: unknown;
  try {
    const res = await fetchFn(url, {
      headers: {
        authorization: `Bearer ${config.market.tradierApiKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return out;
    body = await res.json();
  } catch {
    return out;
  }

  // Tradier's envelope: {quotes: {quote: {...} | [{...}]}} — a single
  // match arrives as an object, several as an array, none as absent.
  const raw = (body as { quotes?: { quote?: unknown } })?.quotes?.quote;
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const symbol = typeof r.symbol === 'string' ? r.symbol : null;
    const occ = symbol ? bySymbol.get(symbol.toUpperCase()) : undefined;
    if (!occ) continue;
    out.set(occ, { bidE4: toE4(r.bid), askE4: toE4(r.ask), lastE4: toE4(r.last) });
  }
  return out;
}
