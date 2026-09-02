import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { daysToExpiry, parseOccSymbol } from '@org/shared';
import { config } from '../../config.js';
import { marketDb } from '../../db/market/index.js';
import { optionContracts } from '../../db/market/schema.js';
import { paperDb } from '../../db/paper/index.js';
import { paperExitRevisions, paperOrders } from '../../db/paper/schema.js';
import type { paperDecisionLog } from '../../db/paper/schema.js';

type DecisionRow = Omit<typeof paperDecisionLog.$inferInsert, 'createdAt'>;
import { adviseOnExit, type ExitAdvisorResult } from '../agents/exitAdvisor.js';
import { haircutE4, recordIntradayMark, reduceOrder, contractMultiplier, closeOrder, logDecisions } from '../paper.js';
import {
  computeExitTarget,
  evaluateExit,
  positionHealth as scoreHeldContracts,
  QuantRefusal,
  QuantUnavailable,
} from '../quant.js';
import { readDocumentsSince } from '../text/news.js';
import { nowIso, todayKey } from '../util.js';
import { PolygonProvider } from './polygon.js';
import { operatingTradingDay } from './positionHealth.js';
import { fetchLiveNbbo } from './liveQuotes.js';
import type { OptionsProvider } from './provider.js';

/**
 * The quant/LLM calls this orchestrator makes, injectable the same way
 * `capture.ts` injects an `OptionsProvider` — so a test can exercise the
 * actual close/revise/escalate branching without a live Python sidecar or
 * a live Anthropic key, rather than only ever exercising the "unavailable"
 * fallback path.
 */
export interface ExitEngineDeps {
  evaluateExit: typeof evaluateExit;
  scoreHeldContracts: typeof scoreHeldContracts;
  adviseOnExit: (input: Parameters<typeof adviseOnExit>[0]) => Promise<ExitAdvisorResult>;
  /** `config.anthropic.configured`/`config.market.exitRecheck.maxCallsPerRun`
   * by default — injected, like the calls above, so a test can flip them
   * without fighting `config`'s deliberate read-only typing. */
  anthropicConfigured: boolean;
  maxCallsPerRun: number;
  /** The live-NBBO realism overlay — see lib/options/liveQuotes.ts for
   * the provider dispatch (IBKR, then Tradier). Injected so tests
   * exercise both the measured and print-basis paths. */
  fetchLiveNbbo: typeof fetchLiveNbbo;
  computeExitTarget: typeof computeExitTarget;
}

const defaultDeps: ExitEngineDeps = {
  evaluateExit,
  scoreHeldContracts,
  adviseOnExit,
  anthropicConfigured: config.anthropic.configured,
  maxCallsPerRun: config.market.exitRecheck.maxCallsPerRun,
  computeExitTarget,
  fetchLiveNbbo,
};

/**
 * The intraday recheck for every open, model-managed paper position — see
 * `services/quant/app/exit.py`'s own module docstring for the two-tier
 * design this orchestrates: cheap deterministic rules resolve most
 * rechecks with a live quote alone, and only a genuine `needs_review`
 * escalation ever reaches the LLM-backed `exitAdvisor.ts`, budgeted the
 * same way the multi-agent panel budgets its own calls (see
 * `agents/panel/budget.ts`) — a hard per-run ceiling, checked before every
 * call, because this app has already lost a night's data once to an
 * unpaced vendor call and an intraday LLM job needs the same guard from
 * day one.
 *
 * Only `source: 'model'` orders are managed here — a manually opened
 * position has no target to check and is left alone entirely.
 */

export interface ExitEngineSummary {
  startedAt: string;
  finishedAt: string;
  checked: number;
  /** Open model positions that had no exit plan and were given one this
   * run — see `adoptUnmanagedOrders`. Normally 0. */
  adopted: number;
  closed: number;
  reduced: number;
  revised: number;
  escalated: number;
  llmCallsMade: number;
  status: 'done' | 'partial';
  errors: string[];
}

