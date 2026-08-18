import { describe, expect, it } from 'vitest';
import {
  breakEvenE4,
  daysToExpiry,
  formatOccSymbol,
  fromE4,
  intrinsicValueE4,
  isInTheMoney,
  logMoneyness,
  parseOccSymbol,
  percentToBreakEven,
  standardizedMoneyness,
  toE4,
  toPolygonSymbol,
  yearsToExpiry,
  type OptionContract,
} from './options.js';

/**
 * Fixtures are real rows from an NVDA chain snapshot taken 2026-08-17 with the
 * underlying at $225.05 and the 2026-08-19 expiry two days out. Using real
 * quotes rather than invented ones keeps the tests honest about the shapes
 * this code actually meets — including the broken ones.
 */
const SPOT_E4 = toE4(225.05);

const NVDA_227_50: OptionContract = {
  underlying: 'NVDA',
  expiry: '2026-08-19',
  type: 'call',
  strikeE4: toE4(227.5),
};

const NVDA_207_50: OptionContract = {
  underlying: 'NVDA',
  expiry: '2026-08-19',
  type: 'call',
  strikeE4: toE4(207.5),
};

describe('E4 conversion', () => {
  it('round-trips prices that cents would lose', () => {
    // A $0.01/$0.02 market has a half-cent mid. In cents this is the
    // difference between a 0%-wide and a 100%-wide spread.
    expect(fromE4(toE4(0.015))).toBe(0.015);
    expect(toE4(1.12)).toBe(11200);
    expect(toE4(227.5)).toBe(2275000);
  });

  it('rounds rather than truncating, so derived mids stay stable', () => {
    expect(toE4((1.1 + 1.14) / 2)).toBe(11200);
  });
});

describe('parseOccSymbol', () => {
  it('parses the canonical space-padded form', () => {
    expect(parseOccSymbol('NVDA  260819C00227500')).toEqual(NVDA_227_50);
  });

  it('parses the unpadded and Polygon-prefixed forms identically', () => {
    expect(parseOccSymbol('NVDA260819C00227500')).toEqual(NVDA_227_50);
    expect(parseOccSymbol('O:NVDA260819C00227500')).toEqual(NVDA_227_50);
  });

  it('handles a six-character root with no separating space', () => {
    const c = parseOccSymbol('GOOGL 260819P00150000');
    expect(c?.underlying).toBe('GOOGL');
    expect(c?.type).toBe('put');
    expect(c?.strikeE4).toBe(toE4(150));
  });

  it('handles roots containing dots and digits', () => {
    expect(parseOccSymbol('BRK.B 260819C00500000')?.underlying).toBe('BRK.B');
    expect(parseOccSymbol('RIOT  260819C00015000')?.underlying).toBe('RIOT');
  });

  it('returns null on malformed input rather than throwing', () => {
    // A vendor row that fails to parse should be skipped and counted, not
    // crash a capture of a hundred thousand contracts.
    expect(parseOccSymbol('')).toBeNull();
    expect(parseOccSymbol('NVDA')).toBeNull();
    expect(parseOccSymbol('NVDA  260819X00227500')).toBeNull();
    expect(parseOccSymbol('NVDA  261319C00227500')).toBeNull(); // month 13
    expect(parseOccSymbol('TOOLONG260819C00227500')).toBeNull(); // 7-char root
    expect(parseOccSymbol('NVDA  260819C0022750')).toBeNull(); // 7-digit strike
  });

  it('round-trips through format', () => {
    const symbol = 'NVDA  260819C00227500';
    expect(formatOccSymbol(parseOccSymbol(symbol)!)).toBe(symbol);
  });
});

describe('formatOccSymbol', () => {
  it('pads the root to six columns', () => {
    expect(formatOccSymbol(NVDA_227_50)).toBe('NVDA  260819C00227500');
    expect(formatOccSymbol({ ...NVDA_227_50, underlying: 'F' })).toBe('F     260819C00227500');
  });

  it('emits Polygon symbols without padding', () => {
    expect(toPolygonSymbol(NVDA_227_50)).toBe('O:NVDA260819C00227500');
  });

  it('refuses a strike finer than OCC can encode', () => {
    // Truncating here would silently change contract identity, so it throws.
    expect(() => formatOccSymbol({ ...NVDA_227_50, strikeE4: 2275001 })).toThrow(/no OCC encoding/);
  });

  it('rejects a malformed expiry', () => {
    expect(() => formatOccSymbol({ ...NVDA_227_50, expiry: '19 Aug 2026' })).toThrow(/YYYY-MM-DD/);
  });
});

