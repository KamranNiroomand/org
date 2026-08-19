import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * Narrow on purpose, same as leakageAudit.test.ts: the configuration guard,
 * not classification quality. No precedent in this codebase for hitting
 * the live Anthropic API from the normal test suite.
 *
 * Judgment verified by hand against real documents from news.ts/edgar.ts's
 * live dogfooding: correctly used 'other' with low confidence for ambiguous
 * pieces (an investor's share-sale disclosure, a market-cap milestone
 * writeup) instead of forcing a category, and used high confidence only
 * where genuinely unambiguous (a broad-market ETF commentary piece tagged
 * macro_or_sector). See the PR this shipped in for the full transcript.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('classifyDocument', () => {
  it('refuses to run without an API key, before making any request', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { classifyDocument } = await import('./events.js');
    await expect(
      classifyDocument({ title: 'Some headline', summary: null, docType: 'news', items: null }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
