/**
 * Money is stored and passed around as **integer minor units** (cents), never
 * as a float. `$45.30` is `4530`. Floats silently lose cents when summed over a
 * few hundred transactions, and a budget that disagrees with its own ledger by
 * a penny is worse than useless — you can't tell a rounding artifact from a
 * real bug.
 *
 * Conversion to a human-readable string happens once, at the edge.
 */

export type CurrencyCode = string;

/** An amount in minor units, tagged with its currency. */
export interface Money {
  /** Integer minor units. Negative means money out. */
  readonly cents: number;
  readonly currency: CurrencyCode;
}

/** Number of decimal places a currency uses. CAD/USD → 2, JPY → 0. */
export function minorUnitDigits(currency: CurrencyCode): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function money(cents: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(cents)) {
    throw new TypeError(`Money.cents must be an integer, got ${cents}`);
  }
  return { cents, currency };
}

/**
 * Parses user input into minor units. Accepts `"45.30"`, `"$45.30"`,
 * `"1,234.56"`, `"-12"`, `"(12.00)"` (accounting negative), and Persian and
 * Arabic-Indic digits.
 *
 * Returns `null` rather than throwing, because this runs on every keystroke of
 * the quick-add bar and a half-typed amount is not an error.
 */
export function parseMoney(input: string, currency: CurrencyCode): Money | null {
  if (typeof input !== 'string') return null;

  let s = toLatinDigits(input).trim();
  if (s === '') return null;

  // Accounting notation: (12.00) means -12.00
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  // Strip currency symbols, codes, and spaces; keep digits, separators, sign.
  s = s.replace(/[^\d.,+-]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  // Disambiguate thousands separators from the decimal mark. The last
  // separator wins if it leaves 1-2 trailing digits; otherwise all separators
  // are thousands groupings ("1,234" and "1.234" are both 1234).
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  const lastSep = Math.max(lastComma, lastDot);

  let whole: string;
  let frac: string;
  if (lastSep === -1) {
    whole = s;
    frac = '';
  } else {
    const tail = s.slice(lastSep + 1);
    if (/^\d{1,2}$/.test(tail) && /^[\d.,]*$/.test(s.slice(0, lastSep))) {
      whole = s.slice(0, lastSep).replace(/[.,]/g, '');
      frac = tail;
    } else {
      whole = s.replace(/[.,]/g, '');
      frac = '';
    }
  }

  if (whole === '' && frac === '') return null;
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;

  const digits = minorUnitDigits(currency);
  const scale = 10 ** digits;
  const fracPadded = frac.padEnd(digits, '0').slice(0, digits);

  const wholePart = whole === '' ? 0 : Number(whole);
  const fracPart = fracPadded === '' ? 0 : Number(fracPadded);
  if (!Number.isFinite(wholePart) || !Number.isFinite(fracPart)) return null;

  const cents = Math.round(wholePart * scale) + fracPart;
  return money(negative ? -cents : cents, currency);
}

export interface FormatMoneyOptions {
  /** Omit the currency symbol entirely. */
  bare?: boolean;
  /** Always show a leading + on positive amounts. */
  signed?: boolean;
  /** Render digits in Persian numerals. */
  persianDigits?: boolean;
  /** Locale override. Defaults to en-CA. */
  locale?: string;
}

export function formatMoney(m: Money, opts: FormatMoneyOptions = {}): string {
  const { bare = false, signed = false, persianDigits = false, locale = 'en-CA' } = opts;
  const digits = minorUnitDigits(m.currency);
  const value = m.cents / 10 ** digits;

  const formatter = new Intl.NumberFormat(locale, {
    style: bare ? 'decimal' : 'currency',
    currency: bare ? undefined : m.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: signed ? 'exceptZero' : 'auto',
  });

  const out = formatter.format(value);
  return persianDigits ? toPersianDigits(out) : out;
}

/** Sums amounts. Throws on mixed currencies — that's always a bug upstream. */
export function sumMoney(amounts: readonly Money[], currency: CurrencyCode): Money {
  let total = 0;
  for (const a of amounts) {
    if (a.currency !== currency) {
      throw new TypeError(
        `Cannot sum ${a.currency} into a ${currency} total — convert first`,
      );
    }
    total += a.cents;
  }
  return money(total, currency);
}

/**
 * Splits an amount into `n` parts that sum back to exactly the original.
 * Remainder cents are distributed one each to the earliest parts, so
 * `1000 / 3` becomes `[334, 333, 333]` rather than three lossy `333`s.
 */
export function splitMoney(m: Money, n: number): Money[] {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`Cannot split into ${n} parts`);
  }
  const sign = m.cents < 0 ? -1 : 1;
  const abs = Math.abs(m.cents);
  const base = Math.floor(abs / n);
  const remainder = abs - base * n;

  return Array.from({ length: n }, (_, i) =>
    money(sign * (base + (i < remainder ? 1 : 0)), m.currency),
  );
}

/** Applies an FX rate, rounding once at the end. */
export function convertMoney(m: Money, rate: number, to: CurrencyCode): Money {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`Invalid FX rate: ${rate}`);
  }
  const fromDigits = minorUnitDigits(m.currency);
  const toDigits = minorUnitDigits(to);
  const major = (m.cents / 10 ** fromDigits) * rate;
  return money(Math.round(major * 10 ** toDigits), to);
}

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;
const ARABIC_INDIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;

/** `1405` → `۱۴۰۵`. Non-digit characters pass through untouched. */
export function toPersianDigits(s: string): string {
  return s.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]!);
}

/** Normalizes Persian and Arabic-Indic digits back to ASCII for parsing. */
export function toLatinDigits(s: string): string {
  return s.replace(/[۰-۹٠-٩]/g, (ch) => {
    const p = PERSIAN_DIGITS.indexOf(ch as (typeof PERSIAN_DIGITS)[number]);
    if (p !== -1) return String(p);
    const a = ARABIC_INDIC_DIGITS.indexOf(ch as (typeof ARABIC_INDIC_DIGITS)[number]);
    return a !== -1 ? String(a) : ch;
  });
}
