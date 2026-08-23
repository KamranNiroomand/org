import { config } from '../../config.js';
import { accountCapacity, openOrder, PaperError } from '../paper.js';
import { selectEntries, QuantRefusal, QuantUnavailable, type RankedContract } from '../quant.js';

/**
 * Once/day, alongside the existing rank refresh: opens every contract the
 * quant sidecar's `select_entries` picks as a `source: 'model'` paper
 * order, each carrying the exit target `services/quant/app/exit.py`
 * suggested for it — see the "Options model" plan's Phase 1 for why this
 * exists: a signal that only ever shows a ranked list is a signal you have
 * to act on by hand, and that was the actual complaint this was built to
 * answer.
 *
 * **How many positions is a market question, not a constant.** The count
 * falls out of how many genuinely independent, affordable candidates clear
 * the bar on a given day, bounded by the account's real free cash and the
 * concurrent/daily caps in `config.market.autoEntry`. The allocation rule
 * itself lives in Python with the rest of the decision math — see
 * `select_entries`, including the real $122,440-per-contract candidate
 * that proved an explicit capital constraint was not optional.
 */

export interface AutoEntryResult {
  day: string;
  opened: Array<{ occSymbol: string; orderId: string }>;
  /** Why nothing was opened. Null whenever at least one position opened —
   * a per-contract problem during a partly-successful run goes in
   * `failures`, so a non-null value here always means "no positions". */
  skippedReason: string | null;
  /** Per-contract problems during an otherwise successful run. */
  failures: string[];
}

/**
 * `selectEntries` is injectable — same reason `exitEngine.ts` injects its
 * quant calls: the test suite's `QUANT_URL` is pinned unreachable (see
 * vitest.config.ts), so exercising the actual open-and-persist loop needs
 * a real selection supplied directly, not just the honest "sidecar
 * unavailable" fallback.
 */
export async function runAutoEntry(
  day: string,
  selectEntriesFn: typeof selectEntries = selectEntries,
): Promise<AutoEntryResult> {
  const capacity = accountCapacity();
  const availableCapital =
    (capacity.freeCashE4 / 10_000) * (1 - config.market.autoEntry.capitalReservePct);

  let selected: RankedContract[];
  try {
    selected = (
      await selectEntriesFn({
        day,
        heldUnderlyings: capacity.heldUnderlyings,
        availableCapital,
        openPositionCount: capacity.openPositionCount,
        maxConcurrentPositions: config.market.autoEntry.maxConcurrentPositions,
        maxNewPositions: config.market.autoEntry.maxNewPositionsPerDay,
        minEvPerRisk: config.market.autoEntry.minEvPerRisk,
        minProbProfit: config.market.autoEntry.minProbProfit,
      })
    ).selected;
  } catch (err) {
    const reason =
      err instanceof QuantRefusal || err instanceof QuantUnavailable
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Entry selection failed for an unknown reason';
    return { day, opened: [], skippedReason: reason, failures: [] };
  }

  if (selected.length === 0) {
    return {
      day,
      opened: [],
      skippedReason:
        'No contract cleared the auto-entry bar today, or none fit the account’s remaining capital and position limits.',
      failures: [],
    };
  }

  const opened: Array<{ occSymbol: string; orderId: string }> = [];
  const failures: string[] = [];
  for (const candidate of selected) {
    try {
      // The sidecar excludes candidates with no computable exit plan before
      // it allocates, so this should never fire — but a null slipping
      // through would not throw here: `null * 10_000` is 0 in JavaScript,
      // silently writing a zeroed target and a null date, which
      // `managedOpenOrders()` then filters out forever. That is the
      // orphaned-unmanaged-position bug again, so it's checked rather than
      // asserted away.
      if (
        candidate.suggested_target_exit_price === null ||
        candidate.suggested_stop_loss_price === null ||
        candidate.suggested_target_exit_date === null
      ) {
        failures.push(`${candidate.occ_symbol}: selected without a complete exit plan — not opened`);
        continue;
      }
      // Order and exit plan land in one insert — see `OpenOrderInput.exitPlan`
      // for why this must not be an insert followed by an update.
      const orderId = openOrder({
        occSymbol: candidate.occ_symbol,
        quantity: 1,
        entryPriceE4: Math.round(candidate.market_price * 10_000),
        source: 'model',
        notes: `Auto-opened: EV ${candidate.ev.toFixed(2)}, ${(candidate.ev_per_risk * 100).toFixed(1)}% of risk, P(profit) ${(candidate.prob_profit * 100).toFixed(0)}%.`,
        exitPlan: {
          targetExitPriceE4: Math.round(candidate.suggested_target_exit_price * 10_000),
          stopLossPriceE4: Math.round(candidate.suggested_stop_loss_price * 10_000),
          targetExitDate: candidate.suggested_target_exit_date,
          entryEv: candidate.ev,
        },
      });
      opened.push({ occSymbol: candidate.occ_symbol, orderId });
    } catch (err) {
      // One contract failing to open must not cost the rest of the day's
      // selection — same per-item isolation as capture.ts's own loop.
      const message = err instanceof PaperError ? err.message : err instanceof Error ? err.message : 'Failed to open order';
      failures.push(`${candidate.occ_symbol}: ${message}`);
    }
  }

  return {
    day,
    opened,
    // Only a run that opened nothing gets a skip reason — see the field's
    // own doc comment.
    skippedReason: opened.length === 0 && failures.length > 0 ? failures.join('; ') : null,
    failures,
  };
}
