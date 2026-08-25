import { max, sql } from 'drizzle-orm';
import { marketDb } from '../../db/market/index.js';
import { equityBars } from '../../db/market/schema.js';
import { backfillBars, type BackfillProgress } from './backfill.js';
import type { OptionsProvider } from './provider.js';
import { listUniverse, toVendorSymbol } from './universe.js';

/**
 * Nightly incremental bars sync — the job whose absence went unnoticed for a
 * week.
 *
 * Bars were originally loaded by a one-off backfill script and then never
 * again: the options chain was captured every night while the underlying
 * bars — the input to *every* forecast (momentum features, HAR realized
 * vol, the direction model's whole panel) — silently froze at whatever day
 * the script was last run by hand. Positions were being opened on week-old
 * momentum and week-old vol, and nothing anywhere said so.
 *
 * The sync is deliberately a thin wrapper over `backfillBars`, which is
 * already idempotent (upsert per (symbol, day)) and checkpointed: the only
 * new decision here is the range. `from` starts a few days *before* the
 * latest stored bar, not at it — `adjusted=true` means a split or dividend
 * restates recent history, and re-fetching a small overlap window picks
 * those restatements up for free. An empty table falls back to a modest
 * default window rather than a full-history pull; the deep backfill stays
 * an explicit operator action.
 */
const OVERLAP_DAYS = 5;
const EMPTY_TABLE_WINDOW_DAYS = 30;

export async function syncBars(provider: OptionsProvider): Promise<BackfillProgress> {
  const latest = marketDb
    .select({ day: max(equityBars.day) })
    .from(equityBars)
    .get()?.day;

  const today = new Date().toISOString().slice(0, 10);
  const windowDays = latest === null || latest === undefined ? EMPTY_TABLE_WINDOW_DAYS : OVERLAP_DAYS;
  const anchor = latest ?? today;
  const from = new Date(Date.parse(`${anchor}T00:00:00Z`) - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const symbols = listUniverse({ activeOnly: true }).map((u) => toVendorSymbol(u.symbol));
  return backfillBars(provider, symbols, from, today);
}

/** The latest stored bar day — for the health panel to surface staleness. */
export function latestBarDay(): string | null {
  return (
    marketDb
      .select({ day: sql<string | null>`max(${equityBars.day})` })
      .from(equityBars)
      .get()?.day ?? null
  );
}
