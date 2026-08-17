/**
 * Option contracts: identity, money, and moneyness.
 *
 * Two conventions apply throughout and are worth stating once.
 *
 * **Money is integer ten-thousandths of a dollar** (`E4`), not the cents used
 * elsewhere in this repo. `$1.12` is `11200`. Cents are one digit too coarse
 * here: a contract quoted `$1.10 / $1.14` has a mid of `$1.12`, but one quoted
 * `$0.01 / $0.02` has a mid of `$0.015`, and rounding that to a cent turns a
 * 50%-wide spread into either 0% or 100%. Strikes use the same unit as prices
 * — one scale for all option money is worth more than a tighter fit per field.
 *
 * **Expiries are civil days** (`YYYY-MM-DD`), matching the repo's rule that a
 * date with no meaningful time of day is never stored as an instant.
 */

/** Ten-thousandths of a dollar per dollar. */
export const OPTION_PRICE_SCALE = 10_000;

export type OptionType = 'call' | 'put';

export interface OptionContract {
  /** Root symbol, e.g. `NVDA`. Uppercase, no padding. */
  readonly underlying: string;
  /** Civil expiry date, `YYYY-MM-DD`. */
  readonly expiry: string;
  readonly type: OptionType;
  /** Strike in integer ten-thousandths of a dollar. `$227.50` is `2275000`. */
  readonly strikeE4: number;
}

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

/** `1.12` → `11200`. Rounds, so it is safe on values that came from division. */
export function toE4(major: number): number {
  if (!Number.isFinite(major)) {
    throw new RangeError(`Cannot convert ${major} to E4`);
  }
  return Math.round(major * OPTION_PRICE_SCALE);
}

/** `11200` → `1.12`. Lossy by design — for display and for float math only. */
export function fromE4(e4: number): number {
  return e4 / OPTION_PRICE_SCALE;
}

// ---------------------------------------------------------------------------
// OCC symbols
// ---------------------------------------------------------------------------

/**
 * The OCC option symbol is fixed-width at the tail and variable at the head:
 * a root padded to six characters, then `YYMMDD`, then `C` or `P`, then the
 * strike in eight digits of thousandths-of-a-dollar.
 *
 *     NVDA  260819C00227500
 *     ^root ^date ^^strike   → NVDA, 2026-08-19, call, $227.50
 *
 * Parsing splits from the right rather than matching a single regex, because
 * the root is the only variable-width field and roots legitimately contain
 * digits (`RIOT`), dots (`BRK.B`), and occasionally fill the full six columns
 * with no separating space.
 */
const OCC_TAIL = 15; // YYMMDD(6) + C|P(1) + strike(8)

/**
 * Accepts the canonical space-padded form, the unpadded form, and Polygon's
 * `O:`-prefixed variant. Returns null rather than throwing: this parses data
 * arriving from a vendor, where a malformed row should be skipped and counted,
 * not crash a nightly capture of a hundred thousand contracts.
 */
export function parseOccSymbol(symbol: string): OptionContract | null {
  if (typeof symbol !== 'string') return null;

  let s = symbol.trim().toUpperCase();
  if (s.startsWith('O:')) s = s.slice(2);
  if (s.length <= OCC_TAIL) return null;

  const root = s.slice(0, s.length - OCC_TAIL).trim();
  const tail = s.slice(s.length - OCC_TAIL);

  if (!/^[A-Z0-9.]{1,6}$/.test(root)) return null;

  const m = /^(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(tail);
  if (!m) return null;

  const [, yy, mm, dd, cp, strike] = m as unknown as [string, string, string, string, string, string];

  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Two-digit years are unambiguous in practice: listed options extend at most
  // ~3 years out, so every symbol in circulation is 20xx.
  const expiry = `20${yy}-${mm}-${dd}`;

  const strikeE4 = Number(strike) * 10; // eight digits of thousandths → E4
  if (strikeE4 <= 0) return null;

  return { underlying: root, expiry, type: cp === 'C' ? 'call' : 'put', strikeE4 };
}

/** Produces the canonical 21-character space-padded OCC symbol. */
export function formatOccSymbol(c: OptionContract): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.expiry);
  if (!m) throw new RangeError(`Expiry must be YYYY-MM-DD, got "${c.expiry}"`);
  const [, yyyy, mm, dd] = m as unknown as [string, string, string, string];

  if (!Number.isInteger(c.strikeE4) || c.strikeE4 <= 0) {
    throw new RangeError(`Strike must be a positive integer E4, got ${c.strikeE4}`);
  }
  // OCC encodes thousandths, so anything finer than $0.001 cannot round-trip.
  // Silently truncating would corrupt contract identity, so it's an error.
  if (c.strikeE4 % 10 !== 0) {
    throw new RangeError(
      `Strike ${fromE4(c.strikeE4)} is finer than $0.001 and has no OCC encoding`,
    );
  }
  const thousandths = c.strikeE4 / 10;
  if (thousandths > 99_999_999) {
    throw new RangeError(`Strike ${fromE4(c.strikeE4)} exceeds the OCC eight-digit field`);
  }

  const root = c.underlying.toUpperCase().padEnd(6, ' ');
  const cp = c.type === 'call' ? 'C' : 'P';
  return `${root}${yyyy.slice(2)}${mm}${dd}${cp}${String(thousandths).padStart(8, '0')}`;
}

