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

/**
 * Ceiling on in-flight requests per caller — `backfill.ts` uses this via
 * `mapLimit`. No longer the primary defense against sustained rate-limiting:
 * see `paceRequest` below. Every request a `mapLimit` worker makes still
 * queues for the same shared pacer slot, so raising this only changes how
 * many requests are in flight waiting for their turn, not how fast the
 * vendor sees them — throughput is governed by
 * `POLYGON_MAX_REQUESTS_PER_MINUTE`, not by concurrency.
 */
const MAX_CONCURRENCY = 2;
const MAX_RETRIES = 4;

/**
 * Paces every outbound request to `config.market.polygonMaxRequestsPerMinute`,
 * independent of how many callers are in flight.
 *
 * Concurrency limits alone don't protect against a *sustained* per-minute
 * ceiling: `capture.ts` fetches one symbol at a time, `backfill.ts` caps at
 * `MAX_CONCURRENCY`, yet the first real nightly capture still lost 321 of 566
 * symbols to 429s — spread evenly across the whole ~48-minute run, not
 * clustered at the end, which means the vendor's real limit was being
 * exceeded from the first request onward regardless of concurrency. Retrying
 * with backoff (below) reacts after the fact and, against a per-minute
 * ceiling, often retries back into the same exhausted window. Spacing every
 * request's *start* evenly ahead of time is what actually keeps the run
 * under budget rather than hoping retries eventually find room.
 *
 * Global and module-level on purpose: every Polygon call in the process —
 * capture, backfill, news, the capability probe — shares one vendor-side
 * budget, so they have to share one pacer. A side effect worth knowing: two
 * "concurrent" requests (e.g. `fetchLiveChain`'s `Promise.all` of the chain
 * snapshot and the underlying's last close) now queue for sequential slots
 * on this one clock rather than actually overlapping on the wire — correct
 * for staying under budget, but it means that `Promise.all` no longer buys
 * real parallelism, only readability.
 *
 * That fix cut losses from 321/566 to 145/566 on the next real run, not to
 * zero — meaning `POLYGON_MAX_REQUESTS_PER_MINUTE` (default 60) is still
 * optimistic against the account's actual entitlement, which this app has no
 * way to read from the vendor directly. Rather than guess a second static
 * number, the pace now adapts: a 429 slows the shared rate down
 * (`BACKOFF_GROWTH`×, capped at `MAX_BACKOFF_MULTIPLIER`), and a quiet period
 * with no 429s eases it back toward the configured baseline. The configured
 * rate becomes a ceiling this converges toward, not a number assumed correct
 * from the first request.
 *
 * Two things this got wrong on the first pass, caught in review before ever
 * running against production traffic:
 *
 * - Growth is counted once per *logical request* (`get()`'s own retry loop
 *   sets `rateLimited` at most once — see below), not once per HTTP attempt.
 *   `get()` retries the same request up to `MAX_RETRIES` times; counting
 *   every attempt let one unlucky request's own retry chain alone walk the
 *   shared multiplier to the cap in seconds, conflating "one request had a
 *   bad time" with "the vendor is broadly rate-limiting everyone."
 * - Recovery is gated on *wall-clock quiet time* since the last 429
 *   (`RECOVERY_QUIET_MS`), not a counter of consecutive clean responses. A
 *   streak counter can never reach its threshold — and the pacer can never
 *   recover, for the rest of the process's life — against a background rate
 *   of occasional 429s that never quite goes to zero; time-based recovery
 *   only needs one actual quiet stretch, however many requests that takes.
 */
const BASE_REQUEST_INTERVAL_MS = 60_000 / config.market.polygonMaxRequestsPerMinute;
const MAX_BACKOFF_MULTIPLIER = 8;
const BACKOFF_GROWTH = 1.5;
/** How long a quiet stretch (no 429s) has to be before easing the slowdown
 * back a step — and the minimum spacing between easing steps, so recovery
 * still takes several such intervals to fully unwind rather than snapping
 * back the instant one interval passes. */
const RECOVERY_QUIET_MS = 2 * 60_000;
const RECOVERY_STEP = 0.85;

let nextRequestAt = 0;
let backoffMultiplier = 1;
let lastRateLimitedAt = 0;
let lastRecoveryStepAt = 0;

async function paceRequest(): Promise<void> {
  maybeRecover();
  const now = Date.now();
  const scheduledAt = Math.max(now, nextRequestAt);
  nextRequestAt = scheduledAt + BASE_REQUEST_INTERVAL_MS * backoffMultiplier;
  if (scheduledAt > now) await sleep(scheduledAt - now);
}

/** Called at most once per logical request, from any caller sharing this
 * pacer — see the module comment above for why the shared rate slows down
 * rather than just this one caller's own retry backoff. */
function recordRateLimited(): void {
  backoffMultiplier = Math.min(MAX_BACKOFF_MULTIPLIER, backoffMultiplier * BACKOFF_GROWTH);
  lastRateLimitedAt = Date.now();
}

/** Eases the slowdown back one step once both the most recent 429 and the
 * most recent easing step are far enough in the past — checked on every
 * paced request rather than only on success, so recovery still progresses
 * even if nothing calls back in after a long quiet stretch. */
