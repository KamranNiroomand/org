import { afterEach, describe, expect, it, vi } from 'vitest';
import { filterValidSectors } from './resolveTheme.js';

describe('filterValidSectors', () => {
  it('keeps only sectors from the offered list', () => {
    expect(filterValidSectors(['Energy', 'Health Care'], ['Energy', 'Health Care', 'Utilities'])).toEqual([
      'Energy',
      'Health Care',
    ]);
  });

  it('drops a hallucinated sector not in the offered list', () => {
    expect(filterValidSectors(['Energy', 'Quantum Computing'], ['Energy', 'Health Care'])).toEqual(['Energy']);
  });

  it('returns empty when nothing matches', () => {
    expect(filterValidSectors(['Nonexistent'], ['Energy'])).toEqual([]);
  });
});

/** Narrow on purpose — see specialists.test.ts's own doc comment. */
describe('resolveThemeQuery', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses to run without an API key, before making any request', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { resolveThemeQuery } = await import('./resolveTheme.js');
    await expect(resolveThemeQuery('what looks good in energy', ['Energy'])).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
