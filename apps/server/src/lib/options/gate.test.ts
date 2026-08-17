import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toE4, type OptionContract, type OptionType } from '@org/shared';
import { DEFAULT_LIQUIDITY, evaluateLiquidity, isTradeable, type GateReason } from './gate.js';

/**
 * Driven by `fixtures/options/gate-cases.json` — real NVDA rows, shared with
 * the Python backtest gate. Two implementations of one rule set will drift
 * apart eventually; pinning both to the same file makes that drift a test
 * failure rather than a silent disagreement between what the board shows and
 * what the backtest fills.
 */

interface GateCase {
  note: string;
  strike: number;
  bid: number;
  ask: number;
  openInterest: number;
  volume: number;
  liquid: boolean;
  reasons: GateReason[];
}

interface Fixture {
  asOf: string;
  underlying: string;
  expiry: string;
  type: OptionType;
  spot: number;
  thresholds: {
    minMid: number;
    maxSpreadFraction: number;
    minOpenInterest: number;
    minVolume: number;
  };
  cases: GateCase[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, '..', '..', '..', '..', '..', 'fixtures', 'options', 'gate-cases.json'), 'utf8'),
) as Fixture;

const contractFor = (strike: number): OptionContract => ({
  underlying: fixture.underlying,
  expiry: fixture.expiry,
  type: fixture.type,
  strikeE4: toE4(strike),
});

const inputFor = (c: GateCase) => ({
  contract: contractFor(c.strike),
  bidE4: toE4(c.bid),
  askE4: toE4(c.ask),
  openInterest: c.openInterest,
  volume: c.volume,
  spotE4: toE4(fixture.spot),
});

describe('liquidity gate — real NVDA chain', () => {
  it('agrees with the fixture thresholds', () => {
    // If a default moves, the fixture must move with it deliberately.
    expect(DEFAULT_LIQUIDITY.minMidE4).toBe(toE4(fixture.thresholds.minMid));
    expect(DEFAULT_LIQUIDITY.maxSpreadFraction).toBe(fixture.thresholds.maxSpreadFraction);
    expect(DEFAULT_LIQUIDITY.minOpenInterest).toBe(fixture.thresholds.minOpenInterest);
    expect(DEFAULT_LIQUIDITY.minVolume).toBe(fixture.thresholds.minVolume);
  });

  for (const c of fixture.cases) {
    it(`$${c.strike}: ${c.liquid ? 'passes' : 'rejects'} — ${c.note}`, () => {
      const verdict = evaluateLiquidity(inputFor(c));
      expect(verdict.liquid).toBe(c.liquid);
      expect([...verdict.reasons].sort()).toEqual([...c.reasons].sort());
    });
  }

  it('keeps the tradeable set small even on the most liquid name on the board', () => {
    const passing = fixture.cases.filter((c) => isTradeable(inputFor(c)));
    expect(passing).toHaveLength(5);
    // The whole point: NVDA is liquid at $227.50 and untradeable at $207.50.
    expect(passing.map((c) => c.strike)).toContain(227.5);
    expect(passing.map((c) => c.strike)).not.toContain(207.5);
  });
});

describe('liquidity gate — derived quantities', () => {
  it('reports mid and spread fraction for a usable quote', () => {
    const v = evaluateLiquidity(inputFor(fixture.cases[0]!));
    expect(v.midE4).toBe(toE4(1.12));
    expect(v.spreadFraction).toBeCloseTo(0.04 / 1.12, 10);
  });

  it('reports null mid rather than a number when the quote is unusable', () => {
    // Returning 0.005 here would let a caller treat an unsellable contract as
    // a half-cent one. Null forces the caller to handle it.
    const zeroBid = fixture.cases.find((c) => c.bid === 0)!;
    const v = evaluateLiquidity(inputFor(zeroBid));
    expect(v.midE4).toBeNull();
    expect(v.spreadFraction).toBeNull();
  });

  it('collects every failing rule, not just the first', () => {
    const zeroBid = fixture.cases.find((c) => c.bid === 0)!;
    expect(evaluateLiquidity(inputFor(zeroBid)).reasons).toHaveLength(4);
  });

  it('flags a crossed market as bad data', () => {
    const v = evaluateLiquidity({
      contract: contractFor(227.5),
      bidE4: toE4(1.2),
      askE4: toE4(1.1),
      openInterest: 5000,
      volume: 5000,
      spotE4: toE4(fixture.spot),
    });
    expect(v.reasons).toContain('crossed');
    expect(v.liquid).toBe(false);
  });

  it('skips the intrinsic check when spot is unknown', () => {
    // Capture always has an underlying price, but a backfill row might not,
    // and a missing spot must not manufacture a rejection.
    const belowIntrinsic = fixture.cases.find((c) => c.strike === 207.5)!;
    const v = evaluateLiquidity({ ...inputFor(belowIntrinsic), spotE4: 0 });
    expect(v.reasons).not.toContain('below-intrinsic');
    expect(v.reasons).toContain('spread-too-wide');
  });

  it('respects loosened thresholds', () => {
    const belowIntrinsic = fixture.cases.find((c) => c.strike === 212.5)!;
    expect(isTradeable(inputFor(belowIntrinsic))).toBe(false);
    expect(
      isTradeable(inputFor(belowIntrinsic), { ...DEFAULT_LIQUIDITY, maxSpreadFraction: 0.25 }),
    ).toBe(true);
  });
});
