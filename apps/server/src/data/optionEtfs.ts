/**
 * Exchange-traded funds with genuinely active options markets.
 *
 * Held as static data for the same reason as `sp500.ts`: the list changes
 * rarely, and a live dependency would buy accuracy nobody notices while adding
 * a call that can fail.
 *
 * These matter disproportionately. Index and sector ETFs are where option
 * spreads are tightest — SPY routinely quotes a penny wide where a single name
 * quotes a nickel — so they are the contracts most likely to survive costs.
 * They also anchor the cross-sectional features: a name's implied vol is only
 * interesting relative to the market's, and SPY is the market.
 *
 * Sourced from published options-volume rankings, 2026-08-17.
 */

export interface OptionEtf {
  readonly symbol: string;
  readonly name: string;
  /** Loose grouping, used to seed sector features before real data arrives. */
  readonly kind: 'broad' | 'sector' | 'commodity' | 'bond' | 'volatility' | 'leveraged' | 'country';
}

export const OPTION_ETFS: readonly OptionEtf[] = [
  // Broad market — the deepest options markets in existence.
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', kind: 'broad' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', kind: 'broad' },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF', kind: 'broad' },
  { symbol: 'DIA', name: 'SPDR Dow Jones Industrial Average ETF', kind: 'broad' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', kind: 'broad' },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', kind: 'broad' },
  { symbol: 'RSP', name: 'Invesco S&P 500 Equal Weight ETF', kind: 'broad' },

  // Sectors — the cross-section a single name is measured against.
  { symbol: 'XLF', name: 'Financial Select Sector SPDR', kind: 'sector' },
  { symbol: 'XLE', name: 'Energy Select Sector SPDR', kind: 'sector' },
  { symbol: 'XLK', name: 'Technology Select Sector SPDR', kind: 'sector' },
  { symbol: 'XLV', name: 'Health Care Select Sector SPDR', kind: 'sector' },
  { symbol: 'XLI', name: 'Industrial Select Sector SPDR', kind: 'sector' },
  { symbol: 'XLP', name: 'Consumer Staples Select Sector SPDR', kind: 'sector' },
  { symbol: 'XLY', name: 'Consumer Discretionary Select Sector SPDR', kind: 'sector' },
  { symbol: 'XLU', name: 'Utilities Select Sector SPDR', kind: 'sector' },
  { symbol: 'XLB', name: 'Materials Select Sector SPDR', kind: 'sector' },
  { symbol: 'XLRE', name: 'Real Estate Select Sector SPDR', kind: 'sector' },
  { symbol: 'XLC', name: 'Communication Services Select Sector SPDR', kind: 'sector' },
  { symbol: 'SMH', name: 'VanEck Semiconductor ETF', kind: 'sector' },
  { symbol: 'XBI', name: 'SPDR S&P Biotech ETF', kind: 'sector' },
  { symbol: 'KRE', name: 'SPDR S&P Regional Banking ETF', kind: 'sector' },
  { symbol: 'ITB', name: 'iShares U.S. Home Construction ETF', kind: 'sector' },
  { symbol: 'IYR', name: 'iShares U.S. Real Estate ETF', kind: 'sector' },

  // Commodities and precious metals.
  { symbol: 'GLD', name: 'SPDR Gold Shares', kind: 'commodity' },
  { symbol: 'SLV', name: 'iShares Silver Trust', kind: 'commodity' },
  { symbol: 'GDX', name: 'VanEck Gold Miners ETF', kind: 'commodity' },
  { symbol: 'USO', name: 'United States Oil Fund', kind: 'commodity' },
  { symbol: 'UNG', name: 'United States Natural Gas Fund', kind: 'commodity' },

  // Rates and credit — where macro shows up first.
  { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', kind: 'bond' },
  { symbol: 'IEF', name: 'iShares 7-10 Year Treasury Bond ETF', kind: 'bond' },
  { symbol: 'SHY', name: 'iShares 1-3 Year Treasury Bond ETF', kind: 'bond' },
  { symbol: 'HYG', name: 'iShares iBoxx High Yield Corporate Bond ETF', kind: 'bond' },
  { symbol: 'LQD', name: 'iShares iBoxx Investment Grade Corporate Bond ETF', kind: 'bond' },

  // International.
  { symbol: 'EEM', name: 'iShares MSCI Emerging Markets ETF', kind: 'country' },
  { symbol: 'EFA', name: 'iShares MSCI EAFE ETF', kind: 'country' },
  { symbol: 'FXI', name: 'iShares China Large-Cap ETF', kind: 'country' },
  { symbol: 'KWEB', name: 'KraneShares CSI China Internet ETF', kind: 'country' },
  { symbol: 'EWZ', name: 'iShares MSCI Brazil ETF', kind: 'country' },
  { symbol: 'EWJ', name: 'iShares MSCI Japan ETF', kind: 'country' },

  /**
   * Volatility and leveraged products.
   *
   * Deliberately included, and deliberately never seeded as `core`. Their
   * options are heavily traded and carry real information about positioning,
   * so they earn their place in the training cross-section. But the underlying
   * instruments decay structurally — a leveraged fund rebalances daily and a
   * volatility future rolls — so their price series do not mean what an equity
   * price series means, and a model that learns from them without that context
   * will happily extrapolate a downtrend that is mechanical rather than
   * predictive.
   */
  { symbol: 'VXX', name: 'iPath Series B S&P 500 VIX Short-Term Futures ETN', kind: 'volatility' },
  { symbol: 'UVXY', name: 'ProShares Ultra VIX Short-Term Futures ETF', kind: 'volatility' },
  { symbol: 'SVXY', name: 'ProShares Short VIX Short-Term Futures ETF', kind: 'volatility' },
  { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ', kind: 'leveraged' },
  { symbol: 'SQQQ', name: 'ProShares UltraPro Short QQQ', kind: 'leveraged' },
  { symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X', kind: 'leveraged' },
  { symbol: 'SPXL', name: 'Direxion Daily S&P 500 Bull 3X', kind: 'leveraged' },
  { symbol: 'TNA', name: 'Direxion Daily Small Cap Bull 3X', kind: 'leveraged' },

  // Crypto exposure — options markets became genuinely liquid post-2024.
  { symbol: 'IBIT', name: 'iShares Bitcoin Trust', kind: 'commodity' },
];

/** Structurally decaying instruments, excluded from the tradeable core. */
export const NON_EQUITY_LIKE = new Set(
  OPTION_ETFS.filter((e) => e.kind === 'volatility' || e.kind === 'leveraged').map((e) => e.symbol),
);

export const OPTION_ETF_SET = new Set(OPTION_ETFS.map((e) => e.symbol));
