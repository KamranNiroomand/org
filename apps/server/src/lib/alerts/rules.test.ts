import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICE_THRESHOLDS, evaluatePriceRules, type InstrumentSnapshot } from './rules.js';

const base: InstrumentSnapshot = {
  symbol: 'TEST',
  price: 100,
  dayChangePercent: 0,
  fiftyTwoWeekHigh: 150,
  fiftyTwoWeekLow: 50,
  volume: 1_000_000,
  avgVolume10Day: 1_000_000,
};

describe('evaluatePriceRules', () => {
  it('fires nothing for an unremarkable day', () => {
    expect(evaluatePriceRules(base)).toEqual([]);
  });

  it('fires day_change_down on a 9% drop', () => {
    const hits = evaluatePriceRules({ ...base, dayChangePercent: -9.2 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ruleKey: 'day_change_down', direction: 'bearish' });
  });

  it('fires day_change_up on a 9% jump', () => {
    const hits = evaluatePriceRules({ ...base, dayChangePercent: 9.2 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ruleKey: 'day_change_up', direction: 'bullish' });
  });

  it('does not fire below the threshold', () => {
    expect(evaluatePriceRules({ ...base, dayChangePercent: -6.9 })).toEqual([]);
  });

  it('fires new_52w_high when price meets or exceeds the high', () => {
    const hits = evaluatePriceRules({ ...base, price: 150 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ruleKey: 'new_52w_high', direction: 'bullish' });
  });

  it('fires new_52w_low when price meets or falls below the low', () => {
    const hits = evaluatePriceRules({ ...base, price: 50 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ruleKey: 'new_52w_low', direction: 'bearish' });
  });

  it('fires only new_52w_high, never both, when the 52-week range is degenerate', () => {
    // A same-day IPO or thin data can report high === low === price — both
    // conditions are technically true, but only one alert should fire.
    const hits = evaluatePriceRules({ ...base, price: 100, fiftyTwoWeekHigh: 100, fiftyTwoWeekLow: 100 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.ruleKey).toBe('new_52w_high');
  });

  it('fires volume_spike at 3x the 10-day average, direction neutral', () => {
    const hits = evaluatePriceRules({ ...base, volume: 3_000_000, avgVolume10Day: 1_000_000 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ruleKey: 'volume_spike', direction: 'neutral' });
  });

  it('does not divide by zero when avgVolume10Day is 0', () => {
    expect(evaluatePriceRules({ ...base, volume: 500, avgVolume10Day: 0 })).toEqual([]);
  });

  it('returns every rule that fires, not just the first', () => {
    const hits = evaluatePriceRules({
      ...base,
      price: 50,
      dayChangePercent: -8,
      volume: 5_000_000,
      avgVolume10Day: 1_000_000,
    });
    const keys = hits.map((h) => h.ruleKey).sort();
    expect(keys).toEqual(['day_change_down', 'new_52w_low', 'volume_spike'].sort());
  });

  it('skips null fields rather than treating them as zero', () => {
    expect(
      evaluatePriceRules({
        symbol: 'TEST',
        price: null,
        dayChangePercent: null,
        fiftyTwoWeekHigh: null,
        fiftyTwoWeekLow: null,
        volume: null,
        avgVolume10Day: null,
      }),
    ).toEqual([]);
  });

  it('respects custom thresholds', () => {
    const hits = evaluatePriceRules(
      { ...base, dayChangePercent: -3 },
      { ...DEFAULT_PRICE_THRESHOLDS, dayChangePercent: 2 },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.ruleKey).toBe('day_change_down');
  });
});
