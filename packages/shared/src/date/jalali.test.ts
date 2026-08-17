import { describe, expect, it } from 'vitest';
import {
  JALALI_MONTHS_EN,
  addCivilDays,
  buildMonthGrid,
  civilKey,
  civilToJalali,
  isLeapJalali,
  jalaliMonthLength,
  jalaliToCivil,
  monthOf,
  parseCivilKey,
  shiftMonth,
  weekOf,
  weekdayIndex,
  type CivilDate,
} from './jalali.js';
import { formatShamsi, jalaliHoliday, monthLabel } from './format.js';

describe('conversion', () => {
  it('pins today: 2026-08-17 is 26 Mordad 1405', () => {
    const j = civilToJalali({ y: 2026, m: 8, d: 17 });
    expect(j).toEqual({ jy: 1405, jm: 5, jd: 26 });
    expect(JALALI_MONTHS_EN[j.jm - 1]).toBe('Mordad');
  });

  it('pins Nowruz 1405 to 2026-03-21', () => {
    expect(jalaliToCivil({ jy: 1405, jm: 1, jd: 1 })).toEqual({ y: 2026, m: 3, d: 21 });
  });

  it('pins the documented jalaali-js example', () => {
    expect(civilToJalali({ y: 2016, m: 4, d: 11 })).toEqual({ jy: 1395, jm: 1, jd: 23 });
    expect(jalaliToCivil({ jy: 1395, jm: 1, jd: 23 })).toEqual({ y: 2016, m: 4, d: 11 });
  });

  it('round-trips every day across a four-year span', () => {
    let c: CivilDate = { y: 2024, m: 1, d: 1 };
    for (let i = 0; i < 365 * 4; i++) {
      const back = jalaliToCivil(civilToJalali(c));
      expect(back, `round-trip failed at ${civilKey(c)}`).toEqual(c);
      c = addCivilDays(c, 1);
    }
  });
});

describe('leap years and month lengths', () => {
  it('follows 6x31, 5x30, then 29 or 30 for Esfand', () => {
    for (const jy of [1403, 1404, 1405, 1406]) {
      for (let jm = 1; jm <= 6; jm++) expect(jalaliMonthLength(jy, jm)).toBe(31);
      for (let jm = 7; jm <= 11; jm++) expect(jalaliMonthLength(jy, jm)).toBe(30);
      expect(jalaliMonthLength(jy, 12)).toBe(isLeapJalali(jy) ? 30 : 29);
    }
  });

  it('knows 1395 is leap and 1394 is not', () => {
    expect(isLeapJalali(1395)).toBe(true);
    expect(isLeapJalali(1394)).toBe(false);
  });

  it('gives every year 365 or 366 days across a 33-year cycle', () => {
    for (let jy = 1390; jy < 1423; jy++) {
      const start = jalaliToCivil({ jy, jm: 1, jd: 1 });
      const next = jalaliToCivil({ jy: jy + 1, jm: 1, jd: 1 });
      const days = Math.round(
        (new Date(next.y, next.m - 1, next.d).getTime() -
          new Date(start.y, start.m - 1, start.d).getTime()) /
          86_400_000,
      );
      expect(days, `year ${jy}`).toBe(isLeapJalali(jy) ? 366 : 365);
    }
  });

  it('places Esfand 30 only in leap years', () => {
    expect(() => jalaliToCivil({ jy: 1395, jm: 12, jd: 30 })).not.toThrow();
    expect(jalaliMonthLength(1394, 12)).toBe(29);
  });
});

