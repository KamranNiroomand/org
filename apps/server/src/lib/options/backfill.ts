import { sql } from 'drizzle-orm';
import { marketDb } from '../../db/market/index.js';
import { captureRuns, equityBars } from '../../db/market/schema.js';
import { newId, nowIso } from '../util.js';
import { assertRunner } from './role.js';
import { mapLimit } from './polygon.js';
import type { OptionsProvider } from './provider.js';

/**
 * Historical daily bars for the underlyings.
 *
 * This is the half of the corpus that *can* be recovered. Option quotes cannot
 * — a night not captured is gone — but equity bars are served from history on
 * demand, so this job is patient rather than urgent, and safe to re-run.
 *
 * Bars carry more of the forecasting load than the chains do. Realized
 * volatility, the return distribution, every label on the underlying: all of
 * it comes from here, and none of it needs an option quote. That is why this
 * runs first, and why the forecasting half of the system can be built and
 * validated long before the execution half has data worth trusting.
 */

const CONCURRENCY = 6;
/** Polygon caps an aggregates response at 50k rows; a decade of days is ~2.5k. */
const CHUNK_YEARS = 2;

export interface BackfillProgress {
  runId: string;
  symbolsDone: number;
  symbolsTotal: number;
  barsWritten: number;
  errors: string[];
}

/** Splits a range into vendor-friendly spans, so one symbol is one or two calls. */
function spans(from: string, to: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = from;
  for (;;) {
    const startYear = Number(start.slice(0, 4));
    const capped = `${startYear + CHUNK_YEARS}-01-01`;
    if (capped >= to) {
      out.push([start, to]);
      return out;
    }
    out.push([start, capped]);
    start = capped;
  }
}

/**
 * Fetches and stores daily bars for each symbol.
 *
 * Checkpoints after every symbol. A run interrupted at 400 of 566 resumes
 * where it stopped rather than restarting — which matters less for
 * correctness here than for patience, since a full pass is hundreds of
 * requests.
 */
export async function backfillBars(
  provider: OptionsProvider,
  symbols: readonly string[],
  from: string,
  to: string,
  onProgress?: (p: BackfillProgress) => void,
): Promise<BackfillProgress> {
  assertRunner('backfill equity bars');

  const runId = newId();
  marketDb
    .insert(captureRuns)
    .values({ id: runId, kind: 'backfill', startedAt: nowIso() })
    .run();

  const progress: BackfillProgress = {
    runId,
    symbolsDone: 0,
    symbolsTotal: symbols.length,
    barsWritten: 0,
    errors: [],
  };

  const ranges = spans(from, to);

  await mapLimit(symbols, CONCURRENCY, async (symbol) => {
    try {
      for (const [start, end] of ranges) {
        const bars = await provider.fetchBars(symbol, start, end);
        if (bars.length === 0) continue;

        // Chunked because SQLite caps bound parameters per statement, and a
        // decade of daily bars for one symbol comfortably exceeds it.
        marketDb.transaction((tx) => {
          for (let i = 0; i < bars.length; i += 400) {
            tx.insert(equityBars)
              .values(bars.slice(i, i + 400))
              // Re-running must refresh rather than duplicate: `adjusted=true`
              // means a split restates every prior bar, so an older row for the
              // same day is stale rather than equally valid.
              .onConflictDoUpdate({
                target: [equityBars.symbol, equityBars.day],
                set: {
                  openE4: sql`excluded.open_e4`,
                  highE4: sql`excluded.high_e4`,
                  lowE4: sql`excluded.low_e4`,
                  closeE4: sql`excluded.close_e4`,
                  adjCloseE4: sql`excluded.adj_close_e4`,
                  volume: sql`excluded.volume`,
                },
              })
              .run();
          }
        });
        progress.barsWritten += bars.length;
      }
    } catch (err) {
      // One dead symbol out of hundreds must not end the run.
      progress.errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }

    progress.symbolsDone += 1;
    marketDb
      .update(captureRuns)
      .set({
        cursor: { symbol },
        symbolsDone: progress.symbolsDone,
        quotesWritten: progress.barsWritten,
        errors: progress.errors,
      })
      .where(sql`${captureRuns.id} = ${runId}`)
      .run();

    onProgress?.(progress);
  });

  marketDb
    .update(captureRuns)
    .set({
      status: progress.barsWritten > 0 ? 'done' : 'failed',
      finishedAt: nowIso(),
      errors: progress.errors,
    })
    .where(sql`${captureRuns.id} = ${runId}`)
    .run();

  return progress;
}

/** Coverage per symbol, so gaps are visible before a model trains through one. */
export function barCoverage(): Array<{ symbol: string; days: number; first: string; last: string }> {
  return marketDb
    .select({
      symbol: equityBars.symbol,
      days: sql<number>`count(*)`,
      first: sql<string>`min(${equityBars.day})`,
      last: sql<string>`max(${equityBars.day})`,
    })
    .from(equityBars)
    .groupBy(equityBars.symbol)
    .all();
}
