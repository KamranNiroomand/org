import { beforeEach, describe, expect, it } from 'vitest';
import { formatOccSymbol, toE4 } from '@org/shared';
import { config } from '../config.js';
import { marketDb } from '../db/market/index.js';
import { runMarketMigrations } from '../db/market/migrate.js';
import { optionContracts, optionQuotes, paperEquity, paperMarks, paperOrders } from '../db/market/schema.js';
import { nowIso } from './util.js';
import {
  closeOrder,
  computeDailyEquity,
  markOpenPositions,
  openOrder,
  PaperError,
  tradeReturnPct,
} from './paper.js';

/**
 * Prices are the real NVDA $227.50 call from the published chain fixture:
 * $1.10 bid / $1.14 ask, spot $225.05, 2026-08-19 expiry. Using a real
 * quoted spread rather than round numbers means the entry-at-ask,
 * exit-at-bid convention is being tested against an actual market, not a
 * number chosen to make the arithmetic convenient.
 */
const CONTRACT = {
  underlying: 'NVDA',
  expiry: '2026-08-19',
  type: 'call' as const,
  strikeE4: toE4(227.5),
};
const OCC = formatOccSymbol(CONTRACT);
const ASK_E4 = toE4(1.14);
const BID_E4 = toE4(1.1);
const MULTIPLIER = 100;

function seedContract() {
  marketDb
    .insert(optionContracts)
    .values({
      occSymbol: OCC,
      underlying: CONTRACT.underlying,
      expiry: CONTRACT.expiry,
      type: CONTRACT.type,
      strikeE4: CONTRACT.strikeE4,
      multiplier: MULTIPLIER,
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
    })
    .run();
}

function seedQuote(tradingDay: string, bidE4: number, askE4: number) {
  marketDb
    .insert(optionQuotes)
    .values({
      occSymbol: OCC,
      asOf: `${tradingDay}T21:00:00.000Z`,
      tradingDay,
      bidE4,
      askE4,
      lastE4: null,
      closeE4: null,
      volume: 100,
      openInterest: 500,
      underlyingE4: toE4(225.05),
      liquid: true,
      gateReasons: [],
    })
    .run();
}

beforeEach(() => {
  runMarketMigrations();
  marketDb.delete(paperMarks).run();
  marketDb.delete(paperEquity).run();
  marketDb.delete(paperOrders).run();
  marketDb.delete(optionQuotes).run();
  marketDb.delete(optionContracts).run();
  seedContract();
});

describe('openOrder', () => {
  it('fills at the ask when a real quote exists', () => {
    seedQuote(new Date().toISOString().slice(0, 10), BID_E4, ASK_E4);
    const id = openOrder({ occSymbol: OCC, quantity: 2 });
    const order = marketDb.select().from(paperOrders).all().find((o) => o.id === id)!;
    expect(order.entryPriceE4).toBe(ASK_E4);
    expect(order.entryBasis).toBe('measured');
    expect(order.side).toBe('long');
    expect(order.status).toBe('open');
  });

  it('requires an explicit price before any quote exists', () => {
    expect(() => openOrder({ occSymbol: OCC, quantity: 1 })).toThrow(PaperError);
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    const order = marketDb.select().from(paperOrders).all().find((o) => o.id === id)!;
    expect(order.entryBasis).toBe('modelled');
  });

  it('refuses a short position outright', () => {
    expect(() => openOrder({ occSymbol: OCC, quantity: 1, side: 'short', entryPriceE4: ASK_E4 })).toThrow(
      /not modelled/,
    );
  });

  it('rejects a non-positive quantity', () => {
    expect(() => openOrder({ occSymbol: OCC, quantity: 0, entryPriceE4: ASK_E4 })).toThrow(PaperError);
    expect(() => openOrder({ occSymbol: OCC, quantity: -1, entryPriceE4: ASK_E4 })).toThrow(PaperError);
    expect(() => openOrder({ occSymbol: OCC, quantity: 1.5, entryPriceE4: ASK_E4 })).toThrow(PaperError);
  });

  it('rejects an unknown contract', () => {
    expect(() => openOrder({ occSymbol: 'GHOST 260101C00001000', quantity: 1, entryPriceE4: 100 })).toThrow(
      /Unknown contract/,
    );
  });
});

describe('closeOrder', () => {
  it('fills at the bid when a real quote exists', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    seedQuote(new Date().toISOString().slice(0, 10), BID_E4, ASK_E4);
    closeOrder({ orderId: id });
    const order = marketDb.select().from(paperOrders).all().find((o) => o.id === id)!;
    expect(order.exitPriceE4).toBe(BID_E4);
    expect(order.exitBasis).toBe('measured');
    expect(order.status).toBe('closed');
  });

  it('accepts a zero bid — worthless at expiry is a legitimate exit', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    closeOrder({ orderId: id, exitPriceE4: 0 });
    const order = marketDb.select().from(paperOrders).all().find((o) => o.id === id)!;
    expect(order.exitPriceE4).toBe(0);
  });

  it('refuses to close an already-closed order', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    closeOrder({ orderId: id, exitPriceE4: BID_E4 });
    expect(() => closeOrder({ orderId: id, exitPriceE4: BID_E4 })).toThrow(/already closed/);
  });
});

