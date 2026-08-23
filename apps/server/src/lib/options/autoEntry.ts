import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { paperDb } from '../../db/paper/index.js';
import { paperOrders } from '../../db/paper/schema.js';
import { openOrder, PaperError } from '../paper.js';
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

/**
 * Reads the underlying straight off each open order — denormalized at open
 * time in `openOrder` (see `paperOrders.underlying`'s own doc comment) —
 * rather than re-resolving it via a live join to `optionContracts`. That
 * join is exactly what used to break this guarantee: a contract pruned or
 * expired out of the corpus while its order was still open would silently
 * drop out of the held-set, letting a second position open on the same
 * name. Only pre-migration rows (`underlying` still null) fall through
 * this check — a one-time gap that closes as those orders close.
 */
function alreadyHeldUnderlyings(): Set<string> {
  const open = paperDb.select({ underlying: paperOrders.underlying }).from(paperOrders).where(eq(paperOrders.status, 'open')).all();
  return new Set(open.map((o) => o.underlying).filter((u): u is string => u !== null));
}

function hasExitTarget(c: RankedContract): boolean {
  return c.suggested_target_exit_price !== null && c.suggested_stop_loss_price !== null && c.suggested_target_exit_date !== null;
}

function pickCandidate(contracts: RankedContract[], heldUnderlyings: Set<string>): RankedContract | null {
  const eligible = contracts
    .filter((c) => c.ev_per_risk >= config.market.autoEntry.minEvPerRisk)
    .filter((c) => c.prob_profit >= config.market.autoEntry.minProbProfit)
    .filter((c) => !heldUnderlyings.has(c.underlying))
    // A candidate this can't compute an exit plan for can't be auto-managed
    // — opening it anyway would leave a `source: 'model'` position with no
    // target that exitEngine.ts's managedOpenOrders() can never see again.
    // Better to skip it for today than open something silently unmanaged.
    .filter(hasExitTarget);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, c) => (c.ev > best.ev ? c : best));
}

/**
 * `rankDay` is injectable — same reason `exitEngine.ts` injects its quant
 * calls: the test suite's `QUANT_URL` is pinned unreachable (see
 * vitest.config.ts), so exercising the actual candidate-selection logic
 * needs a real ranked list supplied directly, not just the honest
 * "sidecar unavailable" fallback.
 */
export async function runAutoEntry(day: string, rankDayFn: typeof rankDay = rankDay): Promise<AutoEntryResult> {
  let ranked: RankedContract[];
  try {
    ranked = (await rankDayFn(day, 25, true)).contracts;
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

  // pickCandidate already required a full exit target (hasExitTarget) — a
  // candidate without one is never selected, so this order is never left
  // open without a target to manage.
  paperDb
    .update(paperOrders)
    .set({
      entryEv: candidate.ev,
      targetExitPriceE4: Math.round(candidate.suggested_target_exit_price! * 10_000),
      stopLossPriceE4: Math.round(candidate.suggested_stop_loss_price! * 10_000),
      targetExitDate: candidate.suggested_target_exit_date!,
      exitUpdatedAt: nowIso(),
    })
    .where(eq(paperOrders.id, orderId))
    .run();

  return { day, openedOccSymbol: candidate.occ_symbol, orderId, skippedReason: null };
}
