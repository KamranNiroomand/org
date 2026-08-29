import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { instruments, panelRuns, panelSymbolAnalyses } from '../db/schema.js';
import { marketDb } from '../db/market/index.js';
import { docMentions, documents, trackedUnderlyings } from '../db/market/schema.js';
import { QuantRefusal, QuantUnavailable, stockCrowding, stockRank, stockRegime, stockSizes, type StockPick } from './quant.js';
import { fetchQuotes } from './quotes.js';
import { nyToday } from './options/positionHealth.js';
import { toVendorSymbol } from './options/universe.js';
import {
  closeStockPosition,
  logStockDecisions,
  type StockDecisionRow,
  markStockPosition,
  openStockPosition,
  openStockOrders,
  stockCapacity,
  stockDecisionsForDay,
  stockEntriesOpenedOn,
  type StockBook,
} from './stockBook.js';

/**
 * The stock engine's daily cycle: rank, read, enter, and manage.
 *
 * Three layers, deliberately independent so a failure in one degrades
 * rather than stops the others:
 *
 *  1. The **model** ranks every symbol it has features for (`/stock/rank`).
 *  2. The **panel** — the existing four-specialist LLM — reads the news
 *     for the top candidates and returns a stance. It is an *overlay*,
 *     exactly like the Tradier quote adapter: when it has an opinion the
 *     engine listens, and when it is missing or broken the engine
 *     proceeds on the quant signal alone and logs that it did. An LLM
 *     outage must never silently halt a systematic strategy.
 *  3. The **book** applies the constraints that make a ranked list into
 *     a portfolio: slots, capital, one position per symbol, a sector
 *     cap, and a per-day entry cap.
 */

const SHORT_TARGET = 'stk_short' as const;
const LONG_TARGET = 'stk_long' as const;

/** How many ranked names the panel reads per book per night. */
const PANEL_CANDIDATES = 12;

export interface StockEntryResult {
  day: string;
  book: StockBook;
  opened: Array<{ symbol: string; quantity: number; orderId: string }>;
  skippedReason: string | null;
  rejections: Array<{ symbol: string; reason: string }>;
}

/** The stance the panel reached for each symbol today, if it ran. */
export function stancesForSymbols(symbols: string[]): Record<string, { stance: string; summary: string }> {
  const map = todaysStances(nyToday(), symbols);
  return Object.fromEntries([...map].map(([k, v]) => [k, { stance: v.stance, summary: v.summary }]));
}

function todaysStances(
  day: string,
  symbols: string[],
): Map<string, { stance: string; summary: string; id: string }> {
  const out = new Map<string, { stance: string; summary: string; id: string }>();
  if (symbols.length === 0) return out;
  const rows = db
    .select({
      id: panelSymbolAnalyses.id,
      symbol: panelSymbolAnalyses.symbol,
      stance: panelSymbolAnalyses.stance,
      summary: panelSymbolAnalyses.summary,
      complete: panelSymbolAnalyses.synthesisComplete,
      startedAt: panelRuns.startedAt,
    })
    .from(panelSymbolAnalyses)
    .innerJoin(panelRuns, eq(panelRuns.id, panelSymbolAnalyses.runId))
    .where(inArray(panelSymbolAnalyses.symbol, symbols))
    // By the *run's* start time, not the analysis id: that id is a
    // random UUID, so ordering on it sorts lexicographically and picks
    // an arbitrary row. Live consequence — FOX's finished 'not_notable'
    // was ignored in favour of an earlier 'mixed' from a different run,
    // and the long book's thesis rule never fired on it.
    .orderBy(desc(panelRuns.startedAt), desc(panelSymbolAnalyses.id))
    .all();
  for (const r of rows) {
    // Today's completed synthesis only. A stale stance is worse than no
    // stance: it reads as a current opinion while describing a week-old
    // company, and the engine would act on it with full confidence.
    if (!r.complete || !r.startedAt?.startsWith(day)) continue;
    if (!out.has(r.symbol)) out.set(r.symbol, { stance: r.stance, summary: r.summary, id: r.id });
  }
  return out;
}

/**
 * The panel's last two thesis verdicts for a held symbol, newest first —
 * only real, completed reviews (thesisVerdict is written exclusively when
 * the panel saw a heldThesis in context). The exit rule requires TWO
 * consecutive 'broken' reads before the long book closes: one LLM read on
 * one day is exactly the noise source that used to close positions on
 * quiet days, and a thesis that is genuinely dead will still be dead
 * tomorrow — the confirmation costs one day of exposure and buys immunity
 * to a single bad sample.
 */
