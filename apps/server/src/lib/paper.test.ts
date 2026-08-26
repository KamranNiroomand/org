import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { formatOccSymbol, toE4 } from '@org/shared';
import { config } from '../config.js';
import { marketDb } from '../db/market/index.js';
import { runMarketMigrations } from '../db/market/migrate.js';
import { optionContracts, optionQuotes } from '../db/market/schema.js';
import { paperDb } from '../db/paper/index.js';
import { runPaperMigrations } from '../db/paper/migrate.js';
import { paperDecisionLog, paperEquity, paperExitRevisions, paperMarks, paperOrders } from '../db/paper/schema.js';
import { nowIso } from './util.js';
import {
  accountCapacity,
  decisionsForDay,
  logDecisions,
  closeOrder,
  computeDailyEquity,
  markOpenPositions,
  openOrder,
  reduceOrder,
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
  runPaperMigrations();
  paperDb.delete(paperMarks).run();
  paperDb.delete(paperEquity).run();
  paperDb.delete(paperExitRevisions).run();
  // Cleared like every other paper table. Without this the decision log
  // accumulates across files sharing one on-disk database — see the note
  // in vitest.config.ts — and a row this file wrote surfaces in another
  // file's assertions.
  paperDb.delete(paperDecisionLog).run();
  paperDb.delete(paperOrders).run();
  marketDb.delete(optionQuotes).run();
  marketDb.delete(optionContracts).run();
  seedContract();
});

describe('openOrder', () => {
  it('fills at the ask when a real quote exists', () => {
    seedQuote(new Date().toISOString().slice(0, 10), BID_E4, ASK_E4);
    const id = openOrder({ occSymbol: OCC, quantity: 2 });
    const order = paperDb.select().from(paperOrders).all().find((o) => o.id === id)!;
    expect(order.entryPriceE4).toBe(ASK_E4);
    expect(order.entryBasis).toBe('measured');
    expect(order.side).toBe('long');
    expect(order.status).toBe('open');
  });

  it('requires an explicit price before any quote exists', () => {
    expect(() => openOrder({ occSymbol: OCC, quantity: 1 })).toThrow(PaperError);
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    const order = paperDb.select().from(paperOrders).all().find((o) => o.id === id)!;
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

describe('reduceOrder', () => {
  it('splits the sold half into its own closed row and keeps the survivor whole', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 8, entryPriceE4: 10_000 });
    const sliceId = reduceOrder({ orderId: id, contracts: 4, exitPriceE4: 15_000 });

    const all = paperDb.select().from(paperOrders).all();
    const survivor = all.find((o) => o.id === id)!;
    const slice = all.find((o) => o.id === sliceId)!;

    expect(survivor.status).toBe('open');
    expect(survivor.quantity).toBe(4);
    expect(survivor.initialQuantity).toBe(8); // the durable already-scaled fact
    expect(slice.status).toBe('closed');
    expect(slice.quantity).toBe(4);
    expect(slice.entryPriceE4).toBe(10_000); // cost basis travels with the slice
    expect(slice.exitPriceE4).toBe(15_000);
    expect(slice.splitFrom).toBe(id);
  });

  it('keeps the account arithmetic exact across the split', () => {
    // 8 @ $1.00 = $800 out of a clean account. Selling 4 @ $1.50 banks
    // $600 back and a $200 realized gain; the surviving 4 remain deployed
    // at cost. Free cash must land on the same number a whole-position
    // close of half the size would produce — the split is invisible to
    // every sum.
    const before = accountCapacity().freeCashE4;
    const id = openOrder({ occSymbol: OCC, quantity: 8, entryPriceE4: 10_000 });
    reduceOrder({ orderId: id, contracts: 4, exitPriceE4: 15_000 });
    const after = accountCapacity().freeCashE4;
    // -800 (entry) + 600 (slice proceeds) = net -200 vs before, in dollars x multiplier.
    expect(before - after).toBe((8 * 10_000 - 4 * 15_000) * 100);
  });

  it('refuses a reduction that would close or overdraw the position', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 2, entryPriceE4: 10_000 });
    expect(() => reduceOrder({ orderId: id, contracts: 2, exitPriceE4: 15_000 })).toThrow(/use closeOrder/);
    expect(() => reduceOrder({ orderId: id, contracts: 3, exitPriceE4: 15_000 })).toThrow(PaperError);
    expect(() => reduceOrder({ orderId: id, contracts: 0, exitPriceE4: 15_000 })).toThrow(PaperError);
  });
});

