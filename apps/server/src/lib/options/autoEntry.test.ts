import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { formatOccSymbol, toE4 } from '@org/shared';
import { marketDb } from '../../db/market/index.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { optionContracts } from '../../db/market/schema.js';
import { paperDb } from '../../db/paper/index.js';
import { runPaperMigrations } from '../../db/paper/migrate.js';
import { paperOrders } from '../../db/paper/schema.js';
import { openOrder } from '../paper.js';
import { nowIso } from '../util.js';
import type { RankedContract, RankResult } from '../quant.js';
import { runAutoEntry } from './autoEntry.js';

/**
 * `rankDay` is injected (see autoEntry.ts's own comment) so these tests can
 * exercise the real candidate-selection logic — `QUANT_URL` is pinned
 * unreachable for the whole suite (see vitest.config.ts).
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

function rankFn(contracts: RankedContract[]): (day: string, top?: number, force?: boolean) => Promise<RankResult> {
  return async () => ({ model_run_id: 'test', model_beats_baseline: false, model_information_coefficient: 0, contracts });
}

// Exercised against the real ambient defaults (AUTO_ENTRY_MIN_EV_PER_RISK
// 0.05, AUTO_ENTRY_MIN_PROB_PROFIT 0.5 — see config.ts), not overridden:
// `config` is deliberately read-only in this codebase, and the fixtures
// below are chosen to sit clearly above or below those real defaults.
beforeEach(() => {
  runMarketMigrations();
  runPaperMigrations();
  paperDb.delete(paperOrders).run();
  marketDb.delete(optionContracts).run();
});

describe('runAutoEntry', () => {
  it('opens the top-EV eligible contract, carrying its suggested exit plan', async () => {
    contract(ranked().occ_symbol, 'NVDA');
    const candidate = ranked();
    const weaker = ranked({ occ_symbol: 'AAPL  260919C00100000', underlying: 'AAPL', ev: 3 });
    contract(weaker.occ_symbol, 'AAPL');

    const result = await runAutoEntry('2026-08-18', rankFn([weaker, candidate]));

    expect(result.openedOccSymbol).toBe(candidate.occ_symbol);
    expect(result.skippedReason).toBeNull();
    const order = paperDb.select().from(paperOrders).where(eq(paperOrders.id, result.orderId!)).get()!;
    expect(order.source).toBe('model');
    expect(order.entryEv).toBe(10);
    expect(order.targetExitPriceE4).toBe(toE4(3.0));
    expect(order.stopLossPriceE4).toBe(toE4(1.0));
    expect(order.targetExitDate).toBe('2026-09-05');
  });

  it('skips a contract below the minimum EV-per-risk bar', async () => {
    const weak = ranked({ ev_per_risk: 0.01 });
    contract(weak.occ_symbol, 'NVDA');

    const result = await runAutoEntry('2026-08-18', rankFn([weak]));

    expect(result.openedOccSymbol).toBeNull();
    expect(result.skippedReason).toMatch(/no contract cleared/i);
  });

  it('skips a contract below the minimum probability-of-profit bar', async () => {
    const weak = ranked({ prob_profit: 0.1 });
    contract(weak.occ_symbol, 'NVDA');

    const result = await runAutoEntry('2026-08-18', rankFn([weak]));

    expect(result.openedOccSymbol).toBeNull();
  });

  it('never opens a second position on an underlying that already has one open', async () => {
    const c = ranked();
    contract(c.occ_symbol, 'NVDA');
    openOrder({ occSymbol: c.occ_symbol, quantity: 1, entryPriceE4: toE4(1.5), source: 'model' });

    const result = await runAutoEntry('2026-08-18', rankFn([c]));

    expect(result.openedOccSymbol).toBeNull();
    expect(paperDb.select().from(paperOrders).all()).toHaveLength(1);
  });

  it('still refuses a second position on an underlying whose contract has since been pruned from the corpus', async () => {
    // Regression test: underlying used to be re-derived at check time via a
    // live join to optionContracts, so a position whose contract had
    // expired/been pruned would silently drop out of the held-set and a
    // second position on the same name could open. underlying is now
    // denormalized onto the order at open time, so this must still refuse.
    const c = ranked();
    contract(c.occ_symbol, 'NVDA');
    openOrder({ occSymbol: c.occ_symbol, quantity: 1, entryPriceE4: toE4(1.5), source: 'model' });
    marketDb.delete(optionContracts).run(); // the contract is gone; the open order remains

    const result = await runAutoEntry('2026-08-18', rankFn([c]));

    expect(result.openedOccSymbol).toBeNull();
    expect(paperDb.select().from(paperOrders).all()).toHaveLength(1);
  });

  it('skips a candidate whose exit target could not be computed rather than opening it unmanaged', async () => {
    const noTarget = ranked({
      suggested_target_exit_price: null,
      suggested_stop_loss_price: null,
      suggested_target_exit_date: null,
    });
    contract(noTarget.occ_symbol, 'NVDA');

    const result = await runAutoEntry('2026-08-18', rankFn([noTarget]));

    expect(result.openedOccSymbol).toBeNull();
    expect(paperDb.select().from(paperOrders).all()).toHaveLength(0);
  });

  it('records a skip reason rather than throwing when the quant sidecar is unreachable', async () => {
    // No injected rankDayFn — exercises the real one against the suite's
    // pinned-unreachable QUANT_URL (see vitest.config.ts).
    const result = await runAutoEntry('2026-08-18');
    expect(result.openedOccSymbol).toBeNull();
    expect(result.skippedReason).toBeTruthy();
  });
});
