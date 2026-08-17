import { intrinsicValueE4, type OptionContract } from '@org/shared';

/**
 * The single definition of "tradeable".
 *
 * Every stage — capture, feature building, backtest fills, and the ranked
 * signal board — asks this module and nothing else. One definition matters
 * more than the exact thresholds: a backtest that fills contracts the live
 * board would never show you is measuring a strategy you cannot run.
 *
 * The rules come from a real NVDA chain (2 DTE, spot $225.05), which is worth
 * describing because it corrects the obvious intuition. NVDA is the most
 * liquid single name on the board, and yet:
 *
 *   - the $227.50 call quoted $1.10/$1.14 — a 3.6% round trip, genuinely tradeable
 *   - the $207.50 call quoted $15.05/$18.35 — a 20% round trip, and a mid
 *     *beneath* its $17.55 of intrinsic value
 *   - the $390 call quoted $0.00/$0.01 with an implied vol of 435.84%
 *
 * So liquidity is a property of the **contract**, not the underlying. A gate
 * applied per symbol would have admitted all three. Contracts like the last
 * two are also where fake backtest returns come from: a $0.01 mid moves ±100%
 * on a single tick, and a model trained on those rows learns tick noise and
 * reports a spectacular edge that evaporates on the first real fill.
 */

export interface LiquidityThresholds {
  /**
   * Minimum mid price, in E4. Default $0.10.
   *
   * A tradeoff, not a bright line: at $0.10 a one-cent tick is still a 10%
   * move, but raising it much further starts excluding out-of-the-money
   * contracts that genuinely trade. Configurable so a backtest can measure
   * how much the choice matters rather than assuming.
   */
  minMidE4: number;
  /**
   * Maximum `(ask - bid) / mid`. Default 0.10.
   *
   * This *is* the round-trip cost fraction — buy at ask, sell at bid — so 10%
   * is already a generous ceiling. It sits between the real NVDA rows at 5.6%
   * (tradeable) and 13.4% (not).
   */
  maxSpreadFraction: number;
  minOpenInterest: number;
  minVolume: number;
}

export const DEFAULT_LIQUIDITY: LiquidityThresholds = {
  minMidE4: 1_000,
  maxSpreadFraction: 0.1,
  minOpenInterest: 100,
  minVolume: 10,
};

export type GateReason =
  | 'no-bid'
  | 'crossed'
  | 'too-cheap'
  | 'spread-too-wide'
  | 'thin-open-interest'
  | 'thin-volume'
  | 'below-intrinsic';

export interface GateInput {
  readonly contract: OptionContract;
  readonly bidE4: number;
  readonly askE4: number;
  readonly openInterest: number;
  readonly volume: number;
  /** Underlying price at the same instant. Non-positive skips the intrinsic check. */
  readonly spotE4: number;
}

export interface GateVerdict {
  readonly liquid: boolean;
  /** Every failing rule, not just the first — diagnostics beat short-circuiting. */
  readonly reasons: readonly GateReason[];
  /** Null when the quote is unusable, so callers cannot mistake it for a price. */
  readonly midE4: number | null;
  readonly spreadFraction: number | null;
}

export function evaluateLiquidity(
  input: GateInput,
  thresholds: LiquidityThresholds = DEFAULT_LIQUIDITY,
): GateVerdict {
  const { bidE4, askE4, openInterest, volume, spotE4, contract } = input;
  const reasons: GateReason[] = [];

  // A zero bid is not a cheap contract, it is an unsellable one: there is no
  // resting order to hit. Whatever the ask says, the position cannot be exited.
  const noBid = !(bidE4 > 0);
  if (noBid) reasons.push('no-bid');

  // Crossed or locked markets are bad data, not opportunities.
  const crossed = askE4 < bidE4 || !(askE4 > 0);
  if (crossed) reasons.push('crossed');

  const quoteUsable = !noBid && !crossed;
  const midE4 = quoteUsable ? (bidE4 + askE4) / 2 : null;
  const spreadFraction = midE4 !== null && midE4 > 0 ? (askE4 - bidE4) / midE4 : null;

  // Price and spread rules still apply to a zero-bid quote — the $390 row
  // fails four rules at once, and reporting all four is more useful than
  // stopping at the first.
  const effectiveMid = midE4 ?? (askE4 > 0 ? askE4 / 2 : 0);
  if (effectiveMid < thresholds.minMidE4) reasons.push('too-cheap');

  if (spreadFraction !== null && spreadFraction > thresholds.maxSpreadFraction) {
    reasons.push('spread-too-wide');
  }

  if (openInterest < thresholds.minOpenInterest) reasons.push('thin-open-interest');
  if (volume < thresholds.minVolume) reasons.push('thin-volume');

  /**
   * A mid beneath intrinsic value means the quote is stale — nobody is
   * maintaining it. These are American-style equity options, so holding one
   * priced below its immediate exercise value is not a market state that
   * survives contact with an arbitrageur; it is a market nobody is watching.
   * (European deep-in-the-money puts genuinely can trade below intrinsic on
   * carry, which is why this rule is scoped to American exercise.)
   */
  if (spotE4 > 0 && midE4 !== null) {
    if (midE4 < intrinsicValueE4(contract, spotE4)) reasons.push('below-intrinsic');
  }

  return { liquid: reasons.length === 0, reasons, midE4, spreadFraction };
}

/** Convenience for the common case where only the verdict matters. */
export function isTradeable(
  input: GateInput,
  thresholds: LiquidityThresholds = DEFAULT_LIQUIDITY,
): boolean {
  return evaluateLiquidity(input, thresholds).liquid;
}
