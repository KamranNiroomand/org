import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Narrow on purpose, same as narrate.test.ts/leakageAudit.test.ts: the
 * configuration guard, not reasoning quality. No precedent in this codebase
 * for hitting the live Anthropic API from the normal test suite — panel
 * output quality was verified by hand against real box queries (NVDA, AAPL,
 * MRNA, a thematic energy-sector query) during development; see the PR this
 * shipped in for those transcripts.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const CTX = {
  symbol: 'TEST',
  name: 'Test Co',
  price: 100,
  dayChangePercent: 1,
  marketCap: 1_000_000_000,
  sector: 'Information Technology',
  trailingPe: 20,
  forwardPe: 18,
  priceToBook: 5,
  dividendYield: null,
  fiftyTwoWeekHigh: 120,
  fiftyTwoWeekLow: 80,
  volume: 1_000_000,
  avgVolume10Day: 900_000,
  holding: null,
  sectorPulse: null,
  heldThesis: null,
  radar: null,
  recentDocuments: [],
};

describe('runRound1', () => {
  it('refuses to run without an API key, before making any request', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { runRound1 } = await import('./specialists.js');
    await expect(runRound1('momentum', CTX)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('runRound2', () => {
  it('refuses to run without an API key, before making any request', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { runRound2 } = await import('./specialists.js');
    await expect(runRound2('momentum', CTX, [])).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
