import { describe, expect, it } from 'vitest';
import { stockStopPct, stockTargetPct, thesisExitAction } from './stockEngine.js';

describe('stockStopPct', () => {
  it('scales the stop to the symbol’s own volatility', () => {
    // Same horizon, different names: the jumpy one gets more room.
    const calm = stockStopPct(0.15, 21, 1.5);
    const wild = stockStopPct(0.9, 21, 1.5);
    expect(wild).toBeGreaterThan(calm);
  });

  it('gives the long book a wider stop at the same volatility', () => {
    const short = stockStopPct(0.3, 21, 1.5);
    const long = stockStopPct(0.3, 126, 3);
    expect(long).toBeGreaterThan(short);
  });

  it('clamps into a band a stock position can survive in', () => {
    // A near-frozen symbol must not get a hair-trigger stop...
    expect(stockStopPct(0.01, 21, 1.5)).toBe(0.05);
    // ...and a violently volatile one must not be allowed to lose a
    // fifth of the position before the rule fires. 1.5 sigma of a
    // 145%-vol name over 21 days computes to 63%: correct arithmetic,
    // useless risk management on shares, where the whole notional is at
    // risk rather than an option's premium.
    expect(stockStopPct(1.45, 21, 1.5)).toBe(0.2);
    expect(stockStopPct(1.45, 126, 2, 0.3)).toBe(0.3);
  });

  it('falls back to a fixed stop when volatility is unknown, never to none', () => {
    expect(stockStopPct(null, 21, 1.5)).toBe(0.12);
    expect(stockStopPct(0, 21, 1.5)).toBe(0.12);
  });
});


describe('stockTargetPct', () => {
  it('is a multiple of the position’s own stop, so reward-to-risk is fixed', () => {
    expect(stockTargetPct(0.1, 'short')).toBeCloseTo(0.2);
    expect(stockTargetPct(0.1, 'long')).toBeCloseTo(0.25);
  });

  it('stays legible where a sigma extrapolation would not', () => {
    // The failure it replaces: 3 sigma of a 145%-vol name over 126 days
    // is a +308% objective, which put the breakeven ratchet's halfway
    // mark out of reach and quietly disabled it.
    const stop = stockStopPct(1.45, 126, 2, 0.3);
    expect(stockTargetPct(stop, 'long')).toBeLessThan(1);
  });
});

describe('instrument eligibility', () => {
  // The rules live inside runStockEntries' loop, so these pin the
  // *policy* the loop encodes rather than re-running the whole engine:
  // ETFs are eligible positions in both books, leveraged funds only in
  // the short one, and an unclassified symbol is eligible nowhere.
  const eligible = (book: 'short' | 'long', sector: string | null): string | null => {
    if (sector === null) return 'unclassified_symbol';
    if (book === 'long' && sector === 'ETF / leveraged') return 'leveraged_etf_in_long_book';
    return null;
  };

  it('holds plain ETFs in both books, alongside stocks', () => {
    for (const sector of ['ETF / broad', 'ETF / sector', 'ETF / commodity']) {
      expect(eligible('short', sector)).toBeNull();
      expect(eligible('long', sector)).toBeNull();
    }
    expect(eligible('long', 'Information Technology')).toBeNull();
  });

  it('keeps leveraged funds out of the six-month book but not the one-month one', () => {
    expect(eligible('short', 'ETF / leveraged')).toBeNull();
    expect(eligible('long', 'ETF / leveraged')).toBe('leveraged_etf_in_long_book');
  });

  it('refuses a symbol with no classification at all', () => {
    expect(eligible('short', null)).toBe('unclassified_symbol');
    expect(eligible('long', null)).toBe('unclassified_symbol');
  });
});

describe('thesisExitAction', () => {
  it('exits only on two consecutive broken verdicts', () => {
    expect(thesisExitAction(['broken', 'broken'])).toBe('exit');
  });

  it('a single broken read is unconfirmed, never an exit', () => {
    expect(thesisExitAction(['broken'])).toBe('unconfirmed');
    expect(thesisExitAction(['broken', 'intact'])).toBe('unconfirmed');
    expect(thesisExitAction(['broken', 'weakened'])).toBe('unconfirmed');
  });

  it('a broken read followed by recovery does not exit', () => {
    // The order is newest-first: today intact, yesterday broken — the
    // panel walked it back, and the position lives.
    expect(thesisExitAction(['intact', 'broken'])).toBe('none');
    expect(thesisExitAction(['weakened', 'broken'])).toBe('weakened');
  });

  it('weakened warns without exiting', () => {
    expect(thesisExitAction(['weakened', 'weakened'])).toBe('weakened');
  });

  it('no verdicts at all holds quietly — absence of review is not evidence', () => {
    expect(thesisExitAction([])).toBe('none');
    expect(thesisExitAction(['intact'])).toBe('none');
  });
});