function latestThesisVerdicts(symbol: string, limit = 2): Array<'intact' | 'weakened' | 'broken'> {
  const rows = db
    .select({ verdict: panelSymbolAnalyses.thesisVerdict, startedAt: panelRuns.startedAt })
    .from(panelSymbolAnalyses)
    .innerJoin(panelRuns, eq(panelRuns.id, panelSymbolAnalyses.runId))
    .where(
      eq(panelSymbolAnalyses.symbol, symbol),
    )
    .orderBy(desc(panelRuns.startedAt), desc(panelSymbolAnalyses.id))
    .limit(20)
    .all();
  const verdicts: Array<'intact' | 'weakened' | 'broken'> = [];
  let lastDay: string | null = null;
  for (const r of rows) {
    if (r.verdict === null) continue;
    // One verdict per calendar day, the newest: "two consecutive broken
    // reads" must mean two different days' evidence, or a user clicking
    // Run cycle twice on one bad afternoon would self-confirm an exit.
    const runDay = r.startedAt?.slice(0, 10) ?? null;
    if (runDay !== null && runDay === lastDay) continue;
    lastDay = runDay;
    verdicts.push(r.verdict);
    if (verdicts.length >= limit) break;
  }
  return verdicts;
}

/**
 * Deterministic intraday distress signals for one open position — the
 * "a stock can be fine at the open and gross by noon" problem. Pure and
 * price-anchored: each signal is defined against the position's OWN stop
 * budget, so a volatile name isn't flagged for a move that is ordinary
 * for it while a quiet name gets flagged for the same percentage.
 * Returns the strongest signal or null. News distress is checked
 * separately (it needs a database, this needs arithmetic).
 *
 * - 'near_stop': more than 65% of the entry→stop distance is spent. The
 *   stop will still bound the loss, but by the time it fires the panel
 *   was never asked whether the reason for owning it died first.
 * - 'sharp_day_drop': a single session consumed 40%+ of the total stop
 *   budget — the shape of an event, not a drift.
 */
export function priceDistress(input: {
  priceE4: number;
  entryPriceE4: number;
  stopPriceE4: number | null;
  dayChangePercent: number | null;
}): 'near_stop' | 'sharp_day_drop' | null {
  const { priceE4, entryPriceE4, stopPriceE4, dayChangePercent } = input;
  if (stopPriceE4 === null || stopPriceE4 >= entryPriceE4) return null;
  const budget = entryPriceE4 - stopPriceE4;
  if (priceE4 < entryPriceE4 && (priceE4 - stopPriceE4) / budget < 0.35) return 'near_stop';
  const stopPct = budget / entryPriceE4;
  if (dayChangePercent !== null && dayChangePercent / 100 <= -0.4 * stopPct) return 'sharp_day_drop';
  return null;
}

/**
 * What the long book does with a position given the panel's last thesis
 * verdicts, newest first. Pure on purpose — this is the rule that decides
 * whether a six-month position dies, and it must be testable without a
 * database: 'exit' only on two consecutive 'broken' reads (one LLM read
 * on one day is a sample, not a verdict), 'unconfirmed'/'weakened' put a
 * warning in the decision log, 'none' holds quietly.
 */
export function thesisExitAction(
  verdicts: Array<'intact' | 'weakened' | 'broken'>,
): 'exit' | 'unconfirmed' | 'weakened' | 'none' {
  if (verdicts[0] === 'broken') return verdicts[1] === 'broken' ? 'exit' : 'unconfirmed';
  if (verdicts[0] === 'weakened') return 'weakened';
  return 'none';
}

/**
 * Fresh, affirmatively bad news on a symbol — the distress trigger price
 * alone can't see: a mid-day guidance cut or regulatory action lands in
 * the corpus (text sync runs every 20 minutes in market hours) well
 * before the price finishes reacting. Only a classified event with
 * negative sentiment counts; ordinary chatter and neutral coverage never
 * summon a review.
 */
function freshNegativeNews(symbol: string, sinceHours = 12): { title: string; eventType: string | null } | null {
  const isUnsafeToConvert = symbol.includes('-') && symbol.includes('.');
  if (isUnsafeToConvert) return null;
  const cutoff = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
  const row = marketDb
    .select({ title: documents.title, eventType: documents.eventType })
    .from(docMentions)
    .innerJoin(documents, eq(docMentions.documentId, documents.id))
    .where(
      sql`${docMentions.underlying} = ${toVendorSymbol(symbol)} and ${docMentions.sentiment} = 'negative' and ${documents.publishedAt} >= ${cutoff} and ${documents.eventType} is not null and ${documents.eventType} != 'other'`,
    )
    .orderBy(desc(documents.publishedAt))
    .limit(1)
    .get();
  return row ?? null;
}

/** Today's thesis verdicts per symbol — completed syntheses from today's
 * runs only, newest run first, same staleness discipline as
 * `todaysStances` and for the same reason. */
