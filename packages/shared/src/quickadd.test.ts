import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from './quickadd.js';
import type { CivilDate } from './date/jalali.js';

// Monday, 17 August 2026 — 26 Mordad 1405.
const TODAY: CivilDate = { y: 2026, m: 8, d: 17 };
const parse = (s: string) => parseQuickAdd(s, TODAY);

describe('plain text', () => {
  it('passes through untouched when there is nothing to parse', () => {
    const r = parse('buy milk');
    expect(r).toMatchObject({
      title: 'buy milk',
      dueOn: null,
      priority: 'none',
      tags: [],
      projectHint: null,
    });
  });

  it('collapses whitespace', () => {
    expect(parse('  buy   milk  ').title).toBe('buy milk');
  });
});

describe('relative dates', () => {
  it('resolves today, tomorrow, and week offsets', () => {
    expect(parse('ship it today').dueOn).toBe('2026-08-17');
    expect(parse('ship it tomorrow').dueOn).toBe('2026-08-18');
    expect(parse('ship it next week').dueOn).toBe('2026-08-24');
    expect(parse('ship it in 3 days').dueOn).toBe('2026-08-20');
    expect(parse('ship it in 2 weeks').dueOn).toBe('2026-08-31');
  });

  it('strips the date from the title', () => {
    expect(parse('ship it tomorrow').title).toBe('ship it');
    expect(parse('tomorrow ship it').title).toBe('ship it');
  });
});

describe('weekdays', () => {
  it('finds the next occurrence', () => {
    // 2026-08-17 is a Monday.
    expect(parse('gym friday').dueOn).toBe('2026-08-21');
    expect(parse('gym tuesday').dueOn).toBe('2026-08-18');
    expect(parse('gym sunday').dueOn).toBe('2026-08-23');
  });

  it('never resolves to today — "monday" on a Monday means next Monday', () => {
    expect(parse('standup monday').dueOn).toBe('2026-08-24');
  });

  it('accepts abbreviations and a next prefix', () => {
    expect(parse('gym fri').dueOn).toBe('2026-08-21');
    expect(parse('gym next friday').dueOn).toBe('2026-08-21');
    expect(parse('gym next friday').title).toBe('gym');
  });
});

describe('calendar dates', () => {
  it('parses Gregorian month names in both orders', () => {
    expect(parse('trip 25 dec').dueOn).toBe('2026-12-25');
    expect(parse('trip dec 25').dueOn).toBe('2026-12-25');
  });

  it('rolls a date that has already passed into next year', () => {
    expect(parse('taxes 1 jan').dueOn).toBe('2027-01-01');
    expect(parse('bbq 1 aug').dueOn).toBe('2027-08-01'); // 1 Aug is behind us
  });

  it('parses Jalali month names, in Latin and Persian script', () => {
    // 1 Mehr 1405 = 23 September 2026.
    expect(parse('start 1 mehr').dueOn).toBe('2026-09-23');
    expect(parse('start ۱ مهر').dueOn).toBe('2026-09-23');
  });

  it('parses an explicit ISO date', () => {
    expect(parse('review 2026-11-05').dueOn).toBe('2026-11-05');
    expect(parse('review 2026-11-05').title).toBe('review');
  });
});

describe('priority', () => {
  it('reads the shorthand forms', () => {
    expect(parse('fix bug !urgent').priority).toBe('urgent');
    expect(parse('fix bug !high').priority).toBe('high');
    expect(parse('fix bug !h').priority).toBe('high');
    expect(parse('fix bug !!').priority).toBe('high');
    expect(parse('fix bug !!!').priority).toBe('urgent');
    expect(parse('fix bug !low').priority).toBe('low');
  });

  it('strips it from the title', () => {
    expect(parse('fix bug !high').title).toBe('fix bug');
  });

  it('leaves an unrecognised bang alone', () => {
    const r = parse('ship it !now');
    expect(r.priority).toBe('none');
    expect(r.title).toBe('ship it !now');
  });
});

describe('tags and projects', () => {
  it('collects multiple tags', () => {
    const r = parse('call plumber #home #urgent-ish');
    expect(r.tags).toEqual(['home', 'urgent-ish']);
    expect(r.title).toBe('call plumber');
  });

  it('reads a project hint', () => {
    const r = parse('draft spec @renovation');
    expect(r.projectHint).toBe('renovation');
    expect(r.title).toBe('draft spec');
  });

  it('handles Persian tags', () => {
    expect(parse('خرید نان #خانه').tags).toEqual(['خانه']);
  });
});

describe('everything at once', () => {
  it('parses a fully loaded line', () => {
    const r = parse('pay hydro bill friday !high #home @apartment');
    expect(r).toMatchObject({
      title: 'pay hydro bill',
      dueOn: '2026-08-21',
      priority: 'high',
      tags: ['home'],
      projectHint: 'apartment',
    });
  });

  it('reports ranges in order so the UI can highlight them', () => {
    const r = parse('pay hydro friday !high #home');
    expect(r.matched.map((m) => m.kind)).toEqual(['date', 'priority', 'tag']);
    for (let i = 1; i < r.matched.length; i++) {
      expect(r.matched[i]!.start).toBeGreaterThanOrEqual(r.matched[i - 1]!.end);
    }
  });

  it('keeps words it does not understand', () => {
    // The cost of a missed due date is lower than the cost of a lost word.
    const r = parse('email marco about the thing eventually');
    expect(r.title).toBe('email marco about the thing eventually');
    expect(r.dueOn).toBeNull();
  });
});
