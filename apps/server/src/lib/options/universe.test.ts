import { describe, expect, it } from 'vitest';
import { buildUniverse, toOccRoot, toVendorSymbol } from './universe.js';
import { OPTION_ETF_SET, NON_EQUITY_LIKE } from '../../data/optionEtfs.js';

describe('universe composition', () => {
  const rows = buildUniverse();

  it('spans roughly five hundred underlyings', () => {
    // Breadth is the point: cross-sectional context is most of the signal, so
    // a name's implied vol can be measured against its sector and the market.
    expect(rows.length).toBeGreaterThan(500);
    expect(rows.length).toBeLessThan(600);
  });

  it('contains no duplicate symbols', () => {
    expect(new Set(rows.map((r) => r.symbol)).size).toBe(rows.length);
  });

  it('includes the deepest options markets in the core', () => {
    const core = new Set(rows.filter((r) => r.tier === 'core').map((r) => r.symbol));
    for (const symbol of ['SPY', 'QQQ', 'IWM', 'XLF', 'GLD', 'TLT']) {
      expect(core).toContain(symbol);
    }
  });

  it('keeps structurally decaying products out of the core', () => {
    // A leveraged fund rebalances daily and a volatility future rolls, so
    // their price series do not mean what an equity series means. They belong
    // in the training cross-section, never in the tradeable set by default.
    const byTier = new Map(rows.map((r) => [r.symbol, r.tier]));
    for (const symbol of NON_EQUITY_LIKE) {
      expect(byTier.get(symbol)).toBe('research');
    }
    expect(byTier.get('UVXY')).toBe('research');
    expect(byTier.get('TQQQ')).toBe('research');
  });

  it('carries every options ETF', () => {
    const symbols = new Set(rows.map((r) => r.symbol));
    for (const etf of OPTION_ETF_SET) expect(symbols).toContain(etf);
  });

  it('leaves sector null rather than inventing one', () => {
    // Nasdaq-100 members outside the S&P 500 arrive without a sector. A
    // fabricated label would silently become a categorical feature.
    const withoutSector = rows.filter((r) => r.sector === null);
    for (const row of withoutSector) expect(row.name).toBe(row.symbol);
  });

  it('is not built around any one name', () => {
    // The pricing fixture uses a real NVDA chain because its greeks were
    // independently published; that is a unit test for the maths, not a
    // universe. Nothing here should be special-cased to it.
    const nvda = rows.filter((r) => r.symbol === 'NVDA');
    expect(nvda).toHaveLength(1);
    expect(rows.length).toBeGreaterThan(500);
  });
});

describe('symbol spelling', () => {
  it('translates class shares between the three conventions', () => {
    // This repo follows Yahoo, Polygon uses a dot, the OCC root strips both.
    expect(toVendorSymbol('BRK-B')).toBe('BRK.B');
    expect(toOccRoot('BRK-B')).toBe('BRKB');
    expect(toOccRoot('BRK.B')).toBe('BRKB');
  });

  it('leaves ordinary symbols untouched', () => {
    for (const s of ['SPY', 'NVDA', 'AAPL']) {
      expect(toVendorSymbol(s)).toBe(s);
      expect(toOccRoot(s)).toBe(s);
    }
  });
});