describe('closeOrder', () => {
  it('fills at the bid when a real quote exists', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    seedQuote(new Date().toISOString().slice(0, 10), BID_E4, ASK_E4);
    closeOrder({ orderId: id });
    const order = paperDb.select().from(paperOrders).all().find((o) => o.id === id)!;
    expect(order.exitPriceE4).toBe(BID_E4);
    expect(order.exitBasis).toBe('measured');
    expect(order.status).toBe('closed');
  });

  it('accepts a zero bid — worthless at expiry is a legitimate exit', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    closeOrder({ orderId: id, exitPriceE4: 0 });
    const order = paperDb.select().from(paperOrders).all().find((o) => o.id === id)!;
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

    const mark = paperDb.select().from(paperMarks).all().find((m) => m.orderId === id)!;
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
    const mark = paperDb.select().from(paperMarks).all().find((m) => m.orderId === id)!;
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
    const marks = paperDb.select().from(paperMarks).all().filter((m) => m.orderId === id);
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
    const row = paperDb.select().from(paperEquity).all().find((e) => e.day === today)!;

    const realizedPl = (BID_E4 - ASK_E4) * 2 * MULTIPLIER;
    const mark = paperDb.select().from(paperMarks).all().find((m) => m.orderId === openId)!;
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
    const row1 = paperDb.select().from(paperEquity).all().find((e) => e.day === day1)!;
    expect(row1.dayReturnPct).toBeNull();

    markOpenPositions(day2);
    computeDailyEquity(day2);
    const row2 = paperDb.select().from(paperEquity).all().find((e) => e.day === day2)!;
    expect(row2.dayReturnPct).not.toBeNull();
  });

  it('cumulative return is measured against the starting balance, not the prior day', () => {
    const today = new Date().toISOString().slice(0, 10);
    seedQuote(today, BID_E4, ASK_E4);
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    markOpenPositions(today);
    computeDailyEquity(today);
    const row = paperDb.select().from(paperEquity).all().find((e) => e.day === today)!;

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
    const rows = paperDb.select().from(paperEquity).all().filter((e) => e.day === today);
    expect(rows).toHaveLength(1);
  });
});

describe('logDecisions', () => {
  it('never throws, so a broken log cannot take down the run it describes', () => {
    // A decision log exists to make a failed or surprising run explicable.
    // A logger that turns a partial failure into a total one destroys
    // exactly the evidence it was added to keep, so it reports failure by
    // return value and the caller carries on.
    const bad = [{ day: null, occSymbol: 'X', decision: 'opened', reason: 'r' }] as unknown as Parameters<
      typeof logDecisions
    >[0];

    expect(() => logDecisions(bad)).not.toThrow();
    expect(logDecisions(bad)).toBe(false);
  });

  it('is a no-op for an empty batch rather than an empty insert', () => {
    expect(logDecisions([])).toBe(true);
  });

  it('writes a batch far larger than SQLite’s parameter ceiling', () => {
    // 8 bound columns against a 32,766-parameter cap means a single
    // INSERT throws at 4,096 rows — and the catch would then lose the
    // *whole* run's decisions rather than some of them, hardest to notice
    // on exactly the biggest day. Chunked, so the size stops mattering.
    // A day no other test uses. `operatingTradingDay()` can resolve to
    // today's real date, so writing 5,000 rows onto it would surface in
    // the exit-engine file's assertions.
    const rows = Array.from({ length: 5_000 }, (_, i) => ({
      day: '1999-01-01',
      occSymbol: `S${i}`,
      decision: 'rejected' as const,
      reason: 'ev_below_bar',
    }));

    expect(logDecisions(rows)).toBe(true);
    expect(decisionsForDay('1999-01-01')).toHaveLength(5_000);
  });

  it('round-trips a decision with its detail intact', () => {
    logDecisions([
      { day: '2026-08-24', occSymbol: OCC, underlying: 'NVDA', decision: 'rejected', reason: 'ev_below_bar', detail: { ev_per_risk: 0.01, bar: 0.05 } },
    ]);

    const [row] = decisionsForDay('2026-08-24');
    expect(row?.reason).toBe('ev_below_bar');
    expect((row?.detail as Record<string, unknown>).bar).toBe(0.05);
    // Another day's decisions are not returned — the log is read per day.
    expect(decisionsForDay('2026-08-25')).toEqual([]);
  });
});

