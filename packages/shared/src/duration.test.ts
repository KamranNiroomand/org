import { describe, expect, it } from 'vitest';
import { elapsedSeconds, formatDuration, formatElapsed, parseDuration } from './duration.js';

describe('parseDuration', () => {
  it('reads a bare number as minutes', () => {
    expect(parseDuration('30')).toBe(30);
    expect(parseDuration('90')).toBe(90);
  });

  it('reads explicit minute units', () => {
    for (const s of ['30m', '30 min', '30mins', '30 minutes']) {
      expect(parseDuration(s)).toBe(30);
    }
  });

  it('reads hours, with and without a minute tail', () => {
    expect(parseDuration('2h')).toBe(120);
    expect(parseDuration('1h30')).toBe(90);
    expect(parseDuration('1h 30m')).toBe(90);
    expect(parseDuration('1.5h')).toBe(90);
    expect(parseDuration('1,5h')).toBe(90);
  });

  it('accepts Persian digits, like the money parser', () => {
    expect(parseDuration('۹۰')).toBe(90);
    expect(parseDuration('۲h')).toBe(120);
  });

  it('is case- and space-insensitive', () => {
    expect(parseDuration('  2 HRS ')).toBe(120);
  });

  it('returns null rather than throwing on a half-typed or junk value', () => {
    for (const s of ['', '   ', 'h', 'abc', '1h2h', '--5', '30m30']) {
      expect(parseDuration(s)).toBeNull();
    }
  });

  it('round-trips through formatDuration', () => {
    for (const mins of [0, 1, 30, 45, 60, 90, 120, 605]) {
      expect(parseDuration(formatDuration(mins))).toBe(mins);
    }
  });
});

describe('formatDuration', () => {
  it('drops the hour when there is none and the minutes when they are zero', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(90)).toBe('1h 30m');
  });

  it('clamps negatives', () => {
    expect(formatDuration(-5)).toBe('0m');
  });
});

describe('formatElapsed', () => {
  it('shows seconds under a minute, so a fresh timer looks alive', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12)).toBe('12s');
    expect(formatElapsed(59)).toBe('59s');
  });

  it('shows whole minutes under an hour', () => {
    expect(formatElapsed(60)).toBe('1m');
    expect(formatElapsed(2_700)).toBe('45m');
  });

  it('zero-pads minutes above an hour so the width is stable', () => {
    expect(formatElapsed(3_600)).toBe('1h 00m');
    expect(formatElapsed(7_500)).toBe('2h 05m');
    expect(formatElapsed(36_000)).toBe('10h 00m');
  });
});

describe('elapsedSeconds', () => {
  const start = '2026-08-17T14:00:00.000Z';
  const now = Date.parse('2026-08-17T14:10:00.000Z');

  it('returns only banked time when no timer runs', () => {
    expect(elapsedSeconds(120, null, now)).toBe(120);
  });

  it('adds the open interval to the banked total', () => {
    expect(elapsedSeconds(120, start, now)).toBe(720);
  });

  it('never runs backwards if the clock moves', () => {
    expect(elapsedSeconds(120, start, Date.parse('2026-08-17T13:00:00.000Z'))).toBe(120);
  });

  it('ignores an unparseable start rather than returning NaN', () => {
    expect(elapsedSeconds(120, 'not-an-instant', now)).toBe(120);
  });
});
