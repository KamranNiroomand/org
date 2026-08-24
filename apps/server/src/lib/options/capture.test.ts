import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatOccSymbol, toE4, type OptionType } from '@org/shared';
import { marketDb } from '../../db/market/index.js';
import { optionContracts, optionQuotes, captureRuns } from '../../db/market/schema.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { captureChains } from './capture.js';
import type { ChainQuote, ChainRequest, DailyBar, OptionsProvider } from './provider.js';

/**
 * End-to-end capture against a stub provider.
 *
 * The point is to exercise the pipeline without a vendor subscription, and in
 * particular to pin the property that matters most: a raw quote is written
 * whether or not anything downstream succeeds. Implied vol can be recomputed
 * from a stored row forever; a past day's bid and ask cannot be re-fetched at
 * any price, so nothing may be allowed to cost us one.
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
      underlyingAsOfDay: DAY,
      asOf: ASOF,
      tradingDay: DAY,
      vendorIv: null,
    } satisfies ChainQuote;
  });
}

class StubProvider implements OptionsProvider {
  readonly name = 'stub';
  calls = 0;
  readonly rateLimitState?: () => { throttled: boolean; multiplier: number };

  constructor(
    private readonly failOn: Set<string> = new Set(),
    rateLimit?: { throttled: boolean; multiplier: number },
  ) {
    // A real OptionsProvider either has this method or doesn't — matched
    // here by only assigning it when a test actually wants rate-limit
    // state reported, rather than always defining it and returning
    // undefined (which the interface's optional-method contract disallows).
    if (rateLimit) this.rateLimitState = () => rateLimit;
  }

  async fetchChain(request: ChainRequest): Promise<ChainQuote[]> {
    this.calls += 1;
    if (this.failOn.has(request.underlying)) throw new Error('vendor exploded');
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

beforeAll(() => {
  runMarketMigrations();
  marketDb.delete(optionQuotes).run();
  marketDb.delete(optionContracts).run();
  marketDb.delete(captureRuns).run();
});

describe('chain capture', () => {
  it('writes contracts and quotes, and records the gate verdict per row', async () => {
    const summary = await captureChains(new StubProvider(), ['NVDA']);

    expect(summary.quotesWritten).toBe(fixture.cases.length);
    expect(summary.contractsSeen).toBe(fixture.cases.length);
    // Five of the eleven real rows are genuinely tradeable.
    expect(summary.liquidWritten).toBe(fixture.cases.filter((c) => c.liquid).length);

    const rows = marketDb.select().from(optionQuotes).all();
    expect(rows).toHaveLength(fixture.cases.length);

    const byStrike = new Map(
      marketDb
        .select()
        .from(optionContracts)
        .all()
        .map((c) => [c.strikeE4, c.occSymbol]),
    );
    const quoteFor = (strike: number) =>
      rows.find((r) => r.occSymbol === byStrike.get(toE4(strike)))!;

    // The rows that made the design: liquid at $227.50, untradeable at $207.50.
    expect(quoteFor(227.5).liquid).toBe(true);
    expect(quoteFor(207.5).liquid).toBe(false);
    expect(quoteFor(207.5).gateReasons).toContain('below-intrinsic');
    expect(quoteFor(390).gateReasons).toContain('no-bid');
  });

  it('stores the raw quote even when nothing downstream can enrich it', async () => {
    // The sidecar is not running in this suite, so every implied vol is null.
    // The quotes must still be here — that asymmetry is the whole point.
    const rows = marketDb.select().from(optionQuotes).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.ivBps).toBeNull();
      expect(r.bidE4).toBeGreaterThanOrEqual(0);
      expect(r.underlyingE4).toBeGreaterThan(0);
    }
  });

  it('is idempotent — re-running a capture does not duplicate a day', async () => {
    const before = marketDb.select().from(optionQuotes).all().length;
    await captureChains(new StubProvider(), ['NVDA']);
    const after = marketDb.select().from(optionQuotes).all().length;
    expect(after).toBe(before);
  });

  it('notes a still-throttled rate-limit pacer in the run summary', async () => {
    const provider = new StubProvider(undefined, { throttled: true, multiplier: 4 });
    const summary = await captureChains(provider, ['NVDA']);
    expect(summary.errors.some((e) => e.includes('still throttled at 4.0x'))).toBe(true);
  });

  it('says nothing about the pacer when the provider reports no throttling', async () => {
    const provider = new StubProvider(undefined, { throttled: false, multiplier: 1 });
    const summary = await captureChains(provider, ['NVDA']);
    expect(summary.errors.some((e) => e.includes('throttled'))).toBe(false);
  });

  it('keeps going when one underlying fails, and records why', async () => {
    const provider = new StubProvider(new Set(['BROKEN']));
    const summary = await captureChains(provider, ['BROKEN', 'NVDA']);

    expect(summary.symbolsDone).toBe(2);
    expect(summary.errors.some((e) => e.startsWith('BROKEN:'))).toBe(true);
    // One bad symbol out of 566 must not cost the whole night's capture.
    expect(provider.calls).toBe(2);
  });

  it('checkpoints progress so an interrupted run can resume', async () => {
    const runs = marketDb.select().from(captureRuns).all();
    expect(runs.length).toBeGreaterThan(0);
    const last = runs[runs.length - 1]!;
    expect(last.cursor).not.toBeNull();
    expect(last.symbolsDone).toBeGreaterThan(0);
    expect(last.finishedAt).not.toBeNull();
    // BROKEN failed and NVDA succeeded — real quotes were written, but not
    // for every symbol, which is exactly what 'degraded' is for.
    expect(last.status).toBe('degraded');
  });
});
