import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { instruments, radarRuns, radarScores } from '../../db/schema.js';
import { marketDb } from '../../db/market/index.js';
import { documents, docMentions } from '../../db/market/schema.js';
import { toVendorSymbol } from '../options/universe.js';
import { newId, nowIso, todayKey } from '../util.js';
import { computePopulationStats, isEligible, scoreInstrument, type RadarInputs } from './score.js';

/** Above this age, the freshest quote in `instruments` predates the last
 * scheduled sweep by more than a missed cycle's worth of slack — the same
 * "stale data dressed up as fresh" risk `evaluatePriceAlerts` guards against
 * via `sweepSucceeded`, applied here as a soft warning rather than a hard
 * skip: a heuristic screen that's a day behind is still worth seeing, as
 * long as it says so. */
const STALE_INSTRUMENTS_HOURS = 30;

/** How many symbols the nightly shortlist keeps — the LLM panel (a later
 * milestone) only ever sees this list, never the full universe, so this
 * number is also what bounds that future cost. */
const SHORTLIST_SIZE = 50;

/** How far back to average news sentiment — a week-old story isn't still
 * moving today's picture, and a longer window would smooth out exactly the
 * recent shift the composite is trying to surface. */
const SENTIMENT_LOOKBACK_DAYS = 7;

export interface RadarRunSummary {
  runId: string | null;
  universeScored: number;
  shortlisted: number;
  errors: string[];
}

/** Only ever called on a non-null sentiment — see the `isNotNull` filter on
 * the mentions query below. An EDGAR filing's `sentiment` is always null
 * (Polygon news is the only source that populates it); folding a null in
 * here as 0 would misrepresent "never measured" as "measured and neutral". */
function sentimentValue(sentiment: 'positive' | 'negative' | 'neutral'): number {
  return sentiment === 'positive' ? 1 : sentiment === 'negative' ? -1 : 0;
}

/** Guards against the cron and a manual trigger overlapping — mirrors
 * `watchlistTextSyncing` in scheduler.ts, but owned here since this job's
 * only caller-visible surface is this one function. */
let radarRunning = false;

/**
 * Scores the full eligible `instruments` universe and persists the top
 * `SHORTLIST_SIZE` for `tradingDay`. Cheap and numeric — reads rows already
 * in SQLite from the night's sweep and a bounded window of `market.db`
 * sentiment, no network call of its own. Idempotent per day: existing
 * `radarScores` rows for `tradingDay` are cleared right before the new
 * shortlist is written (in the same transaction as the insert, and only
 * once a shortlist actually exists to replace them with), so re-running the
 * same day (the manual trigger route, or a retried cron tick) always leaves
 * exactly `min(50, eligible universe)` rows — never a stale symbol from an
 * earlier run that has since dropped out of the top 50, and never a good
 * shortlist wiped down to zero by a run that legitimately found nothing
 * eligible.
 */