describe('intrinsic value', () => {
  it('is zero for an out-of-the-money call', () => {
    expect(intrinsicValueE4(NVDA_227_50, SPOT_E4)).toBe(0);
    expect(isInTheMoney(NVDA_227_50, SPOT_E4)).toBe(false);
  });

  it('detects a bid below intrinsic — the signature of a stale quote', () => {
    // The real $207.50 row quoted $15.05 / $18.35 against $17.55 of intrinsic
    // value. A bid beneath intrinsic is not an arbitrage, it is a quote nobody
    // is maintaining, and the liquidity gate has to reject rows like it.
    const intrinsic = intrinsicValueE4(NVDA_207_50, SPOT_E4);
    expect(fromE4(intrinsic)).toBeCloseTo(17.55, 10);
    expect(toE4(15.05)).toBeLessThan(intrinsic);
    expect(isInTheMoney(NVDA_207_50, SPOT_E4)).toBe(true);
  });

  it('mirrors for puts', () => {
    const put: OptionContract = { ...NVDA_227_50, type: 'put' };
    expect(fromE4(intrinsicValueE4(put, SPOT_E4))).toBeCloseTo(2.45, 10);
  });
});

describe('break-even', () => {
  it('reproduces the broker figures exactly', () => {
    // Chain showed BE $228.62 on a $1.12 mid, and $230.54 on a $0.54 mid.
    expect(fromE4(breakEvenE4(NVDA_227_50, toE4(1.12)))).toBeCloseTo(228.62, 10);

    const nvda230: OptionContract = { ...NVDA_227_50, strikeE4: toE4(230) };
    expect(fromE4(breakEvenE4(nvda230, toE4(0.54)))).toBeCloseTo(230.54, 10);
  });

  it('subtracts the premium for puts', () => {
    const put: OptionContract = { ...NVDA_227_50, type: 'put' };
    expect(fromE4(breakEvenE4(put, toE4(1.12)))).toBeCloseTo(226.38, 10);
  });

  it('measures the distance to break-even as a percentage of spot', () => {
    // Broker displayed 1.60%; it rounds and may use a slightly different spot,
    // so this asserts our own arithmetic and only sanity-checks the ballpark.
    const pct = percentToBreakEven(NVDA_227_50, toE4(1.12), SPOT_E4);
    expect(pct).toBeCloseTo(1.586, 3);
    expect(pct).toBeGreaterThan(1.5);
    expect(pct).toBeLessThan(1.7);
  });
});

describe('expiry arithmetic', () => {
  it('counts calendar days', () => {
    expect(daysToExpiry('2026-08-19', '2026-08-17')).toBe(2);
    expect(daysToExpiry('2026-08-17', '2026-08-17')).toBe(0);
    expect(daysToExpiry('2026-08-16', '2026-08-17')).toBe(-1);
  });

  it('accepts an instant for asOf and ignores its time of day', () => {
    // Both of these are 2026-08-17 in UTC terms; neither may shift the count.
    expect(daysToExpiry('2026-08-19', '2026-08-17T23:59:00Z')).toBe(2);
    expect(daysToExpiry('2026-08-19', '2026-08-17T00:00:01Z')).toBe(2);
  });

  it('does not shift across a daylight-saving boundary', () => {
    // US DST ends 2026-11-01. Reducing to UTC civil days keeps this exact.
    expect(daysToExpiry('2026-11-02', '2026-10-31')).toBe(2);
  });

  it('converts to years on a 365-day calendar basis', () => {
    expect(yearsToExpiry('2026-08-19', '2026-08-17')).toBeCloseTo(2 / 365, 12);
  });
});

describe('moneyness', () => {
  it('is signed and scale-free', () => {
    expect(logMoneyness(NVDA_227_50, SPOT_E4)).toBeCloseTo(Math.log(227.5 / 225.05), 10);
    expect(logMoneyness(NVDA_207_50, SPOT_E4)).toBeLessThan(0);
  });

  it('standardizes by the expected move', () => {
    const years = yearsToExpiry('2026-08-19', '2026-08-17');
    const z = standardizedMoneyness(NVDA_227_50, SPOT_E4, 0.316, years);
    // sigma*sqrt(T) = 0.316 * sqrt(2/365) = 2.34%, so two days of expected
    // move is ~$5.27. The strike sits $2.45 out, a little under half of that.
    expect(z).toBeCloseTo(0.463, 3);
  });

  it('returns null instead of zero when it is undefined', () => {
    // Zero would read as "exactly at the money", which is the opposite of
    // "unknown" — these rows must be excluded from features, not neutralized.
    expect(standardizedMoneyness(NVDA_227_50, SPOT_E4, 0.316, 0)).toBeNull();
    expect(standardizedMoneyness(NVDA_227_50, SPOT_E4, 0, 0.005)).toBeNull();
    expect(standardizedMoneyness(NVDA_227_50, SPOT_E4, NaN, 0.005)).toBeNull();
  });
});
