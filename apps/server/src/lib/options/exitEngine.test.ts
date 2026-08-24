import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { formatOccSymbol, toE4 } from '@org/shared';
import { marketDb } from '../../db/market/index.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { optionContracts } from '../../db/market/schema.js';
import { paperDb } from '../../db/paper/index.js';
import { runPaperMigrations } from '../../db/paper/migrate.js';
import { paperExitRevisions, paperOrders } from '../../db/paper/schema.js';
import { openOrder } from '../paper.js';
import { QuantRefusal } from '../quant.js';
import { nowIso } from '../util.js';
import type { ChainQuote, ChainRequest, DailyBar, OptionsProvider } from './provider.js';
import { runExitEngine, revisionsByOrder, type ExitEngineDeps } from './exitEngine.js';

/**
 * `evaluateExit`/`scoreHeldContracts`/`adviseOnExit` are injected (see
 * `ExitEngineDeps`) so the actual close/revise/escalate branching can be
 * exercised directly, the same reason `capture.ts` takes an injected
 * `OptionsProvider` — without it, every scenario here would only ever
 * reach the "quant sidecar unreachable" fallback, same as
 * `positionHealth.test.ts` is limited to today (QUANT_URL is pinned
 * unreachable for the whole suite — see vitest.config.ts).
 */

const log = pino({ level: 'silent' });

const CONTRACT = { underlying: 'NVDA', expiry: '2026-08-19', type: 'call' as const, strikeE4: toE4(227.5) };
const OCC = formatOccSymbol(CONTRACT);
const ENTRY_E4 = toE4(1.0);

function seedContract() {
  marketDb
    .insert(optionContracts)
    .values({
      occSymbol: OCC,
      underlying: CONTRACT.underlying,
      expiry: CONTRACT.expiry,
      type: CONTRACT.type,
      strikeE4: CONTRACT.strikeE4,
      multiplier: 100,
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
    })
    .run();
}

function openManagedPosition(overrides: Partial<typeof paperOrders.$inferInsert> = {}): string {
  const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ENTRY_E4, source: 'model' });
  paperDb
    .update(paperOrders)
    .set({
      targetExitPriceE4: toE4(1.5),
      stopLossPriceE4: toE4(0.5),
      targetExitDate: '2026-09-01',
      entryEv: 5,
      ...overrides,
    })
    .where(eq(paperOrders.id, id))
    .run();
  return id;
}

class StubProvider implements OptionsProvider {
  readonly name = 'stub';
  constructor(private readonly quote: ChainQuote | null) {}
  async fetchChain(_request: ChainRequest): Promise<ChainQuote[]> {
    return this.quote ? [this.quote] : [];
  }
  async fetchBars(): Promise<DailyBar[]> {
    return [];
  }
  async probe() {
    return { name: this.name, liveChain: true, historicalChain: false, historicalQuotes: false, equityBars: true, news: false, notes: [] };
  }
}

function liveQuote(bidE4: number | null): ChainQuote {
  return {
    occSymbol: OCC,
    underlying: CONTRACT.underlying,
    expiry: CONTRACT.expiry,
    type: CONTRACT.type,
    strikeE4: CONTRACT.strikeE4,
    multiplier: 100,
    bidE4,
    askE4: bidE4,
    lastE4: bidE4,
    closeE4: bidE4,
    volume: 10,
    openInterest: 10,
    underlyingE4: toE4(230),
    asOf: nowIso(),
    tradingDay: '2026-08-18',
    vendorIv: null,
  };
}

