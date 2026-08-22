import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../db/index.js';
import { runMigrations } from '../../../db/migrate.js';
import { instruments } from '../../../db/schema.js';
import { nowIso } from '../../util.js';

beforeEach(() => {
  runMigrations();
  db.delete(instruments).run();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function seedInstrument(symbol: string, name: string, sector: string | null = 'Health Care') {
  db.insert(instruments)
    .values({ symbol, name, exchange: 'NASDAQ', country: 'US', sector, listedAt: nowIso() })
    .run();
}

describe('resolveBoxQuery', () => {
  it('resolves an exact ticker with zero LLM calls', async () => {
    seedInstrument('MRNA', 'Moderna, Inc.');
    vi.stubEnv('ANTHROPIC_API_KEY', ''); // proves this path never needs one
    const { resolveBoxQuery } = await import('./boxResolve.js');

    const result = await resolveBoxQuery('MRNA');
    expect(result).toEqual({ symbols: ['MRNA'], resolutionMethod: 'ticker_match', normalizedTheme: null });
  });

  it('is case-insensitive on the ticker', async () => {
    seedInstrument('MRNA', 'Moderna, Inc.');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { resolveBoxQuery } = await import('./boxResolve.js');

    const result = await resolveBoxQuery('mrna');
    expect(result.symbols).toEqual(['MRNA']);
  });

  it('falls back to a company-name match when the query is not a real ticker', async () => {
    seedInstrument('MRNA', 'Moderna, Inc.');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { resolveBoxQuery } = await import('./boxResolve.js');

    const result = await resolveBoxQuery('moderna');
    expect(result).toEqual({ symbols: ['MRNA'], resolutionMethod: 'ticker_match', normalizedTheme: null });
  });

  it('reaches the thematic path (needs an API key) when nothing matches directly', async () => {
    seedInstrument('MRNA', 'Moderna, Inc.');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { resolveBoxQuery } = await import('./boxResolve.js');

    await expect(resolveBoxQuery('what looks good in defense right now')).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