/**
 * Give an exit plan to any open `source: 'model'` position that has none.
 *
 * `managedOpenOrders` filters on all three plan fields being non-null, so
 * a position without them is not merely unmanaged — it is *invisible*
 * here, and stays invisible forever. That is not hypothetical: on
 * 2026-08-24 all three open positions on the paper book had null targets,
 * so every recheck since the engine shipped had nothing to check. One was
 * a $122,440 position.
 *
 * Running this on every pass rather than as a one-off backfill script is
 * deliberate. The failure that produces an unmanaged position is a write
 * that did not land — a crash between insert and update, a sidecar that
 * was down at entry — and those recur. A self-healing step turns a
 * permanent hole into at most a 15-minute one.
 *
 * The plan is anchored to **today**, not the original entry day: a
 * horizon measured from an entry several days past can land a target date
 * already behind us, which is a stale number rather than a plan. A
 * position too close to expiry for any honest target is left alone and
 * reported, not given a fabricated one.
 */
async function adoptUnmanagedOrders(
  log: FastifyBaseLogger,
  deps: ExitEngineDeps,
  summary: ExitEngineSummary,
): Promise<void> {
  const orphans = paperDb
    .select()
    .from(paperOrders)
    .where(and(eq(paperOrders.status, 'open'), eq(paperOrders.source, 'model')))
    .all()
    .filter((o) => o.targetExitPriceE4 === null || o.stopLossPriceE4 === null || o.targetExitDate === null);
  if (orphans.length === 0) return;

  const today = operatingTradingDay();
  const adopted: DecisionRow[] = [];
  for (const order of orphans) {
    try {
      const contract = marketDb
        .select({ expiry: optionContracts.expiry })
        .from(optionContracts)
        .where(eq(optionContracts.occSymbol, order.occSymbol))
        .get();
      if (!contract) {
        summary.errors.push(`${order.occSymbol}: no contract row, cannot compute an exit plan.`);
        continue;
      }
      const plan = await deps.computeExitTarget({
        entryPriceE4: order.entryPriceE4,
        expiry: contract.expiry,
        anchorDay: today,
      });
      if (plan.targetE4 === null) {
        summary.errors.push(`${order.occSymbol}: no exit plan is computable — ${plan.refusal}`);
        continue;
      }
      paperDb
        .update(paperOrders)
        // `exitUpdatedAt` is left null on purpose. It is the cutoff
        // `readDocumentsSince` uses, and an orphaned position has never
        // been rechecked, so its whole document history is still owed a
        // review. Stamping it here would discard that backlog at the
        // exact moment the engine finally takes charge — five days of
        // unreviewed news, for the real Aug-19 position. Leaving it null
        // lets the first managed pass escalate once on the accumulated
        // news, after which the advisor path advances the cutoff
        // legitimately.
        .set({
          targetExitPriceE4: plan.targetE4.targetExitPriceE4,
          stopLossPriceE4: plan.targetE4.stopLossPriceE4,
          targetExitDate: plan.targetE4.targetExitDate,
        })
        .where(eq(paperOrders.id, order.id))
        .run();
      summary.adopted += 1;
      adopted.push({
        day: today,
        occSymbol: order.occSymbol,
        underlying: order.underlying,
        decision: 'adopted',
        reason: 'had_no_exit_plan',
        detail: {
          orderId: order.id,
          targetExitPriceE4: plan.targetE4.targetExitPriceE4,
          stopLossPriceE4: plan.targetE4.stopLossPriceE4,
          targetExitDate: plan.targetE4.targetExitDate,
        },
      });
      log.info(
        `Exit engine adopted ${order.occSymbol}: target ${plan.targetE4.targetExitPriceE4 / 10_000}, ` +
          `stop ${plan.targetE4.stopLossPriceE4 / 10_000}, by ${plan.targetE4.targetExitDate}`,
      );
    } catch (err) {
      // One position failing to adopt must not stop the rest, nor the
      // recheck of positions that already have plans.
      summary.errors.push(
        `${order.occSymbol}: could not compute an exit plan — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!logDecisions(adopted)) {
    summary.errors.push(`Decision log write failed for ${adopted.length} adoption(s) — they are lost.`);
  }
}

function managedOpenOrders() {
  return paperDb
    .select()
    .from(paperOrders)
    .where(and(eq(paperOrders.status, 'open'), eq(paperOrders.source, 'model')))
    .all()
    .filter((o) => o.targetExitPriceE4 !== null && o.stopLossPriceE4 !== null && o.targetExitDate !== null);
}

/** True while a run is already in flight — mirrors scheduler.ts's `capturing`/
 * `retraining`/`textSyncing` locks. Lives here, not in scheduler.ts, so both
 * the cron and the manual `/api/paper/exit-recheck` route share one lock:
 * without it, a button click racing the cron (or two clicks) could run two
 * passes over the same open positions, each independently closing an order
 * or spending its own LLM budget on the same escalation. */
let exitRechecking = false;

export async function runExitEngine(
  log: FastifyBaseLogger,
  provider: OptionsProvider = new PolygonProvider(),
  deps: ExitEngineDeps = defaultDeps,
): Promise<ExitEngineSummary> {
  const startedAt = nowIso();
  const summary: ExitEngineSummary = {
    startedAt,
    finishedAt: startedAt,
    checked: 0,
    adopted: 0,
    closed: 0,
    reduced: 0,
    revised: 0,
    escalated: 0,
    llmCallsMade: 0,
    status: 'done',
    errors: [],
  };

  if (exitRechecking) {
    summary.errors.push('An exit recheck was already in progress; skipped this run.');
    return summary;
  }
  exitRechecking = true;

  // Declared out here so the `finally` below can flush whatever was
  // collected even when the run throws partway.
  // Not `todayKey()` — see `operatingTradingDay`. The two writers used
  // different notions of "day" and split one session's decisions across
  // two of them.
  const day = operatingTradingDay();
  const decisions: DecisionRow[] = [];

  try {
    // Before anything else: a position with no plan is invisible to the
    // query below, so adopting first is what lets it be managed at all.
    await adoptUnmanagedOrders(log, deps, summary);

    const orders = managedOpenOrders();

    // Batched, the same reason positionHealth.ts's computePositionHealth
    // batches this call for every open order in one round trip instead of
    // one per position — each call re-reads the sidecar's feature panel
    // off disk, and this job runs every 15 minutes during market hours.
    const contractsBySymbol = new Map(
      orders.length === 0
        ? []
        : marketDb
            .select({
              occSymbol: optionContracts.occSymbol,
              underlying: optionContracts.underlying,
              expiry: optionContracts.expiry,
            })
            .from(optionContracts)
            .where(inArray(optionContracts.occSymbol, orders.map((o) => o.occSymbol)))
            .all()
            .map((c) => [c.occSymbol, c] as const),
    );

    let health: Awaited<ReturnType<typeof deps.scoreHeldContracts>> | null = null;
    const heldContracts = orders
      .map((o) => contractsBySymbol.get(o.occSymbol))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => ({ occSymbol: c.occSymbol, underlying: c.underlying }));
    if (heldContracts.length > 0) {
      try {
        health = await deps.scoreHeldContracts(todayKey(), heldContracts);
      } catch (err) {
        // No current EV view available for anyone this pass (sidecar down,
        // model refuses) — the deterministic price/DTE rules below still
        // run on each position's own live quote; only the EV-sign-flip
        // escalation is unavailable this pass.
        if (err instanceof QuantUnavailable || err instanceof QuantRefusal) {
          summary.errors.push(`Position health unavailable this pass: ${err.message}`);
        } else {
          throw err;
        }
      }
    }

    // Every recheck outcome, not just the ones that changed something.
    // A position that was looked at and left alone is a decision too, and
    // it is the one that makes "was this being watched at all?" answerable
    // — the question that went unanswered for five days when three open
    // positions were invisible to this engine.
    const record = (
      order: { id: string; occSymbol: string; underlying: string | null },
      decision: DecisionRow['decision'],
      reason: string,
      detail: Record<string, unknown> = {},
    ) => {
      decisions.push({
        day,
        occSymbol: order.occSymbol,
        underlying: order.underlying,
        decision,
        reason,
        detail: { orderId: order.id, ...detail },
      });
    };

    const closeAndTally = (
      order: { id: string; occSymbol: string; underlying: string | null },
      exitPriceE4: number,
      reason: string,
      detail: Record<string, unknown> = {},
      exitBasis: 'measured' | 'modelled' = 'modelled',
    ) => {
      closeOrder({ orderId: order.id, exitPriceE4, exitBasis });
      summary.closed += 1;
      record(order, 'exited', reason, { exitPriceE4, exitBasis, ...detail });
    };

    // One batched quote call for every open position, once per pass —
    // the realism overlay. Where Tradier answers, the bid becomes the
    // evaluation price with basis 'measured' (which the spread haircut
    // deliberately leaves untouched: a bid IS the touchable number);
    // where it doesn't, each position falls back to the print-basis path
    // below, exactly as before the overlay existed.
    const liveQuotes = await deps.fetchLiveNbbo(orders.map((o) => o.occSymbol));

    for (const order of orders) {
      summary.checked += 1;
      try {
        // A pruned contract row must not orphan the position: `continue`
        // here meant its stop was never checked again and it rode
        // unmanaged to expiry (review finding, 2026-09-02). The OCC
        // symbol itself carries underlying and expiry — parse them and
        // keep the rulebook running.
        let contract = contractsBySymbol.get(order.occSymbol);
        if (!contract) {
          const parsed = parseOccSymbol(order.occSymbol);
          if (!parsed) {
            summary.errors.push(`${order.occSymbol}: contract missing from corpus AND unparseable — skipping this recheck`);
            continue;
          }
          summary.errors.push(`${order.occSymbol}: contract row missing from corpus — managing from the OCC symbol itself`);
          contract = { underlying: parsed.underlying, expiry: parsed.expiry } as typeof contract & object;
        }
        const dte = Math.max(0, daysToExpiry(contract.expiry, todayKey()));

        const chain = await provider.fetchChain({ underlying: contract.underlying, maxDte: dte + 1 });
        const quote = chain.find((q) => q.occSymbol === order.occSymbol);
        // The evaluation price falls back through the same basis hierarchy
        // the nightly marking job uses: a real bid when the plan ever has
        // one, else the last trade, else the running close. Requiring a
        // bid outright meant that on the current no-quote-entitlement
        // plan *every* recheck skipped *every* position — the stop, the
        // trailing ratchet, and the horizon time-stop had never actually
        // evaluated once, discovered only when a manual recheck reported
        // 10/10 "no live bid available". A modelled basis is worse than a
        // bid and better than a rulebook that never runs; closes made on
        // it are already recorded as 'modelled' by closeOrder.
        const live = liveQuotes.get(order.occSymbol);
        const measuredBidE4 = live?.bidE4 ?? quote?.bidE4 ?? null;
        // Modelled prints are haircut BEFORE the rule ladder sees them,
        // so the stop is checked on the same basis the book is marked
        // at — unhaircut, a position sat marked below its stop for days
        // while the raw print kept the stop from firing (review
        // finding). A measured bid needs no haircut: it IS a fill.
        const rawEvalE4 = measuredBidE4 ?? (quote ? (quote.lastE4 ?? quote.closeE4) : null);
        if (rawEvalE4 === null) {
          summary.errors.push(
            `${order.occSymbol}: no usable price (bid, last, or close) — skipping this recheck`,
          );
          continue;
        }
        const evalBasis: 'measured' | 'modelled' = measuredBidE4 !== null ? 'measured' : 'modelled';
        const evalPriceE4 = evalBasis === 'measured' ? rawEvalE4 : haircutE4(rawEvalE4, 'sell');
        // Persistence (marks, closes, reduces) receives the RAW print with
        // its basis and applies the modelled haircut itself, exactly once —
        // handing it the already-haircut evalPriceE4 double-charged the
        // spread on every modelled exit and marked the book below the
        // price the stop was checked at (review finding, 2026-09-02).
        // haircutE4 is deterministic, so paper.ts lands on the same number
        // the rule ladder evaluated.

        // The price just fetched becomes the position's current mark —
        // see recordIntradayMark for why the book's numbers should move
        // with the session instead of standing at last night's close all
        // day. Written before the decision, so even a pass that exits or
        // errors below leaves the freshest observation on record.
        recordIntradayMark(order.id, day, evalPriceE4, measuredBidE4 !== null ? 'measured' : 'modelled');

        const docs = readDocumentsSince(contract.underlying, order.exitUpdatedAt ?? order.openedAt);
        const currentEv = health?.contracts[order.occSymbol]?.ev ?? undefined;
        const modelBeatsBaseline = health?.model_beats_baseline ?? false;

        const decision = await deps.evaluateExit({
          currentPriceE4: evalPriceE4,
          dte,
          target: {
            targetExitPriceE4: order.targetExitPriceE4!,
            stopLossPriceE4: order.stopLossPriceE4!,
            targetExitDate: order.targetExitDate!,
          },
          entryEv: order.entryEv ?? undefined,
          currentEv,
          newDocumentsCount: docs.length,
          // Real calendar, not the captured day: `day` is the corpus's
          // latest capture (yesterday, during a live session), and using
          // it here made the time-stop fire one session late — three
          // after a weekend — while `dte` above already ran on the real
          // clock. Decision-log rows and marks keep `day` (they describe
          // the corpus vintage); date comparisons get today.
          today: todayKey(),
          entryPriceE4: order.entryPriceE4,
          quantity: order.quantity,
          initialQuantity: order.initialQuantity ?? order.quantity,
          // Half the entry bar, in the same per-contract dollars as the
          // health check's EV: the professional horizon test is "would I
          // still put this on today", and the half-bar hysteresis keeps a
          // position hovering at the boundary from being churned.
          horizonEvFloor:
            (0.5 *
              config.market.autoEntry.minEvPerRisk *
              order.entryPriceE4 *
              contractMultiplier(order.occSymbol).multiplier) /
            10_000,
        });

        if (decision.action === 'exit_now') {
          closeAndTally(
            order,
            evalPriceE4,
            decision.triggeredBy,
            { reasonText: decision.reason },
            measuredBidE4 !== null ? 'measured' : 'modelled',
          );
          continue;
        }

        if (decision.action === 'reduce' && decision.reduceContracts !== null) {
          // The milestone scale-out: the sold half becomes its own closed
          // row (realized P&L, lineage via splitFrom), the survivor keeps
          // this id and every ratchet. reduceOrder refuses a reduction
          // that would empty the position, so a mis-sized decision
          // surfaces as an error instead of a silent full close.
          const sliceId = reduceOrder({
            orderId: order.id,
            contracts: decision.reduceContracts,
            exitPriceE4: evalPriceE4,
            exitBasis: measuredBidE4 !== null ? 'measured' : 'modelled',
          });
          summary.reduced += 1;
          record(order, 'reduced', decision.triggeredBy, {
            contracts: decision.reduceContracts,
            exitPriceE4: evalPriceE4,
            sliceId,
            reasonText: decision.reason,
          });
          continue;
        }

        // The ratchet is persisted before the action is branched on, not
        // inside the `hold` arm, because `evaluate_exit` also attaches a
        // raised stop to a `needs_review` — a winning position that is
        // simultaneously escalating should still tighten its stop on the
        // same pass rather than wait on an advisor call.
        //
        // If the raised stop is not written it resets every pass and the
        // position trails nothing: the rule would look implemented and do
        // nothing. Guarded on being strictly higher so a bug that ever
        // proposed a lower stop widens no risk; `evaluate_exit` already
        // guarantees monotonicity, and this is the cheap second lock.
        //
        // `exitUpdatedAt` is deliberately NOT touched here. It doubles as
        // the cutoff for `readDocumentsSince` above, where advancing it
        // means "the advisor has reviewed every document counted" — which
        // a rule-based stop raise has not done. Stamping it on a ratchet
        // buried unreviewed news permanently, silently, every 15 minutes.
        if (decision.newStopLossPriceE4 !== null && decision.newStopLossPriceE4 > order.stopLossPriceE4!) {
          summary.revised += 1;
          record(order, 'target_moved', 'trailing_stop_raised', {
            oldStopLossPriceE4: order.stopLossPriceE4,
            newStopLossPriceE4: decision.newStopLossPriceE4,
            reasonText: decision.reason,
          });
          paperDb.transaction((tx) => {
            tx.insert(paperExitRevisions)
              .values({
                orderId: order.id,
                revisedAt: nowIso(),
                oldTargetExitPriceE4: order.targetExitPriceE4,
                newTargetExitPriceE4: order.targetExitPriceE4,
                oldTargetExitDate: order.targetExitDate,
                newTargetExitDate: order.targetExitDate,
                oldStopLossPriceE4: order.stopLossPriceE4,
                newStopLossPriceE4: decision.newStopLossPriceE4,
                reason: decision.reason,
                triggeredBy: 'rule',
              })
              .run();
            tx.update(paperOrders)
              .set({ stopLossPriceE4: decision.newStopLossPriceE4 })
              .where(eq(paperOrders.id, order.id))
              .run();
          });
          // Keep the in-memory row honest: a same-pass extension writes
          // its own revision from this object, and pre-ratchet values
          // there made the audit trail lie (review finding).
          order.stopLossPriceE4 = decision.newStopLossPriceE4;
        }

        // An extended target date (the horizon time-stop's "model still
        // wants this" outcome) is persisted for the same reason the stop
        // ratchet is: unwritten, the audit trail and the UI keep showing
        // a date the position is weeks past, and every reader has to
        // rediscover why the engine is still holding. Functionally the
        // rule re-evaluates from scratch each pass, so this write is for
        // the record, not the logic — `exitUpdatedAt` stays untouched for
        // the same document-cutoff reason as above.
        if (
          decision.newTargetExitDate !== null &&
          decision.newTargetExitDate !== order.targetExitDate
        ) {
          summary.revised += 1;
          record(order, 'target_moved', decision.triggeredBy, {
            oldTargetExitDate: order.targetExitDate,
            newTargetExitDate: decision.newTargetExitDate,
            reasonText: decision.reason,
          });
          paperDb.transaction((tx) => {
            tx.insert(paperExitRevisions)
              .values({
                orderId: order.id,
                revisedAt: nowIso(),
                oldTargetExitPriceE4: order.targetExitPriceE4,
                newTargetExitPriceE4: order.targetExitPriceE4,
                oldTargetExitDate: order.targetExitDate,
                newTargetExitDate: decision.newTargetExitDate,
                oldStopLossPriceE4: order.stopLossPriceE4,
                newStopLossPriceE4: order.stopLossPriceE4,
                reason: decision.reason,
                triggeredBy: 'rule',
              })
              .run();
            tx.update(paperOrders)
              .set({ targetExitDate: decision.newTargetExitDate })
              .where(eq(paperOrders.id, order.id))
              .run();
          });
          // Same-pass reads must see the extension — the stop ratchet
          // already does this (see below); without it, an escalation later
          // this pass sends the advisor the PRE-extension date and writes
          // it into the audit trail as if the extension never happened.
          order.targetExitDate = decision.newTargetExitDate;
        }

        if (decision.action === 'hold') {
          record(order, 'held', decision.triggeredBy, { currentPriceE4: evalPriceE4, dte });
          continue;
        }

        // needs_review — the only outcome that may spend an LLM call.
        summary.escalated += 1;
        if (!deps.anthropicConfigured) {
          summary.errors.push(
            `${order.occSymbol}: escalated to review (${decision.reason}) but ANTHROPIC_API_KEY is not set — left on hold`,
          );
          continue;
        }
        if (summary.llmCallsMade >= deps.maxCallsPerRun) {
          summary.status = 'partial';
          summary.errors.push(`${order.occSymbol}: exit-recheck LLM budget exhausted — left on hold`);
          continue;
        }
        summary.llmCallsMade += 1;

        const advice = await deps.adviseOnExit({
          occSymbol: order.occSymbol,
          underlying: contract.underlying,
          escalationReason: decision.reason,
          entryPriceE4: order.entryPriceE4,
          currentPriceE4: evalPriceE4,
          targetExitPriceE4: order.targetExitPriceE4!,
          stopLossPriceE4: order.stopLossPriceE4!,
          targetExitDate: order.targetExitDate!,
          entryEv: order.entryEv,
          currentEv: currentEv ?? null,
          modelBeatsBaseline,
          newDocuments: docs.slice(0, 5).map((d) => ({ title: d.title, eventType: d.eventType, publishedAt: d.publishedAt })),
        });

        if (
          advice.action === 'move_target' &&
          advice.newTargetExitDate !== null &&
          !(typeof advice.newTargetExitDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(advice.newTargetExitDate))
        ) {
          // The old comment down at the clamp assumed a malformed date
          // would "fail loudly at the DB write" — but the column is
          // SQLite text, so garbage stores silently and then corrupts
          // every string-compare in the time-stop. Refused here, on the
          // same no-cutoff-advance path as a missing field, so the
          // triggering documents get re-reviewed.
          summary.errors.push(
            `${order.occSymbol}: advisor returned malformed target date ${JSON.stringify(advice.newTargetExitDate)} — left on hold`,
          );
          continue;
        }
        if (advice.action === 'move_target' && (advice.newTargetExitPriceE4 === null || advice.newTargetExitDate === null)) {
          // The schema describes both fields as required for this action,
          // but nothing enforces that at the API boundary — a response that
          // violates its own contract must be visible, not silently treated
          // as an ordinary "hold" after an LLM call was already spent on it.
          // Bail before the write below so the cutoff does not advance on a
          // review whose outcome was discarded.
          summary.errors.push(
            `${order.occSymbol}: advisor returned move_target with a missing target price/date — left on hold`,
          );
          continue;
        }

        // Everything this recheck decided lands in one transaction, or none
        // of it does.
        //
        // The cutoff bump belongs inside for the same reason the revision
        // and the target do: it records that the advisor has now reviewed
        // every document counted above — which is what stops the same
        // already-seen documents from re-triggering an identical `new_news`
        // escalation, and another LLM call, every 15 minutes for the rest of
        // the day. Advancing it while the decision it accompanies rolled
        // back would suppress the re-review *and* leave no trace of the
        // attempt. Same idiom as routes/options.ts's promote.
        let revised = advice.action === 'move_target';
        // The advisor's outputs are opinions; the contract's expiry is a
        // fact. Unclamped, an extension past expiry kills the time-stop
        // and the position rides theta to the DTE-floor forced exit
        // (review finding). Same clamp the deterministic path applies:
        // never past expiry minus the floor, never a target below the
        // stop.
        if (
          revised &&
          typeof advice.newTargetExitDate === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(advice.newTargetExitDate)
        ) {
          // Type-strict on purpose: a malformed date must reach the DB
          // write and fail loudly there, not be laundered into a valid
          // clamp value ("[object Object]" > "2026-.." is TRUE in JS).
          const latestAllowed = new Date(Date.parse(`${contract.expiry}T00:00:00Z`) - 3 * 86_400_000)
            .toISOString()
            .slice(0, 10);
          if (advice.newTargetExitDate > latestAllowed) advice.newTargetExitDate = latestAllowed;
        }
        if (
          revised &&
          advice.newTargetExitPriceE4 !== null &&
          order.stopLossPriceE4 !== null &&
          advice.newTargetExitPriceE4 <= order.stopLossPriceE4
        ) {
          // A target at or below the stop is not a plan; hold instead.
          revised = false;
        }
        record(
          order,
          revised ? 'target_moved' : 'held',
          revised ? 'advisor_moved_target' : 'advisor_hold',
          {
            escalation: decision.reason,
            reasoning: advice.reasoning,
            ...(revised
              ? { newTargetExitPriceE4: advice.newTargetExitPriceE4, newTargetExitDate: advice.newTargetExitDate }
              : {}),
          },
        );
        paperDb.transaction((tx) => {
          if (revised) {
            tx.insert(paperExitRevisions)
              .values({
                orderId: order.id,
                revisedAt: nowIso(),
                oldTargetExitPriceE4: order.targetExitPriceE4,
                newTargetExitPriceE4: advice.newTargetExitPriceE4,
                oldTargetExitDate: order.targetExitDate,
                newTargetExitDate: advice.newTargetExitDate,
                reason: advice.reasoning,
                triggeredBy: 'llm',
              })
              .run();
          }
          tx.update(paperOrders)
            .set({
              exitUpdatedAt: nowIso(),
              // An ev_sign_flip the advisor has reviewed and chosen to
              // hold through is a RESOLVED fact, not a standing alarm:
              // re-baseline entryEv to the current read so the same
              // permanent flip (an inflated-legacy entry vs honest
              // current EV) cannot burn one LLM call per pass all day
              // (review finding). A future flip is then genuinely new.
              ...(decision.triggeredBy === 'ev_sign_flip' && currentEv !== undefined
                ? { entryEv: currentEv }
                : {}),
              ...(revised
                ? { targetExitPriceE4: advice.newTargetExitPriceE4, targetExitDate: advice.newTargetExitDate }
                : {}),
            })
            .where(eq(paperOrders.id, order.id))
            .run();
        });
        if (revised) summary.revised += 1;

        if (advice.action === 'exit_now') {
          closeAndTally(
            order,
            evalPriceE4,
            'advisor_exit_now',
            { reasoning: advice.reasoning },
            measuredBidE4 !== null ? 'measured' : 'modelled',
          );
          continue;
        }
        // advice.action === 'hold': the cutoff moved, the target stands.
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        summary.errors.push(`${order.occSymbol}: ${message}`);
        log.error({ err, occSymbol: order.occSymbol }, 'Exit recheck failed for one position');
      }
    }
  } finally {
    // In `finally`, not at the end of the try: a run that throws partway
    // is exactly the run whose decisions are most worth having, and
    // flushing inside the try would discard everything collected before
    // the failure. `logDecisions` never throws, so this cannot mask the
    // original error.
    // The return is checked, not discarded. A logger that fails silently
    // rebuilds — inside the logging code — the exact blind spot this table
    // was added to end: the run looks normal, reports success, and wrote
    // nothing, and the absence later reads as "the system did nothing".
    if (!logDecisions(decisions)) {
      summary.errors.push(`Decision log write failed for ${decisions.length} decision(s) — they are lost.`);
      log.warn('Exit engine could not write its decision log');
    }
    exitRechecking = false;
  }

  summary.finishedAt = nowIso();
  return summary;
}

/** Every recorded revision, newest first per order — for the UI's timeline. */
export function revisionsByOrder(): Map<string, Array<typeof paperExitRevisions.$inferSelect>> {
  const rows = paperDb.select().from(paperExitRevisions).orderBy(paperExitRevisions.id).all();
  const byOrder = new Map<string, Array<typeof paperExitRevisions.$inferSelect>>();
  for (const row of rows) {
    const existing = byOrder.get(row.orderId);
    if (existing) existing.push(row);
    else byOrder.set(row.orderId, [row]);
  }
  // Ascending-id rows were pushed in that order; reverse once per order to
  // get newest-first without an O(n) `unshift` per row.
  for (const list of byOrder.values()) list.reverse();
  return byOrder;
}
