import { eq, sql } from 'drizzle-orm';
import { nyToday } from './positionHealth.js';
import { config } from '../../config.js';
import { marketDb } from '../../db/market/index.js';
import { optionContracts, optionQuotes } from '../../db/market/schema.js';
import { listUniverse } from './universe.js';
import { accountCapacity, contractMultiplier, logDecisions, modelEntriesOpenedOn, openOrder, PaperError } from '../paper.js';
import type { paperDecisionLog } from '../../db/paper/schema.js';

type DecisionRow = Omit<typeof paperDecisionLog.$inferInsert, 'createdAt'>;
import { fetchTradierQuotes } from './tradier.js';
import { selectEntries, QuantRefusal, QuantUnavailable, type RejectedEntry, type ScreenedOutEntry, type SelectedEntry } from '../quant.js';

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
 *
 * **Size is the sidecar's answer too, not a constant here.** This used to
 * open `quantity: 1` of whatever came back, which made the position's real
 * size an accident of the contract's price — one unit of a $12 contract and
 * one unit of a $1,200 contract are not the same bet. `select_entries` now
 * returns a quantity per pick, sized equal-weight across the day's
 * available slots.
 */

export interface AutoEntryResult {
  day: string;
  opened: Array<{ occSymbol: string; orderId: string; quantity: number }>;
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
  // Entries only on the session the board describes. The board is a
  // snapshot of one trading day's market; buying from it on any OTHER
  // calendar day records a fill nobody could get — found live when a
  // Saturday catch-up run bought a FICO put at Friday's close on a
  // market that was not open. The runner's capture-time entry always
  // passes (board day == today); every stale path — weekend catch-ups,
  // a reader restart replaying yesterday's board — is refused here, in
  // one place, rather than each caller remembering to check.
  if (day !== nyToday()) {
    const skippedReason =
      `stale_board: board is for ${day} but today is ${nyToday()} — ` +
      `not opening entries against a session that is not this one`;
    logDecisions([
      { day, occSymbol: '-', underlying: null, decision: 'rejected', reason: 'stale_board', detail: { boardDay: day, today: nyToday() } },
    ]);
    return { day, opened: [], skippedReason, failures: [] };
  }

  // A board that covers a fraction of the universe is not a smaller
  // menu — it is a *biased* one: capture walks symbols alphabetically,
  // so a truncated night leaves only the front of the alphabet, and an
  // EV-greedy selection over it is alphabetical bias wearing a ranking's
  // clothes (found live: a board cut off at "CVX" produced a book of
  // A/B/C names). Refusing to shop from it loses one day of entries;
  // shopping from it poisons the book with a bias no later day undoes.
  const boardCoverage = marketDb
    .select({ n: sql<number>`count(distinct ${optionContracts.underlying})` })
    .from(optionQuotes)
    .innerJoin(optionContracts, eq(optionQuotes.occSymbol, optionContracts.occSymbol))
    .where(eq(optionQuotes.tradingDay, day))
    .get()?.n ?? 0;
  const universeSize = listUniverse({ activeOnly: true }).length;
  if (universeSize > 0 && boardCoverage < universeSize * 0.5) {
    const skippedReason =
      `partial_board: only ${boardCoverage}/${universeSize} underlyings captured for ${day} — ` +
      `an alphabetically-biased menu; not opening entries from it`;
    logDecisions([
      { day, occSymbol: '-', underlying: null, decision: 'rejected', reason: 'partial_board', detail: { boardCoverage, universeSize } },
    ]);
    return { day, opened: [], skippedReason, failures: [] };
  }

  const capacity = accountCapacity();
  const availableCapital =
    (capacity.freeCashE4 / 10_000) * (1 - config.market.autoEntry.capitalReservePct);

  let selected: SelectedEntry[];
  let rejected: RejectedEntry[];
  let screenedOut: ScreenedOutEntry[];
  try {
    const result = await selectEntriesFn({
        day,
        heldUnderlyings: capacity.heldUnderlyings,
        availableCapital,
        openPositionCount: capacity.openPositionCount,
        openedToday: modelEntriesOpenedOn(day),
        maxConcurrentPositions: config.market.autoEntry.maxConcurrentPositions,
        maxNewPositions: config.market.autoEntry.maxNewPositionsPerDay,
        minEvPerRisk: config.market.autoEntry.minEvPerRisk,
        minProbProfit: config.market.autoEntry.minProbProfit,
        minDte: config.market.autoEntry.minDte,
        maxDte: config.market.autoEntry.maxDte,
      });
    selected = result.selected;
    rejected = result.rejected;
    screenedOut = result.screened_out ?? [];
  } catch (err) {
    const reason =
      err instanceof QuantRefusal || err instanceof QuantUnavailable
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Entry selection failed for an unknown reason';
    return { day, opened: [], skippedReason: reason, failures: [] };
  }

