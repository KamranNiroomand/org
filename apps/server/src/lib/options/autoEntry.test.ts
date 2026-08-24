import { beforeEach, describe, expect, it } from 'vitest';
import { formatOccSymbol, toE4 } from '@org/shared';
import { config } from '../../config.js';
import { marketDb } from '../../db/market/index.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { optionContracts } from '../../db/market/schema.js';
import { paperDb } from '../../db/paper/index.js';
import { runPaperMigrations } from '../../db/paper/migrate.js';
import { paperOrders } from '../../db/paper/schema.js';
import { openOrder } from '../paper.js';
import { nowIso } from '../util.js';
import type {
  RankedContract,
  SelectedEntry,
  SelectEntriesInput,
  SelectEntriesResult,
} from '../quant.js';
import { runAutoEntry } from './autoEntry.js';

/**
 * `selectEntries` is injected (see autoEntry.ts's own comment) so these
 * tests exercise the real open-and-persist loop — `QUANT_URL` is pinned
 * unreachable for the whole suite (see vitest.config.ts). The allocation
 * rule itself (how many, which, within what capital) is Python's and is
 * tested directly in services/quant/tests/test_rank.py::TestSelectEntries.
 */

function contract(occ: string, underlying: string): void {
  marketDb
    .insert(optionContracts)
    .values({
      occSymbol: occ,
      underlying,
      expiry: '2026-09-19',
      type: 'call',
      strikeE4: toE4(100),
      multiplier: 100,
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
    })
    .run();
}

function ranked(overrides: Partial<RankedContract> = {}): RankedContract {
  return {
    occ_symbol: formatOccSymbol({ underlying: 'NVDA', expiry: '2026-09-19', type: 'call', strikeE4: toE4(100) }),
    underlying: 'NVDA',
    expiry: '2026-09-19',
    type: 'call',
    strike: 100,
    dte: 30,
    market_price: 2.0,
    market_iv: 0.3,
    forecast_vol: 0.32,
    forecast_drift: 0.05,
    forecast_value: 2.5,
    ev: 10,
    ev_per_risk: 0.1,
    prob_profit: 0.6,
    suggested_target_exit_price: 3.0,
    suggested_stop_loss_price: 1.0,
    suggested_target_exit_date: '2026-09-05',
    ...overrides,
  };
}

/** Wraps a contract in the sizing the sidecar would have returned with it.
 * Quantity defaults to 1 so tests that don't care about size read the same
 * as they did before sizing existed. */
function pick(contract: RankedContract, quantity = 1): SelectedEntry {
  return { contract, quantity, cost: contract.market_price * 100 * quantity };
}

/** Captures what autoEntry passed to the allocator, so the account-state
 * wiring (free cash, reserve, held underlyings) can be asserted directly. */
function selectFn(selected: SelectedEntry[], captured?: { input?: SelectEntriesInput }) {
  return async (input: SelectEntriesInput): Promise<SelectEntriesResult> => {
    if (captured) captured.input = input;
    return { model_run_id: 'test', model_beats_baseline: false, selected };
  };
}

beforeEach(() => {
  runMarketMigrations();
  runPaperMigrations();
  paperDb.delete(paperOrders).run();
  marketDb.delete(optionContracts).run();
});

