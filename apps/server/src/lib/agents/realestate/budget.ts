import { eq } from 'drizzle-orm';
import { config } from '../../../config.js';
import { db } from '../../../db/index.js';
import { realEstateRuns } from '../../../db/schema.js';
import { CallBudgetExceeded, withBudget, type CallBudgeted } from '../panel/budget.js';

/** Thin domain wrapper around the panel's generalized `withBudget` — see
 * that module's own doc comment for why this isn't a near-duplicate copy. */
export class RealEstateBudgetExceeded extends CallBudgetExceeded {
  constructor(runId: string, calls: number) {
    super('Real-estate', runId, calls);
    this.name = 'RealEstateBudgetExceeded';
  }
}

function persistRealEstateCallsMade(runId: string, calls: number): void {
  db.update(realEstateRuns).set({ callsMade: calls }).where(eq(realEstateRuns.id, runId)).run();
}

export function withRealEstateBudget(runId: string, maxCalls: number = config.realEstate.maxCallsPerRun): CallBudgeted {
  return withBudget(runId, maxCalls, persistRealEstateCallsMade, (id, c) => new RealEstateBudgetExceeded(id, c));
}