describe('agreement with Intl', () => {
  // jalaali-js uses Borkowski; Intl uses its own leap rule. They agree exactly
  // between Gregorian 1800 and 2256. If this ever drifts inside our range, the
  // dates users see would silently disagree with the rest of the OS.
  it('matches en-US-u-ca-persian every day for six years', () => {
    const fmt = new Intl.DateTimeFormat('en-US-u-ca-persian', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      timeZone: 'UTC',
    });

    let c: CivilDate = { y: 2024, m: 1, d: 1 };
    for (let i = 0; i < 365 * 6; i++) {
      const ours = civilToJalali(c);
      const parts = fmt.formatToParts(new Date(Date.UTC(c.y, c.m - 1, c.d, 12)));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);

      expect(
        { jy: get('year'), jm: get('month'), jd: get('day') },
        `disagreement at ${civilKey(c)}`,
      ).toEqual(ours);

      c = addCivilDays(c, 1);
    }
  });
});

describe('weekday indexing', () => {
  it('starts the Shamsi week on Saturday', () => {
    // 2026-08-15 is a Saturday.
    expect(weekdayIndex({ y: 2026, m: 8, d: 15 }, 'shamsi')).toBe(0);
    expect(weekdayIndex({ y: 2026, m: 8, d: 16 }, 'shamsi')).toBe(1); // Sunday
    expect(weekdayIndex({ y: 2026, m: 8, d: 21 }, 'shamsi')).toBe(6); // Friday
  });

  it('starts the Miladi week on Sunday', () => {
    expect(weekdayIndex({ y: 2026, m: 8, d: 16 }, 'miladi')).toBe(0);
    expect(weekdayIndex({ y: 2026, m: 8, d: 15 }, 'miladi')).toBe(6);
  });

  it('returns seven consecutive days for a week', () => {
    const week = weekOf({ y: 2026, m: 8, d: 17 }, 'shamsi');
    expect(week).toHaveLength(7);
    expect(civilKey(week[0]!)).toBe('2026-08-15'); // Saturday
    expect(civilKey(week[6]!)).toBe('2026-08-21'); // Friday
  });
});

describe('month grid', () => {
  it('is always six rows of seven', () => {
    for (const system of ['shamsi', 'miladi'] as const) {
      for (let m = 1; m <= 12; m++) {
        const grid = buildMonthGrid(system, system === 'shamsi' ? 1405 : 2026, m);
        expect(grid.weeks).toHaveLength(6);
        for (const w of grid.weeks) expect(w).toHaveLength(7);
      }
    }
  });

  it('marks exactly the right number of in-month days', () => {
    const grid = buildMonthGrid('shamsi', 1405, 5); // Mordad, 31 days
    const inMonth = grid.weeks.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[0]!.jalali).toEqual({ jy: 1405, jm: 5, jd: 1 });
    expect(inMonth[30]!.jalali).toEqual({ jy: 1405, jm: 5, jd: 31 });
  });

  it('runs consecutively with no gaps or repeats', () => {
    const cells = buildMonthGrid('shamsi', 1405, 5).weeks.flat();
    for (let i = 1; i < cells.length; i++) {
      expect(civilKey(addCivilDays(cells[i - 1]!.gregorian, 1))).toBe(cells[i]!.key);
    }
  });

  it('opens each row on the system-appropriate first weekday', () => {
    for (const row of buildMonthGrid('shamsi', 1405, 5).weeks) {
      expect(weekdayIndex(row[0]!.gregorian, 'shamsi')).toBe(0);
    }
    for (const row of buildMonthGrid('miladi', 2026, 8).weeks) {
      expect(weekdayIndex(row[0]!.gregorian, 'miladi')).toBe(0);
    }
  });

  it('flags Friday as the weekend under Shamsi, Sat/Sun under Miladi', () => {
    const shamsi = buildMonthGrid('shamsi', 1405, 5).weeks[0]!;
    expect(shamsi.map((c) => c.isWeekend)).toEqual([
      false, false, false, false, false, false, true,
    ]);

    const miladi = buildMonthGrid('miladi', 2026, 8).weeks[0]!;
    expect(miladi.map((c) => c.isWeekend)).toEqual([
      true, false, false, false, false, false, true,
    ]);
  });

  it('marks today, and only today', () => {
    const today = { y: 2026, m: 8, d: 17 };
    const cells = buildMonthGrid('shamsi', 1405, 5, today).weeks.flat();
    expect(cells.filter((c) => c.isToday)).toHaveLength(1);
    expect(cells.find((c) => c.isToday)!.key).toBe('2026-08-17');
  });

  it('handles a leap Esfand', () => {
    const grid = buildMonthGrid('shamsi', 1395, 12);
    expect(grid.weeks.flat().filter((c) => c.inMonth)).toHaveLength(30);
  });
});

