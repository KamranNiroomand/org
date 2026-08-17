import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { asc } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { holdings } from '../db/schema.js';
import { syncAllItems, syncIsStale } from './plaid.js';
import { fetchQuotes, fetchUsdCad, saveQuotes } from './quotes.js';

/**
 * The nightly job.
 *
 * A cron inside the app only fires while the app is running, which on a laptop
 * is a weak guarantee — the Mac sleeps, the server gets restarted, you're away
 * for a weekend. Two things make that survivable:
 *
 *   1. `/transactions/sync` is cursor-based, so a run that covers three missed
 *      nights returns everything since the last committed cursor. Missing a
 *      night costs nothing but freshness.
 *   2. A catch-up run fires shortly after startup when anything looks stale,
 *      so opening the app after time away pulls the backlog immediately rather
 *      than waiting for the next 06:00.
 *
 * For a hard guarantee the machine would need a launchd agent hitting the sync
 * endpoint; that's noted in the README rather than installed behind your back.
 */

/** Guards against a catch-up run and the cron overlapping on a slow sync. */
let running = false;

export interface NightlyResult {
  startedAt: string;
  banks: { items: number; added: number; modified: number; removed: number; categorized: number };
  prices: { symbols: number; quoted: number; usdCad: number | null };
  errors: string[];
}

export async function runNightly(log: FastifyBaseLogger, reason: string): Promise<NightlyResult> {
  const result: NightlyResult = {
    startedAt: new Date().toISOString(),
    banks: { items: 0, added: 0, modified: 0, removed: 0, categorized: 0 },
    prices: { symbols: 0, quoted: 0, usdCad: null },
    errors: [],
  };

  if (running) {
    result.errors.push('A sync was already in progress; skipped this run.');
    return result;
  }
  running = true;
  log.info(`Nightly job starting (${reason})`);

  try {
    // --- Banks --------------------------------------------------------------
    if (config.plaid.configured) {
      const outcomes = await syncAllItems();
      result.banks.items = outcomes.length;
      for (const o of outcomes) {
        result.banks.added += o.added;
        result.banks.modified += o.modified;
        result.banks.removed += o.removed;
        result.banks.categorized += o.categorized;
        if (o.error) result.errors.push(`${o.institutionName}: ${o.error}`);
      }
      log.info(
        `Banks: ${result.banks.added} new, ${result.banks.modified} updated, ` +
          `${result.banks.categorized} categorized across ${result.banks.items} institution(s)`,
      );
    }

    // --- Prices -------------------------------------------------------------
    const symbols = [
      ...new Set(db.select({ s: holdings.symbol }).from(holdings).orderBy(asc(holdings.symbol)).all().map((h) => h.s)),
    ];
    result.prices.symbols = symbols.length;

    if (symbols.length > 0) {
      const [quotes, usdCad] = await Promise.all([fetchQuotes(symbols), fetchUsdCad()]);
      if (quotes.size > 0) saveQuotes(quotes.values());
      result.prices.quoted = quotes.size;
      result.prices.usdCad = usdCad;

      const missed = symbols.filter((s) => !quotes.has(s));
      if (missed.length > 0) result.errors.push(`No quote for: ${missed.join(', ')}`);
      log.info(`Prices: ${quotes.size}/${symbols.length} quoted, USD/CAD ${usdCad ?? 'unavailable'}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    log.error({ err }, 'Nightly job failed');
  } finally {
    running = false;
  }

  return result;
}

let task: ReturnType<typeof cron.schedule> | null = null;
let lastResult: NightlyResult | null = null;

export const getLastNightlyResult = (): NightlyResult | null => lastResult;

/** Returns the next scheduled fire time, for display in the UI. */
export function getNextRun(): string | null {
  const next = task?.getNextRun();
  return next ? new Date(next).toISOString() : null;
}

export function startScheduler(log: FastifyBaseLogger): void {
  if (!cron.validate(config.syncCron)) {
    log.error(`SYNC_CRON is not a valid cron expression: "${config.syncCron}" — scheduler disabled`);
    return;
  }

  task = cron.schedule(
    config.syncCron,
    () => {
      void runNightly(log, 'scheduled').then((r) => {
        lastResult = r;
      });
    },
    // Fire on your wall clock, not UTC — "6am" should mean 6am in Toronto
    // whether or not daylight saving is in effect.
    { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  );

  const next = getNextRun();
  log.info(`Nightly sync scheduled (${config.syncCron}), next run ${next ?? 'unknown'}`);

  // Catch up shortly after boot if the machine was off or asleep at 06:00. The
  // delay keeps startup fast and avoids racing the first request.
  setTimeout(() => {
    if (config.plaid.configured && syncIsStale()) {
      void runNightly(log, 'catch-up: last sync is stale').then((r) => {
        lastResult = r;
      });
    }
  }, 15_000).unref();
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
}
