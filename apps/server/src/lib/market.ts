import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
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
  firstTradeDateMilliseconds?: number;
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
          firstTradeMs: num(q.firstTradeDateMilliseconds),
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

export interface MarketQuery {
  index?: IndexFilter;
  exchange?: string;
  limit?: number;
}

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
  /** How much of the universe carries a quote at all. */
  quoted: number;
  universe: number;
  exchanges: string[];
}

/**
 * Reads the stored universe. Ordered by market cap and capped, because the map
 * can only draw so many boxes and the table only scrolls so far — the tail of
 * a seven-thousand-name universe is micro-caps nobody is looking for by eye.
 */
export function getMarket(query: MarketQuery = {}): MarketSnapshot {
  const { index = 'all', exchange, limit = 1500 } = query;

  const filters: SQL[] = [isNotNull(instruments.marketCap)];
  if (index === 'sp500') filters.push(inArray(instruments.symbol, [...SP500_SET]));
  if (index === 'nasdaq100') filters.push(inArray(instruments.symbol, [...NASDAQ_100_SET]));
  if (index === 'us') filters.push(eq(instruments.country, 'US'));
  if (index === 'ca') filters.push(eq(instruments.country, 'CA'));
  if (exchange && exchange !== 'all') filters.push(eq(instruments.exchange, exchange));

  const rows = db
    .select()
    .from(instruments)
    .where(and(...filters))
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

  return {
    asOf: stats?.asOf ?? null,
    quoted: stats?.quoted ?? 0,
    universe: stats?.universe ?? 0,
    exchanges,
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
