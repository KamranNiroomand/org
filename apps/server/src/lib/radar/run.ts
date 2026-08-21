import { eq, gte } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { instruments, radarRuns, radarScores } from '../../db/schema.js';
import { marketDb } from '../../db/market/index.js';
import { documents, docMentions } from '../../db/market/schema.js';
import { toVendorSymbol } from '../options/universe.js';
import { newId, nowIso, todayKey } from '../util.js';
import { computePopulationStats, isEligible, scoreInstrument, type RadarInputs } from './score.js';

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

function sentimentValue(sentiment: 'positive' | 'negative' | 'neutral' | null): number {
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
 * `radarScores` rows for `tradingDay` are cleared before the new shortlist
 * is written, so re-running the same day (the manual trigger route, or a
 * retried cron tick) always leaves exactly `min(50, eligible universe)`
 * rows — never a stale symbol from an earlier run that has since dropped
 * out of the top 50.
 */
export function runRadarScoring(tradingDay: string = todayKey()): RadarRunSummary {
  if (radarRunning) {
    return { runId: null, universeScored: 0, shortlisted: 0, errors: ['A radar run was already in progress; skipped this run.'] };
  }
  radarRunning = true;

  const runId = newId();
  const startedAt = nowIso();
  db.insert(radarRuns).values({ id: runId, startedAt, tradingDay }).run();

  const errors: string[] = [];
  let universeScored = 0;
  let shortlisted = 0;

  try {
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
      })
      .from(instruments)
      .all();
    universeScored = rows.length;

    // Sentiment, keyed by the vendor's symbol format — docMentions.underlying
    // is stored that way (see newsAlerts.ts's own doc comment on the same
    // conversion). Only a forward lookup is needed here (instruments.symbol
    // -> vendor format), unlike createNewsAlerts' reverse direction, since
    // every instrument's own app-format symbol is already known going in.
    const cutoff = new Date(Date.now() - SENTIMENT_LOOKBACK_DAYS * 86_400_000).toISOString();
    const mentions = marketDb
      .select({ underlying: docMentions.underlying, sentiment: docMentions.sentiment })
      .from(docMentions)
      .innerJoin(documents, eq(docMentions.documentId, documents.id))
      .where(gte(documents.publishedAt, cutoff))
      .all();
    const sentimentBySymbol = new Map<string, { sum: number; count: number }>();
    for (const m of mentions) {
      const entry = sentimentBySymbol.get(m.underlying) ?? { sum: 0, count: 0 };
      entry.sum += sentimentValue(m.sentiment);
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
    db.transaction((tx) => {
      tx.delete(radarScores).where(eq(radarScores.tradingDay, tradingDay)).run();
      scored.forEach(({ input, components: c }, i) => {
        tx.insert(radarScores)
          .values({
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
          })
          .run();
      });
    });
    shortlisted = scored.length;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    radarRunning = false;
  }

  db.update(radarRuns)
    .set({
      status: universeScored === 0 && errors.length > 0 ? 'failed' : 'done',
      finishedAt: nowIso(),
      universeScored,
      shortlisted,
      errors,
    })
    .where(eq(radarRuns.id, runId))
    .run();

  return { runId, universeScored, shortlisted, errors };
}
