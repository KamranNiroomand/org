import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatOccSymbol, toE4, type OptionType } from '@org/shared';
import { marketDb } from '../../db/market/index.js';
import { optionContracts, optionQuotes, captureRuns } from '../../db/market/schema.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { captureChains } from './capture.js';
import { repriceDay } from './reprice.js';
import type { ChainQuote, ChainRequest, DailyBar, OptionsProvider } from './provider.js';

/**
 * The scenario this exists for: capture writes a row, but the sidecar was
 * unreachable at the time, so `iv_bps` is null even though the row is
 * genuinely liquid. Reprice must find exactly those rows and nothing else —
 * not the illiquid ones, not ones already priced — without touching the
 * provider at all.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, '..', '..', '..', '..', '..', 'fixtures', 'options', 'gate-cases.json'), 'utf8'),
) as {
  underlying: string;
  expiry: string;
  type: OptionType;
  spot: number;
  cases: Array<{ strike: number; bid: number; ask: number; openInterest: number; volume: number; liquid: boolean }>;
};

const ASOF = '2026-08-17T21:30:00.000Z';
const DAY = '2026-08-17';

function chainFromFixture(): ChainQuote[] {
  return fixture.cases.map((c) => {
    const contract = {
      underlying: fixture.underlying,
      expiry: fixture.expiry,
      type: fixture.type,
      strikeE4: toE4(c.strike),
    };
    return {
      occSymbol: formatOccSymbol(contract),
      underlying: contract.underlying,
      expiry: contract.expiry,
      type: contract.type,
      strikeE4: contract.strikeE4,
      multiplier: 100,
      bidE4: toE4(c.bid),
      askE4: toE4(c.ask),
      lastE4: null,
      closeE4: toE4((c.bid + c.ask) / 2),
      volume: c.volume,
      openInterest: c.openInterest,
      underlyingE4: toE4(fixture.spot),
      asOf: ASOF,
      tradingDay: DAY,
      vendorIv: null,
    } satisfies ChainQuote;
  });
}

class StubProvider implements OptionsProvider {
  readonly name = 'stub';
  async fetchChain(_request: ChainRequest): Promise<ChainQuote[]> {
    return chainFromFixture();
  }
  async fetchBars(): Promise<DailyBar[]> {
    return [];
  }
  async probe() {
    return {
      name: this.name,
      liveChain: true,
      historicalChain: false,
      historicalQuotes: false,
      equityBars: true,
      news: false,
      notes: [],
    };
  }
}

beforeAll(async () => {
  runMarketMigrations();
  marketDb.delete(optionQuotes).run();
  marketDb.delete(optionContracts).run();
  marketDb.delete(captureRuns).run();
  // No quant sidecar in this suite, so this leaves every row un-priced —
  // exactly the state a rate-limited or cold-sidecar capture leaves behind.
  await captureChains(new StubProvider(), ['NVDA']);
});

describe('repriceDay', () => {
  it('only selects liquid, unpriced rows for the requested day — never touches the provider', async () => {
    const liquidCount = fixture.cases.filter((c) => c.liquid).length;
    const summary = await repriceDay(DAY);

    expect(summary.tradingDay).toBe(DAY);
    expect(summary.candidates).toBe(liquidCount);
  });

  it('reports plainly when the sidecar is unavailable rather than pretending nothing was found', async () => {
    // The suite never runs the Python sidecar, so this is the honest path.
    const summary = await repriceDay(DAY);
    expect(summary.quantAvailable).toBe(false);
    expect(summary.priced).toBe(0);
    expect(summary.candidates).toBeGreaterThan(0);
  });

  it('finds nothing for a day with no captured quotes', async () => {
    const summary = await repriceDay('2099-01-01');
    expect(summary.candidates).toBe(0);
    expect(summary.priced).toBe(0);
  });
});