describe('month navigation', () => {
  it('steps within the leading calendar, not the other one', () => {
    // Stepping forward from Mordad must reach Shahrivar, not September.
    expect(shiftMonth('shamsi', 1405, 5, 1)).toEqual({ year: 1405, month: 6 });
    expect(shiftMonth('shamsi', 1405, 12, 1)).toEqual({ year: 1406, month: 1 });
    expect(shiftMonth('shamsi', 1405, 1, -1)).toEqual({ year: 1404, month: 12 });
    expect(shiftMonth('miladi', 2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });

  it('survives a full year of steps in both directions', () => {
    let cur = { year: 1405, month: 1 };
    for (let i = 0; i < 12; i++) cur = shiftMonth('shamsi', cur.year, cur.month, 1);
    expect(cur).toEqual({ year: 1406, month: 1 });
    for (let i = 0; i < 12; i++) cur = shiftMonth('shamsi', cur.year, cur.month, -1);
    expect(cur).toEqual({ year: 1405, month: 1 });
  });

  it('reports the month a date belongs to per system', () => {
    const c = { y: 2026, m: 8, d: 17 };
    expect(monthOf(c, 'shamsi')).toEqual({ year: 1405, month: 5 });
    expect(monthOf(c, 'miladi')).toEqual({ year: 2026, month: 8 });
  });
});

describe('civil keys', () => {
  it('pads and round-trips', () => {
    expect(civilKey({ y: 2026, m: 8, d: 7 })).toBe('2026-08-07');
    expect(parseCivilKey('2026-08-07')).toEqual({ y: 2026, m: 8, d: 7 });
  });

  it('sorts lexicographically in date order', () => {
    const keys = ['2026-12-01', '2026-01-02', '2026-01-10'].sort();
    expect(keys).toEqual(['2026-01-02', '2026-01-10', '2026-12-01']);
  });

  it('rejects malformed keys', () => {
    expect(() => parseCivilKey('2026-8-7')).toThrow();
  });
});

describe('formatting', () => {
  it('renders Shamsi with Persian digits', () => {
    const out = formatShamsi({ y: 2026, m: 8, d: 17 }, { style: 'long' });
    expect(out).toContain('مرداد');
    expect(out).toContain('۱۴۰۵');
  });

  it('renders Shamsi in Latin script when asked', () => {
    const out = formatShamsi({ y: 2026, m: 8, d: 17 }, { style: 'long', persian: false });
    expect(out).toContain('Mordad');
    expect(out).toContain('1405');
  });

  it('labels months in each system', () => {
    expect(monthLabel(1405, 5, 'shamsi')).toBe('مرداد ۱۴۰۵');
    expect(monthLabel(1405, 5, 'shamsi', false)).toBe('Mordad 1405');
    expect(monthLabel(2026, 8, 'miladi')).toBe('August 2026');
  });
});

describe('holidays', () => {
  it('finds Nowruz on 1 Farvardin', () => {
    expect(jalaliHoliday({ jy: 1405, jm: 1, jd: 1 })?.name).toBe('Nowruz');
    expect(jalaliHoliday({ jy: 1405, jm: 1, jd: 4 })?.name).toBe('Nowruz');
    expect(jalaliHoliday({ jy: 1405, jm: 1, jd: 5 })).toBeNull();
  });

  it('separates official holidays from cultural observances', () => {
    expect(jalaliHoliday({ jy: 1405, jm: 11, jd: 22 })?.official).toBe(true);
    expect(jalaliHoliday({ jy: 1405, jm: 9, jd: 30 })?.official).toBe(false); // Yalda
  });
});