export function runRadarScoring(tradingDay: string = todayKey()): RadarRunSummary {
  if (radarRunning) {
    return { runId: null, universeScored: 0, shortlisted: 0, errors: ['A radar run was already in progress; skipped this run.'] };
  }
  radarRunning = true;

  const runId = newId();
  const startedAt = nowIso();
  const errors: string[] = [];
  let universeScored = 0;
  let shortlisted = 0;
  // Only true once the `radarRuns` bookkeeping row actually exists — guards
  // the finalizing UPDATE below against a run that failed before that
  // insert (e.g. a locked org.db), which would otherwise try to update a
  // row that was never created.
  let runRowInserted = false;

  try {
    db.insert(radarRuns).values({ id: runId, startedAt, tradingDay }).run();
    runRowInserted = true;

    const rows = db
      .select({
        symbol: instruments.symbol,
        price: instruments.price,
        dayChangePercent: instruments.dayChangePercent,
        fiftyTwoWeekHigh: instruments.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: instruments.fiftyTwoWeekLow,
        volume: instruments.volume,
        avgVolume10Day: instruments.avgVolume10Day,
        marketCap: instruments.marketCap,
        quotedAt: instruments.quotedAt,
      })
      .from(instruments)
      .all();
    universeScored = rows.length;

    const quotedTimes = rows.map((r) => r.quotedAt).filter((v): v is string => v !== null);
    if (quotedTimes.length > 0) {
      const freshest = quotedTimes.reduce((a, b) => (a > b ? a : b));
      const ageHours = (Date.now() - new Date(freshest).getTime()) / 3_600_000;
      if (ageHours > STALE_INSTRUMENTS_HOURS) {
        errors.push(
          `instruments data looks stale — the freshest quote is ${Math.round(ageHours)}h old; ` +
            `today's shortlist may be scored against an outdated market sweep.`,
        );
      }
    }

    // Sentiment, keyed by the vendor's symbol format — docMentions.underlying
    // is stored that way (see newsAlerts.ts's own doc comment on the same
    // conversion). Only a forward lookup is needed here (instruments.symbol
    // -> vendor format), unlike createNewsAlerts' reverse direction, since
    // every instrument's own app-format symbol is already known going in.
    //
    // isNotNull(sentiment) excludes EDGAR-sourced mentions, which always
    // carry a null sentiment (only Polygon news populates it — see
    // docMentions' own schema comment). Without this filter an EDGAR-only
    // symbol would be counted as "covered" with a fabricated neutral score,
    // which RadarInputs' own doc comment says must never happen.
    const cutoff = new Date(Date.now() - SENTIMENT_LOOKBACK_DAYS * 86_400_000).toISOString();
    const mentions = marketDb
      .select({ underlying: docMentions.underlying, sentiment: docMentions.sentiment })
      .from(docMentions)
      .innerJoin(documents, eq(docMentions.documentId, documents.id))
      .where(and(gte(documents.publishedAt, cutoff), isNotNull(docMentions.sentiment)))
      .all();
    const sentimentBySymbol = new Map<string, { sum: number; count: number }>();
    for (const m of mentions) {
      const entry = sentimentBySymbol.get(m.underlying) ?? { sum: 0, count: 0 };
      entry.sum += sentimentValue(m.sentiment!);
      entry.count += 1;
      sentimentBySymbol.set(m.underlying, entry);
    }

    const eligible: RadarInputs[] = [];
    for (const row of rows) {
      if (!isEligible(row)) continue;
      const sentiment = sentimentBySymbol.get(toVendorSymbol(row.symbol));
      eligible.push({
        ...row,
        sentimentScore: sentiment ? sentiment.sum / sentiment.count : null,
        sentimentDocCount: sentiment?.count ?? 0,
      });
    }

    const stats = computePopulationStats(eligible);
    const scored = eligible
      .map((input) => ({ input, components: scoreInstrument(input, stats) }))
      .sort((a, b) => b.components.score - a.components.score)
      .slice(0, SHORTLIST_SIZE);

    const at = nowIso();
    if (scored.length > 0) {
      db.transaction((tx) => {
        tx.delete(radarScores).where(eq(radarScores.tradingDay, tradingDay)).run();
        tx.insert(radarScores)
          .values(
            scored.map(({ input, components: c }, i) => ({
              id: newId(),
              runId,
              tradingDay,
              symbol: input.symbol,
              rank: i + 1,
              score: c.score,
              momentumZ: c.momentumZ,
              trendPct: c.trendPct,
              newHigh: c.newHigh,
              volumeRatio: c.volumeRatio,
              volumeZ: c.volumeZ,
              sentimentZ: c.sentimentZ,
              sentimentDocCount: input.sentimentDocCount,
              inputsUsed: c.inputsUsed,
              createdAt: at,
            })),
          )
          .run();
      });
    }
    shortlisted = scored.length;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    radarRunning = false;
  }

  if (runRowInserted) {
    db.update(radarRuns)
      .set({
        // Keyed off `shortlisted` (whether a shortlist actually got
        // persisted), not `universeScored` (whether the initial read
        // succeeded) — an error thrown after the instruments read but
        // before the transaction completes must not read as 'done' just
        // because the read itself was fine.
        status: errors.length > 0 && shortlisted === 0 ? 'failed' : 'done',
        finishedAt: nowIso(),
        universeScored,
        shortlisted,
        errors,
      })
      .where(eq(radarRuns.id, runId))
      .run();
  }

  return { runId: runRowInserted ? runId : null, universeScored, shortlisted, errors };
}