function todaysThesisVerdicts(day: string, symbols: string[]): Map<string, 'intact' | 'weakened' | 'broken'> {
  const out = new Map<string, 'intact' | 'weakened' | 'broken'>();
  if (symbols.length === 0) return out;
  const rows = db
    .select({
      symbol: panelSymbolAnalyses.symbol,
      verdict: panelSymbolAnalyses.thesisVerdict,
      complete: panelSymbolAnalyses.synthesisComplete,
      startedAt: panelRuns.startedAt,
    })
    .from(panelSymbolAnalyses)
    .innerJoin(panelRuns, eq(panelRuns.id, panelSymbolAnalyses.runId))
    .where(inArray(panelSymbolAnalyses.symbol, symbols))
    .orderBy(desc(panelRuns.startedAt), desc(panelSymbolAnalyses.id))
    .all();
  for (const r of rows) {
    if (!r.complete || r.verdict === null || !r.startedAt?.startsWith(day)) continue;
    if (!out.has(r.symbol)) out.set(r.symbol, r.verdict);
  }
  return out;
}

/**
 * How many new positions a day may open under a market regime — the
 * vol-management evidence applied at the only safe altitude: entries.
 * Existing positions are never touched (their exits have their own
 * rules); the throttle only slows the rate at which new risk goes on
 * when the tape is in the historically toxic quadrant. 'unknown' — a
 * missing quant sidecar or thin index history — spends the full budget:
 * do no harm must not fail closed into never trading.
 */
export function regimeEntryCap(
  maxNewPerDay: number,
  regime: 'risk_on' | 'neutral' | 'risk_off' | 'unknown',
): number {
  if (regime === 'risk_off') return 1;
  if (regime === 'neutral') return Math.max(1, Math.floor(maxNewPerDay * 0.75));
  return maxNewPerDay;
}

/** Stop distance in percent, scaled to the symbol's own volatility over
 * the book's horizon — the same principle as the options book's
 * sigma-scaled stops, with an equity's elasticity of 1. */
export function stockStopPct(
  annualVol: number | null,
  horizonDays: number,
  sigmas: number,
  maxPct = 0.2,
): number {
  if (annualVol === null || !(annualVol > 0)) return 0.12;
  const sigmaHorizon = annualVol * Math.sqrt(horizonDays / 252);
  return Math.min(maxPct, Math.max(0.05, sigmas * sigmaHorizon));
}

/**
 * The target, as a distance rather than a forecast.
 *
 * Two sigma of a 145%-vol name over 126 days is a +308% price
 * objective — arithmetically correct and completely useless, and it
 * pushes the breakeven ratchet's halfway mark somewhere the position
 * will never reach, which quietly disables the one rule that guarantees
 * a winner cannot become a loser. Targets are therefore a multiple of
 * the position's own stop distance: a fixed, legible reward-to-risk
 * rather than an extrapolation the model cannot support.
 */
export function stockTargetPct(stopPct: number, book: StockBook): number {
  return stopPct * (book === 'short' ? 2 : 2.5);
}

