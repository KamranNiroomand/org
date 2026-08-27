import { afterEach, describe, expect, it, vi } from 'vitest';

/** Narrow on purpose — see specialists.test.ts's own doc comment. */

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
  radar: null,
  recentDocuments: [],
};

describe('runSynthesis', () => {
  it('refuses to run without an API key, before making any request', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { runSynthesis } = await import('./synthesize.js');
    await expect(runSynthesis(CTX, [], [])).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
