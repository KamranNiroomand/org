import { eq } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { realEstateRuns } from '../../../db/schema.js';
import { config } from '../../../config.js';
import { newId, nowIso } from '../../util.js';
import type { CallBudgeted } from '../panel/budget.js';
import { computeFinancials } from './financials.js';
import { runLocationRound1, runLocationRound2 } from './location.js';
import { runRentalRound1, runRentalRound2 } from './rental.js';
import { runManagerSynthesis } from './manager.js';
import { RealEstateBudgetExceeded, withRealEstateBudget } from './budget.js';
import type { BalancePlacement, ComputedFinancials, LocationAgentResult, PropertyInput, RentalAgentResult } from './types.js';

/**
 * Orchestrates one property end to end: round 1 (location + rental, in
 * parallel, independent) → persist whichever succeeded → round 2 (each
 * agent reading the other's round-1 transcript, skipped for an agent whose
 * own round 1 failed — there is nothing for it to revise) → persist → the
 * manager's synthesis, given whatever rounds actually exist → persist the
 * final verdict and mark `synthesisComplete`.
 *
 * Per-call failure tolerance mirrors the stock panel's `collectRound`: one
 * agent's failure must not discard the other's already-paid-for result.
 */

interface AgentCallResult<T> {
  value: T | null;
  error: string | null;
  budgetError: RealEstateBudgetExceeded | null;
  webSearches: number;
}

async function runAgentCall<T>(
  callBudgeted: CallBudgeted,
  fn: () => Promise<{ result: T; webSearches: number }>,
): Promise<AgentCallResult<T>> {
  try {
    const { result, webSearches } = await callBudgeted(fn);
    return { value: result, error: null, budgetError: null, webSearches };
  } catch (err) {
    if (err instanceof RealEstateBudgetExceeded) return { value: null, error: err.message, budgetError: err, webSearches: 0 };
    return { value: null, error: err instanceof Error ? err.message : String(err), budgetError: null, webSearches: 0 };
  }
}

function emptyAgentResult<T>(): AgentCallResult<T> {
  return { value: null, error: null, budgetError: null, webSearches: 0 };
}

/**
 * Computes the deterministic financials (an awaited sidecar call — the one
 * place this can fail before any LLM call happens, surfaced by the route as
 * a 503) and inserts the run row immediately with them, then kicks off the
 * real work fire-and-forget, matching the panel's `startPanelRun` shape. No
 * placeholder-then-fill dance is needed for the financials themselves (they
 * are real from the first moment the row exists); the agent/manager columns
 * stay null until each actually completes.
 */
export async function startRealEstateRun(input: PropertyInput): Promise<string> {
  const computed = await computeFinancials(input);

  const runId = newId();
  db.insert(realEstateRuns)
    .values({
      id: runId,
      status: 'running',
      startedAt: nowIso(),
      model: config.anthropic.model,
      propertyInput: input,
      computedFinancials: computed,
    })
    .run();

  void executeRealEstateRun(runId, input, computed).catch((err) => {
    // Last-resort catch — executeRealEstateRun's own try/catches already
    // attribute every failure to a specific cause and reach their own
    // final status update. This only fires on something that escaped that.
    db.update(realEstateRuns)
      .set({ status: 'failed', finishedAt: nowIso(), errors: [err instanceof Error ? err.message : String(err)] })
      .where(eq(realEstateRuns.id, runId))
      .run();
  });

  return runId;
}

async function executeRealEstateRun(runId: string, input: PropertyInput, computed: ComputedFinancials): Promise<void> {
  const callBudgeted = withRealEstateBudget(runId);
  const errors: string[] = [];
  let totalWebSearches = 0;

  const persist = (patch: Partial<typeof realEstateRuns.$inferInsert>): void => {
    db.update(realEstateRuns).set(patch).where(eq(realEstateRuns.id, runId)).run();
  };

  const [locationR1, rentalR1] = await Promise.all([
    runAgentCall(callBudgeted, () => runLocationRound1(input, computed)),
    runAgentCall(callBudgeted, () => runRentalRound1(input, computed)),
  ]);
  totalWebSearches += locationR1.webSearches + rentalR1.webSearches;
  if (locationR1.error) errors.push(`location round 1: ${locationR1.error}`);
  if (rentalR1.error) errors.push(`rental round 1: ${rentalR1.error}`);
  persist({ locationRound1: locationR1.value, rentalRound1: rentalR1.value, webSearchesUsed: totalWebSearches });

  if (!locationR1.value && !rentalR1.value) {
    persist({ status: 'failed', finishedAt: nowIso(), errors: [...errors, 'Both round-1 agent calls failed.'] });
    return;
  }

  const [locationR2, rentalR2] = await Promise.all([
    locationR1.value
      ? runAgentCall<LocationAgentResult>(callBudgeted, () => runLocationRound2(input, computed, rentalR1.value))
      : Promise.resolve(emptyAgentResult<LocationAgentResult>()),
    rentalR1.value
      ? runAgentCall<RentalAgentResult>(callBudgeted, () => runRentalRound2(input, computed, locationR1.value))
      : Promise.resolve(emptyAgentResult<RentalAgentResult>()),
  ]);
  totalWebSearches += locationR2.webSearches + rentalR2.webSearches;
  if (locationR2.error) errors.push(`location round 2: ${locationR2.error}`);
  if (rentalR2.error) errors.push(`rental round 2: ${rentalR2.error}`);
  persist({ locationRound2: locationR2.value, rentalRound2: rentalR2.value, webSearchesUsed: totalWebSearches });

  const finalLocation = locationR2.value ?? locationR1.value;
  const balancePlacement: BalancePlacement = {
    cashFlowScore: computed.cashFlowAxisScore,
    appreciationScore: finalLocation ? finalLocation.appreciationOutlookScore : null,
  };

  let managerResult = null;
  try {
    managerResult = await callBudgeted(() =>
      runManagerSynthesis(input, computed, locationR1.value, locationR2.value, rentalR1.value, rentalR2.value),
    );
  } catch (err) {
    errors.push(`manager: ${err instanceof Error ? err.message : String(err)}`);
  }

  persist({
    managerResult,
    balancePlacement,
    // True only when the manager's real result actually landed — matching
    // the panel's own synthesisComplete, which is likewise never set on a
    // path where synthesis failed.
    synthesisComplete: managerResult !== null,
    status: managerResult && errors.length === 0 ? 'done' : 'partial',
    finishedAt: nowIso(),
    errors,
  });
}