const NEVER_REVIEW_DEPS: ExitEngineDeps = {
  evaluateExit: async () => ({
    action: 'hold',
    newTargetExitPriceE4: toE4(1.5),
    newTargetExitDate: '2026-09-01',
    newStopLossPriceE4: null,
    reason: 'no trigger',
    triggeredBy: 'unchanged',
  }),
  scoreHeldContracts: async () => ({ model_run_id: 'test', model_beats_baseline: false, contracts: {} }),
  adviseOnExit: async () => {
    throw new Error('adviseOnExit should not be called on this path');
  },
  anthropicConfigured: false,
  maxCallsPerRun: 30,
  // Every order these tests seed already carries a full exit plan, so
  // adoption has nothing to do; throwing makes an accidental call loud
  // rather than silently reaching the real sidecar.
  computeExitTarget: async () => {
    throw new Error('computeExitTarget should not be called for an order that already has a plan');
  },
};

beforeEach(() => {
  runMarketMigrations();
  runPaperMigrations();
  paperDb.delete(paperExitRevisions).run();
  paperDb.delete(paperOrders).run();
  marketDb.delete(optionContracts).run();
  seedContract();
});

describe('runExitEngine', () => {
  it('does nothing when there are no open positions', async () => {
    const summary = await runExitEngine(log, new StubProvider(null), NEVER_REVIEW_DEPS);
    expect(summary.checked).toBe(0);
    expect(summary.status).toBe('done');
  });

  it('ignores a manually opened position even if open', async () => {
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ENTRY_E4, source: 'manual' });
    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), NEVER_REVIEW_DEPS);
    expect(summary.checked).toBe(0);
  });

  it('persists a ratcheted stop so the trail actually survives to the next pass', async () => {
    // The failure this pins is silent: if the raised stop is not written,
    // it resets every pass and the position trails nothing — the rule
    // looks implemented and does nothing at all.
    const id = openManagedPosition();

    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(3.0))), {
      ...NEVER_REVIEW_DEPS,
      evaluateExit: async () => ({
        action: 'hold',
        newTargetExitPriceE4: toE4(1.5),
        newTargetExitDate: '2026-09-01',
        newStopLossPriceE4: toE4(2.1),
        reason: 'letting it run with the stop raised',
        triggeredBy: 'trail_raised',
      }),
    });

    expect(summary.revised).toBe(1);
    const [order] = paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).all();
    expect(order?.stopLossPriceE4).toBe(toE4(2.1));
    expect(order?.status).toBe('open'); // still running — that is the point
    const revisions = revisionsByOrder().get(id) ?? [];
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.oldStopLossPriceE4).toBe(toE4(0.5));
    expect(revisions[0]?.newStopLossPriceE4).toBe(toE4(2.1));
    expect(revisions[0]?.triggeredBy).toBe('rule');
  });

  it('does not advance the news cutoff when only a rule raised the stop', async () => {
    // `exitUpdatedAt` doubles as the cutoff for `readDocumentsSince`, and
    // the advisor path advances it to record "every document counted has
    // now been reviewed". A rule-based ratchet has reviewed nothing, so
    // stamping it there buried unreviewed news permanently, every pass.
    const id = openManagedPosition();
    const before = paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).all()[0];

    await runExitEngine(log, new StubProvider(liveQuote(toE4(3.0))), {
      ...NEVER_REVIEW_DEPS,
      evaluateExit: async () => ({
        action: 'hold',
        newTargetExitPriceE4: toE4(1.5),
        newTargetExitDate: '2026-09-01',
        newStopLossPriceE4: toE4(2.1),
        reason: 'stop raised',
        triggeredBy: 'trail_raised',
      }),
    });

    const [after] = paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).all();
    expect(after?.stopLossPriceE4).toBe(toE4(2.1)); // the ratchet still landed
    expect(after?.exitUpdatedAt).toBe(before?.exitUpdatedAt ?? null);
  });

  it('leaves an adopted position’s news backlog pending review', async () => {
    // An orphan has never been rechecked, so its whole document history is
    // still owed a review. Stamping exitUpdatedAt on adoption would throw
    // that away at the moment the engine finally takes charge.
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ENTRY_E4, source: 'model' });

    await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), {
      ...NEVER_REVIEW_DEPS,
      computeExitTarget: async () => ({
        targetE4: { targetExitPriceE4: toE4(1.5), stopLossPriceE4: toE4(0.5), targetExitDate: '2026-09-01' },
        refusal: null,
        horizon: 5,
        modelRunId: 'test',
      }),
    });

    const [order] = paperDb.select().from(paperOrders).all();
    expect(order?.targetExitPriceE4).toBe(toE4(1.5)); // adopted
    expect(order?.exitUpdatedAt).toBeNull(); // but the backlog still counts
  });

  it('never lowers a stop, even if asked to', async () => {
    // A stop that can move down is not a stop. `evaluate_exit` already
    // guarantees the ratchet is monotone; this is the second lock.
    const id = openManagedPosition();

    await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), {
      ...NEVER_REVIEW_DEPS,
      evaluateExit: async () => ({
        action: 'hold',
        newTargetExitPriceE4: toE4(1.5),
        newTargetExitDate: '2026-09-01',
        newStopLossPriceE4: toE4(0.1), // below the 0.5 already in force
        reason: 'should be ignored',
        triggeredBy: 'trail_raised',
      }),
    });

    const [order] = paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).all();
    expect(order?.stopLossPriceE4).toBe(toE4(0.5));
    expect(revisionsByOrder().get(id) ?? []).toHaveLength(0);
  });

  it('adopts a model-opened position that has no exit plan, then manages it', async () => {
    // This used to assert `checked: 0` — "ignores a model-opened position
    // with no exit target recorded yet". That was the bug, not the spec:
    // such a position is invisible to `managedOpenOrders` forever, so it
    // is never managed at all. On 2026-08-24 every position on the real
    // paper book was in exactly this state, one of them worth $122,440.
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ENTRY_E4, source: 'model' });

    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), {
      ...NEVER_REVIEW_DEPS,
      computeExitTarget: async () => ({
        targetE4: { targetExitPriceE4: toE4(1.5), stopLossPriceE4: toE4(0.5), targetExitDate: '2026-09-01' },
        refusal: null,
        horizon: 5,
        modelRunId: 'test',
      }),
    });

    expect(summary.adopted).toBe(1);
    expect(summary.checked).toBe(1); // adopted first, so it is visible in the same run
    const [order] = paperDb.select().from(paperOrders).all();
    if (!order) throw new Error('expected an order');
    expect(order.targetExitPriceE4).toBe(toE4(1.5));
    expect(order.stopLossPriceE4).toBe(toE4(0.5));
    expect(order.targetExitDate).toBe('2026-09-01');
  });

  it('leaves a position unmanaged, with a reason, when no honest target exists', async () => {
    // A contract inside the DTE floor has no target date that both exists
    // and clears the floor. Inventing one would be worse than leaving it
    // alone — see exit.py's refusal case.
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ENTRY_E4, source: 'model' });

    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), {
      ...NEVER_REVIEW_DEPS,
      computeExitTarget: async () => ({
        targetE4: null,
        refusal: '2026-08-19 is only 2 day(s) out — no target date clears the 3-day floor.',
        horizon: 5,
        modelRunId: 'test',
      }),
    });

    expect(summary.adopted).toBe(0);
    expect(summary.checked).toBe(0);
    expect(summary.errors.join(' ')).toContain('no exit plan is computable');
    const [order] = paperDb.select().from(paperOrders).all();
    if (!order) throw new Error('expected an order');
    expect(order.targetExitPriceE4).toBeNull();
  });

  it('does not let one un-adoptable position stop the rest of the run', async () => {
    // Per-item isolation, same as the close/revise loop below it: a
    // sidecar failure on one orphan must not cost every other position
    // its recheck.
    openManagedPosition(); // already has a plan
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ENTRY_E4, source: 'model' });

    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), {
      ...NEVER_REVIEW_DEPS,
      computeExitTarget: async () => {
        throw new Error('sidecar down');
      },
    });

    expect(summary.adopted).toBe(0);
    expect(summary.checked).toBe(1); // the already-planned position still ran
    expect(summary.errors.join(' ')).toContain('sidecar down');
  });

  it('records an error and leaves the position open when the contract is gone from the corpus', async () => {
    const id = openManagedPosition();
    marketDb.delete(optionContracts).run();
    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), NEVER_REVIEW_DEPS);
    expect(summary.errors.some((e) => e.includes('not found in the corpus'))).toBe(true);
    expect(paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!.status).toBe('open');
  });

  it('records an error and leaves the position open when no live bid is available', async () => {
    const id = openManagedPosition();
    const summary = await runExitEngine(log, new StubProvider(liveQuote(null)), NEVER_REVIEW_DEPS);
    expect(summary.errors.some((e) => e.includes('no live bid'))).toBe(true);
    expect(paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!.status).toBe('open');
  });

  it('closes the position on a deterministic exit_now decision, without ever calling the LLM advisor', async () => {
    const id = openManagedPosition();
    const deps: ExitEngineDeps = {
      ...NEVER_REVIEW_DEPS,
      evaluateExit: async () => ({
        action: 'exit_now',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reason: 'hit stop-loss',
        triggeredBy: 'stop_loss',
      }),
    };
    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(0.4))), deps);
    expect(summary.closed).toBe(1);
    expect(summary.llmCallsMade).toBe(0);
    const order = paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!;
    expect(order.status).toBe('closed');
    expect(order.exitPriceE4).toBe(toE4(0.4));
  });

  it('leaves the target unchanged on a hold decision', async () => {
    openManagedPosition();
    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), NEVER_REVIEW_DEPS);
    expect(summary.closed).toBe(0);
    expect(summary.revised).toBe(0);
    expect(paperDb.select().from(paperExitRevisions).all()).toHaveLength(0);
  });

  it('escalates to review but records an error rather than closing when ANTHROPIC_API_KEY is not set', async () => {
    const id = openManagedPosition();
    const deps: ExitEngineDeps = {
      ...NEVER_REVIEW_DEPS,
      evaluateExit: async () => ({
        action: 'needs_review',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reason: 'EV flipped sign',
        triggeredBy: 'ev_sign_flip',
      }),
    };
    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), deps);
    expect(summary.escalated).toBe(1);
    expect(summary.llmCallsMade).toBe(0);
    expect(summary.errors.some((e) => e.includes('ANTHROPIC_API_KEY'))).toBe(true);
    expect(paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!.status).toBe('open');
  });

  it('records a revision and updates the target when the advisor moves it', async () => {
    const id = openManagedPosition();
    const deps: ExitEngineDeps = {
      ...NEVER_REVIEW_DEPS,
      anthropicConfigured: true,
      evaluateExit: async () => ({
        action: 'needs_review',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reason: 'new documents',
        triggeredBy: 'new_news',
      }),
      adviseOnExit: async () => ({
        action: 'move_target',
        newTargetExitPriceE4: toE4(1.8),
        newTargetExitDate: '2026-09-10',
        reasoning: 'Thesis strengthened by the new filing.',
        citedInputs: ['newDocuments'],
      }),
    };
    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), deps);
    expect(summary.revised).toBe(1);
    const order = paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!;
    expect(order.targetExitPriceE4).toBe(toE4(1.8));
    expect(order.targetExitDate).toBe('2026-09-10');
    const revisions = paperDb.select().from(paperExitRevisions).where(eq(paperExitRevisions.orderId, id)).all();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.triggeredBy).toBe('llm');
    expect(revisions[0]!.oldTargetExitPriceE4).toBe(toE4(1.5));
  });

  it('closes the position when the advisor itself recommends exiting', async () => {
    const id = openManagedPosition();
    const deps: ExitEngineDeps = {
      ...NEVER_REVIEW_DEPS,
      anthropicConfigured: true,
      evaluateExit: async () => ({
        action: 'needs_review',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reason: 'EV flipped sign',
        triggeredBy: 'ev_sign_flip',
      }),
      adviseOnExit: async () => ({
        action: 'exit_now',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reasoning: 'The flip reflects a real, durable change.',
        citedInputs: ['currentEv'],
      }),
    };
    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), deps);
    expect(summary.closed).toBe(1);
    expect(paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!.status).toBe('closed');
  });

  it('stops spending once the LLM call budget for the run is exhausted', async () => {
    openManagedPosition();
    const deps: ExitEngineDeps = {
      ...NEVER_REVIEW_DEPS,
      anthropicConfigured: true,
      maxCallsPerRun: 0,
      evaluateExit: async () => ({
        action: 'needs_review',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reason: 'new documents',
        triggeredBy: 'new_news',
      }),
    };
    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), deps);
    expect(summary.status).toBe('partial');
    expect(summary.llmCallsMade).toBe(0);
    expect(summary.errors.some((e) => e.includes('budget exhausted'))).toBe(true);
  });

  it('refuses a second concurrent run while one is already in progress', async () => {
    openManagedPosition();
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const deps: ExitEngineDeps = {
      ...NEVER_REVIEW_DEPS,
      evaluateExit: async (input) => {
        await gate; // hold the first run open until the second has been attempted
        return NEVER_REVIEW_DEPS.evaluateExit(input);
      },
    };
    const first = runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), deps);
    // Give the first run a tick to set the lock before the second starts.
    await new Promise((r) => setTimeout(r, 0));
    const second = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), NEVER_REVIEW_DEPS);
    expect(second.checked).toBe(0);
    expect(second.errors.some((e) => e.includes('already in progress'))).toBe(true);
    releaseFirst();
    const firstResult = await first;
    expect(firstResult.checked).toBe(1);
  });

  it('still runs the deterministic price/DTE checks when scoreHeldContracts refuses (QuantRefusal), not just when it is unreachable', async () => {
    const id = openManagedPosition();
    const deps: ExitEngineDeps = {
      ...NEVER_REVIEW_DEPS,
      scoreHeldContracts: async () => {
        throw new QuantRefusal('model does not beat baseline');
      },
      evaluateExit: async () => ({
        action: 'exit_now',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reason: 'hit stop-loss',
        triggeredBy: 'stop_loss',
      }),
    };
    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(0.4))), deps);
    expect(summary.closed).toBe(1);
    expect(paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!.status).toBe('closed');
  });

  it('records an error rather than silently dropping a move_target advisory missing its target fields', async () => {
    const id = openManagedPosition();
    const deps: ExitEngineDeps = {
      ...NEVER_REVIEW_DEPS,
      anthropicConfigured: true,
      evaluateExit: async () => ({
        action: 'needs_review',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reason: 'new documents',
        triggeredBy: 'new_news',
      }),
      adviseOnExit: async () => ({
        action: 'move_target',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        reasoning: 'malformed response',
        citedInputs: [],
      }),
    };
    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), deps);
    expect(summary.revised).toBe(0);
    expect(summary.errors.some((e) => e.includes('a missing target price/date'))).toBe(true);
    expect(paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!.status).toBe('open');
    expect(revisionsByOrder().get(id)).toBeUndefined();
  });

  it('bumps exitUpdatedAt after any advisor review, including a hold, so the same documents do not re-trigger the next recheck', async () => {
    const id = openManagedPosition({ exitUpdatedAt: '2020-01-01T00:00:00.000Z' });
    const deps: ExitEngineDeps = {
      ...NEVER_REVIEW_DEPS,
      anthropicConfigured: true,
      evaluateExit: async () => ({
        action: 'needs_review',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reason: 'new documents',
        triggeredBy: 'new_news',
      }),
      adviseOnExit: async () => ({
        action: 'hold',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reasoning: 'One ambiguous headline is not grounds to exit.',
        citedInputs: [],
      }),
    };
    await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), deps);
    const order = paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!;
    expect(order.exitUpdatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('runExitEngine revision atomicity', () => {
  function moveTargetDeps(overrides: Partial<ExitEngineDeps> = {}): ExitEngineDeps {
    return {
      ...NEVER_REVIEW_DEPS,
      anthropicConfigured: true,
      evaluateExit: async () => ({
        action: 'needs_review',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        newStopLossPriceE4: null,
        reason: 'new documents',
        triggeredBy: 'new_news',
      }),
      adviseOnExit: async () => ({
        action: 'move_target',
        newTargetExitPriceE4: toE4(1.9),
        newTargetExitDate: '2026-09-12',
        reasoning: 'Filing supports holding longer.',
        citedInputs: ['newDocuments'],
      }),
      ...overrides,
    };
  }

  it('applies the revision, the moved target and the cutoff together', async () => {
    const id = openManagedPosition({ exitUpdatedAt: '2020-01-01T00:00:00.000Z' });

    await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), moveTargetDeps());

    const order = paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!;
    const revisions = paperDb.select().from(paperExitRevisions).where(eq(paperExitRevisions.orderId, id)).all();

    expect(revisions).toHaveLength(1);
    expect(order.targetExitPriceE4).toBe(toE4(1.9));
    expect(order.targetExitDate).toBe('2026-09-12');
    expect(order.exitUpdatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(revisions[0]!.newTargetExitPriceE4).toBe(order.targetExitPriceE4);
    expect(revisions[0]!.newTargetExitDate).toBe(order.targetExitDate);
    // The revision records where the target came *from*, so the audit trail
    // reconstructs the whole path rather than just the current value.
    expect(revisions[0]!.oldTargetExitPriceE4).toBe(toE4(1.5));
  });

  it('leaves nothing behind — including the cutoff — when the write fails', async () => {
    // Both statements bind the same two advice values, so a value bad
    // enough to fail the update fails the insert first; there is no way
    // through this interface to force insert-then-update-failure. What is
    // testable, and what actually matters here, is that a failed recheck
    // leaves *no* partial trace — in particular the news cutoff must not
    // advance, or the documents that triggered this review are silently
    // skipped next time. `paper.test.ts` pins the rollback semantics of
    // `paperDb.transaction` itself.
    const id = openManagedPosition({ exitUpdatedAt: '2020-01-01T00:00:00.000Z' });
    const deps = moveTargetDeps({
      adviseOnExit: async () => ({
        action: 'move_target',
        newTargetExitPriceE4: toE4(1.9),
        newTargetExitDate: { bogus: true } as unknown as string,
        reasoning: 'Filing supports holding longer.',
        citedInputs: ['newDocuments'],
      }),
    });

    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), deps);

    const order = paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!;
    const revisions = paperDb.select().from(paperExitRevisions).where(eq(paperExitRevisions.orderId, id)).all();

    expect(summary.revised).toBe(0);
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(revisions).toHaveLength(0);
    expect(order.targetExitPriceE4).toBe(toE4(1.5));
    expect(order.exitUpdatedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('does not advance the cutoff when a malformed move_target is rejected', async () => {
    // The guard runs before the write, so an advisor response that violates
    // its own schema costs an LLM call but changes nothing — including the
    // cutoff, so the same documents get reviewed again rather than being
    // written off by a decision that was never applied.
    const id = openManagedPosition({ exitUpdatedAt: '2020-01-01T00:00:00.000Z' });
    const deps = moveTargetDeps({
      adviseOnExit: async () => ({
        action: 'move_target',
        newTargetExitPriceE4: null,
        newTargetExitDate: null,
        reasoning: 'malformed response',
        citedInputs: [],
      }),
    });

    const summary = await runExitEngine(log, new StubProvider(liveQuote(toE4(1.0))), deps);

    const order = paperDb.select().from(paperOrders).where(eq(paperOrders.id, id)).get()!;
    expect(summary.revised).toBe(0);
    expect(summary.errors.some((e) => e.includes('a missing target price/date'))).toBe(true);
    expect(order.exitUpdatedAt).toBe('2020-01-01T00:00:00.000Z');
  });
});
