import { eq, sql } from 'drizzle-orm';
import { marketDb } from '../../db/market/index.js';
import { optionQuotes } from '../../db/market/schema.js';
import { paperDb } from '../../db/paper/index.js';
import { paperOrders, paperPositionHealth } from '../../db/paper/schema.js';
import { contractMultiplier } from '../paper.js';
import { positionHealth as scoreHeldContracts, type HeldContract } from '../quant.js';
import { readDocumentsSince } from '../text/news.js';
import { nowIso } from '../util.js';

/**
 * Nightly re-evaluation of every open paper position — a static "the model
 * liked this when you clicked Open" snapshot is a bad model of how a real
 * day goes: the model's own forecast moves daily with new bars, and real
 * news can move the picture the model can't see on its own. See
 * `paperPositionHealth`'s own doc comment in schema.ts for the full
 * reasoning and what a `null` score means there.
 */

export interface PositionHealthRunResult {
  tradingDay: string;
  scored: number;
  skipped: Array<{ occSymbol: string; reason: string }>;
}

export async function computePositionHealth(tradingDay: string): Promise<PositionHealthRunResult> {
  const open = paperDb.select().from(paperOrders).where(eq(paperOrders.status, 'open')).all();
  const result: PositionHealthRunResult = { tradingDay, scored: 0, skipped: [] };
  if (open.length === 0) return result;

  const underlyingByOccSymbol = new Map<string, string>();
  const contracts: HeldContract[] = [];
  for (const order of open) {
    try {
      const { underlying } = contractMultiplier(order.occSymbol);
      underlyingByOccSymbol.set(order.occSymbol, underlying);
      contracts.push({ occSymbol: order.occSymbol, underlying });
    } catch (err) {
      result.skipped.push({
        occSymbol: order.occSymbol,
        reason: err instanceof Error ? err.message : 'unknown contract',
      });
    }
  }

  let scoredByOcc: Record<string, { ev: number; ev_per_risk: number; prob_profit: number; forecast_vol: number; forecast_drift: number } | null> = {};
  if (contracts.length > 0) {
    try {
      scoredByOcc = (await scoreHeldContracts(tradingDay, contracts)).contracts;
    } catch (err) {
      // One batched call for every open position — if the sidecar is down
      // or the model refuses, nothing this run can score. That must not
      // crash the nightly job, must not fail silently, and — since scoring
      // and the news check below are independent capabilities — must not
      // suppress the news check either: a quant outage is exactly the kind
      // of night a person would still want to know real news broke.
      const reason = err instanceof Error ? err.message : 'quant unavailable';
      for (const { occSymbol } of contracts) result.skipped.push({ occSymbol, reason });
    }
  }

  for (const order of open) {
    const underlying = underlyingByOccSymbol.get(order.occSymbol);
    if (!underlying) continue; // already recorded above

    const scored = scoredByOcc[order.occSymbol] ?? null;
    const docs = readDocumentsSince(underlying, order.openedAt);
    const latest = docs[0];

    paperDb
      .insert(paperPositionHealth)
      .values({
        orderId: order.id,
        day: tradingDay,
        currentEv: scored?.ev ?? null,
        currentEvPerRisk: scored?.ev_per_risk ?? null,
        currentProbProfit: scored?.prob_profit ?? null,
        currentForecastVol: scored?.forecast_vol ?? null,
        currentForecastDrift: scored?.forecast_drift ?? null,
        newDocumentsCount: docs.length,
        latestDocumentTitle: latest?.title ?? null,
        latestDocumentEventType: latest?.eventType ?? null,
        latestDocumentPublishedAt: latest?.publishedAt ?? null,
        computedAt: nowIso(),
      })
      .onConflictDoUpdate({
        target: [paperPositionHealth.orderId, paperPositionHealth.day],
        set: {
          currentEv: scored?.ev ?? null,
          currentEvPerRisk: scored?.ev_per_risk ?? null,
          currentProbProfit: scored?.prob_profit ?? null,
          currentForecastVol: scored?.forecast_vol ?? null,
          currentForecastDrift: scored?.forecast_drift ?? null,
          newDocumentsCount: docs.length,
          latestDocumentTitle: latest?.title ?? null,
          latestDocumentEventType: latest?.eventType ?? null,
          latestDocumentPublishedAt: latest?.publishedAt ?? null,
          computedAt: nowIso(),
        },
      })
      .run();
    result.scored += 1;
  }

  return result;
}

/** Latest health row per order, for the API to join onto the equity response. */
export function latestPositionHealth(): Map<string, typeof paperPositionHealth.$inferSelect> {
  const rows = paperDb.select().from(paperPositionHealth).all();
  const byOrder = new Map<string, typeof paperPositionHealth.$inferSelect>();
  for (const row of rows) {
    const existing = byOrder.get(row.orderId);
    // The autoincrement id, not `day` and not `computedAt`: an ad-hoc
    // "Check health" click can legitimately compute against an earlier
    // trading day than a previous run did (see latestCapturedTradingDay),
    // so the greatest `day` is not reliably the most recent row — and two
    // computations can land in the same millisecond, tying `computedAt`.
    // Insertion order never ties and is always the real recency order.
    if (!existing || row.id > existing.id) byOrder.set(row.orderId, row);
  }
  return byOrder;
}

/**
 * The most recent trading day actually captured, for the ad-hoc "Check
 * health" trigger — using literal today would score against a day that
 * has no quotes yet whenever this is clicked before tonight's capture has
 * run, the same gap the Signal Board's own default day had. The scheduled
 * nightly call still passes literal today deliberately, since it always
 * runs immediately after that day's own capture completes.
 */
/**
 * The trading day this system is operating on — the one definition every
 * writer should use.
 *
 * It exists because two of them disagreed. `runAutoEntry` was called with
 * `latestCapturedTradingDay() ?? UTC today` while the exit engine stamped
 * its decisions with `todayKey()`, the *local* civil date. Those differed
 * in practice, not in theory: on 2026-08-24 the newest captured day was
 * 2026-08-21, so one session's entry decisions landed under Friday and its
 * exit decisions under Monday. A table built to answer "what did the
 * system do today, and why" then returned half the story to either query.
 *
 * Resolving to the corpus's own newest day is the right anchor: every
 * decision is made against that data, and on a reader whose pull is stale
 * that is genuinely the day being reasoned about. The fallback is UTC to
 * match the scheduler's own, since a local-vs-UTC split is the second way
 * these drift apart — in the evening they name different days.
 */
/**
 * Today's date in New York — the only calendar the US session runs on.
 * UTC dates agree with this between 00:00 and 20:00 ET and silently
 * disagree after; a nightly job delayed past 8pm ET stamped a phantom
 * next-day trading day with exactly that bug.
 */
export function nyToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function operatingTradingDay(): string {
  return latestCapturedTradingDay() ?? new Date().toISOString().slice(0, 10);
}

export function latestCapturedTradingDay(): string | null {
  const row = marketDb
    .select({ lastDay: sql<string | null>`max(${optionQuotes.tradingDay})` })
    .from(optionQuotes)
    .get();
  return row?.lastDay ?? null;
}