export async function runStockEntries(
  log: FastifyBaseLogger,
  book: StockBook,
  day = nyToday(),
): Promise<StockEntryResult> {
  const result: StockEntryResult = { day, book, opened: [], skippedReason: null, rejections: [] };
  // No entries when the market is not open: a weekend or holiday "Run
  // cycle" would buy at the previous session's close — a fill nobody
  // could get (the options book learned this on a Saturday, with FICO).
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    result.skippedReason = `market_closed: ${day} is not a trading session`;
    logStockDecisions([
      { day, book, symbol: '-', decision: 'skipped', reason: 'market_closed', detail: { day } },
    ]);
    return result;
  }
  const target = book === 'short' ? SHORT_TARGET : LONG_TARGET;
  const cfg = config.market.stockBook;
  const maxPositions = book === 'short' ? cfg.shortMaxPositions : cfg.longMaxPositions;
  const horizonDays = book === 'short' ? 21 : 126;

  const capacity = stockCapacity(book);
  const alreadyToday = stockEntriesOpenedOn(day, book);

  // The market's own state gates how fast new risk goes on. Fail-open:
  // a down sidecar reads as 'unknown' and the full budget applies — the
  // regime layer is an overlay, exactly like the panel.
  let regime: Awaited<ReturnType<typeof stockRegime>> | null = null;
  try {
    regime = await stockRegime(day);
  } catch (err) {
    log.warn(`Stock entries: regime unavailable — ${err instanceof Error ? err.message : String(err)}`);
  }
  const dailyCap = regimeEntryCap(cfg.maxNewPerDay, regime?.regime ?? 'unknown');
  const slots = Math.min(
    Math.max(0, maxPositions - capacity.openCount),
    Math.max(0, dailyCap - alreadyToday),
  );
  if (slots < Math.max(0, Math.min(maxPositions - capacity.openCount, cfg.maxNewPerDay - alreadyToday))) {
    // The regime actually bit today — say so in the log, or a throttled
    // day is indistinguishable from an uneventful one.
    logStockDecisions([
      {
        day,
        book,
        symbol: '*',
        decision: 'skipped',
        reason: 'regime_throttle',
        detail: { regime: regime?.regime, exposure: regime?.exposure, dailyCap, maxNewPerDay: cfg.maxNewPerDay },
        modelRunId: null,
      },
    ]);
  }
  if (slots <= 0) {
    const reason =
      alreadyToday >= cfg.maxNewPerDay
        ? 'daily_cap_spent'
        : alreadyToday >= dailyCap
          ? 'regime_throttle'
          : 'no_slots';
    result.skippedReason =
      reason === 'daily_cap_spent'
        ? `daily_cap_spent: ${alreadyToday} ${book}-book entries already opened for ${day}`
        : reason === 'regime_throttle'
          ? `regime_throttle: ${regime?.regime ?? 'unknown'} regime caps new entries at ${dailyCap}/day (${alreadyToday} opened)`
          : `no_slots: ${capacity.openCount}/${maxPositions} ${book}-book positions already open`;
    logStockDecisions([
      {
        day,
        book,
        symbol: '-',
        decision: 'skipped',
        reason,
        detail: { alreadyToday, openCount: capacity.openCount, maxPositions },
      },
    ]);
    return result;
  }

  let picks: StockPick[];
  let modelRunId: string;
  try {
    const ranked = await stockRank(day, target, 25);
    picks = ranked.picks;
    modelRunId = ranked.modelRunId;
  } catch (err) {
    result.skippedReason =
      err instanceof QuantRefusal || err instanceof QuantUnavailable
        ? `quant_unavailable: ${err.message}`
        : `rank_failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
  if (picks.length === 0) {
    result.skippedReason = 'no_ranked_candidates';
    return result;
  }

  const stances = todaysStances(day, picks.slice(0, PANEL_CANDIDATES).map((p) => p.symbol));
  if (stances.size === 0) {
    log.info(`Stock entries (${book}): no panel stances for ${day} — proceeding on the quant signal alone`);
  }

  // One quote call for the shortlist. A position may only open at a
  // measured price: unlike the options book, equities really do have a
  // live quote, so there is no honest reason to model one.
  const shortlist = picks.slice(0, PANEL_CANDIDATES).map((p) => p.symbol);
  const quotes = await fetchQuotes(shortlist);
  // Sector comes from `instruments` for companies and from
  // `tracked_underlyings` for funds, which already classifies them as
  // "ETF / broad", "ETF / sector", "ETF / commodity" or "ETF /
  // leveraged". Both books hold stocks and ETFs side by side — a sector
  // fund or a commodity fund is a legitimate expression of a
  // cross-sectional forecast, and the model ranks them on the same bar
  // features it ranks anything else.
  const sectors = new Map<string, string | null>(
    db
      .select({ symbol: instruments.symbol, sector: instruments.sector })
      .from(instruments)
      .where(inArray(instruments.symbol, shortlist))
      .all()
      .map((r) => [r.symbol, r.sector]),
  );
  for (const row of marketDb
    .select({ symbol: trackedUnderlyings.symbol, sector: trackedUnderlyings.sector })
    .from(trackedUnderlyings)
    .where(inArray(trackedUnderlyings.symbol, shortlist))
    .all()) {
    if (!sectors.get(row.symbol) && row.sector) sectors.set(row.symbol, row.sector);
  }

  const decisions: StockDecisionRow[] = [];
  const pushRejection = (symbol: string, reason: string, detail: Record<string, unknown> = {}) => {
    result.rejections.push({ symbol, reason });
    decisions.push({ day, book, symbol, decision: 'rejected', reason, detail, modelRunId });
  };
  const sectorCounts = { ...capacity.sectorCounts };
  const held = new Set(capacity.heldSymbols);
  let remainingCashE4 = capacity.freeCashE4;
  const perPositionE4 = Math.floor(capacity.bookCapitalE4 / maxPositions);

  // The stop each candidate would actually get, computed once: sizing is
  // a function of the stop (equal dollars at every stop — sizing.py),
  // and computing it twice invites the two to disagree about the risk.
  const stopPctBySymbol = new Map(
    picks
      .slice(0, PANEL_CANDIDATES)
      .map((p) => [
        p.symbol,
        stockStopPct(p.forecastVol, horizonDays, book === 'short' ? 1.5 : 2, book === 'short' ? 0.2 : 0.3),
      ]),
  );
  // Both quant overlays fail open: a down sidecar means equal-slice
  // sizing and no crowding veto, never a halted entry pass.
  let sizeBySymbol = new Map<string, number>();
  try {
    sizeBySymbol = await stockSizes(
      capacity.bookCapitalE4,
      maxPositions,
      [...stopPctBySymbol].map(([symbol, stopPct]) => ({ symbol, stop_pct: stopPct })),
    );
  } catch (err) {
    log.warn(`Stock entries: sizing unavailable, equal slices — ${err instanceof Error ? err.message : String(err)}`);
  }
  let crowding = new Map<string, { avgCorr: number; nHeldUsed: number }>();
  const allHeld = [...new Set([...stockCapacity('short').heldSymbols, ...stockCapacity('long').heldSymbols])];
  if (allHeld.length >= 3) {
    try {
      crowding = await stockCrowding(allHeld, [...stopPctBySymbol.keys()]);
    } catch (err) {
      log.warn(`Stock entries: crowding unavailable — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const pick of picks.slice(0, PANEL_CANDIDATES)) {
    if (result.opened.length >= slots) {
      pushRejection(pick.symbol, 'slots_full');
      continue;
    }
    if (held.has(pick.symbol)) {
      pushRejection(pick.symbol, 'already_held');
      continue;
    }
    const stance = stances.get(pick.symbol);
    if (stance?.stance === 'not_notable') {
      pushRejection(pick.symbol, 'panel_not_notable');
      continue;
    }
    // A pick must be *classified* — placed in a sector by the universe
    // classifier or labelled a fund by the tracked universe. An entirely
    // unknown symbol has no diversification bucket, and letting such
    // symbols share one would let a book fill up with them.
    const sector = sectors.get(pick.symbol) ?? null;
    if (sector === null) {
      pushRejection(pick.symbol, 'unclassified_symbol');
      continue;
    }
    // Leveraged funds are barred from the long book only, and the reason
    // is arithmetic rather than taste: a daily-rebalanced 3x fund tracks
    // 3x the *daily* return, so over months its path decays against the
    // index in any choppy tape — the well-documented volatility drag.
    // Over twenty-one days that drag is second-order and the short book
    // may hold them; over a hundred and twenty-six it is the dominant
    // term, and no directional forecast this model produces is strong
    // enough to pay it. The engine bought SOXL into a six-month book on
    // its first live cycle, which is what made the rule necessary.
    if (book === 'long' && sector === 'ETF / leveraged') {
      pushRejection(pick.symbol, 'leveraged_etf_in_long_book');
      continue;
    }
    if ((sectorCounts[sector] ?? 0) >= cfg.maxPerSector) {
      result.rejections.push({ symbol: pick.symbol, reason: `sector_cap:${sector}` });
      continue;
    }
    const crowd = crowding.get(pick.symbol);
    if (crowd && crowd.avgCorr > cfg.maxBookCorrelation) {
      pushRejection(pick.symbol, `crowded:${crowd.avgCorr.toFixed(2)}`, {
        avgCorr: crowd.avgCorr,
        nHeldUsed: crowd.nHeldUsed,
        threshold: cfg.maxBookCorrelation,
      });
      continue;
    }
    const quote = quotes.get(pick.symbol);
    if (!quote || !(quote.price > 0)) {
      pushRejection(pick.symbol, 'no_quote');
      continue;
    }
    // quotes.ts prices are minor units (cents); the book stores E4.
    const priceE4 = quote.price * 100;
    const budgetE4 = Math.min(sizeBySymbol.get(pick.symbol) ?? perPositionE4, remainingCashE4);
    const quantity = Math.floor((budgetE4 / priceE4) * 1000) / 1000; // fractional, 3dp
    if (quantity <= 0) {
      pushRejection(pick.symbol, 'unaffordable');
      continue;
    }

    // The ceiling is per book and deliberately tight for equities. A
    // 1.5-sigma stop on a 145%-vol name computes to 63%, and a stop that
    // lets half the position evaporate before it fires is not risk
    // management — it is an options-book parameter (where the premium at
    // risk is a fraction of exposure) applied to shares, where it is
    // not. Volatility belongs in position *sizing*; the stop's job is to
    // bound the loss.
    const stopPct = stopPctBySymbol.get(pick.symbol)!;
    const targetExit = new Date(Date.parse(`${day}T00:00:00Z`) + horizonDays * 1.4 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const orderId = openStockPosition({
      symbol: pick.symbol,
      book,
      quantity,
      priceE4,
      basis: 'measured',
      day,
      sector,
      forecastReturn: pick.horizonReturn,
      modelRunId,
      thesisRef: stance?.id ?? null,
      stopPriceE4: Math.round(priceE4 * (1 - stopPct)),
      // See stockTargetPct: a multiple of this position's own stop, not
      // a sigma extrapolation. The asymmetry is the point — 2x the risk
      // on a one-month position, 2.5x on a six-month one — and it stays
      // legible at any volatility.
      targetPriceE4: Math.round(priceE4 * (1 + stockTargetPct(stopPct, book))),
      targetExitDate: targetExit,
      notes:
        `Rank ${pick.rank} of the ${target} board: forecast ` +
        `${pick.forecastSigmas !== null ? `${pick.forecastSigmas.toFixed(2)} sigma` : 'n/a'} ` +
        `over ${horizonDays} trading days, stop ${(stopPct * 100).toFixed(0)}% ` +
        `(${book === 'short' ? 1.5 : 3} sigma). ` +
        (stance ? `Panel: ${stance.stance}.` : 'Panel: no stance today.'),
    });
    result.opened.push({ symbol: pick.symbol, quantity, orderId });
    decisions.push({
      day,
      book,
      symbol: pick.symbol,
      decision: 'opened',
      reason: 'cleared_all_rules',
      detail: {
        rank: pick.rank,
        forecastSigmas: pick.forecastSigmas,
        quantity,
        priceE4,
        stopPct,
        sector,
      },
      modelRunId,
      panelStance: stance?.stance ?? null,
    });
    held.add(pick.symbol);
    sectorCounts[sector] = (sectorCounts[sector] ?? 0) + 1;
    remainingCashE4 -= Math.round(priceE4 * quantity);
  }
  logStockDecisions(decisions);
  return result;
}

