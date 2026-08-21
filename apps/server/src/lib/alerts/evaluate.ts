import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { alertEvents, holdings, instruments, watchlist } from '../../db/schema.js';
import { newId, nowIso, todayKey } from '../util.js';
import { evaluatePriceRules, type InstrumentSnapshot } from './rules.js';

export interface AlertRunSummary {
  scanned: number;
  fired: number;
  errors: string[];
}

/**
 * Runs the price rules over the full instruments universe and persists new
 * hits, one row per (symbol, ruleKey, tradingDay). Idempotent for an
 * unchanged re-evaluation — but not a strict "first fire wins" dedup: this
 * app already ships two ways to re-evaluate mid-day (the market-refresh
 * button and this feature's own "Check now"), so a rule that keeps
 * matching with a materially different headline (a -7.2% drop that's now
 * -18%) updates the existing row and re-opens it for acknowledgment,
 * rather than leaving the first, now-stale number sitting there dedup'd
 * away for the rest of the day.
 *
 * Cheap: it reads instruments rows already in SQLite from tonight's sweep —
 * no network call of its own. Deliberately evaluates every symbol, not just
 * holdings/watchlist — a name the user has never looked at can still fire,
 * which is what actually answers "give me a heads up on something new".
 *
 * Safe to call with no reentrancy guard (unlike runOptionsCapture/
 * runTextSync in scheduler.ts) only because this function has no `await` —
 * better-sqlite3 is synchronous, so the whole run is one atomic turn of the
 * event loop and can't interleave with a concurrent call. If this ever
 * grows a real await (e.g. a news-fetch step), add a `running` guard before
 * that lands — the reentrancy protection above disappears with it.
 */
export function evaluatePriceAlerts(tradingDay: string = todayKey()): AlertRunSummary {
  const rows: InstrumentSnapshot[] = db
    .select({
      symbol: instruments.symbol,
      price: instruments.price,
      dayChangePercent: instruments.dayChangePercent,
      fiftyTwoWeekHigh: instruments.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: instruments.fiftyTwoWeekLow,
      volume: instruments.volume,
      avgVolume10Day: instruments.avgVolume10Day,
    })
    .from(instruments)
    .all();

  const held = new Set(db.select({ symbol: holdings.symbol }).from(holdings).all().map((h) => h.symbol));
  const watched = new Set(db.select({ symbol: watchlist.symbol }).from(watchlist).all().map((w) => w.symbol));

  let fired = 0;
  const errors: string[] = [];
  const at = nowIso();

  db.transaction((tx) => {
    for (const row of rows) {
      try {
        for (const hit of evaluatePriceRules(row)) {
          const context = held.has(row.symbol) ? 'holding' : watched.has(row.symbol) ? 'watchlist' : 'unwatched';
          const existing = tx
            .select({ id: alertEvents.id, headline: alertEvents.headline })
            .from(alertEvents)
            .where(
              and(
                eq(alertEvents.symbol, row.symbol),
                eq(alertEvents.ruleKey, hit.ruleKey),
                eq(alertEvents.tradingDay, tradingDay),
              ),
            )
            .get();

          if (!existing) {
            tx.insert(alertEvents)
              .values({
                id: newId(),
                symbol: row.symbol,
                ruleKey: hit.ruleKey,
                tradingDay,
                context,
                direction: hit.direction,
                headline: hit.headline,
                detail: hit.detail,
                acknowledged: false,
                triggeredAt: at,
                createdAt: at,
              })
              .run();
            fired += 1;
          } else if (existing.headline !== hit.headline) {
            tx.update(alertEvents)
              .set({ direction: hit.direction, headline: hit.headline, detail: hit.detail, acknowledged: false, triggeredAt: at })
              .where(eq(alertEvents.id, existing.id))
              .run();
            fired += 1;
          }
        }
      } catch (err) {
        errors.push(`${row.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  return { scanned: rows.length, fired, errors };
}