describe('runAutoEntry', () => {
  it('opens every selected contract, carrying each suggested exit plan', async () => {
    const a = ranked();
    const b = ranked({ occ_symbol: 'AAPL  260919C00100000', underlying: 'AAPL', ev: 8, suggested_target_exit_price: 4.5 });
    contract(a.occ_symbol, 'NVDA');
    contract(b.occ_symbol, 'AAPL');

    const result = await runAutoEntry('2026-08-18', selectFn([pick(a), pick(b, 4)]));

    expect(result.opened.map((o) => o.occSymbol)).toEqual([a.occ_symbol, b.occ_symbol]);
    expect(result.skippedReason).toBeNull();
    const orders = paperDb.select().from(paperOrders).all();
    expect(orders).toHaveLength(2);
    // The sidecar's quantity is what gets written — not a hard-coded 1,
    // which is what made a position's real size an accident of the
    // contract's price.
    expect(orders.map((o) => o.quantity).sort()).toEqual([1, 4]);
    for (const o of orders) {
      expect(o.source).toBe('model');
      expect(o.targetExitPriceE4).not.toBeNull();
      expect(o.stopLossPriceE4).toBe(toE4(1.0));
      expect(o.targetExitDate).toBe('2026-09-05');
      expect(o.entryEv).not.toBeNull();
    }
  });

  it('opens nothing and explains why when the allocator returns an empty selection', async () => {
    const result = await runAutoEntry('2026-08-18', selectFn([]));
    expect(result.opened).toEqual([]);
    expect(result.skippedReason).toMatch(/no contract cleared|remaining capital/i);
    expect(paperDb.select().from(paperOrders).all()).toHaveLength(0);
  });

  it('passes the account’s real free cash, reserve applied, and held underlyings to the allocator', async () => {
    const c = ranked();
    contract(c.occ_symbol, 'NVDA');
    // One open position at $1.50 x 100 = $150 committed against the
    // $100,000 starting balance.
    openOrder({ occSymbol: c.occ_symbol, quantity: 1, entryPriceE4: toE4(1.5), source: 'model' });

    const captured: { input?: SelectEntriesInput } = {};
    await runAutoEntry('2026-08-18', selectFn([], captured));

    expect(captured.input!.openPositionCount).toBe(1);
    expect(captured.input!.heldUnderlyings).toEqual(['NVDA']);
    // (100_000 - 150) * (1 - 0.2 reserve)
    expect(captured.input!.availableCapital).toBeCloseTo(79_880, 2);
  });

  it('keeps going when one contract fails to open, and reports it as a failure not a skip', async () => {
    const good = ranked();
    const ghost = ranked({ occ_symbol: 'GHOST 260919C00100000', underlying: 'GHST' });
    contract(good.occ_symbol, 'NVDA'); // ghost deliberately not in the corpus

    const result = await runAutoEntry('2026-08-18', selectFn([pick(good), pick(ghost)]));

    expect(result.opened.map((o) => o.occSymbol)).toEqual([good.occ_symbol]);
    expect(result.failures.join('; ')).toContain('GHOST');
    // A partly-successful run is not a skipped one — see the field's own
    // doc comment. Conflating them made a partial success read as total.
    expect(result.skippedReason).toBeNull();
    expect(paperDb.select().from(paperOrders).all()).toHaveLength(1);
  });

  it('refuses a selected candidate missing any part of its exit plan', async () => {
    // The sidecar filters these out before allocating, so this is a
    // belt-and-braces guard — but without it `null * 10_000` is 0 in JS,
    // which would quietly write a zeroed target and a null date and strand
    // the position outside the exit engine's view forever.
    const broken = ranked({ suggested_target_exit_date: null });
    contract(broken.occ_symbol, 'NVDA');

    const result = await runAutoEntry('2026-08-18', selectFn([pick(broken)]));

    expect(result.opened).toEqual([]);
    expect(result.skippedReason).toContain('without a complete exit plan');
    expect(paperDb.select().from(paperOrders).all()).toHaveLength(0);
  });

  it('refuses a selection sized at zero rather than opening a zero-cost position', async () => {
    // Same class of guard as the missing-exit-plan case above: a quantity
    // of 0 would insert a row with no cost and no payoff that the exit
    // engine then manages for the rest of its life.
    const c = ranked();
    contract(c.occ_symbol, 'NVDA');

    const result = await runAutoEntry('2026-08-18', selectFn([pick(c, 0)]));

    expect(result.opened).toEqual([]);
    expect(result.skippedReason).toContain('non-positive quantity');
    expect(paperDb.select().from(paperOrders).all()).toHaveLength(0);
  });

  it('trims a selection the account cannot actually afford at the contract’s real multiplier', async () => {
    // The sidecar sizes against 100x because a ranked contract carries no
    // multiplier. This one is 1000x, so its 40 units cost 10x what the
    // sidecar budgeted — and `openOrder` has no cash guard of its own.
    const c = ranked({ occ_symbol: 'BIGM  260919C00100000', underlying: 'BIGM', market_price: 2.0 });
    marketDb
      .insert(optionContracts)
      .values({
        occSymbol: c.occ_symbol,
        underlying: 'BIGM',
        expiry: '2026-09-19',
        type: 'call',
        strikeE4: toE4(100),
        multiplier: 1000,
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
      })
      .run();
    // Cap free cash so 40 units at $2,000 each ($80,000) does not fit:
    // one open position eats most of the $100,000 starting balance.
    contract('FILL  260919C00100000', 'FILL');
    openOrder({ occSymbol: 'FILL  260919C00100000', quantity: 1, entryPriceE4: toE4(950), source: 'manual' });

    const result = await runAutoEntry('2026-08-18', selectFn([pick(c, 40)]));

    const order = paperDb.select().from(paperOrders).all().find((o) => o.occSymbol === c.occ_symbol);
    expect(order).toBeDefined();
    // (100_000 - 95_000) * 0.8 reserve = $4,000 available; $2,000 a unit.
    expect(order!.quantity).toBe(2);
    expect(result.failures.join('; ')).toContain('trimmed from 40 to 2');
  });

  it('refuses a selection whose real cost exceeds every dollar available', async () => {
    const c = ranked({ occ_symbol: 'HUGE  260919C00100000', underlying: 'HUGE', market_price: 2_000 });
    contract(c.occ_symbol, 'HUGE');

    const result = await runAutoEntry('2026-08-18', selectFn([pick(c, 1)]));

    expect(result.opened).toEqual([]);
    expect(result.skippedReason).toContain('more than the');
    expect(paperDb.select().from(paperOrders).all()).toHaveLength(0);
  });

  it('passes the configured DTE band through to the allocator', async () => {
    const captured: { input?: SelectEntriesInput } = {};
    await runAutoEntry('2026-08-18', selectFn([], captured));

    // The band has to reach Python — filtering by maturity in the caller
    // instead would let a candidate consume a selection slot and then be
    // discarded, silently shrinking the day's book.
    expect(captured.input!.minDte).toBe(config.market.autoEntry.minDte);
    expect(captured.input!.maxDte).toBe(config.market.autoEntry.maxDte);
    expect(captured.input!.maxDte).toBeGreaterThanOrEqual(captured.input!.minDte);
  });

  it('records a skip reason rather than throwing when the quant sidecar is unreachable', async () => {
    // No injected fn — exercises the real one against the suite's
    // pinned-unreachable QUANT_URL (see vitest.config.ts).
    const result = await runAutoEntry('2026-08-18');
    expect(result.opened).toEqual([]);
    expect(result.skippedReason).toBeTruthy();
  });
});
