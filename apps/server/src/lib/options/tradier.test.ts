import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTradierQuotes, toTradierSymbol } from './tradier.js';

const OCC = 'AAPL  261016C00255000';

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe('tradier quotes', () => {
  beforeEach(() => {
    process.env.TRADIER_API_KEY = 'test-token';
  });

  it('strips OCC padding into Tradier spelling', () => {
    expect(toTradierSymbol(OCC)).toBe('AAPL261016C00255000');
  });

  it('parses the single-object envelope and maps back to our OCC symbol', async () => {
    const quotes = await fetchTradierQuotes(
      [OCC],
      fetchReturning({ quotes: { quote: { symbol: 'AAPL261016C00255000', bid: 55.1, ask: 56.4, last: 55.9 } } }),
    );
    expect(quotes.get(OCC)).toEqual({ bidE4: 551_000, askE4: 564_000, lastE4: 559_000 });
  });

  it('parses the array envelope', async () => {
    const other = 'AMD   261016C00420000';
    const quotes = await fetchTradierQuotes(
      [OCC, other],
      fetchReturning({
        quotes: {
          quote: [
            { symbol: 'AAPL261016C00255000', bid: 55.1, ask: 56.4, last: null },
            { symbol: 'AMD261016C00420000', bid: 73.0, ask: 74.2, last: 73.5 },
          ],
        },
      }),
    );
    expect(quotes.size).toBe(2);
    expect(quotes.get(other)!.bidE4).toBe(730_000);
  });

  it('degrades to an empty map on any failure — realism is an overlay, not a dependency', async () => {
    expect((await fetchTradierQuotes([OCC], fetchReturning({}, false))).size).toBe(0);
    const throwing = vi.fn(async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect((await fetchTradierQuotes([OCC], throwing)).size).toBe(0);
  });

  it('treats a zero bid as no bid — nobody is actually there', async () => {
    const quotes = await fetchTradierQuotes(
      [OCC],
      fetchReturning({ quotes: { quote: { symbol: 'AAPL261016C00255000', bid: 0, ask: 0.05, last: 0.03 } } }),
    );
    expect(quotes.get(OCC)!.bidE4).toBeNull();
  });
});