/** Polygon's variant: `O:` prefix, no space padding. */
export function toPolygonSymbol(c: OptionContract): string {
  return `O:${formatOccSymbol(c).replace(/\s+/g, '')}`;
}

// ---------------------------------------------------------------------------
// Moneyness and expiry
// ---------------------------------------------------------------------------

/** What the contract would be worth if it expired right now. Never negative. */
export function intrinsicValueE4(c: OptionContract, spotE4: number): number {
  const diff = c.type === 'call' ? spotE4 - c.strikeE4 : c.strikeE4 - spotE4;
  return Math.max(0, diff);
}

export function isInTheMoney(c: OptionContract, spotE4: number): boolean {
  return intrinsicValueE4(c, spotE4) > 0;
}

/**
 * The underlying price at which a long position breaks even at expiry.
 * Debit-side only — this is the "BE" column on a broker chain, which assumes
 * you bought the contract and held it to expiry.
 */
export function breakEvenE4(c: OptionContract, premiumE4: number): number {
  return c.type === 'call' ? c.strikeE4 + premiumE4 : c.strikeE4 - premiumE4;
}

/** How far the underlying must travel to break even, as a percentage of spot. */
export function percentToBreakEven(
  c: OptionContract,
  premiumE4: number,
  spotE4: number,
): number {
  if (spotE4 <= 0) throw new RangeError(`Spot must be positive, got ${spotE4}`);
  return ((breakEvenE4(c, premiumE4) - spotE4) / spotE4) * 100;
}

/**
 * Calendar days from `asOf` to expiry. Both are reduced to civil days in UTC
 * before differencing, so the result never shifts by one across a timezone
 * boundary or a daylight-saving change.
 *
 * Day granularity is deliberate: this system captures one chain snapshot per
 * day, so an intraday fraction would be false precision. Zero means the
 * contract expires today; negative means it already has.
 */
export function daysToExpiry(expiry: string, asOf: string): number {
  const end = civilDayUtc(expiry);
  const start = civilDayUtc(asOf.slice(0, 10));
  if (end === null || start === null) {
    throw new RangeError(`Cannot compute days between "${asOf}" and "${expiry}"`);
  }
  return Math.round((end - start) / 86_400_000);
}

/**
 * Time to expiry in years, for Black-Scholes and its relatives.
 *
 * Calendar days over 365, not trading days over 252. Both conventions are in
 * use; calendar time is the one that matches how the closed-form models are
 * derived, and — more practically — it's the convention brokers quote implied
 * vol under, so our IV stays comparable to theirs.
 */
export function yearsToExpiry(expiry: string, asOf: string): number {
  return daysToExpiry(expiry, asOf) / 365;
}

function civilDayUtc(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** `log(K/S)` — the raw distance from at-the-money, signed and scale-free. */
export function logMoneyness(c: OptionContract, spotE4: number): number {
  if (spotE4 <= 0) throw new RangeError(`Spot must be positive, got ${spotE4}`);
  return Math.log(c.strikeE4 / spotE4);
}

/**
 * `log(K/S) / (σ√T)` — log-moneyness expressed in standard deviations of the
 * expected move.
 *
 * This is the form that belongs in a model. Raw log-moneyness is not
 * comparable across names or expiries: 5% out of the money is a long way on a
 * utility with two days left and nothing at all on a biotech with six months.
 * Dividing by σ√T puts every contract on one axis.
 *
 * Returns null when σ or T is non-positive, which happens on expiry day and on
 * contracts whose implied vol failed to solve. Those rows have no meaningful
 * standardized moneyness and must not silently become zero — zero reads as
 * "exactly at the money", which is the opposite of "unknown".
 */
export function standardizedMoneyness(
  c: OptionContract,
  spotE4: number,
  impliedVol: number,
  years: number,
): number | null {
  if (!(impliedVol > 0) || !(years > 0)) return null;
  return logMoneyness(c, spotE4) / (impliedVol * Math.sqrt(years));
}
