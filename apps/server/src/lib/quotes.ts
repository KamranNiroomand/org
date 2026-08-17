import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { fxRates, priceSnapshots } from '../db/schema.js';
import { newId, nowIso, todayKey } from './util.js';

/**
 * Market prices and FX.
 *
 * Prices come from Yahoo Finance via `yahoo-finance2`. That's an *unofficial*
 * endpoint — free and comprehensive, covering TSX (`.TO`) and TSX-V (`.V`)
 * alongside US listings, but with no stability guarantee. Every failure here is
 * caught and surfaced as a null price rather than an exception, so a portfolio
 * still renders with cost basis when quotes are unavailable.
 *
 * FX comes from the Bank of Canada's Valet API: official, free, no key, and
 * CAD-native, which is exactly the pairing this app needs.
 */

export interface Quote {
  symbol: string;
  /** Minor units. */
  price: number;
  currency: string;
  dayChangePercent: number | null;
  asOf: string;
}

/**
 * The slice of the library this app touches, declared locally.
 *
 * `yahoo-finance2` v4 is a class — v2's bare-function default export is gone —
 * and its `quote()` return type is a wide union across asset classes. Narrowing
 * that union at every access point costs more than it explains, and naming the
 * imported class in a type position would force an `import()` annotation for a
 * module that is loaded lazily.
 */
interface YahooClient {
  quote(symbol: string): Promise<unknown>;
}

interface RawQuote {
  regularMarketPrice?: number;
  currency?: string;
  regularMarketChangePercent?: number;
}

/** Built once and reused; `suppressNotices` keeps a survey banner out of the log. */
let client: YahooClient | null = null;

async function getClient(): Promise<YahooClient> {
  if (client) return client;
  const { default: YahooFinance } = await import('yahoo-finance2');
  client = new YahooFinance({ suppressNotices: ['yahooSurvey'] }) as YahooClient;
  return client;
}

/** Fetches quotes, returning only the ones that succeeded. */
export async function fetchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (symbols.length === 0) return out;

  let yf: YahooClient;
  try {
    yf = await getClient();
  } catch {
    return out;
  }

  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean);

  const results = await Promise.allSettled(
    unique.map(async (symbol): Promise<Quote | null> => {
      const q = (await yf.quote(symbol)) as RawQuote | undefined;
      if (!q || typeof q.regularMarketPrice !== 'number') return null;

      return {
        symbol,
        // Quotes arrive in the listing's own currency — CAD for `.TO`, USD for
        // US listings. Recording it is what makes the base-currency conversion
        // in the portfolio route correct.
        currency: (q.currency ?? 'USD').toUpperCase(),
        price: Math.round(q.regularMarketPrice * 100),
        dayChangePercent:
          typeof q.regularMarketChangePercent === 'number' ? q.regularMarketChangePercent : null,
        asOf: nowIso(),
      };
    }),
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) out.set(r.value.symbol, r.value);
  }
  return out;
}

/** Records quotes so the portfolio still shows a price when Yahoo is down. */
export function saveQuotes(quotes: Iterable<Quote>): void {
  const rows = [...quotes].map((q) => ({
    id: newId(),
    symbol: q.symbol,
    price: q.price,
    currency: q.currency,
    dayChangePercent: q.dayChangePercent,
    asOf: q.asOf,
  }));
  if (rows.length > 0) db.insert(priceSnapshots).values(rows).run();
}

/** The most recent stored price for a symbol. */
export function lastKnownPrice(symbol: string): Quote | null {
  const row = db
    .select()
    .from(priceSnapshots)
    .where(eq(priceSnapshots.symbol, symbol.toUpperCase()))
    .orderBy(desc(priceSnapshots.asOf))
    .limit(1)
    .get();

  return row
    ? {
        symbol: row.symbol,
        price: row.price,
        currency: row.currency,
        dayChangePercent: row.dayChangePercent,
        asOf: row.asOf,
      }
    : null;
}

/**
 * USD→CAD from the Bank of Canada. Cached per day: the rate is published once
 * each business day, so refetching it more often gains nothing.
 */
export async function fetchUsdCad(): Promise<number | null> {
  const today = todayKey();

  const cached = db
    .select()
    .from(fxRates)
    .where(eq(fxRates.asOf, today))
    .orderBy(desc(fxRates.asOf))
    .get();
  if (cached) return cached.rate;

  try {
    const res = await fetch(
      'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1',
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return lastKnownRate();

    const json = (await res.json()) as {
      observations?: Array<{ d: string; FXUSDCAD?: { v: string } }>;
    };
    const obs = json.observations?.[0];
    const rate = Number(obs?.FXUSDCAD?.v);
    if (!obs || !Number.isFinite(rate)) return lastKnownRate();

    db.insert(fxRates)
      .values({ id: newId(), base: 'USD', quote: 'CAD', rate, asOf: today })
      .onConflictDoNothing()
      .run();

    return rate;
  } catch {
    return lastKnownRate();
  }
}

function lastKnownRate(): number | null {
  const row = db.select().from(fxRates).orderBy(desc(fxRates.asOf)).limit(1).get();
  return row?.rate ?? null;
}