  // Every candidate the allocator looked at, whether or not it was taken.
  // Written once at the end rather than per-candidate: a few hundred
  // single-row inserts on a cron path is a few hundred needless round
  // trips, and a partial log is harder to reason about than a whole one.
  const decisions: DecisionRow[] = screenedOut.map((r) => ({
    day,
    occSymbol: r.occ_symbol,
    underlying: r.underlying,
    decision: 'rejected' as const,
    // Prefixed so a GROUP BY separates "the screens distrusted the quote"
    // from "the allocator turned it down" — different fixes.
    reason: `screened_${r.reason}`,
    detail: {},
  }));
  decisions.push(...rejected.map((r) => ({
    day,
    occSymbol: r.contract.occ_symbol,
    underlying: r.contract.underlying,
    decision: 'rejected' as const,
    reason: r.reason,
    detail: { ...r.detail, ev: r.contract.ev, ev_per_risk: r.contract.ev_per_risk, prob_profit: r.contract.prob_profit, dte: r.contract.dte },
  })));

  // Before the early return, not after it. A day that opened nothing is
  // the day whose reasoning is most worth having — "the market offered
  // nothing", "the book was full" and "everything was too expensive" are
  // three different situations that look identical from the outside.
  if (selected.length === 0) {
    const logged = logDecisions(decisions);
    return {
      day,
      opened: [],
      skippedReason:
        'No contract cleared the auto-entry bar today, or none fit the account’s remaining capital and position limits.',
      failures: logged ? [] : [`Decision log write failed for ${decisions.length} decision(s) — they are lost.`],
    };
  }

  const opened: Array<{ occSymbol: string; orderId: string; quantity: number }> = [];
  const failures: string[] = [];
  // Depleted as positions open, so the cap below is against cash actually
  // left rather than the whole day's budget for every pick in turn.
  let remainingE4 = Math.round(availableCapital * 10_000);
  // One batched quote call for the day's selections — the entry-side
  // realism overlay, mirror image of the exit engine's. Where Tradier
  // answers with a real ask, the fill is that ask, basis 'measured', and
  // the modelled-fill haircut stays out of it; where it doesn't, the
  // print-derived price pays the buy-side haircut in openOrder as before.
  const liveAsks = await fetchTradierQuotes(selected.map((s) => s.contract.occ_symbol));

