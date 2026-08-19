import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * Narrow on purpose, same as leakageAudit.test.ts: the configuration guard,
 * not narration quality. No precedent in this codebase for hitting the live
 * Anthropic API from the normal test suite.
 *
 * Judgment verified by hand against the real, currently-losing direction
 * model's actual manifest (563 symbols, 432 days, IC 0.0106, does not beat
 * baseline) and a real ranked contract's real numbers. The agent correctly
 * led with the model's lack of demonstrated edge rather than burying it, and
 * did not invent a catalyst or reason beyond the input fields. See the PR
 * this shipped in for the transcript.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('narrateSignal', () => {
  it('refuses to run without an API key, before making any request', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { narrateSignal } = await import('./narrate.js');
    await expect(
      narrateSignal({
        occSymbol: 'X     260101C00100000',
        underlying: 'X',
        type: 'call',
        strike: 100,
        dte: 30,
        marketPrice: 5,
        marketIv: 0.3,
        forecastVol: 0.35,
        forecastDrift: 0.05,
        ev: 10,
        evPerRisk: 0.02,
        probProfit: 0.4,
        modelBeatsBaseline: false,
        modelInformationCoefficient: 0.01,
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
