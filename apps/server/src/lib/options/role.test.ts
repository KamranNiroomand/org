import { describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { assertRunner, isRunner, ReadOnlyCorpusError } from './role.js';

/**
 * The two-machine setup has one rule and breaking it is silent: a synced
 * folder written by two machines produces conflicted copies under names no
 * reader looks for, so data appears to vanish rather than to conflict. These
 * tests pin that the guard exists and that its message tells you which knob to
 * turn — an error nobody can act on is barely better than no error.
 */
describe('corpus write guard', () => {
  it('defaults to runner, so a single-machine setup needs no configuration', () => {
    expect(config.market.role).toBe('runner');
    expect(isRunner()).toBe(true);
    expect(() => assertRunner('capture option chains')).not.toThrow();
  });

  it('names the action, the path, and the fix', () => {
    const err = new ReadOnlyCorpusError('capture option chains');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReadOnlyCorpusError');
    expect(err.message).toContain('capture option chains');
    expect(err.message).toContain(config.market.dataDir);
    expect(err.message).toContain('MARKET_ROLE=runner');
  });
});
