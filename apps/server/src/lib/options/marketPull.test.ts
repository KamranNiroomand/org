import { describe, expect, it } from 'vitest';
import { pullMarketSnapshot } from './marketPull.js';

/**
 * The test environment defaults to MARKET_ROLE=runner (see role.test.ts),
 * so this pins the one branch reachable without faking a reader identity:
 * a runner must never attempt to pull from itself.
 */
describe('pullMarketSnapshot', () => {
  it('refuses to run on a runner', async () => {
    const result = await pullMarketSnapshot();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('runner');
  });
});
