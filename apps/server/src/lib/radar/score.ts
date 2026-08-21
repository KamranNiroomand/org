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

export interface PopulationStats {
  momentum: { mean: number; stdDev: number };
  volumeRatio: { mean: number; stdDev: number };
  /** Present only if at least one eligible symbol has sentiment coverage. */
  sentiment: { mean: number; stdDev: number } | null;
}

export function computePopulationStats(rows: readonly RadarInputs[]): PopulationStats {
  const momentumValues = rows.map((r) => r.dayChangePercent).filter((v): v is number => v !== null);
  const volumeRatioValues = rows
    .filter((r) => r.volume !== null && r.avgVolume10Day !== null && r.avgVolume10Day > 0)
    .map((r) => r.volume! / r.avgVolume10Day!);
  const sentimentValues = rows
    .filter((r) => r.sentimentDocCount > 0 && r.sentimentScore !== null)
    .map((r) => r.sentimentScore!);

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
    trendPct = Math.min(1, Math.max(0, (row.price - row.fiftyTwoWeekLow) / (row.fiftyTwoWeekHigh - row.fiftyTwoWeekLow)));
    newHigh = row.price >= row.fiftyTwoWeekHigh;
    // trendPct is 0..1, not a z-score — recentered so "at the midpoint of
    // the 52-week range" contributes nothing, matching every other
    // component's zero point. newHigh adds a fixed bonus on top: the
    // closest available proxy to genuine relative strength without a full
    // return series, not a substitute for one.
    zComponents.push((trendPct - 0.5) * 2 + (newHigh ? 1 : 0));
    inputsUsed.push('fiftyTwoWeekRange');
  }

  let volumeRatio: number | null = null;
  let volumeZ: number | null = null;
  if (row.volume !== null && row.avgVolume10Day !== null && row.avgVolume10Day > 0) {
    volumeRatio = row.volume / row.avgVolume10Day;
    volumeZ = zScore(volumeRatio, stats.volumeRatio.mean, stats.volumeRatio.stdDev);
    zComponents.push(volumeZ);
    inputsUsed.push('volumeRatio');
  }

  let sentimentZ: number | null = null;
  if (row.sentimentDocCount > 0 && row.sentimentScore !== null && stats.sentiment !== null) {
    sentimentZ = zScore(row.sentimentScore, stats.sentiment.mean, stats.sentiment.stdDev);
    zComponents.push(sentimentZ);
    inputsUsed.push('sentimentScore');
  }

  const score = zComponents.length > 0 ? zComponents.reduce((s, v) => s + v, 0) / zComponents.length : 0;

  return { momentumZ, trendPct, newHigh, volumeRatio, volumeZ, sentimentZ, inputsUsed, score };
}
