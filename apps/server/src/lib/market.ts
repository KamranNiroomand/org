import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { instruments } from '../db/schema.js';
import { NASDAQ_100_SET } from '../data/indices.js';
import { SP500 } from '../data/sp500.js';
import { nowIso } from './util.js';

/**
 * The market map's data.
 *
 * Roughly seven thousand US and Canadian common stocks. A full sweep is around
 * a hundred and fifty batched Yahoo calls and takes minutes, so it runs
 * nightly and lands in SQLite; the page then reads stored rows instantly and
 * refreshes live prices for only the symbols actually on screen.
 *
 * That split is what makes a whole-market map possible without a paid feed:
 * market cap, P/E and sector barely move intraday, while the hundred or so
 * boxes a person is looking at can be re-quoted in a single call.
 */

const CHUNK = 50;
/** Yahoo tolerates a steady stream far better than a burst. */
const CHUNK_PAUSE_MS = 120;

const SP500_SET = new Set(SP500.map(([symbol]) => symbol));

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
  firstTradeDateMilliseconds?: unknown;
  sector?: string;
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

/**
 * `yahoo-finance2` parses date-ish fields into `Date` objects rather than
 * leaving them as the epoch milliseconds the field name promises. Reading it
 * as a number silently discards every value — which is exactly what happened,
 * leaving the listing date null for the entire universe.
 */
