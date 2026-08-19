import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * Narrow on purpose, same as leakageAudit.test.ts: the configuration guard,
 * not proposal quality. No precedent in this codebase for hitting the live
 * Anthropic API from the normal test suite.
 *
 * Judgment verified by hand against the real current model context (563
 * symbols, 432 days, six momentum/volume-z columns, IC 0.0106, does not
 * beat baseline). The agent correctly distinguished bars-only features
 * (buildable today) from chain-surface ideas needing more captured history,
 * and did not merely propose more momentum windows. See the PR this shipped
 * in for the transcript.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('proposeHypotheses', () => {
  it('refuses to run without an API key, before making any request', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { proposeHypotheses } = await import('./hypotheses.js');
    await expect(
      proposeHypotheses({
        target: 'dir',
        currentFeatureCols: ['momentum_1d'],
        currentInformationCoefficient: 0.01,
        currentBeatsBaseline: false,
        nSymbols: 563,
        nTrainDays: 432,
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