export interface StockExitResult {
  day: string;
  checked: number;
  closed: number;
  marked: number;
  errors: string[];
}

/**
 * The daily pass over every open stock position: mark it, then apply the
 * book's exit rules.
 *
 * Daily, not every fifteen minutes. A 21-day thesis re-examined every
 * quarter hour is a thesis being asked to defend itself against noise —
 * and the long book's positions are meant to be held through exactly the
 * wobbles an intraday rulebook would sell into.
 */
export async function runStockExits(log: FastifyBaseLogger, day = nyToday()): Promise<StockExitResult> {
  const result: StockExitResult = { day, checked: 0, closed: 0, marked: 0, errors: [] };
  const orders = openStockOrders();
  if (orders.length === 0) return result;
  const decisions: StockDecisionRow[] = [];

  const quotes = await fetchQuotes([...new Set(orders.map((o) => o.symbol))]);

  // The intraday distress ledger: which held symbols already got an
  // event-triggered panel review today (this pass or an earlier one),
  // and what those reviews concluded. Persisted in the decision log, so
  // the cap and the dedupe survive restarts — a symbol is reviewed at
  // most once per day, and at most `maxReviews` symbols per day, because
  // each review costs nine LLM calls and a panicky tape must not be able
  // to spend the whole budget re-asking the same question.
  const distressReviewed = new Set(
    stockDecisionsForDay(day)
      .filter((d) => d.reason === 'distress_review')
      .map((d) => d.symbol),
  );
  const maxDistressReviews = config.market.stockBook.distressMaxReviewsPerDay;
  const eventVerdicts = todaysThesisVerdicts(day, [...distressReviewed]);
  const panelable =
    distressReviewed.size >= maxDistressReviews || !config.anthropic.configured
      ? new Set<string>()
      : new Set(
          db
            .select({ symbol: instruments.symbol })
            .from(instruments)
            .where(inArray(instruments.symbol, [...new Set(orders.map((o) => o.symbol))]))
            .all()
            .map((r) => r.symbol),
        );

  for (const order of orders) {
    result.checked += 1;
    const quote = quotes.get(order.symbol);
    if (!quote || !(quote.price > 0)) {
      result.errors.push(`${order.symbol}: no quote — position left unmanaged this pass`);
      decisions.push({
        day,
        book: order.book,
        symbol: order.symbol,
        decision: 'skipped',
        reason: 'no_quote',
        detail: {},
        modelRunId: order.modelRunId,
      });
      continue;
    }
    const priceE4 = quote.price * 100;
    markStockPosition(order.id, day, priceE4, 'measured');
    result.marked += 1;

    // 1. The stop, first and unconditionally: it is the only rule that
    //    exists to bound a loss, and every other consideration is about
    //    a position that still has a future.
    if (order.stopPriceE4 !== null && priceE4 <= order.stopPriceE4) {
      closeStockPosition(order.id, priceE4, 'measured', day, 'stop_loss');
      result.closed += 1;
      decisions.push({
        day,
        book: order.book,
        symbol: order.symbol,
        decision: 'exited',
        reason: 'stop_loss',
        detail: { priceE4, entryPriceE4: order.entryPriceE4, stopPriceE4: order.stopPriceE4 },
        modelRunId: order.modelRunId,
      });
      continue;
    }

    // 2. The horizon: past its target date, the forecast that justified
    //    the position has fully played out. The short book exits; the
    //    long book defers to the panel's current view instead, because a
    //    six-month thesis is about the company, not the calendar.
    const pastHorizon = order.targetExitDate !== null && day > order.targetExitDate;
    if (pastHorizon && order.book === 'short') {
      closeStockPosition(order.id, priceE4, 'measured', day, 'horizon_spent');
      result.closed += 1;
      decisions.push({
        day,
        book: order.book,
        symbol: order.symbol,
        decision: 'exited',
        reason: 'horizon_spent',
        detail: { priceE4, entryPriceE4: order.entryPriceE4, stopPriceE4: order.stopPriceE4 },
        modelRunId: order.modelRunId,
      });
      continue;
    }

    // 3. The long book's thesis check. This used to key on the panel's
    //    daily stance, and `not_notable` — "a quiet day" — closed
    //    positions whose thesis nobody had actually examined (ERIE died
    //    this way). The stance answers "was today notable" and re-rolls
    //    with every news cycle; a six-month position needs the panel's
    //    judgment of its ORIGINAL thesis (`thesisVerdict`, written only
    //    when the panel reviewed the held position), and it needs it
    //    twice: only two consecutive 'broken' reads close the book, so a
    //    single noisy LLM sample can never end a position on its own.
    if (order.book === 'long') {
      const verdicts = latestThesisVerdicts(order.symbol);
      const action = thesisExitAction(verdicts);
      if (action === 'exit') {
        closeStockPosition(order.id, priceE4, 'measured', day, 'thesis_broken');
        result.closed += 1;
        decisions.push({
          day,
          book: order.book,
          symbol: order.symbol,
          decision: 'exited',
          reason: 'thesis_broken',
          detail: { priceE4, entryPriceE4: order.entryPriceE4, verdicts },
          modelRunId: order.modelRunId,
        });
        continue;
      }
      if (action === 'unconfirmed' || action === 'weakened') {
        // Not an exit yet — but silent tolerance would be indistinguishable
        // from never having checked. The decision log carries the warning.
        decisions.push({
          day,
          book: order.book,
          symbol: order.symbol,
          decision: 'held',
          reason: action === 'unconfirmed' ? 'thesis_broken_unconfirmed' : 'thesis_weakened',
          detail: { priceE4, verdicts },
          modelRunId: order.modelRunId,
        });
      }
    }

    // 3.5 Intraday distress — the mechanism for "fine at the open,
    //    gross by noon". Deterministic triggers watch every pass: price
    //    signals scaled to the position's own stop budget, and fresh
    //    negative classified news (the text sync lands new stories every
    //    20 minutes in market hours). A trigger summons a focused panel
    //    review of that one symbol immediately instead of waiting for
    //    tonight's cycle; a later pass acts on the verdict. An
    //    event-triggered 'broken' closes SAME-DAY, without the two-day
    //    confirmation — that rule guards against noise on quiet days,
    //    and this path only ever fires on affirmative adverse evidence.
    //    'weakened' tightens the stop to halfway between where it was
    //    and the current price: keep the position, cut the tail.
    if (distressReviewed.has(order.symbol)) {
      const verdict = eventVerdicts.get(order.symbol);
      if (verdict === 'broken') {
        closeStockPosition(order.id, priceE4, 'measured', day, 'thesis_broken_event');
        result.closed += 1;
        decisions.push({
          day,
          book: order.book,
          symbol: order.symbol,
          decision: 'exited',
          reason: 'thesis_broken_event',
          detail: { priceE4, entryPriceE4: order.entryPriceE4 },
          modelRunId: order.modelRunId,
        });
        continue;
      }
      if (verdict === 'weakened' && order.stopPriceE4 !== null && priceE4 > order.stopPriceE4) {
        const tightened = Math.round((order.stopPriceE4 + priceE4) / 2);
        if (tightened > order.stopPriceE4) {
          const { paperDb } = await import('../db/paper/index.js');
          const { stockOrders } = await import('../db/paper/schema.js');
          paperDb
            .update(stockOrders)
            .set({ stopPriceE4: tightened, exitUpdatedAt: new Date().toISOString() })
            .where(eq(stockOrders.id, order.id))
            .run();
          log.info(`Stock exits: ${order.symbol} stop tightened after weakened event review`);
          decisions.push({
            day,
            book: order.book,
            symbol: order.symbol,
            decision: 'stop_raised',
            reason: 'distress_stop_tighten',
            detail: { from: order.stopPriceE4, to: tightened, priceE4 },
            modelRunId: order.modelRunId,
          });
          order.stopPriceE4 = tightened;
        }
      }
    } else if (panelable.has(order.symbol) && distressReviewed.size < maxDistressReviews) {
      const signal =
        priceDistress({
          priceE4,
          entryPriceE4: order.entryPriceE4,
          stopPriceE4: order.stopPriceE4,
          dayChangePercent: quote.dayChangePercent,
        }) ?? (freshNegativeNews(order.symbol) ? 'fresh_negative_news' : null);
      if (signal !== null) {
        const { startPanelRun } = await import('./agents/panel/run.js');
        const runId = startPanelRun({
          trigger: 'stock_picks',
          query: null,
          resolutionMethod: 'model_shortlist',
          symbols: [order.symbol],
        });
        // Not awaited: this pass's job is to raise the alarm, and the
        // next pass (15 minutes) acts on the verdict. Blocking every
        // position check behind a 3-minute panel would gut the cadence.
        distressReviewed.add(order.symbol);
        log.info(`Stock exits: ${order.symbol} distress review started (${signal})`);
        decisions.push({
          day,
          book: order.book,
          symbol: order.symbol,
          decision: 'held',
          reason: 'distress_review',
          detail: { signal, runId, priceE4, stopPriceE4: order.stopPriceE4 },
          modelRunId: order.modelRunId,
        });
      }
    }

    // 4. Breakeven ratchet, shared by both books: once a position is
    //    halfway to its target, it must not be allowed to become a loss.
    if (order.targetPriceE4 !== null && order.stopPriceE4 !== null) {
      const halfway = order.entryPriceE4 + 0.5 * (order.targetPriceE4 - order.entryPriceE4);
      if (priceE4 >= halfway && order.stopPriceE4 < order.entryPriceE4) {
        const { paperDb } = await import('../db/paper/index.js');
        const { stockOrders } = await import('../db/paper/schema.js');
        paperDb
          .update(stockOrders)
          .set({ stopPriceE4: order.entryPriceE4, exitUpdatedAt: new Date().toISOString() })
          .where(eq(stockOrders.id, order.id))
          .run();
        log.info(`Stock exits: ${order.symbol} stop ratcheted to breakeven`);
        decisions.push({
          day,
          book: order.book,
          symbol: order.symbol,
          decision: 'stop_raised',
          reason: 'breakeven_ratchet',
          detail: { from: order.stopPriceE4, to: order.entryPriceE4, priceE4 },
          modelRunId: order.modelRunId,
        });
      }
    }
  }
  logStockDecisions(decisions);
  return result;
}


