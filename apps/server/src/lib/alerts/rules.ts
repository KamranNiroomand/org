/**
 * Price/momentum alert rules — the single definition of "worth a look".
 *
 * Mirrors `lib/options/gate.ts`'s shape on purpose: thresholds in, every
 * matching rule out (not just the first — a symbol can hit a new 52-week
 * low and a volume spike the same day, and stopping at the first would
 * hide half the picture). Pure and DB-free so it can be tested against
 * fixture rows without touching SQLite.
 */

export interface PriceRuleThresholds {
  /** Absolute day-change percent that counts as a real move. Default 7. */
  dayChangePercent: number;
  /** Multiple of the 10-day average volume that counts as a spike. Default 3. */
  volumeSpikeMultiple: number;
}

export const DEFAULT_PRICE_THRESHOLDS: PriceRuleThresholds = {
  dayChangePercent: 7,
  volumeSpikeMultiple: 3,
};

export type RuleKey =
  | 'day_change_up'
  | 'day_change_down'
  | 'new_52w_high'
  | 'new_52w_low'
  | 'volume_spike';

export type Direction = 'bullish' | 'bearish' | 'neutral';

export interface InstrumentSnapshot {
  symbol: string;
  price: number | null;
  dayChangePercent: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  volume: number | null;
  avgVolume10Day: number | null;
}

export interface RuleHit {
  ruleKey: RuleKey;
  direction: Direction;
  headline: string;
  detail: Record<string, unknown>;
}

/** Every price/momentum rule that fires for one instrument row. */
export function evaluatePriceRules(
  row: InstrumentSnapshot,
  thresholds: PriceRuleThresholds = DEFAULT_PRICE_THRESHOLDS,
): RuleHit[] {
  const hits: RuleHit[] = [];

  if (row.dayChangePercent !== null) {
    if (row.dayChangePercent <= -thresholds.dayChangePercent) {
      hits.push({
        ruleKey: 'day_change_down',
        direction: 'bearish',
        headline: `${row.symbol} is down ${Math.abs(row.dayChangePercent).toFixed(1)}% today`,
        detail: { dayChangePercent: row.dayChangePercent, threshold: thresholds.dayChangePercent },
      });
    } else if (row.dayChangePercent >= thresholds.dayChangePercent) {
      hits.push({
        ruleKey: 'day_change_up',
        direction: 'bullish',
        headline: `${row.symbol} is up ${row.dayChangePercent.toFixed(1)}% today`,
        detail: { dayChangePercent: row.dayChangePercent, threshold: thresholds.dayChangePercent },
      });
    }
  }

  // A same-day IPO or a thinly-traded symbol can report a 52-week high equal
  // to (or, on stale data, below) its own 52-week low — else-if rather than
  // two independent checks, so a degenerate range never fires both a
  // "new high" and a "new low" for the same row on the same day.
  if (row.price !== null && row.fiftyTwoWeekHigh !== null && row.price >= row.fiftyTwoWeekHigh) {
    hits.push({
      ruleKey: 'new_52w_high',
      direction: 'bullish',
      headline: `${row.symbol} hit a new 52-week high`,
      detail: { price: row.price, fiftyTwoWeekHigh: row.fiftyTwoWeekHigh },
    });
  } else if (row.price !== null && row.fiftyTwoWeekLow !== null && row.price <= row.fiftyTwoWeekLow) {
    hits.push({
      ruleKey: 'new_52w_low',
      direction: 'bearish',
      headline: `${row.symbol} hit a new 52-week low`,
      detail: { price: row.price, fiftyTwoWeekLow: row.fiftyTwoWeekLow },
    });
  }

  if (row.volume !== null && row.avgVolume10Day !== null && row.avgVolume10Day > 0) {
    const multiple = row.volume / row.avgVolume10Day;
    if (multiple >= thresholds.volumeSpikeMultiple) {
      // Neutral on purpose — a spike says something is happening, not which way.
      hits.push({
        ruleKey: 'volume_spike',
        direction: 'neutral',
        headline: `${row.symbol} volume is ${multiple.toFixed(1)}x its 10-day average`,
        detail: { volume: row.volume, avgVolume10Day: row.avgVolume10Day, multiple },
      });
    }
  }

  return hits;
}
