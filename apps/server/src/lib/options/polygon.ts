import { daysToExpiry, formatOccSymbol, parseOccSymbol, toE4, type OptionType } from '@org/shared';
import { config } from '../../config.js';
import {
  ProviderError,
  type ChainQuote,
  type ChainRequest,
  type DailyBar,
  type OptionsProvider,
  type ProviderCapabilities,
} from './provider.js';

/**
 * Polygon.io implementation.
 *
 * Two things about this vendor shape the code more than anything else.
 *
 * The snapshot endpoint returns implied vol and greeks. We read neither into
 * the pipeline — see `provider.ts` — but the preflight compares them against
 * ours, which is a genuinely useful independent check on our own solver.
 *
 * Historical chains are assembled per contract rather than per day: there is
 * no "give me the whole chain as it stood on this date" call. Enumerating
 * contracts alive on a date is one request; their prices are one request per
 * contract. For a two-year, four-hundred-name backfill that is a large number
 * of requests, which is survivable only because the plan bills by month rather
 * than by call — and because the backfill checkpoints and resumes.
 */

const BASE = 'https://api.polygon.io';

/** Polite ceiling on in-flight requests. Unlimited-call plans still throttle. */
const MAX_CONCURRENCY = 8;
const MAX_RETRIES = 4;

interface PolygonEnvelope<T> {
  status?: string;
  results?: T[];
  next_url?: string;
  error?: string;
  message?: string;
}

interface SnapshotResult {
  details?: {
    ticker?: string;
    contract_type?: string;
    expiration_date?: string;
    strike_price?: number;
    shares_per_contract?: number;
  };
  day?: { volume?: number; close?: number };
  last_quote?: { bid?: number; ask?: number };
  last_trade?: { price?: number };
  open_interest?: number;
  implied_volatility?: number;
  underlying_asset?: { price?: number };
}

interface AggResult {
  t?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  vw?: number;
}

function apiKey(): string {
  const key = config.market.polygonKey;
  if (!key) {
    throw new ProviderError(
      'POLYGON_API_KEY is not set — see .env.example. Options capture is disabled without it.',
    );
  }
  return key;
}

/**
 * One GET with backoff.
 *
 * 429 is retried because a long backfill will meet it regardless of plan; 5xx
 * because vendors have bad minutes. 4xx other than 429 is *not* retried — an
 * endpoint the subscription does not cover will keep saying no, and retrying
 * it four times only makes a capability probe slower and its output murkier.
 */
