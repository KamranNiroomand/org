import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { skewAgentReads, stockAgentReads } from '../db/schema.js';

/**
 * The system's own daily physical: every hour, verify the whole trading
 * chain end-to-end and REMEDIATE the standard failures automatically.
 *
 * Born from a week in which each day one silent link died — a wedged
 * sidecar, an unsolved volatility batch, an immortal lock eating an
 * entry cycle, a half-judged agent board — and each was found by a
 * human asking "why is nothing happening?". Reliability is the system
 * asking itself first, running the same runbook a human ran, and
 * confessing anything it could not fix on a status card no one has to
 * request.
 *
 * Checks are FACTS with a pass/fail and a plain sentence; remediations
 * are the bounded, idempotent moves from the incident log: re-solve
 * volatilities, re-pull the snapshot, re-warm the map, top up agent
 * reads. Anything needing more than that fails loudly instead.
 */

export interface HealthCheck {
  name: string;
  ok: boolean;
  /** Plain-language: what was verified, or what is wrong and what was tried. */
  detail: string;
  remediated?: boolean;
}

export interface HealthReport {
  ranAt: string;
  checks: HealthCheck[];
  allOk: boolean;
}

let lastReport: HealthReport | null = null;
export const latestHealthReport = (): HealthReport | null => lastReport;

const isWeekend = (): boolean => [0, 6].includes(new Date().getDay());

