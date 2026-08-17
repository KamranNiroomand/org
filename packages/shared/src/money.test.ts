import { describe, expect, it } from 'vitest';
import {
  convertMoney,
  formatMoney,
  minorUnitDigits,
  money,
  parseMoney,
  splitMoney,
  sumMoney,
  toLatinDigits,
  toPersianDigits,
} from './money.js';

describe('parseMoney', () => {
  it('parses plain and decorated amounts', () => {
    expect(parseMoney('45.30', 'CAD')?.cents).toBe(4530);
    expect(parseMoney('$45.30', 'CAD')?.cents).toBe(4530);
    expect(parseMoney('  45.30 CAD ', 'CAD')?.cents).toBe(4530);
    expect(parseMoney('45', 'CAD')?.cents).toBe(4500);
    expect(parseMoney('.5', 'CAD')?.cents).toBe(50);
  });

  it('handles thousands separators', () => {
    expect(parseMoney('1,234.56', 'CAD')?.cents).toBe(123456);
    expect(parseMoney('1,234', 'CAD')?.cents).toBe(123400);
    expect(parseMoney('1.234.567', 'CAD')?.cents).toBe(123456700);
  });

  it('handles negatives, including accounting parentheses', () => {
    expect(parseMoney('-12.00', 'CAD')?.cents).toBe(-1200);
    expect(parseMoney('(12.00)', 'CAD')?.cents).toBe(-1200);
    expect(parseMoney('(-12.00)', 'CAD')?.cents).toBe(1200);
  });

  it('accepts Persian and Arabic-Indic digits', () => {
    expect(parseMoney('۴۵٫۳۰'.replace('٫', '.'), 'CAD')?.cents).toBe(4530);
    expect(parseMoney('۱۲۳', 'CAD')?.cents).toBe(12300);
  });

  it('respects zero-decimal currencies', () => {
    expect(minorUnitDigits('JPY')).toBe(0);
    expect(parseMoney('1234', 'JPY')?.cents).toBe(1234);
  });

  it('returns null on junk instead of throwing', () => {
    expect(parseMoney('', 'CAD')).toBeNull();
    expect(parseMoney('   ', 'CAD')).toBeNull();
    expect(parseMoney('abc', 'CAD')).toBeNull();
    expect(parseMoney('$', 'CAD')).toBeNull();
  });

  it('never loses a cent to float error', () => {
    // 0.1 + 0.2 territory — the reason money is integers here.
    expect(parseMoney('0.10', 'CAD')?.cents).toBe(10);
    expect(parseMoney('0.20', 'CAD')?.cents).toBe(20);
    expect(parseMoney('19.99', 'CAD')?.cents).toBe(1999);
    expect(parseMoney('1234567.89', 'CAD')?.cents).toBe(123456789);
  });
});

describe('formatMoney', () => {
  it('formats with and without a symbol', () => {
    expect(formatMoney(money(4530, 'CAD'))).toBe('$45.30');
    expect(formatMoney(money(4530, 'CAD'), { bare: true })).toBe('45.30');
  });

  it('shows an explicit sign when asked', () => {
    expect(formatMoney(money(4530, 'CAD'), { signed: true, bare: true })).toBe('+45.30');
    expect(formatMoney(money(-4530, 'CAD'), { signed: true, bare: true })).toBe('-45.30');
    expect(formatMoney(money(0, 'CAD'), { signed: true, bare: true })).toBe('0.00');
  });

  it('round-trips through parseMoney', () => {
    for (const cents of [0, 1, 99, 100, 4530, -4530, 123456789]) {
      const m = money(cents, 'CAD');
      expect(parseMoney(formatMoney(m, { bare: true }), 'CAD')?.cents).toBe(cents);
    }
  });
});

describe('sumMoney', () => {
  it('sums exactly over many values', () => {
    const items = Array.from({ length: 1000 }, () => money(1999, 'CAD'));
    expect(sumMoney(items, 'CAD').cents).toBe(1_999_000);
  });

  it('refuses to mix currencies', () => {
    expect(() => sumMoney([money(100, 'USD')], 'CAD')).toThrow(/convert first/);
  });
});

describe('splitMoney', () => {
  it('splits without losing cents', () => {
    const parts = splitMoney(money(1000, 'CAD'), 3);
    expect(parts.map((p) => p.cents)).toEqual([334, 333, 333]);
    expect(sumMoney(parts, 'CAD').cents).toBe(1000);
  });

  it('preserves the total for negatives too', () => {
    const parts = splitMoney(money(-1000, 'CAD'), 3);
    expect(sumMoney(parts, 'CAD').cents).toBe(-1000);
  });

  it('always sums back to the original', () => {
    for (let n = 1; n <= 12; n++) {
      for (const cents of [1, 7, 100, 4530, 99999]) {
        expect(sumMoney(splitMoney(money(cents, 'CAD'), n), 'CAD').cents).toBe(cents);
      }
    }
  });
});

describe('convertMoney', () => {
  it('applies a rate and rounds once', () => {
    expect(convertMoney(money(10000, 'USD'), 1.37, 'CAD').cents).toBe(13700);
  });

  it('rejects a nonsense rate', () => {
    expect(() => convertMoney(money(100, 'USD'), 0, 'CAD')).toThrow();
  });
});

describe('digit conversion', () => {
  it('converts both ways', () => {
    expect(toPersianDigits('1405')).toBe('۱۴۰۵');
    expect(toLatinDigits('۱۴۰۵')).toBe('1405');
    expect(toLatinDigits('١٤٠٥')).toBe('1405'); // Arabic-Indic
  });

  it('leaves non-digits alone', () => {
    expect(toPersianDigits('Mordad 26')).toBe('Mordad ۲۶');
  });
});
