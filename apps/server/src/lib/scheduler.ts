import cron from 'node-cron';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { asc, desc, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { nowIso, todayKey } from './util.js';
import { db } from '../db/index.js';
import { holdings, radarScores, watchlist } from '../db/schema.js';
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
import { markOpenPositions, computeDailyEquity } from './paper.js';
import { registerModelRun } from './options/modelRegistry.js';
import { ingestNewsForUniverse } from './text/news.js';
import { ingestEdgarForUniverse } from './text/edgar.js';
import { classifyUnclassifiedDocuments } from './text/classify.js';
import { computePositionHealth, latestCapturedTradingDay } from './options/positionHealth.js';
import { pullMarketSnapshot } from './options/marketPull.js';
import { evaluatePriceAlerts } from './alerts/evaluate.js';
import { createNewsAlerts } from './alerts/newsAlerts.js';
import { runRadarScoring, type RadarRunSummary } from './radar/run.js';
import { startPanelRun } from './agents/panel/run.js';

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
  alerts: { scanned: number; fired: number };
  prices: { symbols: number; quoted: number; usdCad: number | null };
  errors: string[];
}

export async function runNightly(log: FastifyBaseLogger, reason: string): Promise<NightlyResult> {
  const result: NightlyResult = {
    startedAt: new Date().toISOString(),
    banks: { items: 0, added: 0, modified: 0, removed: 0, categorized: 0 },
    calendars: { feeds: 0, added: 0, updated: 0, removed: 0 },
    market: { universe: 0, quoted: 0 },
    alerts: { scanned: 0, fired: 0 },
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
     * A few thousand symbols after SPAC warrant/unit/right derivatives are
     * classified out (see universe.ts's own `classifyUniverse` call), roughly
     * a minute end to end. Nightly is the right cadence: listings change
     * slowly, and market cap, P/E and sector barely move intraday. The open
     * page re-quotes only what it displays.
     */
    let sweepSucceeded = false;
    try {
      const universe = await refreshUniverse();
      const swept = await sweepMarket();
      result.market = { universe: universe.total, quoted: swept.quoted };
      log.info(`Market: ${swept.quoted}/${universe.total} instruments quoted`);
      if (universe.classificationSkipped) {
        // Fails open by design (see universe.ts) — but silent every night
        // would hide a sustained quant-sidecar outage behind what looks like
        // ordinary listing churn in the added/updated/removed counts.
        log.warn('Market: SPAC warrant/unit/right classification skipped — quant sidecar unreachable');
        result.errors.push('Universe classification skipped: quant sidecar unreachable');
      }
      sweepSucceeded = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Market sweep: ${message}`);
    }

    // --- Price alerts ---------------------------------------------------------
    // Right after the sweep, on the row set it just wrote — evaluating against
    // yesterday's prices would flag moves a day stale by the time anyone opens
    // the tab. Skipped entirely when the sweep itself failed: instruments still
    // holds yesterday's numbers then, and evaluating against them would insert
    // an alert dated *today* for a move that isn't actually today's — a stale
    // headline dressed up as fresh news, and one that would then dedup-block
    // the real alert once a later sweep does succeed.
    if (sweepSucceeded) {
      try {
        const alerts = evaluatePriceAlerts();
        result.alerts = { scanned: alerts.scanned, fired: alerts.fired };
        log.info(`Alerts: ${alerts.fired} fired across ${alerts.scanned} instruments`);
        result.errors.push(...alerts.errors);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`Alert evaluation: ${message}`);
      }
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

    // --- Options corpus (reader machines only) ------------------------------
    // The runner captures and marks its own paper trades on its own schedule
    // (`runOptionsCapture`, `runPaperMaintenance`). A reader never runs that
    // job at all, so without this it would never sync from the runner and
    // never mark or health-check any paper trades placed here — see
    // `runPaperMaintenance`'s own doc comment for the incident that found
    // this gap. `SYNC_CRON` defaults to 06:00 local, comfortably after the
    // runner's own ~16:45 Eastern capture, so this sees that night's data.
    if (!isRunner() && config.market.runnerSshHost) {
      const pull = await pullMarketSnapshot();
      if (pull.ok) {
        log.info(`Market sync: ${pull.message}`);
        const tradingDay = latestCapturedTradingDay() ?? new Date().toISOString().slice(0, 10);
        await runPaperMaintenance(log, tradingDay);
      } else {
        result.errors.push(`Market sync: ${pull.message}`);
      }
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

/**
 * Marks every open paper position and re-evaluates its health for one
 * trading day — reads `market.db` (quotes, documents) but only ever writes
 * `paper.db`, so this is safe to run on a reader as well as the runner.
 * That matters: `paper.db` is deliberately per-machine (see its own schema
 * doc comment), and a person places a trade from whichever machine they're
 * looking at the UI on, a reader as often as the runner — this used to only
 * run inside `runOptionsCapture`, which is only ever scheduled on the
 * runner, so a reader's own paper trades never got marked or health-checked
 * by anything but a manual click. Shared here so both callers use the exact
 * same logic rather than two copies drifting apart.
 */
async function runPaperMaintenance(log: FastifyBaseLogger, tradingDay: string): Promise<void> {
  try {
    const marks = markOpenPositions(tradingDay);
    computeDailyEquity(tradingDay);
    log.info(`Paper book: ${marks.marked} position(s) marked, ${marks.skipped.length} skipped`);
  } catch (err) {
    log.error({ err }, 'Paper marking failed');
  }

  try {
    const health = await computePositionHealth(tradingDay);
    log.info(`Position health: ${health.scored} position(s) scored, ${health.skipped.length} skipped`);
  } catch (err) {
    log.error({ err }, 'Position health failed');
  }
}

// ---------------------------------------------------------------------------
// Text — news and EDGAR
// ---------------------------------------------------------------------------

/**
 * News and EDGAR ingestion + classification, on its own cadence
 * (`TEXT_SYNC_CRON`, market hours) rather than only riding along with the
 * once-nightly capture job.
 *
 * A headline breaking at 10am used to sit unseen until the 16:45 capture
 * job got around to it — stale by any reasonable reading of "an options
 * position should know about the news." This runs independently, and
 * `runOptionsCapture` also calls it once more directly after capture so
 * that night's `runPaperMaintenance` still sees whatever landed since the
 * last poll.
 *
 * Runner-only, same reasoning as capture itself: documents/doc_mentions
 * live in `market.db`, and writing them on a reader would be silently
 * destroyed by the next `market:pull`.
 */
let textSyncing = false;

export interface TextSyncResult {
  startedAt: string;
  finishedAt: string;
  documentsWritten: number;
  mentionsWritten: number;
  filingsWritten: number;
  classified: number;
  errors: string[];
}

export async function runTextSync(log: FastifyBaseLogger, reason: string): Promise<TextSyncResult> {
  const startedAt = nowIso();
  const result: TextSyncResult = {
    startedAt,
    finishedAt: startedAt,
    documentsWritten: 0,
    mentionsWritten: 0,
    filingsWritten: 0,
    classified: 0,
    errors: [],
  };

  if (!isRunner()) {
    result.errors.push('This machine is a reader; text ingestion writes to market.db, which only the runner may write.');
    result.finishedAt = nowIso();
    return result;
  }
  if (textSyncing) {
    result.errors.push('A text sync was already in progress; skipped this run.');
    result.finishedAt = nowIso();
    return result;
  }
  textSyncing = true;
  log.info(`Text sync starting (${reason})`);

  try {
    const symbols = listUniverse({ activeOnly: true }).map((u) => toVendorSymbol(u.symbol));

    // Each step isolated — SEC_EDGAR_USER_AGENT has no default (see
    // config.ts), so a machine that hasn't set it must not lose news
    // ingestion or classification of what news.ts just wrote.
    try {
      const news = await ingestNewsForUniverse(symbols);
      result.documentsWritten += news.documentsWritten;
      result.mentionsWritten += news.mentionsWritten;
      log.info(`News: ${news.documentsWritten} documents, ${news.mentionsWritten} mentions`);
      result.errors.push(...news.errors);
    } catch (err) {
      result.errors.push(`News ingest: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const edgar = await ingestEdgarForUniverse(symbols);
      result.documentsWritten += edgar.documentsWritten;
      result.filingsWritten += edgar.documentsWritten;
      log.info(`EDGAR: ${edgar.documentsWritten} filings, ${edgar.symbolsUnresolved.length} unresolved tickers`);
      result.errors.push(...edgar.errors);
    } catch (err) {
      result.errors.push(`EDGAR ingest: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Classification is capped per run (classifyUnclassifiedDocuments' own
    // default limit) rather than draining a large backlog in one call —
    // each is a live LLM call, and the next poll (20 minutes away, not
    // tomorrow night) catches up whatever's left.
    try {
      const classified = await classifyUnclassifiedDocuments();
      result.classified = classified.classified;
      log.info(`Text classification: ${classified.classified}/${classified.attempted}`);
      result.errors.push(...classified.errors);
    } catch (err) {
      result.errors.push(`Text classification: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    textSyncing = false;
  }

  result.finishedAt = nowIso();
  return result;
}

/**
 * News/EDGAR ingestion for the watchlist — the same pipeline as
 * `runTextSync`, pointed at `watchlist` instead of the options universe.
 *
 * Runner-only and Polygon-gated for the identical reason `runTextSync` is:
 * `documents`/`doc_mentions` live in `market.db`, which only the runner may
 * write. On a reader this is a documented no-op — watchlist news still
 * arrives there on the next `market:pull`, same as everything else in that
 * database.
 *
 * A separate `watchlistTextSyncing` guard, not the options one — the two
 * jobs read/write disjoint symbol sets and neither should block the other
 * from running just because it happened to overlap.
 *
 * Deliberately does NOT call `classifyUnclassifiedDocuments` itself.
 * `runTextSync` already sweeps every unclassified document regardless of
 * source, on a *tighter* cadence (`TEXT_SYNC_CRON`, 20 min, vs this job's
 * 30) — and both jobs are only ever scheduled together, under the same
 * `config.market.configured` gate. A second call here bought nothing but a
 * real cost: whenever the two crons' windows land close together (which,
 * at :00 past every trading hour, they do every day), both would select
 * the same pending rows before either had written its classification back,
 * paying for the same document's LLM classification twice.
 */
let watchlistTextSyncing = false;

export interface WatchlistTextSyncResult {
  startedAt: string;
  finishedAt: string;
  symbolsSkipped: number;
  documentsWritten: number;
  mentionsWritten: number;
  filingsWritten: number;
  alertsCreated: number;
  errors: string[];
}

export async function runWatchlistTextSync(log: FastifyBaseLogger, reason: string): Promise<WatchlistTextSyncResult> {
  const startedAt = nowIso();
  const result: WatchlistTextSyncResult = {
    startedAt,
    finishedAt: startedAt,
    symbolsSkipped: 0,
    documentsWritten: 0,
    mentionsWritten: 0,
    filingsWritten: 0,
    alertsCreated: 0,
    errors: [],
  };

  if (!isRunner()) {
    result.errors.push('This machine is a reader; text ingestion writes to market.db, which only the runner may write.');
    result.finishedAt = nowIso();
    return result;
  }
  if (!config.market.configured) {
    result.errors.push('POLYGON_API_KEY is not set — news ingestion is disabled without it.');
    result.finishedAt = nowIso();
    return result;
  }
  if (watchlistTextSyncing) {
    result.errors.push('A watchlist text sync was already in progress; skipped this run.');
    result.finishedAt = nowIso();
    return result;
  }
  watchlistTextSyncing = true;
  log.info(`Watchlist text sync starting (${reason})`);

  try {
    // Kept in this app's own format (`BRK-B`) through ingestion — only
    // converted to the vendor's format (`BRK.B`) right at the two calls
    // that actually leave the process. createNewsAlerts does its own
    // matching conversion when it reads what got stored under that format.
    const watched = db.select({ s: watchlist.symbol }).from(watchlist).all().map((w) => w.s);

    // A watchlist symbol that's already in the options universe gets fresh
    // news/EDGAR coverage from runTextSync's own, tighter-cadence sweep —
    // fetching it again here would just spend a second, redundant slot of
    // the shared Polygon rate budget on data that's already current. Only
    // symbols the options side isn't already watching are this job's to do.
    const inOptionsUniverse = new Set(listUniverse({ activeOnly: true }).map((u) => u.symbol));
    const symbols = watched.filter((s) => !inOptionsUniverse.has(s));
    result.symbolsSkipped = watched.length - symbols.length;

    if (symbols.length === 0) {
      log.info(
        watched.length === 0
          ? 'Watchlist text sync: nothing on the watchlist, skipping'
          : `Watchlist text sync: all ${watched.length} watched symbol(s) already covered by the options universe, skipping`,
      );
      result.finishedAt = nowIso();
      return result;
    }
    const vendorSymbols = symbols.map(toVendorSymbol);

    try {
      const news = await ingestNewsForUniverse(vendorSymbols);
      result.documentsWritten += news.documentsWritten;
      result.mentionsWritten += news.mentionsWritten;
      log.info(`Watchlist news: ${news.documentsWritten} documents, ${news.mentionsWritten} mentions`);
      result.errors.push(...news.errors);
    } catch (err) {
      result.errors.push(`Watchlist news ingest: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const edgar = await ingestEdgarForUniverse(vendorSymbols);
      result.documentsWritten += edgar.documentsWritten;
      result.filingsWritten += edgar.documentsWritten;
      log.info(`Watchlist EDGAR: ${edgar.documentsWritten} filings, ${edgar.symbolsUnresolved.length} unresolved tickers`);
      result.errors.push(...edgar.errors);
    } catch (err) {
      result.errors.push(`Watchlist EDGAR ingest: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      // The full watched list, not the filtered symbols — a symbol skipped
      // above because the options universe already covers it should still
      // get its news alerts; runTextSync's classification sweep reaches its
      // documents too, they just weren't fetched a second time here.
      const alerts = createNewsAlerts(watched);
      result.alertsCreated = alerts.created;
      log.info(`Watchlist news alerts: ${alerts.created} from ${alerts.documentsSeen} classified document(s)`);
      result.errors.push(...alerts.errors);
    } catch (err) {
      result.errors.push(`Watchlist news alerts: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    watchlistTextSyncing = false;
  }

  result.finishedAt = nowIso();
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

    // Right after capture, so a position opened today is marked against
    // tonight's own quotes rather than waiting for tomorrow's job — the
    // whole point of an equity curve is that it moves every day capture
    // runs, not every day someone happens to look at it. This is the
    // runner's own paper trades, if any; a reader's are covered separately
    // inside `runNightly`, since this job never runs there — see
    // `runPaperMaintenance`'s own doc comment for why that split exists.
    {
      const tradingDay = new Date().toISOString().slice(0, 10);
      await runPaperMaintenance(log, tradingDay);
    }

    // Text used to ingest here, once a night — now on its own faster cron
    // (`runTextSync`) so a headline doesn't sit unseen until 16:45. Still
    // run once more right here regardless: capture just gave every
    // underlying a fresh close, and `runPaperMaintenance` below wants
    // whatever text arrived since the last poll folded in before it reads
    // "news since you opened this."
    const text = await runTextSync(log, 'post-capture');
    result.errors.push(...text.errors);

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

// ---------------------------------------------------------------------------
// Weekly model retraining
// ---------------------------------------------------------------------------

/**
 * Retrains on an expanding window and registers the result — never
 * promotes it. `registerModelRun` always inserts a fresh run as
 * `'challenger'` (see modelRegistry.ts); it becomes `'champion'` only
 * through the manual `/api/quant/runs/:id/promote` route, exactly the
 * champion/shadow/promote policy the project plan calls for. A cron job
 * that could put an unreviewed model in front of a ranking decision on its
 * own is the one automation this project's whole validation posture exists
 * to refuse.
 *
 * Only `--target dir` runs today. `--target vrp` needs a real trailing
 * history of *captured* implied vol to mean anything and `train.py` itself
 * refuses it with a clear error until then (see its module docstring) —
 * adding it here is a one-line change to `TARGETS` once that history
 * exists, not a redesign.
 */
let retraining = false;

const TARGETS: ReadonlyArray<{ target: string; horizon: number }> = [{ target: 'dir', horizon: 5 }];

const here = dirname(fileURLToPath(import.meta.url));
// scheduler.ts lives at apps/server/src/lib/ — four levels up is the repo
// root, where services/quant lives alongside apps/server.
const repoRoot = join(here, '..', '..', '..', '..');
const quantDir = join(repoRoot, 'services', 'quant');

export interface RetrainRunOutcome {
  target: string;
  horizon: number;
  runId: string | null;
  registered: boolean;
  error: string | null;
}

export interface RetrainJobResult {
  startedAt: string;
  finishedAt: string;
  runs: RetrainRunOutcome[];
  errors: string[];
}

/** Pulls the `artifact: <path>` line train.py prints on success. */
function parseArtifactPath(stdout: string): string | null {
  const matches = [...stdout.matchAll(/artifact:\s*(.+)/g)];
  return matches.length > 0 ? matches[matches.length - 1]![1]!.trim() : null;
}

export async function runRetrain(log: FastifyBaseLogger, reason: string): Promise<RetrainJobResult> {
  const startedAt = nowIso();
  const result: RetrainJobResult = { startedAt, finishedAt: startedAt, runs: [], errors: [] };

  if (!isRunner()) {
    result.errors.push('This machine is a reader; training runs on the runner, which holds the corpus.');
    return result;
  }
  if (retraining) {
    result.errors.push('A retrain was already in progress; skipped this run.');
    return result;
  }
  retraining = true;
  log.info(`Weekly retrain starting (${reason})`);

  try {
    for (const { target, horizon } of TARGETS) {
      const outcome: RetrainRunOutcome = { target, horizon, runId: null, registered: false, error: null };

      const proc = spawnSync(
        'uv',
        ['run', '--project', quantDir, 'python', '-m', 'app.train', '--target', target, '--horizon', String(horizon)],
        { cwd: repoRoot, encoding: 'utf8', timeout: 30 * 60_000 },
      );

      if (proc.status !== 0) {
        outcome.error = (proc.stderr || proc.stdout || `exit ${proc.status}`).trim().slice(-2000);
        result.runs.push(outcome);
        result.errors.push(`${target}: ${outcome.error}`);
        continue;
      }

      const artifactDir = parseArtifactPath(proc.stdout);
      if (!artifactDir) {
        outcome.error = 'Training succeeded but no artifact path was found in its output.';
        result.runs.push(outcome);
        result.errors.push(`${target}: ${outcome.error}`);
        continue;
      }

      try {
        const registered = registerModelRun(join(artifactDir, 'manifest.json'));
        outcome.runId = registered.runId;
        outcome.registered = true;
        log.info(`Retrain: registered ${registered.runId} (${registered.created ? 'new' : 'updated'}, target=${target})`);
      } catch (err) {
        outcome.error = err instanceof Error ? err.message : String(err);
        result.errors.push(`${target}: register failed — ${outcome.error}`);
      }

      result.runs.push(outcome);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    log.error({ err }, 'Weekly retrain failed');
  } finally {
    retraining = false;
  }

  result.finishedAt = nowIso();
  return result;
}

/**
 * Kicks off a panel run over tonight's radar shortlist — the top
 * `PANEL_MAX_SYMBOLS_PER_NIGHTLY_SHORTLIST` symbols from the most recent
 * `radarScores`, not the full market, per the plan's cost bound. A no-op
 * (returns null, no `panelRuns` row) when the radar hasn't produced a
 * shortlist yet, rather than an error — a fresh install's first night has
 * nothing to run the panel over.
 *
 * Also a no-op when the most recent shortlist isn't *today's* — the same
 * staleness class `evaluatePriceAlerts` guards against via `sweepSucceeded`
 * and the radar's own `STALE_INSTRUMENTS_HOURS` check. Without this, a
 * `RADAR_CRON` failure or misconfiguration would have the panel silently
 * spend real LLM budget re-reasoning about a shortlist that's days old,
 * with nothing recording that the input was stale.
 */
function runNightlyPanel(log: FastifyBaseLogger): string | null {
  const latestDay = db
    .select({ tradingDay: radarScores.tradingDay })
    .from(radarScores)
    .orderBy(desc(radarScores.tradingDay))
    .limit(1)
    .get();
  if (!latestDay) {
    log.info('Nightly panel: no radar shortlist yet, skipping');
    return null;
  }
  if (latestDay.tradingDay !== todayKey()) {
    log.warn(`Nightly panel: radar's most recent shortlist is from ${latestDay.tradingDay}, not today — skipping`);
    return null;
  }

  const shortlist = db
    .select({ symbol: radarScores.symbol })
    .from(radarScores)
    .where(eq(radarScores.tradingDay, latestDay.tradingDay))
    .orderBy(asc(radarScores.rank))
    .limit(config.panel.maxSymbolsPerNightlyShortlist)
    .all()
    .map((r) => r.symbol);

  const runId = startPanelRun({
    trigger: 'nightly_radar',
    query: null,
    resolutionMethod: 'radar_shortlist',
    symbols: shortlist,
  });
  log.info(`Nightly panel started (${runId}) over ${shortlist.length} radar shortlist symbol(s)`);
  return runId;
}

let task: ReturnType<typeof cron.schedule> | null = null;
let captureTask: ReturnType<typeof cron.schedule> | null = null;
let retrainTask: ReturnType<typeof cron.schedule> | null = null;
let textSyncTask: ReturnType<typeof cron.schedule> | null = null;
let watchlistTextSyncTask: ReturnType<typeof cron.schedule> | null = null;
let radarTask: ReturnType<typeof cron.schedule> | null = null;
let panelTask: ReturnType<typeof cron.schedule> | null = null;
let lastResult: NightlyResult | null = null;
let lastCaptureResult: CaptureJobResult | null = null;
let lastRetrainResult: RetrainJobResult | null = null;
let lastTextSyncResult: TextSyncResult | null = null;
let lastWatchlistTextSyncResult: WatchlistTextSyncResult | null = null;
let lastRadarResult: RadarRunSummary | null = null;
let lastPanelRunId: string | null = null;

export const getLastNightlyResult = (): NightlyResult | null => lastResult;
export const getLastCaptureResult = (): CaptureJobResult | null => lastCaptureResult;
export const getLastRetrainResult = (): RetrainJobResult | null => lastRetrainResult;
export const getLastTextSyncResult = (): TextSyncResult | null => lastTextSyncResult;
export const getLastWatchlistTextSyncResult = (): WatchlistTextSyncResult | null => lastWatchlistTextSyncResult;
export const getLastRadarResult = (): RadarRunSummary | null => lastRadarResult;
export const getLastPanelRunId = (): string | null => lastPanelRunId;

/** Next scheduled chain capture, for the UI to show. */
export function getNextCaptureRun(): string | null {
  const next = captureTask?.getNextRun();
  return next ? new Date(next).toISOString() : null;
}

/** Next scheduled text sync, for the UI to show. */
export function getNextTextSyncRun(): string | null {
  const next = textSyncTask?.getNextRun();
  return next ? new Date(next).toISOString() : null;
}

/** Next scheduled retrain, for the UI to show. */
export function getNextRetrainRun(): string | null {
  const next = retrainTask?.getNextRun();
  return next ? new Date(next).toISOString() : null;
}

/** Next scheduled watchlist text sync, for the UI to show. */
export function getNextWatchlistTextSyncRun(): string | null {
  const next = watchlistTextSyncTask?.getNextRun();
  return next ? new Date(next).toISOString() : null;
}

/** Next scheduled radar run, for the UI to show. */
export function getNextRadarRun(): string | null {
  const next = radarTask?.getNextRun();
  return next ? new Date(next).toISOString() : null;
}

/** Next scheduled panel run, for the UI to show. */
export function getNextPanelRun(): string | null {
  const next = panelTask?.getNextRun();
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

  // Radar scoring lives in org.db only — no MARKET_ROLE gate, runs the same
  // on a reader as a runner, so it's scheduled here rather than inside the
  // options-only block below.
  if (!cron.validate(config.radarCron)) {
    log.error(`RADAR_CRON is not valid: "${config.radarCron}" — radar disabled`);
  } else {
    radarTask = cron.schedule(
      config.radarCron,
      () => {
        lastRadarResult = runRadarScoring();
      },
      { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    );
    log.info(`Radar scoring scheduled (${config.radarCron}), next run ${getNextRadarRun() ?? 'unknown'}`);
  }

  // Same reasoning as radar — org.db only, no MARKET_ROLE gate — but also
  // needs a real Anthropic key, since every specialist/synthesis call in a
  // panel run is an LLM call.
  if (!config.anthropic.configured) {
    log.info('Multi-agent panel not scheduled — ANTHROPIC_API_KEY is not set.');
  } else if (!cron.validate(config.panel.cron)) {
    log.error(`PANEL_CRON is not valid: "${config.panel.cron}" — panel disabled`);
  } else {
    panelTask = cron.schedule(
      config.panel.cron,
      () => {
        lastPanelRunId = runNightlyPanel(log);
      },
      { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    );
    log.info(`Multi-agent panel scheduled (${config.panel.cron}), next run ${getNextPanelRun() ?? 'unknown'}`);
  }

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

    if (!cron.validate(config.market.textSyncCron)) {
      log.error(`TEXT_SYNC_CRON is not valid: "${config.market.textSyncCron}" — text sync disabled`);
    } else {
      textSyncTask = cron.schedule(
        config.market.textSyncCron,
        () => {
          void runTextSync(log, 'scheduled').then((r) => {
            lastTextSyncResult = r;
          });
        },
        // Eastern, same as capture — market hours, not local time.
        { timezone: config.market.captureTimezone },
      );
      log.info(
        `Text sync scheduled (${config.market.textSyncCron} ` +
          `${config.market.captureTimezone}), next run ${getNextTextSyncRun() ?? 'unknown'}`,
      );
    }

    if (!cron.validate(config.market.watchlistTextSyncCron)) {
      log.error(
        `WATCHLIST_TEXT_SYNC_CRON is not valid: "${config.market.watchlistTextSyncCron}" — watchlist text sync disabled`,
      );
    } else {
      watchlistTextSyncTask = cron.schedule(
        config.market.watchlistTextSyncCron,
        () => {
          void runWatchlistTextSync(log, 'scheduled').then((r) => {
            lastWatchlistTextSyncResult = r;
          });
        },
        { timezone: config.market.captureTimezone },
      );
      log.info(
        `Watchlist text sync scheduled (${config.market.watchlistTextSyncCron} ` +
          `${config.market.captureTimezone}), next run ${getNextWatchlistTextSyncRun() ?? 'unknown'}`,
      );
    }
  } else {
    log.info('Option capture, text sync, and watchlist text sync disabled — POLYGON_API_KEY is not set');
  }

  if (!config.market.isRunner) {
    log.info('Weekly retrain not scheduled — MARKET_ROLE=reader. Training runs on the runner.');
  } else if (!cron.validate(config.market.retrainCron)) {
    log.error(`RETRAIN_CRON is not valid: "${config.market.retrainCron}" — retrain disabled`);
  } else {
    retrainTask = cron.schedule(
      config.market.retrainCron,
      () => {
        void runRetrain(log, 'scheduled').then((r) => {
          lastRetrainResult = r;
        });
      },
      { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    );
    log.info(`Weekly retrain scheduled (${config.market.retrainCron}), next run ${getNextRetrainRun() ?? 'unknown'}`);
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
  retrainTask?.stop();
  retrainTask = null;
  textSyncTask?.stop();
  textSyncTask = null;
  watchlistTextSyncTask?.stop();
  watchlistTextSyncTask = null;
  radarTask?.stop();
  radarTask = null;
  panelTask?.stop();
  panelTask = null;
}
