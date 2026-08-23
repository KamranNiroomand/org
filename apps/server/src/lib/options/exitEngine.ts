import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { daysToExpiry } from '@org/shared';
import { config } from '../../config.js';
import { marketDb } from '../../db/market/index.js';
import { optionContracts } from '../../db/market/schema.js';
import { paperDb } from '../../db/paper/index.js';
import { paperExitRevisions, paperOrders } from '../../db/paper/schema.js';
import { adviseOnExit, type ExitAdvisorResult } from '../agents/exitAdvisor.js';
import { closeOrder } from '../paper.js';
import { evaluateExit, positionHealth as scoreHeldContracts, QuantRefusal, QuantUnavailable } from '../quant.js';
import { readDocumentsSince } from '../text/news.js';
import { nowIso, todayKey } from '../util.js';
import { PolygonProvider } from './polygon.js';
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
}

const defaultDeps: ExitEngineDeps = {
  evaluateExit,
  scoreHeldContracts,
  adviseOnExit,
  anthropicConfigured: config.anthropic.configured,
  maxCallsPerRun: config.market.exitRecheck.maxCallsPerRun,
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
  closed: number;
  revised: number;
  escalated: number;
  llmCallsMade: number;
  status: 'done' | 'partial';
  errors: string[];
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
    closed: 0,
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

  try {
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

    const closeAndTally = (orderId: string, exitPriceE4: number) => {
      closeOrder({ orderId, exitPriceE4 });
      summary.closed += 1;
    };

    for (const order of orders) {
      summary.checked += 1;
      try {
        const contract = contractsBySymbol.get(order.occSymbol);
        if (!contract) {
          summary.errors.push(`${order.occSymbol}: contract not found in the corpus — skipping this recheck`);
          continue;
        }
        const dte = Math.max(0, daysToExpiry(contract.expiry, todayKey()));

        const chain = await provider.fetchChain({ underlying: contract.underlying, maxDte: dte + 1 });
        const quote = chain.find((q) => q.occSymbol === order.occSymbol);
        if (!quote || quote.bidE4 === null) {
          summary.errors.push(`${order.occSymbol}: no live bid available — skipping this recheck`);
          continue;
        }

        const docs = readDocumentsSince(contract.underlying, order.exitUpdatedAt ?? order.openedAt);
        const currentEv = health?.contracts[order.occSymbol]?.ev ?? undefined;
        const modelBeatsBaseline = health?.model_beats_baseline ?? false;

        const decision = await deps.evaluateExit({
          currentPriceE4: quote.bidE4,
          dte,
          target: {
            targetExitPriceE4: order.targetExitPriceE4!,
            stopLossPriceE4: order.stopLossPriceE4!,
            targetExitDate: order.targetExitDate!,
          },
          entryEv: order.entryEv ?? undefined,
          currentEv,
          newDocumentsCount: docs.length,
        });

        if (decision.action === 'exit_now') {
          closeAndTally(order.id, quote.bidE4);
          continue;
        }
        if (decision.action === 'hold') {
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
          currentPriceE4: quote.bidE4,
          targetExitPriceE4: order.targetExitPriceE4!,
          stopLossPriceE4: order.stopLossPriceE4!,
          targetExitDate: order.targetExitDate!,
          entryEv: order.entryEv,
          currentEv: currentEv ?? null,
          modelBeatsBaseline,
          newDocuments: docs.slice(0, 5).map((d) => ({ title: d.title, eventType: d.eventType, publishedAt: d.publishedAt })),
        });

        // The advisor has now reviewed every document counted above,
        // regardless of what it decided — bumping the cutoff here (not only
        // on `move_target`) is what stops the same already-seen documents
        // from re-triggering an identical `new_news` escalation, and
        // therefore another LLM call, on every 15-minute recheck for the
        // rest of the day.
        paperDb.update(paperOrders).set({ exitUpdatedAt: nowIso() }).where(eq(paperOrders.id, order.id)).run();

        if (advice.action === 'exit_now') {
          closeAndTally(order.id, quote.bidE4);
          continue;
        }
        if (advice.action === 'move_target') {
          if (advice.newTargetExitPriceE4 === null || advice.newTargetExitDate === null) {
            // The schema describes both fields as required for this action,
            // but nothing enforces that at the API boundary — a response
            // that violates its own contract must be visible, not silently
            // treated as an ordinary "hold" after an LLM call was already
            // spent on it.
            summary.errors.push(
              `${order.occSymbol}: advisor returned move_target with a missing target price/date — left on hold`,
            );
            continue;
          }
          // One transaction, because a half-applied revision is worse than
          // no revision: the log alone claims a change that never reached
          // the order, and the order alone moves a target with no audit
          // trail behind it. Same idiom as routes/options.ts's promote.
          paperDb.transaction((tx) => {
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
            tx.update(paperOrders)
              .set({ targetExitPriceE4: advice.newTargetExitPriceE4, targetExitDate: advice.newTargetExitDate })
              .where(eq(paperOrders.id, order.id))
              .run();
          });
          summary.revised += 1;
        }
        // advice.action === 'hold': nothing further to record — the target stands.
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        summary.errors.push(`${order.occSymbol}: ${message}`);
        log.error({ err, occSymbol: order.occSymbol }, 'Exit recheck failed for one position');
      }
    }
  } finally {
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
