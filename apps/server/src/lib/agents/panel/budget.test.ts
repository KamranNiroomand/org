import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { runMigrations } from '../../../db/migrate.js';
import { panelRuns } from '../../../db/schema.js';
import { newId, nowIso } from '../../util.js';
import { CALLS_PER_SYMBOL, PANEL_AGENT_CONCURRENCY, PanelBudgetExceeded, withPanelBudget } from './budget.js';

beforeEach(() => {
  runMigrations();
  db.delete(panelRuns).run();
});

function seedRun(): string {
  const id = newId();
  db.insert(panelRuns)
    .values({
      id,
      trigger: 'box_query',
      query: 'test',
      resolutionMethod: 'ticker_match',
      symbols: ['TEST'],
      startedAt: nowIso(),
      model: 'claude-opus-5',
    })
    .run();
  return id;
}

describe('withPanelBudget', () => {
  it('allows calls up to the configured ceiling', async () => {
    const runId = seedRun();
    const callBudgeted = withPanelBudget(runId, 3);

    await callBudgeted(() => Promise.resolve('a'));
    await callBudgeted(() => Promise.resolve('b'));
    await callBudgeted(() => Promise.resolve('c'));

    const row = db.select().from(panelRuns).where(eq(panelRuns.id, runId)).get();
    expect(row?.callsMade).toBe(3);
  });

  it('throws PanelBudgetExceeded once the ceiling is passed, without running the call', async () => {
    const runId = seedRun();
    const callBudgeted = withPanelBudget(runId, 1);
    let ran = false;

    await callBudgeted(() => Promise.resolve('a'));
    await expect(
      callBudgeted(() => {
        ran = true;
        return Promise.resolve('b');
      }),
    ).rejects.toThrow(PanelBudgetExceeded);

    expect(ran).toBe(false);
  });

  it('shares one counter across every call, not one per call site', async () => {
    const runId = seedRun();
    const callBudgeted = withPanelBudget(runId, 2);

    await Promise.all([1, 2].map(() => callBudgeted(() => Promise.resolve(null))));
    await expect(callBudgeted(() => Promise.resolve(null))).rejects.toThrow(PanelBudgetExceeded);
  });
});

describe('CALLS_PER_SYMBOL', () => {
  it('accounts for every specialist, both rounds, plus one synthesis call', () => {
    expect(CALLS_PER_SYMBOL).toBe(PANEL_AGENT_CONCURRENCY * 2 + 1);
  });
});
