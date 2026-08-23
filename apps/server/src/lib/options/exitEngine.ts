import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config.js';
import { marketDb } from '../../db/market/index.js';
import { optionContracts } from '../../db/market/schema.js';
import { paperDb } from '../../db/paper/index.js';
import { paperExitRevisions, paperOrders } from '../../db/paper/schema.js';
import { adviseOnExit, type ExitAdvisorResult } from '../agents/exitAdvisor.js';
import { closeOrder } from '../paper.js';
import { evaluateExit, positionHealth as scoreHeldContracts, QuantUnavailable } from '../quant.js';
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
}

const defaultDeps: ExitEngineDeps = { evaluateExit, scoreHeldContracts, adviseOnExit };

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

export async function runExitEngine(
  log: FastifyBaseLogger,
  provider: OptionsProvider = new PolygonProvider(),
  deps: ExitEngineDeps = defaultDeps,
): Promise<ExitEngineSummary> {
  const startedAt = nowIso();
  const summary: ExitEngineSummary = {
    startedAt,
    finishedAt: '',
    checked: 0,
    closed: 0,
    revised: 0,
    escalated: 0,
    llmCallsMade: 0,
    status: 'done',
    errors: [],
  };

  for (const order of managedOpenOrders()) {
    summary.checked += 1;
    try {
      const contract = marketDb
        .select({ underlying: optionContracts.underlying, expiry: optionContracts.expiry })
        .from(optionContracts)
        .where(eq(optionContracts.occSymbol, order.occSymbol))
        .get();
      if (!contract) {
        summary.errors.push(`${order.occSymbol}: contract not found in the corpus — skipping this recheck`);
        continue;
      }
      const dte = Math.max(
        0,
        Math.floor((Date.parse(`${contract.expiry}T00:00:00Z`) - Date.now()) / 86_400_000),
      );

      const chain = await provider.fetchChain({ underlying: contract.underlying, maxDte: dte + 1 });
      const quote = chain.find((q) => q.occSymbol === order.occSymbol);
      if (!quote || quote.bidE4 === null) {
        summary.errors.push(`${order.occSymbol}: no live bid available — skipping this recheck`);
        continue;
      }

      const docs = readDocumentsSince(contract.underlying, order.exitUpdatedAt ?? order.openedAt);

      let currentEv: number | undefined;
      let modelBeatsBaseline = false;
      try {
        const health = await deps.scoreHeldContracts(todayKey(), [
          { occSymbol: order.occSymbol, underlying: contract.underlying },
        ]);
        currentEv = health.contracts[order.occSymbol]?.ev ?? undefined;
        modelBeatsBaseline = health.model_beats_baseline;
      } catch (err) {
        // No current EV view available (sidecar down, model refuses) — the
        // deterministic price/DTE rules below still run on the live quote
        // alone; only the EV-sign-flip escalation is unavailable this pass.
        if (!(err instanceof QuantUnavailable)) throw err;
      }

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
        closeOrder({ orderId: order.id, exitPriceE4: quote.bidE4 });
        summary.closed += 1;
        continue;
      }
      if (decision.action === 'hold') {
        continue;
      }

      // needs_review — the only outcome that may spend an LLM call.
      summary.escalated += 1;
      if (!config.anthropic.configured) {
        summary.errors.push(
          `${order.occSymbol}: escalated to review (${decision.reason}) but ANTHROPIC_API_KEY is not set — left on hold`,
        );
        continue;
      }
      if (summary.llmCallsMade >= config.market.exitRecheck.maxCallsPerRun) {
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

      if (advice.action === 'exit_now') {
        closeOrder({ orderId: order.id, exitPriceE4: quote.bidE4 });
        summary.closed += 1;
        continue;
      }
      if (advice.action === 'move_target' && advice.newTargetExitPriceE4 !== null && advice.newTargetExitDate !== null) {
        paperDb
          .insert(paperExitRevisions)
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
        paperDb
          .update(paperOrders)
          .set({
            targetExitPriceE4: advice.newTargetExitPriceE4,
            targetExitDate: advice.newTargetExitDate,
            exitUpdatedAt: nowIso(),
          })
          .where(eq(paperOrders.id, order.id))
          .run();
        summary.revised += 1;
      }
      // advice.action === 'hold': nothing to record — the target stands.
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      summary.errors.push(`${order.occSymbol}: ${message}`);
      log.error({ err, occSymbol: order.occSymbol }, 'Exit recheck failed for one position');
    }
  }

  summary.finishedAt = nowIso();
  return summary;
}
