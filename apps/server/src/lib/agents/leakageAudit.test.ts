import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * What's tested here is deliberately narrow: the configuration guard, not
 * the review quality. There is no precedent in this codebase for hitting
 * the live Anthropic API from the normal test suite (claude.ts, the existing
 * Claude-backed route, has no test file either) — a live call is slow, costs
 * money on every run, and needs a key CI may not have.
 *
 * The agent's actual judgment was verified by hand against real code: run
 * once against `features.py` as it exists in this repo (found a genuine,
 * previously-unnoticed gap — the chain functions group only by expiry, with
 * no as-of-day guard, so a multi-date panel could let a later capture supply
 * an earlier row's feature) and once against a function deliberately written
 * with a centered rolling window and a same-day-unfiltered merge (correctly
 * flagged both as high-risk lookahead). See the PR this shipped in for the
 * full transcripts.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('auditForLeakage', () => {
  it('refuses to run without an API key, before making any request', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { auditForLeakage } = await import('./leakageAudit.js');
    await expect(
      auditForLeakage({ name: 'x', kind: 'feature', sourceCode: 'def f(): pass' }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
