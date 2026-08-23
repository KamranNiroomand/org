import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { paperDb } from '../../db/paper/index.js';
import { paperOrders } from '../../db/paper/schema.js';
import { contractMultiplier, openOrder, PaperError } from '../paper.js';
import { rankDay, QuantRefusal, QuantUnavailable, type RankedContract } from '../quant.js';
import { nowIso } from '../util.js';

/**
 * Once/day, alongside the existing rank refresh: opens the top-ranked
 * contract clearing both bars in `config.market.autoEntry` as a
 * `source: 'model'` paper order, carrying the exit target
 * `services/quant/app/exit.py` already suggested for it — see the
 * "Options model" plan's Phase 1 for why this exists: a signal that only
 * ever shows a ranked list is a signal you have to act on by hand, and
 * that was the actual complaint this was built to answer.
 *
 * Both bars are explicitly a first-pass sanity floor, not a backtested
 * threshold — same honesty framing as the radar's own eligibility floor
 * elsewhere in this codebase. One position at a time per underlying: opening
 * a second position on a name already held would double exposure to the
 * same forecast, not diversify it.
 */

export interface AutoEntryResult {
  day: string;
  openedOccSymbol: string | null;
  orderId: string | null;
  skippedReason: string | null;
}

function alreadyHeldUnderlyings(): Set<string> {
  const open = paperDb.select().from(paperOrders).where(eq(paperOrders.status, 'open')).all();
  const underlyings = new Set<string>();
  for (const order of open) {
    try {
      underlyings.add(contractMultiplier(order.occSymbol).underlying);
    } catch {
      // Contract no longer resolvable (expired/removed) — irrelevant to
      // "is this underlying already held", not this function's concern.
    }
  }
  return underlyings;
}

function pickCandidate(contracts: RankedContract[], heldUnderlyings: Set<string>): RankedContract | null {
  const eligible = contracts
    .filter((c) => c.ev_per_risk >= config.market.autoEntry.minEvPerRisk)
    .filter((c) => c.prob_profit >= config.market.autoEntry.minProbProfit)
    .filter((c) => !heldUnderlyings.has(c.underlying));
  if (eligible.length === 0) return null;
  return eligible.reduce((best, c) => (c.ev > best.ev ? c : best));
}

export async function runAutoEntry(day: string): Promise<AutoEntryResult> {
  let ranked: RankedContract[];
  try {
    ranked = (await rankDay(day, 25, true)).contracts;
  } catch (err) {
    const reason =
      err instanceof QuantRefusal || err instanceof QuantUnavailable
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Ranking failed for an unknown reason';
    return { day, openedOccSymbol: null, orderId: null, skippedReason: reason };
  }

  const candidate = pickCandidate(ranked, alreadyHeldUnderlyings());
  if (!candidate) {
    return {
      day,
      openedOccSymbol: null,
      orderId: null,
      skippedReason:
        'No contract cleared the auto-entry bar today, or every eligible underlying already has an open position.',
    };
  }

  let orderId: string;
  try {
    orderId = openOrder({
      occSymbol: candidate.occ_symbol,
      quantity: 1,
      entryPriceE4: Math.round(candidate.market_price * 10_000),
      source: 'model',
      notes: `Auto-opened: EV ${candidate.ev.toFixed(2)}, ${(candidate.ev_per_risk * 100).toFixed(1)}% of risk, P(profit) ${(candidate.prob_profit * 100).toFixed(0)}%.`,
    });
  } catch (err) {
    const reason = err instanceof PaperError ? err.message : err instanceof Error ? err.message : 'Failed to open order';
    return { day, openedOccSymbol: null, orderId: null, skippedReason: reason };
  }

  const update: Partial<typeof paperOrders.$inferInsert> = { entryEv: candidate.ev };
  if (
    candidate.suggested_target_exit_price !== null &&
    candidate.suggested_stop_loss_price !== null &&
    candidate.suggested_target_exit_date !== null
  ) {
    update.targetExitPriceE4 = Math.round(candidate.suggested_target_exit_price * 10_000);
    update.stopLossPriceE4 = Math.round(candidate.suggested_stop_loss_price * 10_000);
    update.targetExitDate = candidate.suggested_target_exit_date;
    update.exitUpdatedAt = nowIso();
  }
  paperDb.update(paperOrders).set(update).where(eq(paperOrders.id, orderId)).run();

  return { day, openedOccSymbol: candidate.occ_symbol, orderId, skippedReason: null };
}