const epochMs = (v: unknown): number | null => {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/** Quotes a list of symbols in batches, returning only what came back. */
async function quoteAll(symbols: string[], pause = CHUNK_PAUSE_MS): Promise<RawQuote[]> {
  let yf: YahooClient;
  try {
    yf = await getClient();
  } catch {
    return [];
  }

  const out: RawQuote[] = [];
  for (let i = 0; i < symbols.length; i += CHUNK) {
    try {
      const res = await yf.quote(symbols.slice(i, i + CHUNK));
      out.push(...((Array.isArray(res) ? res : [res]) as RawQuote[]));
    } catch {
      // A rejected batch costs fifty symbols, not the sweep.
    }
    if (pause > 0 && i + CHUNK < symbols.length) {
      await new Promise((r) => setTimeout(r, pause));
    }
  }
  return out;
}

function writeQuotes(rows: RawQuote[]): number {
  const at = nowIso();
  let written = 0;

  db.transaction((tx) => {
    for (const q of rows) {
      if (!q.symbol) continue;
      tx.update(instruments)
        .set({
          price: num(q.regularMarketPrice),
          currency: q.currency ?? null,
          dayChangePercent: num(q.regularMarketChangePercent),
          marketCap: num(q.marketCap),
          trailingPe: num(q.trailingPE),
          forwardPe: num(q.forwardPE),
          priceToBook: num(q.priceToBook),
          dividendYield: num(q.dividendYield),
          firstTradeMs: epochMs(q.firstTradeDateMilliseconds),
          // Sector deliberately untouched: it is set by the universe refresh
          // from Nasdaq's screener, and writing it here would blank every
          // symbol the quote call knows nothing about — which is all of them.
          quotedAt: at,
        })
        .where(eq(instruments.symbol, q.symbol))
        .run();
      written++;
    }
  });

  return written;
}

export interface SweepOutcome {
  requested: number;
  quoted: number;
  finishedAt: string;
}

/** Re-quotes the entire universe. Minutes, not seconds — nightly work. */
export async function sweepMarket(): Promise<SweepOutcome> {
  const symbols = db
    .select({ symbol: instruments.symbol })
    .from(instruments)
    .all()
    .map((r) => r.symbol);

  const quotes = await quoteAll(symbols);
  return { requested: symbols.length, quoted: writeQuotes(quotes), finishedAt: nowIso() };
}

/** Re-quotes a specific handful — what the open page is actually showing. */
export async function refreshSymbols(symbols: string[]): Promise<number> {
  if (symbols.length === 0) return 0;
  const quotes = await quoteAll(symbols.slice(0, 250), 0);
  return writeQuotes(quotes);
}

export type IndexFilter = 'all' | 'sp500' | 'nasdaq100' | 'us' | 'ca';

export type CapBand = 'all' | 'mega' | 'large' | 'mid';
export type AgeBand = 'all' | 'recent' | 'mature' | 'old';
export type PeBand = 'all' | 'value' | 'fair' | 'growth' | 'rich' | 'none';

export interface MarketQuery {
  index?: IndexFilter;
  exchange?: string;
  sector?: string;
  cap?: CapBand;
  age?: AgeBand;
  pe?: PeBand;
  search?: string;
  limit?: number;
}

/** Epoch millis for 1 January of a given year, UTC. */
const jan1 = (year: number): number => Date.UTC(year, 0, 1);

export interface MarketRow {
  symbol: string;
  name: string;
  exchange: string;
  country: string;
  sector: string | null;
  price: number | null;
  currency: string | null;
  dayChangePercent: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  dividendYield: number | null;
  firstTradeMs: number | null;
}

export interface MarketSnapshot {
  asOf: string | null;
  rows: MarketRow[];
  /** Total matching the filters, which can exceed the rows returned. */
  matched: number;
  /** How much of the universe carries a quote at all. */
  quoted: number;
  universe: number;
  exchanges: string[];
  sectors: string[];
}

/**
 * Reads the stored universe.
 *
 * Every filter is applied here rather than in the browser. Sending a
 * top-N-by-cap slice and filtering it client-side looks equivalent and is not:
 * the slice is the *largest* companies, so asking for anything small returns
 * only whatever small companies happened to survive the cut — a wrong answer
 * that looks like a real one. Filtering first and truncating after means the
 * cap only ever limits how much of a correct result is drawn.
 */
export function getMarket(query: MarketQuery = {}): MarketSnapshot {
  const { index = 'all', exchange, sector, cap = 'all', age = 'all', pe = 'all', search, limit = 1500 } = query;

  const filters: SQL[] = [isNotNull(instruments.marketCap)];
  if (index === 'sp500') filters.push(inArray(instruments.symbol, [...SP500_SET]));
  if (index === 'nasdaq100') filters.push(inArray(instruments.symbol, [...NASDAQ_100_SET]));
  if (index === 'us') filters.push(eq(instruments.country, 'US'));
  if (index === 'ca') filters.push(eq(instruments.country, 'CA'));
  if (exchange && exchange !== 'all') filters.push(eq(instruments.exchange, exchange));
  if (sector && sector !== 'all') filters.push(eq(instruments.sector, sector));

  if (cap === 'mega') filters.push(gt(instruments.marketCap, 200e9));
  if (cap === 'large') {
    filters.push(gte(instruments.marketCap, 10e9), lte(instruments.marketCap, 200e9));
  }
  if (cap === 'mid') filters.push(lt(instruments.marketCap, 10e9));

  if (age === 'recent') filters.push(gte(instruments.firstTradeMs, jan1(2015)));
  if (age === 'mature') {
    filters.push(gte(instruments.firstTradeMs, jan1(1990)), lt(instruments.firstTradeMs, jan1(2015)));
  }
  if (age === 'old') filters.push(lt(instruments.firstTradeMs, jan1(1990)));

  if (pe === 'value') filters.push(lt(instruments.trailingPe, 15));
  if (pe === 'fair') filters.push(gte(instruments.trailingPe, 15), lte(instruments.trailingPe, 25));
  if (pe === 'growth') filters.push(gt(instruments.trailingPe, 25), lte(instruments.trailingPe, 40));
  if (pe === 'rich') filters.push(gt(instruments.trailingPe, 40));
  if (pe === 'none') filters.push(isNull(instruments.trailingPe));

  const term = search?.trim();
  if (term) {
    const pattern = `%${term}%`;
    filters.push(or(like(instruments.symbol, pattern), like(instruments.name, pattern))!);
  }

  const where = and(...filters);

  const matched =
    db.select({ n: sql<number>`count(*)` }).from(instruments).where(where).get()?.n ?? 0;

  const rows = db
    .select()
    .from(instruments)
    .where(where)
    .orderBy(desc(instruments.marketCap))
    .limit(limit)
    .all();

  const stats = db
    .select({
      quoted: sql<number>`sum(case when ${instruments.quotedAt} is not null then 1 else 0 end)`,
      universe: sql<number>`count(*)`,
      asOf: sql<string | null>`max(${instruments.quotedAt})`,
    })
    .from(instruments)
    .get();

  const exchanges = db
    .selectDistinct({ exchange: instruments.exchange })
    .from(instruments)
    .all()
    .map((r) => r.exchange)
    .sort();

  const sectors = db
    .selectDistinct({ sector: instruments.sector })
    .from(instruments)
    .all()
    .map((r) => r.sector)
    .filter((s): s is string => s !== null)
    .sort();

  return {
    asOf: stats?.asOf ?? null,
    matched,
    quoted: stats?.quoted ?? 0,
    universe: stats?.universe ?? 0,
    exchanges,
    sectors,
    rows: rows.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      exchange: r.exchange,
      country: r.country,
      sector: r.sector,
      price: r.price,
      currency: r.currency,
      dayChangePercent: r.dayChangePercent,
      marketCap: r.marketCap,
      trailingPE: r.trailingPe,
      forwardPE: r.forwardPe,
      priceToBook: r.priceToBook,
      dividendYield: r.dividendYield,
      firstTradeMs: r.firstTradeMs,
    })),
  };
}
