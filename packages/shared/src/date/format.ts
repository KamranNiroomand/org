/**
 * Rendering dates in both calendars.
 *
 * Month and weekday *names* come from `Intl`, not from hand-written tables,
 * so they stay correct across locales. The hand-written tables in `jalali.ts`
 * exist only as a fast path and a fallback.
 */

import {
  GREGORIAN_MONTHS_EN,
  JALALI_MONTHS_EN,
  JALALI_MONTHS_FA,
  type CalendarSystem,
  type CivilDate,
  type JalaliDate,
  civilToDate,
  civilToJalali,
} from './jalali.js';
import { toPersianDigits } from '../money.js';

export interface DualFormat {
  miladi: string;
  shamsi: string;
}

export type DateStyle = 'full' | 'long' | 'medium' | 'short' | 'numeric';

export interface FormatOptions {
  style?: DateStyle;
  /** Render Shamsi output in Persian script and digits. Default true. */
  persian?: boolean;
  /** Include the weekday name. */
  weekday?: boolean;
}

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(options);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    cache.set(key, f);
  }
  return f;
}

function intlOptions(style: DateStyle, weekday: boolean): Intl.DateTimeFormatOptions {
  const base: Intl.DateTimeFormatOptions =
    style === 'numeric'
      ? { year: 'numeric', month: '2-digit', day: '2-digit' }
      : style === 'short'
        ? { year: 'numeric', month: 'short', day: 'numeric' }
        : style === 'medium'
          ? { year: 'numeric', month: 'short', day: 'numeric' }
          : { year: 'numeric', month: 'long', day: 'numeric' };

  return weekday ? { ...base, weekday: style === 'full' ? 'long' : 'short' } : base;
}

/** Formats a civil date in the Gregorian calendar. */
export function formatMiladi(c: CivilDate, opts: FormatOptions = {}): string {
  const { style = 'medium', weekday = false } = opts;
  return formatter('en-CA', intlOptions(style, weekday)).format(civilToDate(c));
}

/** Formats a civil date in the Jalali calendar. */
export function formatShamsi(c: CivilDate, opts: FormatOptions = {}): string {
  const { style = 'medium', persian = true, weekday = false } = opts;
  const locale = persian ? 'fa-IR-u-ca-persian' : 'en-US-u-ca-persian';
  const out = formatter(locale, intlOptions(style, weekday)).format(civilToDate(c));
  // fa-IR already emits Persian digits; en-US-u-ca-persian does not.
  return out;
}

/** Both calendars for the same day. */
export function formatDual(c: CivilDate, opts: FormatOptions = {}): DualFormat {
  return { miladi: formatMiladi(c, opts), shamsi: formatShamsi(c, opts) };
}

/** Formats in whichever calendar leads. */
export function formatIn(
  c: CivilDate,
  system: CalendarSystem,
  opts: FormatOptions = {},
): string {
  return system === 'shamsi' ? formatShamsi(c, opts) : formatMiladi(c, opts);
}

/** Month name in the given system, e.g. `Mordad 1405` or `مرداد ۱۴۰۵`. */
export function monthLabel(
  year: number,
  month: number,
  system: CalendarSystem,
  persian = true,
): string {
  if (system === 'shamsi') {
    const name = persian ? JALALI_MONTHS_FA[month - 1] : JALALI_MONTHS_EN[month - 1];
    const y = persian ? toPersianDigits(String(year)) : String(year);
    return `${name} ${y}`;
  }
  return `${GREGORIAN_MONTHS_EN[month - 1]} ${year}`;
}

/** The day number as shown in a grid square, in the given system. */
export function dayNumber(
  c: CivilDate,
  system: CalendarSystem,
  persian = true,
): string {
  if (system === 'shamsi') {
    const j = civilToJalali(c);
    return persian ? toPersianDigits(String(j.jd)) : String(j.jd);
  }
  return String(c.d);
}

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "in 3 days", "yesterday", "2 weeks ago" — for due dates and sync stamps. */
export function formatRelativeDays(from: CivilDate, to: CivilDate): string {
  const ms = civilToDate(to).getTime() - civilToDate(from).getTime();
  const days = Math.round(ms / 86_400_000);
  if (Math.abs(days) < 7) return relative.format(days, 'day');
  if (Math.abs(days) < 30) return relative.format(Math.round(days / 7), 'week');
  if (Math.abs(days) < 365) return relative.format(Math.round(days / 30), 'month');
  return relative.format(Math.round(days / 365), 'year');
}

// ---------------------------------------------------------------------------
// Iranian holidays
// ---------------------------------------------------------------------------

export interface Holiday {
  name: string;
  nameFa: string;
  /** Official public holidays vs. observed-but-working cultural days. */
  official: boolean;
}

/**
 * Holidays that fall on **fixed Jalali dates**, keyed `month-day`.
 *
 * Iran's calendar also carries a set of Islamic (lunar Hijri) holidays —
 * Eid al-Fitr, Ashura, and the rest — which drift about eleven days earlier
 * each solar year and are fixed by moon sighting rather than by arithmetic.
 * Those are deliberately not listed here: computing them from a tabular Hijri
 * calendar would produce dates that are frequently a day off from the ones
 * actually observed, which is worse than showing nothing.
 */
const FIXED_JALALI_HOLIDAYS: Record<string, Holiday> = {
  '1-1': { name: 'Nowruz', nameFa: 'نوروز', official: true },
  '1-2': { name: 'Nowruz', nameFa: 'نوروز', official: true },
  '1-3': { name: 'Nowruz', nameFa: 'نوروز', official: true },
  '1-4': { name: 'Nowruz', nameFa: 'نوروز', official: true },
  '1-12': { name: 'Islamic Republic Day', nameFa: 'روز جمهوری اسلامی', official: true },
  '1-13': { name: 'Sizdah Bedar', nameFa: 'روز طبیعت', official: true },
  '3-14': { name: 'Passing of Imam Khomeini', nameFa: 'رحلت امام خمینی', official: true },
  '3-15': { name: 'Khordad 15 Uprising', nameFa: 'قیام ۱۵ خرداد', official: true },
  '9-30': { name: 'Yalda Night', nameFa: 'شب یلدا', official: false },
  '11-22': { name: 'Victory of the Islamic Revolution', nameFa: 'پیروزی انقلاب اسلامی', official: true },
  '12-29': { name: 'Nationalization of Oil', nameFa: 'ملی شدن صنعت نفت', official: true },
};

/** Returns the holiday on a given Jalali date, or `null`. */
export function jalaliHoliday(j: JalaliDate): Holiday | null {
  return FIXED_JALALI_HOLIDAYS[`${j.jm}-${j.jd}`] ?? null;
}

export function civilHoliday(c: CivilDate): Holiday | null {
  return jalaliHoliday(civilToJalali(c));
}
