/**
 * Economic invariants — assertions about what numbers are ALLOWED TO
 * MEAN, not about what code does. Every bug this week that survived a
 * green test suite (EV 525% of risk, P(profit) 100%, a Saturday fill, a
 * fifth of the account in one order) was an economics bug wearing
 * correct code: the implementation faithfully computed a number that no
 * honest trading system may produce. These tests are the fence at that
 * altitude. When one fails, the question is never "is the test stale" —
 * it is "which rule stopped meaning what it says".
 */
import { describe, expect, it } from 'vitest';
import {
  priceDistress,
  regimeEntryCap,
  stockStopPct,
  stockTargetPct,
  thesisExitAction,
} from './stockEngine.js';

// A coarse sweep of the space each rule can be called with — invariants
// hold everywhere, not at hand-picked examples.
const VOLS = [null, 0, 0.05, 0.2, 0.5, 1.0, 2.0, 5.0];
const BOOKS = [
  { book: 'short' as const, horizon: 21, sigmas: 1.5, ceiling: 0.2 },
  { book: 'long' as const, horizon: 126, sigmas: 2, ceiling: 0.3 },
];

describe('stops and targets', () => {
  it('a stop is always a real stop: between 5% and the book ceiling, for any volatility', () => {
    for (const { horizon, sigmas, ceiling } of BOOKS) {
      for (const vol of VOLS) {
        const stop = stockStopPct(vol, horizon, sigmas, ceiling);
        expect(stop).toBeGreaterThanOrEqual(0.05);
        expect(stop).toBeLessThanOrEqual(Math.max(ceiling, 0.12));
      }
    }
  });

  it('the target is always beyond the stop, and the breakeven ratchet is always reachable before it', () => {
    for (const { book, horizon, sigmas, ceiling } of BOOKS) {
      for (const vol of VOLS) {
        const stop = stockStopPct(vol, horizon, sigmas, ceiling);
        const target = stockTargetPct(stop, book);
        expect(target).toBeGreaterThan(stop);
        // The ratchet arms at halfway-to-target; it must sit strictly
        // below the target or a winner can never be locked in.
        expect(target / 2).toBeLessThan(target);
        expect(target / 2).toBeGreaterThan(0);
      }
    }
  });
});

describe('position lifecycle rules', () => {
  it('no single panel read can ever close a long-book position', () => {
    const verdicts = ['intact', 'weakened', 'broken'] as const;
    for (const single of verdicts) {
      expect(thesisExitAction([single])).not.toBe('exit');
    }
    for (const first of verdicts) {
      for (const second of verdicts) {
        const action = thesisExitAction([first, second]);
        if (action === 'exit') {
          expect(first).toBe('broken');
          expect(second).toBe('broken');
        }
      }
    }
  });

  it('a protected position never raises a distress alarm', () => {
    // Stop at or above entry = the ratchet already fired; there is no
    // loss left to bound, so no review may be summoned.
    for (const price of [50_0000, 90_0000, 110_0000]) {
      expect(
        priceDistress({ priceE4: price, entryPriceE4: 100_0000, stopPriceE4: 100_0000, dayChangePercent: -30 }),
      ).toBeNull();
    }
  });
});

describe('exposure throttles', () => {
  it('no regime can reduce the entry budget to zero — throttled is never halted', () => {
    for (const regime of ['risk_on', 'neutral', 'risk_off', 'unknown'] as const) {
      for (const max of [1, 2, 3, 8]) {
        expect(regimeEntryCap(max, regime)).toBeGreaterThanOrEqual(1);
        expect(regimeEntryCap(max, regime)).toBeLessThanOrEqual(max);
      }
    }
  });

  it('an unknown regime spends the full budget — fail-open, never fail-closed', () => {
    for (const max of [1, 3, 8]) {
      expect(regimeEntryCap(max, 'unknown')).toBe(max);
    }
  });
});