/**
 * The whole nightly stock cycle: have the panel read the news for the
 * model's best candidates, then let each book act on what it learned.
 *
 * The panel is started and *waited for*, but on a bounded timer: the
 * whole point of reading the news is to have read it before buying, and
 * the whole point of a systematic strategy is that it still trades when
 * the LLM is down. Past the deadline the engine proceeds with whatever
 * stances arrived — usually all of them, occasionally none.
 */
export async function runStockCycle(
  log: FastifyBaseLogger,
  day = nyToday(),
): Promise<{ day: string; entries: StockEntryResult[]; exits: StockExitResult }> {
  const { startPanelRun } = await import('./agents/panel/run.js');
  const { panelRuns } = await import('../db/schema.js');

  // Shortlist = the union of both boards' best names, so one panel run
  // serves both books rather than paying twice for overlapping symbols.
  const shortlist = new Set<string>();
  for (const target of [SHORT_TARGET, LONG_TARGET] as const) {
    try {
      const ranked = await stockRank(day, target, PANEL_CANDIDATES);
      for (const p of ranked.picks) shortlist.add(p.symbol);
    } catch (err) {
      log.warn(`Stock cycle: ${target} rank unavailable — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Only companies reach the panel. ETFs are eligible *positions* — the
  // books hold them alongside stocks — but they are not eligible
  // *subjects*: the four specialists reason about a business (its
  // fundamentals, its news, the bear case against it), and a fund has
  // none of those. Asking anyway paid for five LLM calls to conclude
  // "not found in instruments", which is also what marked every run
  // 'partial'. An ETF simply enters on the quant signal with no stance,
  // which the entry rules already tolerate.
  const classified = new Set(
    db
      .select({ symbol: instruments.symbol })
      .from(instruments)
      .where(inArray(instruments.symbol, [...shortlist]))
      .all()
      .map((r) => r.symbol),
  );
  for (const s of [...shortlist]) if (!classified.has(s)) shortlist.delete(s);

  if (shortlist.size > 0 && config.anthropic.configured) {
    const runId = startPanelRun({
      trigger: 'stock_picks',
      query: null,
      resolutionMethod: 'model_shortlist',
      symbols: [...shortlist],
    });
    // Twenty minutes, not six. A real run over ~15 symbols takes twelve
    // to fifteen — four specialists twice plus a synthesis apiece — and
    // a six-minute deadline meant entries fired on half-formed stances:
    // ERIE was bought at a placeholder while its finished verdict was
    // 'not_notable'. The deadline exists so an LLM outage cannot halt
    // the strategy, not so a healthy panel gets cut off mid-sentence.
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      const row = db.select().from(panelRuns).where(eq(panelRuns.id, runId)).get();
      if (!row || row.status !== 'running') break;
      if (Date.now() > deadline) {
        log.warn('Stock cycle: panel still running at the deadline — entering on the stances that landed');
        break;
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  } else if (shortlist.size > 0) {
    log.info('Stock cycle: no Anthropic key — entering on the quant signal alone');
  }

  const entries: StockEntryResult[] = [];
  for (const book of ['short', 'long'] as const) {
    try {
      const r = await runStockEntries(log, book, day);
      entries.push(r);
      if (r.opened.length > 0) {
        log.info(`Stock entries (${book}): opened ${r.opened.map((o) => o.symbol).join(', ')}`);
      } else if (r.skippedReason) {
        log.info(`Stock entries (${book}): ${r.skippedReason}`);
      }
    } catch (err) {
      log.error({ err }, `Stock entries (${book}) failed`);
    }
  }

  const exits = await runStockExits(log, day);
  if (exits.closed > 0) log.info(`Stock exits: closed ${exits.closed} of ${exits.checked}`);
  return { day, entries, exits };
}
