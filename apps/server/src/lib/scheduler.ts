import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { asc } from 'drizzle-orm';
import { config } from '../config.js';
import { nowIso } from './util.js';
import { db } from '../db/index.js';
import { holdings } from '../db/schema.js';
import { syncAllFeeds } from './calendarFeeds.js';
import { sweepMarket } from './market.js';
import { refreshUniverse } from './universe.js';
import { syncAllItems, syncIsStale } from './plaid.js';
import { fetchQuotes, fetchUsdCad, saveQuotes } from './quotes.js';
import { PolygonProvider } from './options/polygon.js';
import { captureChains } from './options/capture.js';
import { listUniverse, seedUniverse, toVendorSymbol } from './options/universe.js';
import { syncRates } from './options/rates.js';
import { snapshotMarketDb } from '../db/market/snapshot.js';
import { isRunner } from './options/role.js';

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
  calendars: { feeds: number; added: number; updated: number; removed: number };
  market: { universe: number; quoted: number };
  prices: { symbols: number; quoted: number; usdCad: number | null };
  errors: string[];
}

export async function runNightly(log: FastifyBaseLogger, reason: string): Promise<NightlyResult> {
  const result: NightlyResult = {
    startedAt: new Date().toISOString(),
    banks: { items: 0, added: 0, modified: 0, removed: 0, categorized: 0 },
    calendars: { feeds: 0, added: 0, updated: 0, removed: 0 },
    market: { universe: 0, quoted: 0 },
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

    // --- Calendars ----------------------------------------------------------
    /**
     * Subscribed calendars refresh on the same schedule as the banks. Google
     * serves outside subscribers a cached copy that lags by hours, so polling
     * more often than daily mostly buys repeated identical downloads.
     */
    const feedOutcomes = await syncAllFeeds();
    result.calendars.feeds = feedOutcomes.length;
    for (const f of feedOutcomes) {
      result.calendars.added += f.added;
      result.calendars.updated += f.updated;
      result.calendars.removed += f.removed;
      if (f.error) result.errors.push(`${f.name}: ${f.error}`);
    }
    if (feedOutcomes.length > 0) {
      log.info(
        `Calendars: ${result.calendars.added} new, ${result.calendars.updated} updated, ` +
          `${result.calendars.removed} removed across ${result.calendars.feeds} feed(s)`,
      );
    }

    // --- Market universe ----------------------------------------------------
    /**
     * Around seven thousand symbols, roughly fifty seconds. Nightly is the
     * right cadence: listings change slowly, and market cap, P/E and sector
     * barely move intraday. The open page re-quotes only what it displays.
     */
    try {
      const universe = await refreshUniverse();
      const swept = await sweepMarket();
      result.market = { universe: universe.total, quoted: swept.quoted };
      log.info(`Market: ${swept.quoted}/${universe.total} instruments quoted`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Market sweep: ${message}`);
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

// ---------------------------------------------------------------------------
// Option chain capture
// ---------------------------------------------------------------------------

/**
 * Chains are captured on their own schedule, deliberately not folded into the
 * 06:00 nightly job.
 *
 * A snapshot taken the next morning would pair tomorrow's underlying price
 * with yesterday's contract prices, and every implied vol derived from that
 * pairing would be wrong in a way nothing downstream could detect. So capture
 * runs after the US close instead — 17:30 local by default, comfortably past
 * 16:00 Eastern.
 *
 * There is no backfilling a missed evening. Contract quotes are the one thing
 * in this system that cannot be re-fetched at any price, so a night the
 * machine sleeps is a night permanently absent from the corpus. That is why
 * this runs on a fixed schedule rather than on demand, and why a catch-up
 * fires shortly after boot.
 */
let capturing = false;

export interface CaptureJobResult {
  startedAt: string;
  finishedAt: string;
  universe: number;
  symbols: number;
  contracts: number;
  quotes: number;
  liquid: number;
  priced: number;
  rateRows: number;
  quantAvailable: boolean;
  errors: string[];
}

export async function runOptionsCapture(
  log: FastifyBaseLogger,
  reason: string,
): Promise<CaptureJobResult> {
  const startedAt = nowIso();
  const result: CaptureJobResult = {
    startedAt,
    finishedAt: startedAt,
    universe: 0,
    symbols: 0,
    contracts: 0,
    quotes: 0,
    liquid: 0,
    priced: 0,
    rateRows: 0,
    quantAvailable: false,
    errors: [],
  };

  if (!config.market.configured) {
    result.errors.push('POLYGON_API_KEY is not set — chain capture skipped.');
    return result;
  }
  if (capturing) {
    result.errors.push('A capture was already in progress; skipped this run.');
    return result;
  }
  capturing = true;
  log.info(`Option capture starting (${reason})`);

  try {
    // Idempotent, and cheap when already populated. Keeps a fresh checkout
    // from silently capturing nothing because no universe was ever seeded.
    const seeded = seedUniverse();
    result.universe = seeded.total;

    try {
      const rates = await syncRates([new Date().getUTCFullYear()]);
      result.rateRows = rates.rows;
    } catch (err) {
      // Without a curve, implied vol is left null rather than solved against a
      // made-up rate. Capture still proceeds: the quotes are what matter.
      result.errors.push(`Rate curve: ${err instanceof Error ? err.message : String(err)}`);
    }

    const symbols = listUniverse({ activeOnly: true }).map((u) => toVendorSymbol(u.symbol));
    result.symbols = symbols.length;

    const summary = await captureChains(new PolygonProvider(), symbols);
    result.contracts = summary.contractsSeen;
    result.quotes = summary.quotesWritten;
    result.liquid = summary.liquidWritten;
    result.priced = summary.pricedWritten;
    result.quantAvailable = summary.quantAvailable;
    result.errors.push(...summary.errors);

    log.info(
      `Options: ${summary.quotesWritten} quotes across ${summary.symbolsDone} symbols, ` +
        `${summary.liquidWritten} tradeable, ${summary.pricedWritten} priced`,
    );

    // A snapshot only matters if there is somewhere to pull it from — never
    // taken on a reader, which has no runner-scheduled capture to follow
    // anyway, but guarded explicitly rather than relying on that being true.
    if (isRunner()) {
      try {
        const path = snapshotMarketDb();
        log.info(`Snapshot written to ${path}`);
      } catch (err) {
        result.errors.push(
          `Snapshot: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    log.error({ err }, 'Option capture failed');
  } finally {
    capturing = false;
  }

  result.finishedAt = nowIso();
  return result;
}

let task: ReturnType<typeof cron.schedule> | null = null;
let captureTask: ReturnType<typeof cron.schedule> | null = null;
let lastResult: NightlyResult | null = null;
let lastCaptureResult: CaptureJobResult | null = null;

export const getLastNightlyResult = (): NightlyResult | null => lastResult;
export const getLastCaptureResult = (): CaptureJobResult | null => lastCaptureResult;

/** Next scheduled chain capture, for the UI to show. */
export function getNextCaptureRun(): string | null {
  const next = captureTask?.getNextRun();
  return next ? new Date(next).toISOString() : null;
}

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

  if (!config.market.isRunner) {
    log.info(
      'Option capture not scheduled — MARKET_ROLE=reader. This machine displays ' +
        'a corpus produced elsewhere.',
    );
  } else if (config.market.configured) {
    if (!cron.validate(config.market.captureCron)) {
      log.error(
        `OPTIONS_CAPTURE_CRON is not valid: "${config.market.captureCron}" — capture disabled`,
      );
    } else {
      captureTask = cron.schedule(
        config.market.captureCron,
        () => {
          void runOptionsCapture(log, 'scheduled').then((r) => {
            lastCaptureResult = r;
          });
        },
        // Eastern, not local — see config.market.captureCron.
        { timezone: config.market.captureTimezone },
      );
      log.info(
        `Option capture scheduled (${config.market.captureCron} ` +
          `${config.market.captureTimezone}), next run ${getNextCaptureRun() ?? 'unknown'}`,
      );
    }
  } else {
    log.info('Option capture disabled — POLYGON_API_KEY is not set');
  }

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
  captureTask?.stop();
  captureTask = null;
}
