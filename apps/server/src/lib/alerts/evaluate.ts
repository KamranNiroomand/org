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
 * hits. Idempotent per (symbol, ruleKey, tradingDay) via the unique index,
 * so opening the page twice in one day never duplicates an alert.
 *
 * Cheap: it reads instruments rows already in SQLite from tonight's sweep —
 * no network call of its own. Deliberately evaluates every symbol, not just
 * holdings/watchlist — a name the user has never looked at can still fire,
 * which is what actually answers "give me a heads up on something new".
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
          const result = tx
            .insert(alertEvents)
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
            .onConflictDoNothing({ target: [alertEvents.symbol, alertEvents.ruleKey, alertEvents.tradingDay] })
            .run();
          if (result.changes > 0) fired += 1;
        }
      } catch (err) {
        errors.push(`${row.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  return { scanned: rows.length, fired, errors };
}
