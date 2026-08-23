import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * Narrow on purpose, same as narrate.test.ts: the configuration guard, not
 * judgment quality. No precedent in this codebase for hitting the live
 * Anthropic API from the normal test suite.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('adviseOnExit', () => {
  it('refuses to run without an API key, before making any request', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { adviseOnExit } = await import('./exitAdvisor.js');
    await expect(
      adviseOnExit({
        occSymbol: 'X     260101C00100000',
        underlying: 'X',
        escalationReason: 'Expected value flipped sign since entry.',
        entryPriceE4: 50_000,
        currentPriceE4: 48_000,
        targetExitPriceE4: 75_000,
        stopLossPriceE4: 25_000,
        targetExitDate: '2026-02-01',
        entryEv: 10,
        currentEv: -5,
        modelBeatsBaseline: false,
        newDocuments: [],
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
