/**
 * Natural-language quick add.
 *
 * `pay hydro bill friday !high #home` becomes a task titled "pay hydro bill",
 * due this coming Friday, priority high, tagged `home`.
 *
 * The parser is deliberately conservative: tokens it doesn't recognise stay in
 * the title. Losing a word from what you typed is far more annoying than
 * failing to detect a due date, so ambiguity always resolves toward keeping
 * the text.
 */

import {
  addCivilDays,
  civilKey,
  civilToJalali,
  jalaliToCivil,
  todayCivil,
  type CivilDate,
} from './date/jalali.js';
import { toLatinDigits } from './money.js';
import type { Priority } from './types.js';

export interface QuickAddResult {
  title: string;
  dueOn: string | null;
  priority: Priority;
  tags: string[];
  projectHint: string | null;
  /** Character ranges consumed, so the UI can highlight what was understood. */
  matched: Array<{ start: number; end: number; kind: 'date' | 'priority' | 'tag' | 'project' }>;
}

const PRIORITY_WORDS: Record<string, Priority> = {
  '!urgent': 'urgent', '!u': 'urgent', '!!!': 'urgent',
  '!high': 'high', '!h': 'high', '!!': 'high',
  '!medium': 'medium', '!med': 'medium', '!m': 'medium', '!': 'medium',
  '!low': 'low', '!l': 'low',
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

/** Jalali month names, so `۱۵ مرداد` and `15 mordad` both work. */
const JALALI_MONTH_NAMES: Record<string, number> = {
  farvardin: 1, فروردین: 1,
  ordibehesht: 2, اردیبهشت: 2,
  khordad: 3, خرداد: 3,
  tir: 4, تیر: 4,
  mordad: 5, مرداد: 5,
  shahrivar: 6, شهریور: 6,
  mehr: 7, مهر: 7,
  aban: 8, آبان: 8,
  azar: 9, آذر: 9,
  dey: 10, دی: 10,
  bahman: 11, بهمن: 11,
  esfand: 12, اسفند: 12,
};

/** The next occurrence of a weekday, never today (`friday` on a Friday = +7). */
function nextWeekday(from: CivilDate, target: number): CivilDate {
  const current = new Date(from.y, from.m - 1, from.d).getDay();
  const delta = ((target - current + 7) % 7) || 7;
  return addCivilDays(from, delta);
}

export function parseQuickAdd(input: string, today: CivilDate = todayCivil()): QuickAddResult {
  const matched: QuickAddResult['matched'] = [];
  const tags: string[] = [];
  let priority: Priority = 'none';
  let dueOn: string | null = null;
  let projectHint: string | null = null;

  // --- tags: #home -------------------------------------------------------
  for (const m of input.matchAll(/(^|\s)#([\p{L}\p{N}_-]+)/gu)) {
    tags.push(m[2]!);
    const start = m.index! + m[1]!.length;
    matched.push({ start, end: start + m[2]!.length + 1, kind: 'tag' });
  }

  // --- project: @renovation ---------------------------------------------
  const projectMatch = /(^|\s)@([\p{L}\p{N}_-]+)/u.exec(input);
  if (projectMatch) {
    projectHint = projectMatch[2]!;
    const start = projectMatch.index + projectMatch[1]!.length;
    matched.push({ start, end: start + projectHint.length + 1, kind: 'project' });
  }

  // --- priority: !high ---------------------------------------------------
  for (const m of input.matchAll(/(^|\s)(![\p{L}!]*)/gu)) {
    const token = m[2]!.toLowerCase();
    const hit = PRIORITY_WORDS[token];
    if (hit) {
      priority = hit;
      const start = m.index! + m[1]!.length;
      matched.push({ start, end: start + m[2]!.length, kind: 'priority' });
      break;
    }
  }

  // --- dates -------------------------------------------------------------
  const lower = toLatinDigits(input).toLowerCase();

  const setDate = (c: CivilDate, start: number, end: number) => {
    if (dueOn !== null) return; // first match wins
    dueOn = civilKey(c);
    matched.push({ start, end, kind: 'date' });
  };

  const relative: Array<[RegExp, (m: RegExpExecArray) => CivilDate]> = [
    [/(^|\s)(today)(\s|$)/, () => today],
    [/(^|\s)(tomorrow|tmrw)(\s|$)/, () => addCivilDays(today, 1)],
    [/(^|\s)(yesterday)(\s|$)/, () => addCivilDays(today, -1)],
    [/(^|\s)(next week)(\s|$)/, () => addCivilDays(today, 7)],
    [/(^|\s)(in (\d+) days?)(\s|$)/, (m) => addCivilDays(today, Number(m[3]))],
    [/(^|\s)(in (\d+) weeks?)(\s|$)/, (m) => addCivilDays(today, Number(m[3]) * 7)],
  ];

  for (const [re, resolve] of relative) {
    const m = re.exec(lower);
    if (m) {
      const start = m.index + m[1]!.length;
      setDate(resolve(m), start, start + m[2]!.length);
      break;
    }
  }

  // weekday names, optionally prefixed with "next"
  if (dueOn === null) {
    const m = /(^|\s)(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)(\s|$)/.exec(lower);
    if (m) {
      const start = m.index + m[1]!.length;
      const len = (m[2] ?? '').length + m[3]!.length;
      setDate(nextWeekday(today, WEEKDAYS[m[3]!]!), start, start + len);
    }
  }

  // "15 aug", "aug 15", "15 mordad" — Gregorian and Jalali month names alike
  if (dueOn === null) {
    const names = Object.keys({ ...MONTHS, ...JALALI_MONTH_NAMES }).join('|');
    const dayFirst = new RegExp(`(^|\\s)(\\d{1,2}\\s+(${names}))(\\s|$)`, 'u').exec(lower);
    const monthFirst = new RegExp(`(^|\\s)((${names})\\s+\\d{1,2})(\\s|$)`, 'u').exec(lower);
    const m = dayFirst ?? monthFirst;

    if (m) {
      const phrase = m[2]!;
      const dayNum = Number(/\d{1,2}/.exec(phrase)![0]);
      const nameMatch = new RegExp(names, 'u').exec(phrase)![0];
      const start = m.index + m[1]!.length;

      if (nameMatch in JALALI_MONTH_NAMES) {
        const jm = JALALI_MONTH_NAMES[nameMatch]!;
        const jy = civilToJalali(today).jy;
        setDate(jalaliToCivil({ jy, jm, jd: dayNum }), start, start + phrase.length);
      } else {
        const gm = MONTHS[nameMatch]!;
        // Assume the coming occurrence: a date already past rolls to next year.
        let year = today.y;
        if (gm < today.m || (gm === today.m && dayNum < today.d)) year += 1;
        setDate({ y: year, m: gm, d: dayNum }, start, start + phrase.length);
      }
    }
  }

  // explicit ISO date
  if (dueOn === null) {
    const m = /(^|\s)(\d{4}-\d{2}-\d{2})(\s|$)/.exec(lower);
    if (m) {
      const [y, mo, d] = m[2]!.split('-').map(Number) as [number, number, number];
      const start = m.index + m[1]!.length;
      setDate({ y, m: mo, d }, start, start + 10);
    }
  }

  // --- title = whatever wasn't consumed ----------------------------------
  const ordered = [...matched].sort((a, b) => a.start - b.start);
  let title = '';
  let cursor = 0;
  for (const range of ordered) {
    if (range.start >= cursor) {
      title += input.slice(cursor, range.start);
      cursor = range.end;
    }
  }
  title += input.slice(cursor);

  return {
    title: title.replace(/\s+/g, ' ').trim(),
    dueOn,
    priority,
    tags,
    projectHint,
    matched: ordered,
  };
}
