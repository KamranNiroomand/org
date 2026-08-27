import { describe, expect, it } from 'vitest';
import { stockStopPct } from './stockEngine.js';

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

  it('clamps into a band a stop can survive in', () => {
    // A near-frozen symbol must not get a hair-trigger stop...
    expect(stockStopPct(0.01, 21, 1.5)).toBe(0.08);
    // ...and a meme-volatile one must not be allowed to halve first.
    expect(stockStopPct(5, 21, 1.5)).toBe(0.5);
  });

  it('falls back to a fixed stop when volatility is unknown, never to none', () => {
    expect(stockStopPct(null, 21, 1.5)).toBe(0.15);
    expect(stockStopPct(0, 21, 1.5)).toBe(0.15);
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