async function runnerAudit(): Promise<Record<string, unknown> | null> {
  if (!config.market.runnerHttpUrl) return null;
  try {
    const res = await fetch(`${config.market.runnerHttpUrl}/api/options/daily-audit`, {
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function runSystemCheck(log: FastifyBaseLogger): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  const { nyToday, latestCapturedTradingDay } = await import('./options/positionHealth.js');
  const today = nyToday();

  // 1. The trading machine answers.
  const audit = await runnerAudit();
  checks.push({
    name: 'Trading machine',
    ok: audit !== null,
    detail:
      audit !== null
        ? 'The always-on machine answered and reported its state.'
        : 'The always-on machine did not answer — trading, marking, and tonight\'s capture are at risk. Check it is awake and its app is running.',
  });

  if (audit !== null) {
    // 2. Board freshness (weekends excluded: no session, no new board).
    const boardDay = String(audit.latestBoardDay ?? '');
    const boardFresh = isWeekend() || boardDay >= previousTradingDayIsh(today);
    checks.push({
      name: 'Option chains captured',
      ok: boardFresh,
      detail: boardFresh
        ? `Latest full board: ${boardDay}.`
        : `Latest board is ${boardDay} — the nightly capture has missed at least one session.`,
    });

    // 3. Volatilities solved for that board — the silent killer of
    //    2026-09-10 (115k quotes, zero IVs, empty map, no entries).
    const ivCount = Number(audit.latestBoardIvCount ?? 0);
    let ivOk = ivCount > 0;
    let ivRemediated = false;
    if (!ivOk && audit.quantHealthy === true) {
      try {
        const res = await fetch(
          `${config.market.runnerHttpUrl}/api/options/reprice-latest`,
          { method: 'POST', signal: AbortSignal.timeout(1_800_000) },
        );
        if (res.ok) {
          const body = (await res.json()) as { priced?: number };
          ivOk = (body.priced ?? 0) > 0;
          ivRemediated = ivOk;
        }
      } catch {
        // stays failed, reported below
      }
    }
    checks.push({
      name: 'Prices solved',
      ok: ivOk,
      remediated: ivRemediated,
      detail: ivOk
        ? ivRemediated
          ? 'The board had no solved prices — re-solved automatically.'
          : `${ivCount.toLocaleString()} contracts priced on the latest board.`
        : 'The latest board has no solved prices and automatic re-solving failed — the map and entry engine are blind until this is fixed.',
    });

    // 4. The entry engine left a verdict for the last session — trades
    //    OR a logged reason. Silence is the one inexcusable outcome.
    const entryDecisions = Number(audit.entryDecisionsForBoardDay ?? 0);
    checks.push({
      name: 'Entry engine spoke',
      ok: isWeekend() || entryDecisions > 0,
      detail:
        entryDecisions > 0
          ? `The entry engine recorded ${entryDecisions} decision(s) for ${boardDay}.`
          : isWeekend()
            ? 'Weekend — no session to decide on.'
            : `No entry decisions recorded for ${boardDay} — the entry step never ran or died before logging. Its next cycle is tonight; if this persists, the lock/visibility path needs eyes.`,
    });

    // 5. Positions marked.
    const marksDay = String(audit.latestMarksDay ?? '');
    checks.push({
      name: 'Positions marked',
      ok: isWeekend() || marksDay >= boardDay,
      detail: `Latest position marks: ${marksDay || 'none'}.`,
    });

    // 6. Models fresh (a registered run within 3 days).
    const modelDay = String(audit.latestModelRegisteredDay ?? '');
    const modelFresh = modelDay >= daysAgoIso(3);
    checks.push({
      name: 'Models retraining',
      ok: modelFresh,
      detail: modelFresh
        ? `Latest model run registered ${modelDay}.`
        : `No model run registered since ${modelDay || 'ever'} — the daily retrain is not completing.`,
    });
  }

  // 7. Reader corpus in sync with the runner.
  const localBoard = latestCapturedTradingDay();
  const runnerBoard = audit ? String(audit.latestBoardDay ?? '') : null;
  const syncOk = !runnerBoard || (localBoard ?? '') >= runnerBoard;
  let syncRemediated = false;
  if (!syncOk) {
    try {
      const { pullMarketSnapshot } = await import('./options/marketPull.js');
      const pull = await pullMarketSnapshot();
      syncRemediated = pull.ok && (latestCapturedTradingDay() ?? '') >= (runnerBoard ?? '');
    } catch {
      /* reported below */
    }
  }
  checks.push({
    name: 'This screen in sync',
    ok: syncOk || syncRemediated,
    remediated: syncRemediated,
    detail:
      syncOk || syncRemediated
        ? syncRemediated
          ? 'This machine was behind the trading machine — re-synced automatically.'
          : `Local data current (${localBoard ?? 'none'}).`
        : 'This machine\'s copy of the data is behind and re-syncing failed.',
  });

  // 8/9. The reading agents covered their boards (they self-heal hourly;
  //      this check only verifies the healing is actually landing).
  const skewCount = db
    .select({ n: sql<number>`count(*)` })
    .from(skewAgentReads)
    .where(eq(skewAgentReads.day, localBoard ?? ''))
    .get()?.n ?? 0;
  checks.push({
    name: 'Map judged',
    ok: isWeekend() || skewCount > 0,
    detail: skewCount > 0 ? `${skewCount} names judged on the ${localBoard} map.` : `No agent reads yet for the ${localBoard} map — the hourly top-up should fill it; flag if this persists all day.`,
  });
  const stockReadCount = db
    .select({ n: sql<number>`count(*)` })
    .from(stockAgentReads)
    .where(eq(stockAgentReads.day, today))
    .get()?.n ?? 0;
  checks.push({
    name: 'Stock boards judged',
    ok: isWeekend() || stockReadCount > 0,
    detail: stockReadCount > 0 ? `${stockReadCount} stock reads for ${today}.` : `No stock reads yet today — the hourly top-up should fill it.`,
  });

  const report: HealthReport = {
    ranAt: new Date().toISOString(),
    checks,
    allOk: checks.every((c) => c.ok),
  };
  lastReport = report;
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    log.warn(`System check: ${failed.length} failing — ${failed.map((c) => c.name).join(', ')}`);
  } else {
    log.info(`System check: all ${checks.length} checks passed`);
  }
  return report;
}

/** Cheap previous-trading-day approximation: 3 calendar days back covers
 * weekends; holidays read as a false alarm once a quarter, acceptable
 * for a warning light (never used for trading decisions). */
function previousTradingDayIsh(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
}

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}