describe('tradeReturnPct', () => {
  it('matches hand-computed return on the real spread', () => {
    // Enter at ask 1.14, exit at bid 1.10 — the realistic round-trip cost of
    // trading this exact contract, not a contrived loss.
    const pct = tradeReturnPct(ASK_E4, BID_E4);
    expect(pct).toBeCloseTo(((1.1 - 1.14) / 1.14) * 100, 6);
    expect(pct).toBeLessThan(0);
  });
});

describe('markOpenPositions', () => {
  it('marks at the bid and computes unrealized P&L correctly', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 3, entryPriceE4: ASK_E4 });
    const today = new Date().toISOString().slice(0, 10);
    seedQuote(today, BID_E4, ASK_E4);

    const result = markOpenPositions(today);
    expect(result.marked).toBe(1);
    expect(result.skipped).toHaveLength(0);

    const mark = marketDb.select().from(paperMarks).all().find((m) => m.orderId === id)!;
    expect(mark.markPriceE4).toBe(BID_E4);
    expect(mark.basis).toBe('measured');
    expect(mark.unrealizedPlE4).toBe((BID_E4 - ASK_E4) * 3 * MULTIPLIER);
  });

  it('falls back to close price and marks the basis modelled when no bid exists', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    const today = new Date().toISOString().slice(0, 10);
    marketDb
      .insert(optionQuotes)
      .values({
        occSymbol: OCC,
        asOf: `${today}T21:00:00.000Z`,
        tradingDay: today,
        bidE4: null,
        askE4: null,
        lastE4: null,
        closeE4: toE4(1.05),
        volume: 5,
        openInterest: 10,
        underlyingE4: toE4(225.05),
        liquid: false,
        gateReasons: ['no-quote'],
      })
      .run();

    markOpenPositions(today);
    const mark = marketDb.select().from(paperMarks).all().find((m) => m.orderId === id)!;
    expect(mark.markPriceE4).toBe(toE4(1.05));
    expect(mark.basis).toBe('modelled');
  });

  it('skips a position with no quote and no close, rather than fabricating a mark', () => {
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    const result = markOpenPositions(new Date().toISOString().slice(0, 10));
    expect(result.marked).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.occSymbol).toBe(OCC);
  });

  it('re-marking the same day updates rather than duplicates', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    const today = new Date().toISOString().slice(0, 10);
    seedQuote(today, BID_E4, ASK_E4);
    markOpenPositions(today);
    markOpenPositions(today);
    const marks = marketDb.select().from(paperMarks).all().filter((m) => m.orderId === id);
    expect(marks).toHaveLength(1);
  });
});

describe('computeDailyEquity', () => {
  it('satisfies startingBalance + realizedPl + unrealizedPl == totalEquity', () => {
    const today = new Date().toISOString().slice(0, 10);
    seedQuote(today, BID_E4, ASK_E4);

    // One closed trade (realized loss on the real spread) and one still open.
    const closedId = openOrder({ occSymbol: OCC, quantity: 2, entryPriceE4: ASK_E4 });
    closeOrder({ orderId: closedId, exitPriceE4: BID_E4 });

    const openId = openOrder({ occSymbol: OCC, quantity: 5, entryPriceE4: ASK_E4 });
    markOpenPositions(today);

    computeDailyEquity(today);
    const row = marketDb.select().from(paperEquity).all().find((e) => e.day === today)!;

    const realizedPl = (BID_E4 - ASK_E4) * 2 * MULTIPLIER;
    const mark = marketDb.select().from(paperMarks).all().find((m) => m.orderId === openId)!;
    const unrealizedPl = mark.unrealizedPlE4;

    expect(row.realizedPlToDateE4).toBe(realizedPl);
    expect(row.totalEquityE4).toBe(config.market.paperStartingBalanceE4 + realizedPl + unrealizedPl);
  });

  it('reports null day-return on the first day and a real one on the second', () => {
    const day1 = '2026-08-17';
    const day2 = '2026-08-18';
    seedQuote(day1, BID_E4, ASK_E4);
    seedQuote(day2, BID_E4, ASK_E4);

    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    markOpenPositions(day1);
    computeDailyEquity(day1);
    const row1 = marketDb.select().from(paperEquity).all().find((e) => e.day === day1)!;
    expect(row1.dayReturnPct).toBeNull();

    markOpenPositions(day2);
    computeDailyEquity(day2);
    const row2 = marketDb.select().from(paperEquity).all().find((e) => e.day === day2)!;
    expect(row2.dayReturnPct).not.toBeNull();
  });

  it('cumulative return is measured against the starting balance, not the prior day', () => {
    const today = new Date().toISOString().slice(0, 10);
    seedQuote(today, BID_E4, ASK_E4);
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    markOpenPositions(today);
    computeDailyEquity(today);
    const row = marketDb.select().from(paperEquity).all().find((e) => e.day === today)!;

    const expectedPct =
      ((row.totalEquityE4 - config.market.paperStartingBalanceE4) / config.market.paperStartingBalanceE4) * 100;
    expect(row.cumulativeReturnPct).toBeCloseTo(expectedPct, 8);
  });

  it('recomputing the same day updates in place rather than duplicating', () => {
    const today = new Date().toISOString().slice(0, 10);
    seedQuote(today, BID_E4, ASK_E4);
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    markOpenPositions(today);
    computeDailyEquity(today);
    computeDailyEquity(today);
    const rows = marketDb.select().from(paperEquity).all().filter((e) => e.day === today);
    expect(rows).toHaveLength(1);
  });
});