async function get<T>(path: string, signal?: AbortSignal): Promise<PolygonEnvelope<T>> {
  const url = path.startsWith('http') ? new URL(path) : new URL(path, BASE);
  url.searchParams.set('apiKey', apiKey());

  let lastError = '';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_RETRIES) break;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) return (await res.json()) as PolygonEnvelope<T>;

    const body = await res.text().catch(() => '');
    lastError = `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_RETRIES) {
      throw new ProviderError(lastError, res.status, url.pathname);
    }
    // Honour Retry-After when the vendor sends one.
    const after = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : backoffMs(attempt));
  }

  throw new ProviderError(lastError || 'request failed', undefined, url.pathname);
}

const backoffMs = (attempt: number) => Math.min(30_000, 2 ** attempt * 500);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Walks `next_url` pagination to the end, with a hard page cap. */
async function getAll<T>(path: string, maxPages = 200): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  for (let page = 0; page < maxPages && next; page += 1) {
    const env: PolygonEnvelope<T> = await get<T>(next);
    if (env.results) out.push(...env.results);
    next = env.next_url;
  }
  return out;
}

/** Runs tasks with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

function contractType(raw: string | undefined): OptionType | null {
  if (raw === 'call' || raw === 'put') return raw;
  return null;
}

export class PolygonProvider implements OptionsProvider {
  readonly name = 'polygon';

  async fetchChain(request: ChainRequest): Promise<ChainQuote[]> {
    if (request.asOfDay) {
      throw new ProviderError(
        'Historical chain assembly is not wired yet — run the capability probe ' +
          '(npm run options:check) first, because the endpoint that makes it honest ' +
          'is tier-gated and the answer changes the approach.',
      );
    }
    return this.fetchLiveChain(request);
  }

  private async fetchLiveChain(request: ChainRequest): Promise<ChainQuote[]> {
    const asOf = new Date().toISOString();
    const tradingDay = asOf.slice(0, 10);
    const underlying = request.underlying.toUpperCase();

    const raw = await getAll<SnapshotResult>(
      `/v3/snapshot/options/${encodeURIComponent(underlying)}?limit=250`,
    );

    const quotes: ChainQuote[] = [];
    for (const r of raw) {
      const d = r.details;
      const type = contractType(d?.contract_type);
      const expiry = d?.expiration_date;
      const strike = d?.strike_price;
      if (!type || !expiry || typeof strike !== 'number') continue;

      // The capture window. Contracts further out than this are real but not
      // ones we model, and every one kept is a row every night forever.
      const dte = daysToExpiry(expiry, tradingDay);
      if (dte < 0 || dte > request.maxDte) continue;

      const underlyingPrice = r.underlying_asset?.price;
      if (typeof underlyingPrice !== 'number' || underlyingPrice <= 0) continue;

      // Prefer the vendor's own ticker, but rebuild the canonical form so
      // every symbol in our corpus is padded and spelled one way.
      const parsed = d?.ticker ? parseOccSymbol(d.ticker) : null;
      const occSymbol = parsed
        ? formatOccSymbol(parsed)
        : formatOccSymbol({ underlying, expiry, type, strikeE4: toE4(strike) });

      const bid = r.last_quote?.bid;
      const ask = r.last_quote?.ask;

      quotes.push({
        occSymbol,
        underlying,
        expiry,
        type,
        strikeE4: toE4(strike),
        multiplier: d?.shares_per_contract ?? 100,
        // A missing side is stored as zero, not dropped: the liquidity gate
        // treats a zero bid as unsellable, which is exactly what it means,
        // and keeping the row preserves that the contract existed and was
        // untradeable rather than silently omitting it from history.
        bidE4: typeof bid === 'number' ? toE4(bid) : 0,
        askE4: typeof ask === 'number' ? toE4(ask) : 0,
        lastE4: typeof r.last_trade?.price === 'number' ? toE4(r.last_trade.price) : null,
        volume: r.day?.volume ?? 0,
        openInterest: r.open_interest ?? 0,
        underlyingE4: toE4(underlyingPrice),
        asOf,
        tradingDay,
        vendorIv: typeof r.implied_volatility === 'number' ? r.implied_volatility : null,
      });
    }
    return quotes;
  }

  async fetchBars(symbol: string, from: string, to: string): Promise<DailyBar[]> {
    const path =
      `/v2/aggs/ticker/${encodeURIComponent(symbol.toUpperCase())}/range/1/day/${from}/${to}` +
      `?adjusted=true&sort=asc&limit=50000`;
    const rows = await getAll<AggResult>(path);

    const bars: DailyBar[] = [];
    for (const r of rows) {
      if (
        typeof r.t !== 'number' ||
        typeof r.o !== 'number' ||
        typeof r.h !== 'number' ||
        typeof r.l !== 'number' ||
        typeof r.c !== 'number'
      ) {
        continue;
      }
      bars.push({
        symbol: symbol.toUpperCase(),
        // Polygon stamps daily bars at midnight Eastern expressed in epoch ms;
        // reducing through UTC gives the civil trading day directly.
        day: new Date(r.t).toISOString().slice(0, 10),
        openE4: toE4(r.o),
        highE4: toE4(r.h),
        lowE4: toE4(r.l),
        closeE4: toE4(r.c),
        // `adjusted=true` already applies split adjustment to the close.
        adjCloseE4: toE4(r.c),
        volume: Math.round(r.v ?? 0),
      });
    }
    return bars;
  }

  /**
   * Probes what this key can actually reach.
   *
   * Deliberately uses a fixed, very liquid name and a date well inside any
   * plan's history window, so a failure means "the subscription does not cover
   * this" rather than "that symbol had no data that day".
   */
  async probe(): Promise<ProviderCapabilities> {
    const notes: string[] = [];
    const probeSymbol = 'SPY';

    const attempt = async (label: string, fn: () => Promise<string>): Promise<boolean> => {
      try {
        notes.push(`${label}: ${await fn()}`);
        return true;
      } catch (err) {
        const detail =
          err instanceof ProviderError && err.status
            ? `HTTP ${err.status} — ${err.message.slice(0, 160)}`
            : err instanceof Error
              ? err.message.slice(0, 160)
              : String(err);
        notes.push(`${label}: UNAVAILABLE — ${detail}`);
        return false;
      }
    };

    const liveChain = await attempt('live chain snapshot', async () => {
      const env = await get<SnapshotResult>(`/v3/snapshot/options/${probeSymbol}?limit=5`);
      const n = env.results?.length ?? 0;
      if (n === 0) throw new ProviderError('returned no contracts');
      return `${n} contracts, greeks ${env.results?.[0]?.implied_volatility != null ? 'present' : 'absent'}`;
    });

    const equityBars = await attempt('equity daily bars', async () => {
      const env = await get<AggResult>(
        `/v2/aggs/ticker/${probeSymbol}/range/1/day/2025-01-02/2025-01-10?adjusted=true`,
      );
      return `${env.results?.length ?? 0} bars`;
    });

    const historicalChain = await attempt('historical contract reference', async () => {
      const env = await get<{ ticker?: string }>(
        `/v3/reference/options/contracts?underlying_ticker=${probeSymbol}` +
          `&as_of=2025-03-14&limit=5`,
      );
      return `${env.results?.length ?? 0} contracts as of 2025-03-14`;
    });

    // The one that decides whether backtest fills can be honest.
    const historicalQuotes = await attempt('historical NBBO quotes', async () => {
      const env = await get<{ ticker?: string }>(
        `/v3/reference/options/contracts?underlying_ticker=${probeSymbol}&as_of=2025-03-14&limit=1`,
      );
      const ticker = (env.results?.[0] as { ticker?: string } | undefined)?.ticker;
      if (!ticker) throw new ProviderError('could not resolve a contract to test');
      const q = await get<{ bid_price?: number; ask_price?: number }>(
        `/v3/quotes/${encodeURIComponent(ticker)}?timestamp=2025-03-14&limit=1`,
      );
      const n = q.results?.length ?? 0;
      if (n === 0) throw new ProviderError('endpoint reachable but returned no quotes');
      return `${n} quote(s) for ${ticker}`;
    });

    const news = await attempt('news', async () => {
      const env = await get<{ title?: string }>(
        `/v2/reference/news?ticker=${probeSymbol}&limit=5`,
      );
      return `${env.results?.length ?? 0} articles`;
    });

    return {
      name: this.name,
      liveChain,
      historicalChain,
      historicalQuotes,
      equityBars,
      news,
      notes,
    };
  }
}

/** Bounded-concurrency helper, exported for the backfill. */
export { mapLimit, MAX_CONCURRENCY };