describe('accountCapacity', () => {
  it('reports the full starting balance when nothing has ever been traded', () => {
    const cap = accountCapacity();
    expect(cap.freeCashE4).toBe(config.market.paperStartingBalanceE4);
    expect(cap.openPositionCount).toBe(0);
    expect(cap.heldUnderlyings).toEqual([]);
  });

  it('subtracts an open position’s entry cost and reports its underlying as held', () => {
    openOrder({ occSymbol: OCC, quantity: 2, entryPriceE4: ASK_E4 });
    const cap = accountCapacity();
    expect(cap.freeCashE4).toBe(config.market.paperStartingBalanceE4 - ASK_E4 * 2 * MULTIPLIER);
    expect(cap.openPositionCount).toBe(1);
    expect(cap.heldUnderlyings).toEqual(['NVDA']);
  });

  it('reflects a realized loss instead of pretending the capital came back', () => {
    // The bug this pins: counting only *open* positions reported the full
    // starting balance the moment a losing trade closed, so auto-entry
    // would keep sizing against money the account had already lost.
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    closeOrder({ orderId: id, exitPriceE4: 0 }); // total loss on the premium

    const cap = accountCapacity();
    expect(cap.openPositionCount).toBe(0);
    expect(cap.heldUnderlyings).toEqual([]);
    expect(cap.freeCashE4).toBe(config.market.paperStartingBalanceE4 - ASK_E4 * MULTIPLIER);
  });

  it('still reports an underlying held when the order’s own column is null', () => {
    // The 2026-08-24 duplicate, pinned. `heldUnderlyings` was built with
    // `if (o.underlying)`, so a pre-migration row with a null column
    // vanished from the held set and auto-entry read that as "not held" —
    // then opened a second position on a name it was already in.
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    paperDb.update(paperOrders).set({ underlying: null }).where(eq(paperOrders.id, id)).run();

    const cap = accountCapacity();

    expect(cap.openPositionCount).toBe(1);
    expect(cap.heldUnderlyings).toEqual(['NVDA']);
  });

  it('falls back to the OCC root when both the column and the contract are gone', () => {
    // A pruned or expired contract must not resurrect the same hole: an
    // imperfect answer (the root cannot spell a dotted name like BRK.B)
    // still beats claiming no exposure exists.
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    paperDb.update(paperOrders).set({ underlying: null }).where(eq(paperOrders.id, id)).run();
    marketDb.delete(optionContracts).where(eq(optionContracts.occSymbol, OCC)).run();

    const cap = accountCapacity();

    expect(cap.heldUnderlyings).toEqual(['NVDA']);
  });

  it('agrees with computeDailyEquity’s own cash figure', () => {
    // Two definitions of "cash" that disagree would mean the capital
    // constraint and the equity curve describe different accounts.
    const closed = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    closeOrder({ orderId: closed, exitPriceE4: BID_E4 });
    openOrder({ occSymbol: OCC, quantity: 3, entryPriceE4: ASK_E4 });

    // Today: `openOrder` stamps `openedAt` with the current instant, and
    // computeDailyEquity only counts orders opened on or before its day.
    const day = new Date().toISOString().slice(0, 10);
    seedQuote(day, BID_E4, ASK_E4);
    markOpenPositions(day);
    computeDailyEquity(day);

    const equity = paperDb.select().from(paperEquity).all().find((e) => e.day === day)!;
    expect(accountCapacity().freeCashE4).toBe(equity.cashE4);
  });

  it('still values an open position whose contract has been pruned from the corpus', () => {
    // Regression: this used to re-look-up the multiplier in
    // `optionContracts` and throw `PaperError` when the row was gone,
    // taking the whole auto-entry run down with it. The multiplier is
    // denormalized onto the order at open time for exactly this case.
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    marketDb.delete(optionContracts).run();

    const cap = accountCapacity();
    expect(cap.freeCashE4).toBe(config.market.paperStartingBalanceE4 - ASK_E4 * MULTIPLIER);
    expect(cap.openPositionCount).toBe(1);
    expect(cap.heldUnderlyings).toEqual(['NVDA']);
  });

  it('never reports negative cash', () => {
    openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: config.market.paperStartingBalanceE4 });
    expect(accountCapacity().freeCashE4).toBe(0);
  });
});

