import { desc, eq, sql } from 'drizzle-orm';
import { marketDb } from '../../db/market/index.js';
import { riskFreeRates } from '../../db/market/schema.js';

/**
 * The risk-free curve, from the US Treasury's daily par yield series.
 *
 * Free, no key, no vendor. Worth having properly rather than hardcoding a
 * single number: Black-Scholes wants a rate matched to the option's maturity,
 * and using an overnight rate for a 90-day contract misprices it. That error
 * does not stay put — it lands in the implied vol we solve, which is then fed
 * to the model as a feature, so a lazy rate becomes a systematically wrong
 * input rather than a small pricing inaccuracy.
 *
 * At two days to expiry the rate barely matters. At ninety it does.
 */

const CSV_URL =
  'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all' +
  '?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv';

/** Column heading to tenor in days. The Treasury publishes months and years. */
const TENORS: ReadonlyArray<readonly [header: string, days: number]> = [
  ['1 Mo', 30],
  ['1.5 Month', 45],
  ['2 Mo', 60],
  ['3 Mo', 91],
  ['4 Mo', 121],
  ['6 Mo', 182],
  ['1 Yr', 365],
  ['2 Yr', 730],
  ['3 Yr', 1095],
  ['5 Yr', 1825],
  ['7 Yr', 2555],
  ['10 Yr', 3650],
  ['20 Yr', 7300],
  ['30 Yr', 10_950],
];

/** Splits a CSV line, honouring the quoting the Treasury actually emits. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim());
}

/** `08/15/2026` → `2026-08-15`. Returns null on anything else. */
function toIsoDay(mdy: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdy.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m as unknown as [string, string, string, string];
  return `${yyyy}-${mm}-${dd}`;
}

export interface RateRow {
  day: string;
  tenorDays: number;
  rateBps: number;
}

/** Fetches and parses one calendar year of the par yield curve. */
export async function fetchTreasuryYearRates(year: number): Promise<RateRow[]> {
  const res = await fetch(CSV_URL.replaceAll('{year}', String(year)));
  if (!res.ok) {
    throw new Error(`Treasury yield curve ${year}: HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]!);
  const columns = TENORS.map(([name, days]) => ({ index: header.indexOf(name), days })).filter(
    (c) => c.index >= 0,
  );

  const rows: RateRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const day = toIsoDay(cells[0] ?? '');
    if (!day) continue;
    for (const col of columns) {
      const raw = cells[col.index];
      if (!raw) continue;
      const pct = Number(raw);
      // Blanks and "N/A" are normal — not every tenor is published every day.
      if (!Number.isFinite(pct)) continue;
      rows.push({ day, tenorDays: col.days, rateBps: Math.round(pct * 100) });
    }
  }
  return rows;
}

export interface RateSyncResult {
  years: number[];
  rows: number;
}

/** Idempotent: the unique index on (day, tenor) makes re-running a no-op. */
export async function syncRates(years: readonly number[]): Promise<RateSyncResult> {
  let written = 0;
  for (const year of years) {
    const rows = await fetchTreasuryYearRates(year);
    if (rows.length === 0) continue;
    marketDb
      .insert(riskFreeRates)
      .values(rows)
      .onConflictDoNothing({ target: [riskFreeRates.day, riskFreeRates.tenorDays] })
      .run();
    written += rows.length;
  }
  return { years: [...years], rows: written };
}

/**
 * The curve for one day, as a sorted tenor→rate list.
 *
 * Falls back to the most recent published day at or before the one asked for.
 * The Treasury does not publish on weekends or holidays, and an option chain
 * captured on a day with no curve still has to be priced — using the last
 * known curve is exactly what the market itself is doing.
 */
export function curveFor(day: string): Array<{ tenorDays: number; rate: number }> {
  const latest = marketDb
    .select({ day: riskFreeRates.day })
    .from(riskFreeRates)
    .where(sql`${riskFreeRates.day} <= ${day}`)
    .orderBy(desc(riskFreeRates.day))
    .limit(1)
    .get();
  if (!latest) return [];

  return marketDb
    .select({ tenorDays: riskFreeRates.tenorDays, rateBps: riskFreeRates.rateBps })
    .from(riskFreeRates)
    .where(eq(riskFreeRates.day, latest.day))
    .orderBy(riskFreeRates.tenorDays)
    .all()
    .map((r) => ({ tenorDays: r.tenorDays, rate: r.rateBps / 10_000 }));
}

/**
 * Linearly interpolates the curve at a given maturity.
 *
 * Flat extrapolation past either end: below the shortest published tenor the
 * short rate is the best available answer, and beyond thirty years we have no
 * option contracts anyway. Linear rather than a spline because the curve is
 * published at enough points that the difference is far smaller than the
 * bid-ask spread of anything we would price with it.
 */
export function interpolateRate(
  curve: ReadonlyArray<{ tenorDays: number; rate: number }>,
  days: number,
): number | null {
  if (curve.length === 0) return null;
  if (curve.length === 1) return curve[0]!.rate;

  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (days <= first.tenorDays) return first.rate;
  if (days >= last.tenorDays) return last.rate;

  for (let i = 1; i < curve.length; i += 1) {
    const lo = curve[i - 1]!;
    const hi = curve[i]!;
    if (days <= hi.tenorDays) {
      const span = hi.tenorDays - lo.tenorDays;
      if (span <= 0) return lo.rate;
      const weight = (days - lo.tenorDays) / span;
      return lo.rate + weight * (hi.rate - lo.rate);
    }
  }
  return last.rate;
}

/** Convenience: the rate to price a contract expiring `days` out, on `day`. */
export function rateFor(day: string, days: number): number | null {
  return interpolateRate(curveFor(day), days);
}
