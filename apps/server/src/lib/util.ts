import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

/** Current instant as a UTC ISO-8601 string — the app's only time format. */
export const nowIso = (): string => new Date().toISOString();

/** Today's civil day in the server's local zone, as `YYYY-MM-DD`. */
export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM` for the month a civil key falls in. */
export const monthKey = (civil: string): string => civil.slice(0, 7);

/**
 * Collapses a transaction description to a comparable form: lowercase, no
 * punctuation, no runs of whitespace, and with the trailing reference numbers
 * banks staple on stripped off.
 *
 * `"TIM HORTONS #4021  TORONTO ON"` and `"Tim Hortons #4021 Toronto ON"` are
 * the same merchant, and a dedupe that can't see that isn't worth much.
 */
export function normalizeDescription(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[#*]?\d{4,}/g, ' ')
    .replace(/[^a-z0-9؀-ۿ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clamps a number into a range. */
export const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

/** Days between two `YYYY-MM-DD` keys. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Adds days to a `YYYY-MM-DD` key. */
export function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
