/**
 * The heuristic growth/momentum radar's composite score.
 *
 * Deliberately arithmetic, not a model: momentum, proximity to the
 * 52-week high, a volume spike, and (where the corpus has coverage) a
 * news-sentiment trend, combined into an unweighted mean of z-scores. This
 * is a first-pass screen, not a backtested edge — see `RADAR_DISCLAIMER`,
 * which every caller returning radar rows must attach verbatim so that
 * promise never quietly drops on the way to the UI.
 *
 * Pure and DB-free, mirroring `lib/options/gate.ts`'s shape (thresholds in,
 * a verdict out) — `run.ts` owns the SQL and the z-scoring pass across the
 * eligible universe; this module only ever sees one row plus the
 * population statistics needed to score it.
 */

import { clamp } from '../util.js';

export const RADAR_DISCLAIMER =
  'Heuristic screen only: momentum, proximity to 52-week high, volume spike, and ' +
  'news-sentiment trend (where covered), combined into an unweighted composite. ' +
  'Not backtested, not validated against forward returns, not a recommendation — ' +
  'a high score means "worth a closer look," nothing stronger.';

/** Excluded from scoring entirely below this floor — not scored-and-dropped,
 * never considered. A single trade can move a micro-cap's day-change 20%,
 * and a name too thin to fill a real order isn't "worth a closer look," it's
 * noise. Code-level constants, not env config — same precedent as gate.ts's
 * DEFAULT_LIQUIDITY: these are a considered starting point, not a knob
 * anyone's expected to tune per deployment. */
export const RADAR_MIN_MARKET_CAP_USD = 300_000_000;
export const RADAR_MIN_AVG_VOLUME = 100_000;

export interface RadarInputs {
  symbol: string;
  price: number | null;
  dayChangePercent: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  volume: number | null;
  avgVolume10Day: number | null;
  marketCap: number | null;
  /** -1..1, mean of docMentions.sentiment over a trailing window. Null
   * means "not covered", never "neutral" — see `run.ts`'s own comment on
   * why folding an uncovered symbol's sentiment in as 0 would misrepresent
   * it as measured-and-neutral rather than simply unmeasured. */
  sentimentScore: number | null;
  sentimentDocCount: number;
}

export interface RadarComponents {
  momentumZ: number | null;
  trendPct: number | null;
  newHigh: boolean;
  volumeRatio: number | null;
  volumeZ: number | null;
  sentimentZ: number | null;
  inputsUsed: string[];
  score: number;
}

/** A symbol below the eligibility floor never reaches scoring at all. */
export function isEligible(row: Pick<RadarInputs, 'marketCap' | 'avgVolume10Day' | 'price'>): boolean {
  return (
    row.price !== null &&
    row.marketCap !== null &&
    row.marketCap >= RADAR_MIN_MARKET_CAP_USD &&
    row.avgVolume10Day !== null &&
    row.avgVolume10Day >= RADAR_MIN_AVG_VOLUME
  );
}

/** Population mean and standard deviation — z-scoring is always against the
 * night's own eligible universe, not a fixed historical baseline, so "good"
 * tracks what the market actually did that day. */
function zScore(value: number, mean: number, stdDev: number): number {
  return stdDev > 0 ? (value - mean) / stdDev : 0;
}

/** `volume / avgVolume10Day`, or null when there's nothing to divide by —
 * shared by `computePopulationStats` and `scoreInstrument` so the same row
 * is never counted toward the population sample under a different
 * eligibility rule than the one used to score it. */
function volumeRatioOf(row: Pick<RadarInputs, 'volume' | 'avgVolume10Day'>): number | null {
  return row.volume !== null && row.avgVolume10Day !== null && row.avgVolume10Day > 0
    ? row.volume / row.avgVolume10Day
    : null;
}

/** Whether a row has real, measured sentiment — not just a non-null score,
 * which alone doesn't distinguish "measured neutral" from a stray 0. */
function hasSentimentCoverage(row: Pick<RadarInputs, 'sentimentDocCount' | 'sentimentScore'>): boolean {
  return row.sentimentDocCount > 0 && row.sentimentScore !== null;
}

export interface PopulationStats {
  momentum: { mean: number; stdDev: number };
  volumeRatio: { mean: number; stdDev: number };
  /** Present only if at least one eligible symbol has sentiment coverage. */
  sentiment: { mean: number; stdDev: number } | null;
}

export function computePopulationStats(rows: readonly RadarInputs[]): PopulationStats {
  const momentumValues = rows.map((r) => r.dayChangePercent).filter((v): v is number => v !== null);
  const volumeRatioValues = rows.map(volumeRatioOf).filter((v): v is number => v !== null);
  const sentimentValues = rows.filter(hasSentimentCoverage).map((r) => r.sentimentScore!);

  return {
    momentum: meanAndStdDev(momentumValues),
    volumeRatio: meanAndStdDev(volumeRatioValues),
    sentiment: sentimentValues.length > 0 ? meanAndStdDev(sentimentValues) : null,
  };
}

function meanAndStdDev(values: readonly number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

/**
 * Scores one eligible row against the population stats computed for that
 * night's universe. Returns every component even when the composite score
 * ends up 0 (e.g. no inputs available) — `inputsUsed` is what tells a
 * reader whether that 0 means "unremarkable" or "nothing to go on".
 */
export function scoreInstrument(row: RadarInputs, stats: PopulationStats): RadarComponents {
  const inputsUsed: string[] = [];
  const zComponents: number[] = [];

  let momentumZ: number | null = null;
  if (row.dayChangePercent !== null) {
    momentumZ = zScore(row.dayChangePercent, stats.momentum.mean, stats.momentum.stdDev);
    zComponents.push(momentumZ);
    inputsUsed.push('dayChangePercent');
  }

  let trendPct: number | null = null;
  let newHigh = false;
  if (
    row.price !== null &&
    row.fiftyTwoWeekHigh !== null &&
    row.fiftyTwoWeekLow !== null &&
    row.fiftyTwoWeekHigh > row.fiftyTwoWeekLow
  ) {
    trendPct = clamp((row.price - row.fiftyTwoWeekLow) / (row.fiftyTwoWeekHigh - row.fiftyTwoWeekLow), 0, 1);
    newHigh = row.price >= row.fiftyTwoWeekHigh;
    // trendPct is 0..1, not a z-score — recentered so "at the midpoint of
    // the 52-week range" contributes nothing, matching every other
    // component's zero point. newHigh adds a fixed bonus on top: the
    // closest available proxy to genuine relative strength without a full
    // return series, not a substitute for one.
    zComponents.push((trendPct - 0.5) * 2 + (newHigh ? 1 : 0));
    inputsUsed.push('fiftyTwoWeekRange');
  }

  let volumeZ: number | null = null;
  const volumeRatio = volumeRatioOf(row);
  if (volumeRatio !== null) {
    volumeZ = zScore(volumeRatio, stats.volumeRatio.mean, stats.volumeRatio.stdDev);
    zComponents.push(volumeZ);
    inputsUsed.push('volumeRatio');
  }

  let sentimentZ: number | null = null;
  if (hasSentimentCoverage(row) && stats.sentiment !== null) {
    sentimentZ = zScore(row.sentimentScore!, stats.sentiment.mean, stats.sentiment.stdDev);
    zComponents.push(sentimentZ);
    inputsUsed.push('sentimentScore');
  }

  const score = zComponents.length > 0 ? zComponents.reduce((s, v) => s + v, 0) / zComponents.length : 0;

  return { momentumZ, trendPct, newHigh, volumeRatio, volumeZ, sentimentZ, inputsUsed, score };
}
