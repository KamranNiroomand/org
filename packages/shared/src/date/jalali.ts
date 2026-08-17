/**
 * Dual-calendar core: Jalali (Shamsi / Persian) alongside Gregorian (Miladi).
 *
 * Two rules hold everywhere in the app:
 *
 *   1. Instants are persisted as UTC ISO-8601 strings. Jalali exists only at
 *      the view layer — nothing is ever *stored* in Jalali.
 *   2. A calendar grid is about **civil days**, not instants. "17 August" is
 *      the same cell whether it's 00:30 or 23:30 local. So grid maths runs on
 *      `CivilDate` (a bare year/month/day triple) and never touches a
 *      timezone. This is what stops a task due at 11pm from rendering on
 *      tomorrow's square.
 *
 * The conversion arithmetic comes from `jalaali-js`, which implements
 * Borkowski's algorithm. It agrees exactly with ECMAScript's
 * `Intl` Persian calendar between Gregorian 1800 and 2256 — see the
 * cross-check in the test suite, which fails loudly if that ever drifts.
 */

import {
  isLeapJalaaliYear,
  isValidJalaaliDate,
  jalaaliMonthLength,
  toGregorian,
  toJalaali,
} from 'jalaali-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which calendar leads in the UI. */
export type CalendarSystem = 'miladi' | 'shamsi';

/** A date with no time and no timezone — a square on a calendar. */
export interface CivilDate {
  /** Full year. */
  y: number;
  /** Month, 1-12. */
  m: number;
  /** Day of month, 1-31. */
  d: number;
}

export interface JalaliDate {
  jy: number;
  jm: number;
  jd: number;
}

export interface DayCell {
  /** Gregorian civil date for this square. */
  gregorian: CivilDate;
  /** Jalali civil date for the same square. */
  jalali: JalaliDate;
  /** `YYYY-MM-DD` (Gregorian) — the stable key for lookups and React keys. */
  key: string;
  /** Local midnight of this day, for range queries against stored instants. */
  start: Date;
  /** Whether this square belongs to the month being displayed. */
  inMonth: boolean;
  isToday: boolean;
  /** Friday under Shamsi; Saturday and Sunday under Miladi. */
  isWeekend: boolean;
}

export interface MonthGrid {
  system: CalendarSystem;
  /** Year in the leading system. */
  year: number;
  /** Month (1-12) in the leading system. */
  month: number;
  /** Always 6 rows of 7, so the grid never changes height between months. */
  weeks: DayCell[][];
}

// ---------------------------------------------------------------------------
// Month and weekday names
// ---------------------------------------------------------------------------

export const JALALI_MONTHS_EN = [
  'Farvardin', 'Ordibehesht', 'Khordad', 'Tir', 'Mordad', 'Shahrivar',
  'Mehr', 'Aban', 'Azar', 'Dey', 'Bahman', 'Esfand',
] as const;

export const JALALI_MONTHS_FA = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
] as const;

export const GREGORIAN_MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Shamsi weeks start on Saturday. */
export const JALALI_WEEKDAYS_FA = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه'] as const;
export const JALALI_WEEKDAYS_EN = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;

/** Miladi weeks start on Sunday. */
export const GREGORIAN_WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// ---------------------------------------------------------------------------
// CivilDate <-> Date
// ---------------------------------------------------------------------------

/**
 * Reads the civil date an instant falls on, **in the viewer's local zone**.
 * This is the correct boundary for display: a transaction stamped
 * `2026-08-17T03:00:00Z` belongs to 16 August for someone in Toronto.
 */
