import { SP500 } from '../data/sp500.js';

/**
 * The S&P 500 market map's data.
 *
 * Everything shown comes from one batched Yahoo `quote()` call per chunk of
 * symbols — roughly a second per 50, so the whole index lands in about ten.
 * Sector and company name come from the static constituent list, which is why
 * no per-symbol profile lookup is needed.
 *
 * Yahoo reports `exchangeDataDelayedBy: 0` for the US exchanges, so these are
 * live prices rather than the usual fifteen-minute delay. It remains an
 * unofficial endpoint with no stability guarantee, so a failed chunk degrades
 * to fewer rows rather than an error.
 */

const CHUNK = 50;

/**
 * Yahoo is the rate limiter here, and every viewer of the page would otherwise
 * trigger a fresh sweep. Sixty seconds keeps the map live to the eye while
 * collapsing a burst of refreshes into a single upstream fetch.
 */
const TTL_MS = 60_000;

export interface MarketRow {
  symbol: string;
  name: string;
  sector: string;
  price: number | null;
  currency: string;
  dayChangePercent: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  dividendYield: number | null;
  /** Milliseconds since epoch of the first trade — how long it has been listed. */
  firstTradeMs: number | null;
}

export interface MarketSnapshot {
  asOf: string;
  /** How many constituents actually returned a quote. */
  covered: number;
  total: number;
  rows: MarketRow[];
}

interface RawQuote {
  symbol?: string;
  regularMarketPrice?: number;
  currency?: string;
  regularMarketChangePercent?: number;
  marketCap?: number;
  trailingPE?: number;
  forwardPE?: number;
  priceToBook?: number;
  dividendYield?: number;
  firstTradeDateMilliseconds?: number;
}

interface YahooClient {
  quote(symbols: string[]): Promise<unknown>;
}

let client: YahooClient | null = null;

async function getClient(): Promise<YahooClient> {
  if (client) return client;
  const { default: YahooFinance } = await import('yahoo-finance2');
  client = new YahooFinance({ suppressNotices: ['yahooSurvey'] }) as YahooClient;
  return client;
}

const num = (v: number | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

let cache: MarketSnapshot | null = null;
let cachedAt = 0;
/** Collapses concurrent misses onto one upstream sweep. */
let inFlight: Promise<MarketSnapshot> | null = null;

async function sweep(): Promise<MarketSnapshot> {
  const meta = new Map(SP500.map(([symbol, name, sector]) => [symbol, { name, sector }]));
  const symbols = [...meta.keys()];
  const rows: MarketRow[] = [];

  let yf: YahooClient;
  try {
    yf = await getClient();
  } catch {
    return { asOf: new Date().toISOString(), covered: 0, total: symbols.length, rows: [] };
  }

  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    let batch: RawQuote[];
    try {
      const res = await yf.quote(chunk);
      batch = (Array.isArray(res) ? res : [res]) as RawQuote[];
    } catch {
      // One bad chunk shouldn't cost the other 450 symbols.
      continue;
    }

    for (const q of batch) {
      const info = q.symbol ? meta.get(q.symbol) : undefined;
      if (!q.symbol || !info) continue;
      rows.push({
        symbol: q.symbol,
        name: info.name,
        sector: info.sector,
        price: num(q.regularMarketPrice),
        currency: q.currency ?? 'USD',
        dayChangePercent: num(q.regularMarketChangePercent),
        marketCap: num(q.marketCap),
        trailingPE: num(q.trailingPE),
        forwardPE: num(q.forwardPE),
        priceToBook: num(q.priceToBook),
        dividendYield: num(q.dividendYield),
        firstTradeMs: num(q.firstTradeDateMilliseconds),
      });
    }
  }

  rows.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
  return {
    asOf: new Date().toISOString(),
    covered: rows.length,
    total: symbols.length,
    rows,
  };
}

/** Returns the snapshot, refreshing it only when the cache has gone cold. */
export async function getMarket(force = false): Promise<MarketSnapshot> {
  if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache;
  if (inFlight) return inFlight;

  inFlight = sweep()
    .then((snapshot) => {
      // A sweep that returned nothing is an upstream outage, not an empty
      // market — keep serving the last good snapshot if there is one.
      if (snapshot.rows.length > 0 || !cache) {
        cache = snapshot;
        cachedAt = Date.now();
      }
      return cache!;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