  for (const { contract: candidate, quantity } of selected) {
    try {
      // The sidecar sizes every selection at one contract or more; a
      // non-positive quantity would open a zero-cost, zero-payoff row the
      // exit engine would then manage forever. Cheaper to refuse it than
      // to explain it later.
      if (!Number.isInteger(quantity) || quantity < 1) {
        failures.push(`${candidate.occ_symbol}: selected with a non-positive quantity (${quantity}) — not opened`);
        decisions.push({ day, occSymbol: candidate.occ_symbol, underlying: candidate.underlying, decision: 'failed', reason: 'non_positive_quantity', detail: { quantity } });
        continue;
      }
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
        decisions.push({ day, occSymbol: candidate.occ_symbol, underlying: candidate.underlying, decision: 'failed', reason: 'no_exit_plan', detail: {} });
        continue;
      }
      // The sidecar sizes against the standard 100x multiplier because a
      // ranked contract carries no multiplier of its own; the real one
      // lives here, in the contracts table, and a split-adjusted contract
      // can carry something else. Sizing used to be one unit, so a wrong
      // multiplier was a one-contract error; at 40 units it is a 40x one,
      // and `openOrder` has no cash guard of its own to catch it. So the
      // quantity is re-checked against real free cash at the real
      // multiplier, and trimmed rather than trusted.
      const entryPriceE4 = Math.round(candidate.market_price * 10_000);
      const { multiplier } = contractMultiplier(candidate.occ_symbol);
      const perContractE4 = entryPriceE4 * multiplier;
      if (perContractE4 <= 0) {
        // A price under $0.00005 rounds to 0 in E4. Dividing by it gives
        // Infinity, or NaN when no cash is left — and `NaN < 1` is false,
        // so the size check below would wave it straight through. Only
        // `openOrder`'s own positive-price guard catches it today, in
        // another module, reporting a cause this block did not diagnose.
        failures.push(
          `${candidate.occ_symbol}: quoted at $${candidate.market_price} — too small to price in E4, not opened`,
        );
        decisions.push({ day, occSymbol: candidate.occ_symbol, underlying: candidate.underlying, decision: 'failed', reason: 'price_below_e4_resolution', detail: { market_price: candidate.market_price } });
        continue;
      }
      const affordable = Math.floor(remainingE4 / perContractE4);
      const size = Math.min(quantity, affordable);
      if (size < 1) {
        failures.push(
          `${candidate.occ_symbol}: costs $${(perContractE4 / 10_000).toFixed(2)}/contract at a ${multiplier}x ` +
            `multiplier, more than the $${(remainingE4 / 10_000).toFixed(2)} left — not opened`,
        );
        decisions.push({ day, occSymbol: candidate.occ_symbol, underlying: candidate.underlying, decision: 'failed', reason: 'unaffordable_at_real_multiplier', detail: { perContractE4, multiplier, remainingE4 } });
        continue;
      }
      if (size < quantity) {
        failures.push(
          `${candidate.occ_symbol}: trimmed from ${quantity} to ${size} contracts — at a ${multiplier}x multiplier ` +
            `the sidecar's size costs more than the $${(remainingE4 / 10_000).toFixed(2)} of free cash left`,
        );
        // The case that previously left no trace anywhere: the position
        // opens, just smaller than the model asked for, and looked
        // identical afterwards to one sized that way on purpose.
        decisions.push({ day, occSymbol: candidate.occ_symbol, underlying: candidate.underlying, decision: 'trimmed', reason: 'trimmed_to_free_cash', detail: { requested: quantity, opened: size, multiplier, remainingE4 } });
      }
      // Order and exit plan land in one insert — see `OpenOrderInput.exitPlan`
      // for why this must not be an insert followed by an update.
      const liveAskE4 = liveAsks.get(candidate.occ_symbol)?.askE4 ?? null;
      const orderId = openOrder({
        occSymbol: candidate.occ_symbol,
        quantity: size,
        entryPriceE4: liveAskE4 ?? entryPriceE4,
        entryBasis: liveAskE4 !== null ? 'measured' : 'modelled',
        source: 'model',
        notes: `Auto-opened ${size}x: EV ${candidate.ev.toFixed(2)}/contract, ${(candidate.ev_per_risk * 100).toFixed(1)}% of risk, P(profit) ${(candidate.prob_profit * 100).toFixed(0)}%, ${candidate.dte}d to expiry.`,
        entryEv: candidate.ev,
        exitPlan: {
          targetExitPriceE4: Math.round(candidate.suggested_target_exit_price * 10_000),
          stopLossPriceE4: Math.round(candidate.suggested_stop_loss_price * 10_000),
          targetExitDate: candidate.suggested_target_exit_date,
        },
      });
      remainingE4 -= perContractE4 * size;
      opened.push({ occSymbol: candidate.occ_symbol, orderId, quantity: size });
      decisions.push({ day, occSymbol: candidate.occ_symbol, underlying: candidate.underlying, decision: 'opened', reason: 'cleared_all_bars', detail: { orderId, quantity: size, entryPriceE4, ev: candidate.ev, ev_per_risk: candidate.ev_per_risk, prob_profit: candidate.prob_profit, dte: candidate.dte } });
    } catch (err) {
      // One contract failing to open must not cost the rest of the day's
      // selection — same per-item isolation as capture.ts's own loop.
      const message = err instanceof PaperError ? err.message : err instanceof Error ? err.message : 'Failed to open order';
      failures.push(`${candidate.occ_symbol}: ${message}`);
      decisions.push({ day, occSymbol: candidate.occ_symbol, underlying: candidate.underlying, decision: 'failed', reason: 'open_threw', detail: { message } });
    }
  }

  // Checked rather than discarded — a silently failed log is the blind
  // spot this table exists to end, rebuilt one level down.
  if (!logDecisions(decisions)) {
    failures.push(`Decision log write failed for ${decisions.length} decision(s) — they are lost.`);
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
