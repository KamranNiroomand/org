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

export class PanelBudgetExceeded extends Error {
  constructor(runId: string, calls: number) {
    super(`Panel run ${runId} exceeded its call budget at ${calls} calls`);
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
 * Wraps every Anthropic call a panel run makes: increments and persists
 * `callsMade` on the run's `panelRuns` row *before* the call, not after —
 * a crash mid-call still leaves an honest count, the same reasoning as
 * `capture_runs`' own incremental `symbolsDone` writes — and throws
 * `PanelBudgetExceeded` once the configured ceiling is hit, so a bug or a
 * bad prompt can't turn into an unbounded bill.
 */
export function withBudget(runId: string, maxCalls: number = config.panel.maxCallsPerRun): CallBudgeted {
  let calls = 0;
  return async function callBudgeted<T>(fn: () => Promise<T>): Promise<T> {
    calls += 1;
    if (calls > maxCalls) throw new PanelBudgetExceeded(runId, calls);
    db.update(panelRuns).set({ callsMade: calls }).where(eq(panelRuns.id, runId)).run();
    return fn();
  };
}
