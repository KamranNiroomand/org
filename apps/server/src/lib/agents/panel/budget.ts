import { eq } from 'drizzle-orm';
import { config } from '../../../config.js';
import { db } from '../../../db/index.js';
import { panelRuns } from '../../../db/schema.js';
import { SPECIALISTS } from './types.js';

/**
 * The precedent this must not repeat: this app's own options-capture
 * pipeline silently lost 321 of 566 symbols a night to an unpaced vendor
 * integration until it was caught and fixed with a hard per-minute pacer —
 * not just a concurrency cap (see `lib/options/polygon.ts`'s own module
 * comment). An LLM panel needs the equivalent from day one: a hard ceiling
 * on calls per run, checked and persisted before each call, not discovered
 * after the bill arrives.
 */

/** Generic base so `withBudget` doesn't have to hardcode which domain's
 * error to throw — `PanelBudgetExceeded` here and
 * `RealEstateBudgetExceeded` in `agents/realestate/budget.ts` both extend
 * this, so a caller that only cares "did *some* budget blow" can catch the
 * base, while `instanceof PanelBudgetExceeded` still identifies the panel's
 * own specifically. */
export class CallBudgetExceeded extends Error {
  constructor(label: string, runId: string, calls: number) {
    super(`${label} run ${runId} exceeded its call budget at ${calls} calls`);
    this.name = 'CallBudgetExceeded';
  }
}

export class PanelBudgetExceeded extends CallBudgetExceeded {
  constructor(runId: string, calls: number) {
    super('Panel', runId, calls);
    this.name = 'PanelBudgetExceeded';
  }
}

/** How many specialists run per round — the 4 within one round run in
 * parallel; see run.ts's own `mapLimit` call for the concurrency. */
export const PANEL_AGENT_CONCURRENCY = SPECIALISTS.length;

/** Total calls one symbol costs end to end: 4 specialists × 2 rounds + 1
 * synthesis. Exported so a caller can size a shortlist/query against the
 * configured per-run budget without re-deriving this arithmetic. */
export const CALLS_PER_SYMBOL = PANEL_AGENT_CONCURRENCY * 2 + 1;

/** One shared instance per run, threaded through every symbol — see
 * `withBudget`'s own doc comment for why the counter must not be reset
 * per symbol. */
export type CallBudgeted = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Wraps every LLM call a run makes: increments and persists a call count
 * *before* the call, not after — a crash mid-call still leaves an honest
 * count, the same reasoning as `capture_runs`' own incremental
 * `symbolsDone` writes — and throws once the configured ceiling is hit, so
 * a bug or a bad prompt can't turn into an unbounded bill.
 *
 * Generalized (rather than hardcoded to `panelRuns`) so the real-estate
 * assistant's own run table can reuse this exact mechanism instead of a
 * near-duplicate 15-line copy — see `agents/realestate/budget.ts`'s thin
 * wrapper, and `withPanelBudget` below for the panel's own.
 */
export function withBudget(
  runId: string,
  maxCalls: number,
  persistCallsMade: (runId: string, calls: number) => void,
  makeExceeded: (runId: string, calls: number) => CallBudgetExceeded = (id, c) => new CallBudgetExceeded('Run', id, c),
): CallBudgeted {
  let calls = 0;
  return async function callBudgeted<T>(fn: () => Promise<T>): Promise<T> {
    calls += 1;
    if (calls > maxCalls) throw makeExceeded(runId, calls);
    persistCallsMade(runId, calls);
    return fn();
  };
}

function persistPanelCallsMade(runId: string, calls: number): void {
  db.update(panelRuns).set({ callsMade: calls }).where(eq(panelRuns.id, runId)).run();
}

export function withPanelBudget(runId: string, maxCalls: number = config.panel.maxCallsPerRun): CallBudgeted {
  return withBudget(runId, maxCalls, persistPanelCallsMade, (id, c) => new PanelBudgetExceeded(id, c));
}