export function toCivil(date: Date): CivilDate {
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

/** Local midnight at the start of a civil day. */
export function civilToDate(c: CivilDate): Date {
  return new Date(c.y, c.m - 1, c.d, 0, 0, 0, 0);
}

/** `YYYY-MM-DD`. Sorts lexicographically, which is why it's the map key. */
export function civilKey(c: CivilDate): string {
  return `${String(c.y).padStart(4, '0')}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

export function parseCivilKey(key: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new TypeError(`Not a YYYY-MM-DD key: ${key}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function civilEquals(a: CivilDate, b: CivilDate): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

/**
 * Adds days to a civil date. Goes through `Date` so month and year rollover
 * (including Gregorian leap days) is handled by the platform rather than by
 * arithmetic we'd have to get right ourselves.
 */
export function addCivilDays(c: CivilDate, days: number): CivilDate {
  const d = civilToDate(c);
  d.setDate(d.getDate() + days);
  return toCivil(d);
}

export function todayCivil(now: Date = new Date()): CivilDate {
  return toCivil(now);
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export function civilToJalali(c: CivilDate): JalaliDate {
  return toJalaali(c.y, c.m, c.d);
}

export function jalaliToCivil(j: JalaliDate): CivilDate {
  const g = toGregorian(j.jy, j.jm, j.jd);
  return { y: g.gy, m: g.gm, d: g.gd };
}

/** Reads the Jalali date an instant falls on, in the viewer's local zone. */
export function dateToJalali(date: Date): JalaliDate {
  return civilToJalali(toCivil(date));
}

export function isLeapJalali(jy: number): boolean {
  return isLeapJalaaliYear(jy);
}

/** 31 days for months 1-6, 30 for 7-11, and 29 or 30 for Esfand. */
export function jalaliMonthLength(jy: number, jm: number): number {
  return jalaaliMonthLength(jy, jm);
}

export function isValidJalali(j: JalaliDate): boolean {
  return isValidJalaaliDate(j.jy, j.jm, j.jd);
}

export function gregorianMonthLength(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

// ---------------------------------------------------------------------------
// Weekday indexing
// ---------------------------------------------------------------------------

/**
 * Day-of-week index within the given system's week.
 *
 * Miladi weeks start Sunday, so the index is `Date.getDay()` unchanged.
 * Shamsi weeks start Saturday, so Saturday must map to 0: `(getDay() + 1) % 7`
 * shifts Sat(6)→0, Sun(0)→1, … Fri(5)→6.
 */
export function weekdayIndex(c: CivilDate, system: CalendarSystem): number {
  const dow = civilToDate(c).getDay();
  return system === 'shamsi' ? (dow + 1) % 7 : dow;
}

export function weekdayLabels(system: CalendarSystem, persian = false): readonly string[] {
  if (system === 'shamsi') return persian ? JALALI_WEEKDAYS_FA : JALALI_WEEKDAYS_EN;
  return GREGORIAN_WEEKDAYS_EN;
}

/** Friday is the Iranian weekend; Saturday and Sunday are the Western one. */
export function isWeekend(c: CivilDate, system: CalendarSystem): boolean {
  const dow = civilToDate(c).getDay();
  return system === 'shamsi' ? dow === 5 : dow === 0 || dow === 6;
}

// ---------------------------------------------------------------------------
// Month grids
// ---------------------------------------------------------------------------

/**
 * Builds a 6x7 grid for a month in whichever system leads.
 *
 * Fixed at six rows on purpose: a month needing only five would make the grid
 * jump in height as you page through the year, and the extra row costs nothing.
 * Leading and trailing cells come from the neighbouring months and are marked
 * `inMonth: false`.
 */
export function buildMonthGrid(
  system: CalendarSystem,
  year: number,
  month: number,
  today: CivilDate = todayCivil(),
): MonthGrid {
  const first: CivilDate =
    system === 'shamsi'
      ? jalaliToCivil({ jy: year, jm: month, jd: 1 })
      : { y: year, m: month, d: 1 };

  const monthLength =
    system === 'shamsi' ? jalaliMonthLength(year, month) : gregorianMonthLength(year, month);

  const lead = weekdayIndex(first, system);
  const gridStart = addCivilDays(first, -lead);

  const weeks: DayCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const c = addCivilDays(gridStart, w * 7 + d);
      const j = civilToJalali(c);
      const offset = w * 7 + d - lead;
      row.push({
        gregorian: c,
        jalali: j,
        key: civilKey(c),
        start: civilToDate(c),
        inMonth: offset >= 0 && offset < monthLength,
        isToday: civilEquals(c, today),
        isWeekend: isWeekend(c, system),
      });
    }
    weeks.push(row);
  }

  return { system, year, month, weeks };
}

/**
 * Steps a month forward or backward *within the leading system*.
 *
 * The arithmetic turns out to be calendar-independent — both Jalali and
 * Gregorian years hold exactly twelve months, so `year * 12 + month` rolls over
 * correctly for either. `system` is therefore unused, but stays in the
 * signature: it makes call sites say which calendar's months they're walking,
 * which is the whole point of the function. Paging forward from Mordad must
 * land on Shahrivar, not September.
 */
export function shiftMonth(
  _system: CalendarSystem,
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (((total % 12) + 12) % 12) + 1 };
}

/** The month a civil date sits in, expressed in the leading system. */
export function monthOf(c: CivilDate, system: CalendarSystem): { year: number; month: number } {
  if (system === 'shamsi') {
    const j = civilToJalali(c);
    return { year: j.jy, month: j.jm };
  }
  return { year: c.y, month: c.m };
}

/** The seven civil days of the week containing `c`, in the system's order. */
export function weekOf(c: CivilDate, system: CalendarSystem): CivilDate[] {
  const start = addCivilDays(c, -weekdayIndex(c, system));
  return Array.from({ length: 7 }, (_, i) => addCivilDays(start, i));
}