describe('openOrder exit plan', () => {
  it('writes the order and its exit plan in one insert', () => {
    // The bug this closes: the plan used to be a second UPDATE right after
    // the insert, so a crash between them left a `source: 'model'` order
    // with no target — which `managedOpenOrders()` filters out forever,
    // stranding an open position outside the exit engine's view.
    const id = openOrder({
      occSymbol: OCC,
      quantity: 1,
      entryPriceE4: ASK_E4,
      source: 'model',
      entryEv: 12.5,
      exitPlan: {
        targetExitPriceE4: toE4(2.0),
        stopLossPriceE4: toE4(0.5),
        targetExitDate: '2026-09-01',
      },
    });

    const order = paperDb.select().from(paperOrders).all().find((o) => o.id === id)!;
    expect(order.targetExitPriceE4).toBe(toE4(2.0));
    expect(order.stopLossPriceE4).toBe(toE4(0.5));
    expect(order.targetExitDate).toBe('2026-09-01');
    expect(order.entryEv).toBe(12.5);
    expect(order.exitUpdatedAt).not.toBeNull();
  });

  it('leaves every exit-plan field null for a manual order', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4 });
    const order = paperDb.select().from(paperOrders).all().find((o) => o.id === id)!;
    expect(order.targetExitPriceE4).toBeNull();
    expect(order.stopLossPriceE4).toBeNull();
    expect(order.targetExitDate).toBeNull();
    expect(order.entryEv).toBeNull();
    expect(order.exitUpdatedAt).toBeNull();
  });
});

describe('paperDb.transaction', () => {
  it('rolls every statement back when the callback throws', () => {
    // The guarantee exitEngine.ts relies on when it writes a revision row
    // and the order's moved target together. Pinned here because that call
    // site cannot force a mid-transaction failure through its own
    // interface — both of its statements bind the same values, so anything
    // bad enough to fail the second fails the first.
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4, source: 'model' });

    expect(() =>
      paperDb.transaction((tx) => {
        tx.insert(paperExitRevisions)
          .values({
            orderId: id,
            revisedAt: nowIso(),
            oldTargetExitPriceE4: null,
            newTargetExitPriceE4: toE4(2.0),
            oldTargetExitDate: null,
            newTargetExitDate: '2026-09-01',
            reason: 'should not survive',
            triggeredBy: 'llm',
          })
          .run();
        throw new Error('second statement failed');
      }),
    ).toThrow('second statement failed');

    // The insert that had already run is gone.
    expect(paperDb.select().from(paperExitRevisions).all()).toHaveLength(0);
  });

  it('commits every statement when the callback returns', () => {
    const id = openOrder({ occSymbol: OCC, quantity: 1, entryPriceE4: ASK_E4, source: 'model' });

    paperDb.transaction((tx) => {
      tx.insert(paperExitRevisions)
        .values({
          orderId: id,
          revisedAt: nowIso(),
          oldTargetExitPriceE4: null,
          newTargetExitPriceE4: toE4(2.0),
          oldTargetExitDate: null,
          newTargetExitDate: '2026-09-01',
          reason: 'kept',
          triggeredBy: 'llm',
        })
        .run();
      tx.update(paperOrders).set({ targetExitPriceE4: toE4(2.0) }).where(eq(paperOrders.id, id)).run();
    });

    expect(paperDb.select().from(paperExitRevisions).all()).toHaveLength(1);
    expect(paperDb.select().from(paperOrders).all().find((o) => o.id === id)!.targetExitPriceE4).toBe(toE4(2.0));
  });
});
