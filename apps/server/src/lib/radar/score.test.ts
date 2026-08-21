import { describe, expect, it } from 'vitest';
import {
  computePopulationStats,
  isEligible,
  scoreInstrument,
  RADAR_MIN_AVG_VOLUME,
  RADAR_MIN_MARKET_CAP_USD,
  type RadarInputs,
} from './score.js';

const base: RadarInputs = {
  symbol: 'TEST',
  price: 100,
  dayChangePercent: 0,
  fiftyTwoWeekHigh: 150,
  fiftyTwoWeekLow: 50,
  volume: 1_000_000,
  avgVolume10Day: 1_000_000,
  marketCap: 1_000_000_000,
  sentimentScore: null,
  sentimentDocCount: 0,
};

describe('isEligible', () => {
  it('accepts a normal large-cap row', () => {
    expect(isEligible(base)).toBe(true);
  });

  it('rejects a market cap below the floor', () => {
    expect(isEligible({ ...base, marketCap: RADAR_MIN_MARKET_CAP_USD - 1 })).toBe(false);
  });

  it('accepts a market cap exactly at the floor', () => {
    expect(isEligible({ ...base, marketCap: RADAR_MIN_MARKET_CAP_USD })).toBe(true);
  });

  it('rejects thin average volume', () => {
    expect(isEligible({ ...base, avgVolume10Day: RADAR_MIN_AVG_VOLUME - 1 })).toBe(false);
  });

  it('rejects a missing price', () => {
    expect(isEligible({ ...base, price: null })).toBe(false);
  });

  it('rejects a missing market cap', () => {
    expect(isEligible({ ...base, marketCap: null })).toBe(false);
  });
});

describe('computePopulationStats', () => {
  it('returns zero mean/stdDev for an empty population', () => {
    const stats = computePopulationStats([]);
    expect(stats.momentum).toEqual({ mean: 0, stdDev: 0 });
    expect(stats.sentiment).toBeNull();
  });

  it('computes real mean/stdDev across the population', () => {
    const stats = computePopulationStats([
      { ...base, dayChangePercent: -10 },
      { ...base, dayChangePercent: 0 },
      { ...base, dayChangePercent: 10 },
    ]);
    expect(stats.momentum.mean).toBeCloseTo(0);
    expect(stats.momentum.stdDev).toBeGreaterThan(0);
  });

  it('leaves sentiment stats null when nothing in the population has coverage', () => {
    const stats = computePopulationStats([base, { ...base, symbol: 'B' }]);
    expect(stats.sentiment).toBeNull();
  });

  it('computes sentiment stats only from covered rows', () => {
    const stats = computePopulationStats([
      base, // uncovered — must not pull the mean toward 0
      { ...base, symbol: 'B', sentimentScore: 1, sentimentDocCount: 2 },
      { ...base, symbol: 'C', sentimentScore: -1, sentimentDocCount: 1 },
    ]);
    expect(stats.sentiment).not.toBeNull();
    expect(stats.sentiment!.mean).toBeCloseTo(0);
  });
});

describe('scoreInstrument', () => {
  const flatStats = computePopulationStats([base, { ...base, symbol: 'B' }, { ...base, symbol: 'C' }]);

  it('scores a symbol at its 52-week high with a volume spike near the top of a varied population', () => {
    const population = [
      { ...base, symbol: 'A', dayChangePercent: -5 },
      { ...base, symbol: 'B', dayChangePercent: 0 },
      { ...base, symbol: 'C', dayChangePercent: 5 },
      { ...base, symbol: 'HOT', dayChangePercent: 15, price: 150, volume: 5_000_000 },
    ];
    const stats = computePopulationStats(population);
    const hot = scoreInstrument(population[3]!, stats);
    const cold = scoreInstrument(population[0]!, stats);

    expect(hot.newHigh).toBe(true);
    expect(hot.score).toBeGreaterThan(cold.score);
  });

  it('a micro-cap below the eligibility floor is never even offered to scoreInstrument by run.ts — isEligible is the gate', () => {
    // scoreInstrument itself doesn't re-check eligibility (run.ts filters
    // before calling it) — this test documents that boundary explicitly so
    // a future refactor doesn't accidentally assume scoreInstrument enforces it.
    expect(isEligible({ ...base, marketCap: 1_000_000 })).toBe(false);
  });

  it('marks newHigh true only when price meets or exceeds the 52-week high', () => {
    const at = scoreInstrument({ ...base, price: 150, fiftyTwoWeekHigh: 150 }, flatStats);
    const below = scoreInstrument({ ...base, price: 149, fiftyTwoWeekHigh: 150 }, flatStats);
    expect(at.newHigh).toBe(true);
    expect(below.newHigh).toBe(false);
  });

  it('does not compute a trend component for a degenerate 52-week range', () => {
    const degenerate = scoreInstrument({ ...base, fiftyTwoWeekHigh: 100, fiftyTwoWeekLow: 100 }, flatStats);
    expect(degenerate.trendPct).toBeNull();
    expect(degenerate.inputsUsed).not.toContain('fiftyTwoWeekRange');
  });

  it('skips the volume component without dividing by zero when avgVolume10Day is 0', () => {
    const row = scoreInstrument({ ...base, avgVolume10Day: 0 }, flatStats);
    expect(row.volumeRatio).toBeNull();
    expect(row.volumeZ).toBeNull();
    expect(Number.isFinite(row.score)).toBe(true);
  });

  it('excludes sentiment from the score when the symbol has no document coverage', () => {
    const row = scoreInstrument(base, flatStats); // sentimentDocCount: 0
    expect(row.sentimentZ).toBeNull();
    expect(row.inputsUsed).not.toContain('sentimentScore');
  });

  it('lists every input that actually contributed', () => {
    const row = scoreInstrument({ ...base, sentimentScore: 0.5, sentimentDocCount: 3 }, {
      ...flatStats,
      sentiment: { mean: 0, stdDev: 1 },
    });
    expect(row.inputsUsed).toEqual(
      expect.arrayContaining(['dayChangePercent', 'fiftyTwoWeekRange', 'volumeRatio', 'sentimentScore']),
    );
  });

  it('returns a score of 0 with no inputs used when every field is null', () => {
    const empty: RadarInputs = {
      symbol: 'EMPTY',
      price: null,
      dayChangePercent: null,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
      volume: null,
      avgVolume10Day: null,
      marketCap: null,
      sentimentScore: null,
      sentimentDocCount: 0,
    };
    const row = scoreInstrument(empty, flatStats);
    expect(row.score).toBe(0);
    expect(row.inputsUsed).toEqual([]);
  });
});