function maybeRecover(): void {
  if (backoffMultiplier === 1) return;
  const now = Date.now();
  if (now - lastRateLimitedAt < RECOVERY_QUIET_MS) return;
  if (now - lastRecoveryStepAt < RECOVERY_QUIET_MS) return;
  backoffMultiplier = Math.max(1, backoffMultiplier * RECOVERY_STEP);
  lastRecoveryStepAt = now;
}

/** For a caller (capture.ts) to note in its own run summary when a run
 * finishes with the shared pacer still throttled — this module has no
 * logger of its own to report that fact through directly. */
function getPolygonBackoffMultiplier(): number {
  return backoffMultiplier;
}

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
  // Present only with a Quotes entitlement (Advanced tier). Absent on Starter.
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
  // Set at most once per call to get(), regardless of how many of its own
  // retry attempts hit 429 — see recordRateLimited's own doc comment for
  // why one flaky request retrying 5 times must not count as 5 independent
  // rate-limit signals against the shared pacer.
  let rateLimitedThisCall = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let res: Response;
    try {
      await paceRequest();
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

    if (res.status === 429 && !rateLimitedThisCall) {
      recordRateLimited();
      rateLimitedThisCall = true;
    }

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

  rateLimitState(): { throttled: boolean; multiplier: number } {
    const multiplier = getPolygonBackoffMultiplier();
    return { throttled: multiplier > 1, multiplier };
  }

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

  /**
   * The underlying's most recent close.
   *
   * Taken from equity aggregates rather than the chain snapshot, because
   * `underlying_asset` carries only a ticker without a quote entitlement —
   * the price field is gated. Every contract needs a spot to be priced or
   * measured for moneyness, so this is fetched once per chain rather than
   * read per row.
   */
  private async latestUnderlyingE4(
    symbol: string,
    day: string,
  ): Promise<{ closeE4: number; asOfDay: string } | null> {
    const from = new Date(Date.parse(`${day}T00:00:00Z`) - 10 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const bars = await this.fetchBars(symbol, from, day);
    const last = bars.at(-1);
    // The bar's own day travels with its close. `bars.at(-1)` over a
    // trailing window silently hands back a prior day's close whenever the
    // requested day's aggregate is not yet published — a stale spot that
    // shifts every spot-dependent screen on exactly the gap days that
    // matter. The date makes that condition checkable downstream instead
    // of invisible; this function deliberately does not decide what to do
    // about it, because "how stale is too stale" is a screening policy,
    // not a fetch concern.
    return last ? { closeE4: last.closeE4, asOfDay: last.day } : null;
  }

  private async fetchLiveChain(request: ChainRequest): Promise<ChainQuote[]> {
    const asOf = new Date().toISOString();
    // The trading day is a fact about the US session, so it is the date in
    // New York — never the UTC date. `asOf.slice(0, 10)` looked identical
    // for months because capture started at 16:45 ET (20:45 UTC, same
    // date), until a slow night pushed the run past 20:00 ET: the capture
    // straddled UTC midnight and stamped half of one session's board with
    // the *next* day's date — a phantom trading day the ranking then
    // treated as a real session whose every spot was "stale".
    const tradingDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(asOf));
    const underlying = request.underlying.toUpperCase();

    const [raw, spot] = await Promise.all([
      getAll<SnapshotResult>(`/v3/snapshot/options/${encodeURIComponent(underlying)}?limit=250`),
      this.latestUnderlyingE4(underlying, tradingDay),
    ]);

    // Without a spot nothing here can be priced or placed on a moneyness axis,
    // and inventing one would corrupt every derived value. Better to capture
    // nothing for this symbol tonight and say so than to store a fiction.
    if (spot === null || spot.closeE4 <= 0) {
      throw new ProviderError(
        `no recent close for ${underlying} — cannot anchor its chain to a spot price`,
      );
    }

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
        // Null, not zero. On a plan without a quote entitlement there is no
        // market to report, and storing zero would make every contract in the
        // corpus look permanently unsellable.
        bidE4: typeof bid === 'number' ? toE4(bid) : null,
        askE4: typeof ask === 'number' ? toE4(ask) : null,
        lastE4: typeof r.last_trade?.price === 'number' ? toE4(r.last_trade.price) : null,
        closeE4: typeof r.day?.close === 'number' ? toE4(r.day.close) : null,
        volume: r.day?.volume ?? 0,
        openInterest: r.open_interest ?? 0,
        underlyingE4: spot.closeE4,
        underlyingAsOfDay: spot.asOfDay,
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

/**
 * `get` is exported so every direct Polygon caller — not just this file's
 * own chain/bar fetches — goes through the shared pacer and retry/backoff.
 * `news.ts` used to call `fetch` on its own, which meant news polling had
 * neither: it could 429 unpaced against the same budget this module paces
 * everything else against. `mapLimit`/`MAX_CONCURRENCY` are exported for
 * the same reason `backfill.ts` needs them.
 */
export { get, mapLimit, MAX_CONCURRENCY };
