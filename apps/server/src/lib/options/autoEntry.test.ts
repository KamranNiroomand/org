import { beforeEach, describe, expect, it } from 'vitest';
import { formatOccSymbol, toE4 } from '@org/shared';
import { marketDb } from '../../db/market/index.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { optionContracts } from '../../db/market/schema.js';
import { paperDb } from '../../db/paper/index.js';
import { runPaperMigrations } from '../../db/paper/migrate.js';
import { paperOrders } from '../../db/paper/schema.js';
import { openOrder } from '../paper.js';
import { nowIso } from '../util.js';
import type { RankedContract, SelectEntriesInput, SelectEntriesResult } from '../quant.js';
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

/** Captures what autoEntry passed to the allocator, so the account-state
 * wiring (free cash, reserve, held underlyings) can be asserted directly. */
function selectFn(selected: RankedContract[], captured?: { input?: SelectEntriesInput }) {
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

    const result = await runAutoEntry('2026-08-18', selectFn([a, b]));

    expect(result.opened.map((o) => o.occSymbol)).toEqual([a.occ_symbol, b.occ_symbol]);
    expect(result.skippedReason).toBeNull();
    const orders = paperDb.select().from(paperOrders).all();
    expect(orders).toHaveLength(2);
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

  it('keeps going when one contract fails to open, and reports it', async () => {
    const good = ranked();
    const ghost = ranked({ occ_symbol: 'GHOST 260919C00100000', underlying: 'GHST' });
    contract(good.occ_symbol, 'NVDA'); // ghost deliberately not in the corpus

    const result = await runAutoEntry('2026-08-18', selectFn([good, ghost]));

    expect(result.opened.map((o) => o.occSymbol)).toEqual([good.occ_symbol]);
    expect(result.skippedReason).toContain('GHOST');
    expect(paperDb.select().from(paperOrders).all()).toHaveLength(1);
  });

  it('records a skip reason rather than throwing when the quant sidecar is unreachable', async () => {
    // No injected fn — exercises the real one against the suite's
    // pinned-unreachable QUANT_URL (see vitest.config.ts).
    const result = await runAutoEntry('2026-08-18');
    expect(result.opened).toEqual([]);
    expect(result.skippedReason).toBeTruthy();
  });
});
