import type { OptionType } from '@org/shared';

/**
 * The seam between us and whoever sells us option data.
 *
 * It exists because the single most consequential unknown in this build is
 * whether the subscribed tier serves historical **NBBO quotes** or only trade
 * aggregates. Without a historical bid and ask, a backtest can only fill at
 * last-traded prices, which quietly overstates every result — options spreads
 * are wide enough that the difference is the entire edge. If that turns out to
 * be missing, swapping vendors should cost one file, not a rewrite of capture,
 * features and backtesting.
 *
 * Everything crossing this boundary is already normalized: E4 integer money,
 * civil-day dates, canonical OCC symbols. Vendor-specific shapes stop here.
 */

/** One contract's quote at one instant, as captured. */
export interface ChainQuote {
  /** Canonical 21-character OCC symbol. */
  readonly occSymbol: string;
  readonly underlying: string;
  readonly expiry: string;
  readonly type: OptionType;
  readonly strikeE4: number;
  readonly multiplier: number;

  /**
   * Null when the plan carries no quote entitlement. Distinct from zero, which
   * is a real market with nobody bidding — see the gate.
   */
  readonly bidE4: number | null;
  readonly askE4: number | null;
  readonly lastE4: number | null;
  /** The contract's own daily close, from trade aggregates. */
  readonly closeE4: number | null;
  readonly volume: number;
  readonly openInterest: number;
  readonly underlyingE4: number;

  /** Instant of the snapshot. */
  readonly asOf: string;
  /** Civil trading day, denormalized for joins. */
  readonly tradingDay: string;

  /**
   * The vendor's own implied vol, kept only so the preflight can compare it
   * against ours. Never persisted and never a feature — we solve our own so
   * that history and live data come from one model, and so that a quote which
   * determines no volatility yields null instead of an invented number.
   */
  readonly vendorIv: number | null;
}

export interface DailyBar {
  readonly symbol: string;
  readonly day: string;
  readonly openE4: number;
  readonly highE4: number;
  readonly lowE4: number;
  readonly closeE4: number;
  readonly adjCloseE4: number | null;
  readonly volume: number;
}

export interface ChainRequest {
  readonly underlying: string;
  /** Contracts expiring more than this many days out are skipped. */
  readonly maxDte: number;
  /**
   * As-of day for a historical pull. Omitted means "right now", which is the
   * nightly capture path.
   */
  readonly asOfDay?: string;
}

/**
 * What a key can actually reach, discovered by probing rather than assumed
 * from the plan name. Surfaced by `npm run options:check` so the answer is
 * known before two years of backfill are attempted against an endpoint the
 * subscription does not include.
 */
export interface ProviderCapabilities {
  readonly name: string;
  readonly liveChain: boolean;
  readonly historicalChain: boolean;
  /** The one that decides whether backtest fills can be honest. */
  readonly historicalQuotes: boolean;
  readonly equityBars: boolean;
  readonly news: boolean;
  /** Human-readable detail per probe, including the failure reason. */
  readonly notes: readonly string[];
}

export interface OptionsProvider {
  readonly name: string;
  fetchChain(request: ChainRequest): Promise<ChainQuote[]>;
  fetchBars(symbol: string, from: string, to: string): Promise<DailyBar[]>;
  probe(): Promise<ProviderCapabilities>;
  /** Optional: a provider with its own adaptive rate-limit pacer (see
   * polygon.ts) can report whether it's currently slowed down below its
   * configured baseline — surfaced by capture.ts in its own run summary so
   * "this run took much longer than usual" has a visible cause, without
   * capture.ts needing to know which concrete provider it's talking to. */
  rateLimitState?(): { throttled: boolean; multiplier: number };
}

/** Thrown when the vendor answers, but with something we will not guess about. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
