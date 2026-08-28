import { describe, expect, it } from 'vitest';
import { priceDistress, regimeEntryCap, stockStopPct, stockTargetPct, thesisExitAction } from './stockEngine.js';

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

describe('priceDistress', () => {
  const base = { entryPriceE4: 100_0000, stopPriceE4: 80_0000 }; // 20% stop budget

  it('flags a position that has spent most of its stop budget', () => {
    // 65%+ consumed: price below entry - 0.65 * budget = 87.0
    expect(priceDistress({ ...base, priceE4: 86_0000, dayChangePercent: -1 })).toBe('near_stop');
  });

  it('holds quietly while the budget is mostly intact', () => {
    expect(priceDistress({ ...base, priceE4: 95_0000, dayChangePercent: -1 })).toBeNull();
  });

  it('flags a single-session drop that eats 40% of the budget', () => {
    // budget 20% of entry; -9% day is past the 40% threshold
    expect(priceDistress({ ...base, priceE4: 92_0000, dayChangePercent: -9 })).toBe('sharp_day_drop');
  });

  it('scales the day-drop threshold to the position, not a flat percent', () => {
    // A 30%-budget position shrugs off the same -8% day
    expect(
      priceDistress({ entryPriceE4: 100_0000, stopPriceE4: 70_0000, priceE4: 92_0000, dayChangePercent: -8 }),
    ).toBeNull();
  });

  it('never fires without a stop, or once ratcheted to breakeven', () => {
    expect(priceDistress({ ...base, stopPriceE4: null, priceE4: 50_0000, dayChangePercent: -20 })).toBeNull();
    expect(
      priceDistress({ entryPriceE4: 100_0000, stopPriceE4: 100_0000, priceE4: 90_0000, dayChangePercent: -10 }),
    ).toBeNull();
  });

  it('a gain never reads as near_stop', () => {
    expect(priceDistress({ ...base, priceE4: 120_0000, dayChangePercent: 3 })).toBeNull();
  });
});

describe('regimeEntryCap', () => {
  it('spends the full budget in a calm uptrend and when the regime is unknown', () => {
    expect(regimeEntryCap(3, 'risk_on')).toBe(3);
    expect(regimeEntryCap(3, 'unknown')).toBe(3);
  });

  it('throttles mixed and toxic regimes without ever reaching zero', () => {
    expect(regimeEntryCap(3, 'neutral')).toBe(2);
    expect(regimeEntryCap(3, 'risk_off')).toBe(1);
    expect(regimeEntryCap(1, 'neutral')).toBe(1);
  });
});
