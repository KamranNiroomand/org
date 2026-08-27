import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { instruments, panelRuns, panelSymbolAnalyses } from '../db/schema.js';
import { marketDb } from '../db/market/index.js';
import { trackedUnderlyings } from '../db/market/schema.js';
import { QuantRefusal, QuantUnavailable, stockRank, type StockPick } from './quant.js';
import { fetchQuotes } from './quotes.js';
import { nyToday } from './options/positionHealth.js';
import {
  closeStockPosition,
  logStockDecisions,
  type StockDecisionRow,
  markStockPosition,
  openStockPosition,
  openStockOrders,
  stockCapacity,
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
  const target = book === 'short' ? SHORT_TARGET : LONG_TARGET;
  const cfg = config.market.stockBook;
  const maxPositions = book === 'short' ? cfg.shortMaxPositions : cfg.longMaxPositions;
  const horizonDays = book === 'short' ? 21 : 126;

  const capacity = stockCapacity(book);
  const alreadyToday = stockEntriesOpenedOn(day, book);
  const slots = Math.min(
    Math.max(0, maxPositions - capacity.openCount),
    Math.max(0, cfg.maxNewPerDay - alreadyToday),
  );
  if (slots <= 0) {
    const reason = alreadyToday >= cfg.maxNewPerDay ? 'daily_cap_spent' : 'no_slots';
    result.skippedReason =
      reason === 'daily_cap_spent'
        ? `daily_cap_spent: ${alreadyToday} ${book}-book entries already opened for ${day}`
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
    const quote = quotes.get(pick.symbol);
    if (!quote || !(quote.price > 0)) {
      pushRejection(pick.symbol, 'no_quote');
      continue;
    }
    // quotes.ts prices are minor units (cents); the book stores E4.
    const priceE4 = quote.price * 100;
    const budgetE4 = Math.min(perPositionE4, remainingCashE4);
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
    const stopPct = stockStopPct(
      pick.forecastVol,
      horizonDays,
      book === 'short' ? 1.5 : 2,
      book === 'short' ? 0.2 : 0.3,
    );
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
  const stanceCache = todaysStances(day, [...new Set(orders.map((o) => o.symbol))]);

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

    // 3. The long book's thesis check: the panel turning outright
    //    negative on a name is the closest thing this system has to
    //    "the reason we owned it stopped being true".
    if (order.book === 'long') {
      const stance = stanceCache.get(order.symbol);
      if (stance?.stance === 'not_notable') {
        closeStockPosition(order.id, priceE4, 'measured', day, 'thesis_broken');
        result.closed += 1;
        continue;
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
