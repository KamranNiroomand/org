import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { instruments, panelRuns, panelSymbolAnalyses } from '../db/schema.js';
import { QuantRefusal, QuantUnavailable, stockRank, type StockPick } from './quant.js';
import { fetchQuotes } from './quotes.js';
import { nyToday } from './options/positionHealth.js';
import {
  closeStockPosition,
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
export function stockStopPct(annualVol: number | null, horizonDays: number, sigmas: number): number {
  if (annualVol === null || !(annualVol > 0)) return 0.15;
  const sigmaHorizon = annualVol * Math.sqrt(horizonDays / 252);
  return Math.min(0.5, Math.max(0.08, sigmas * sigmaHorizon));
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
    result.skippedReason =
      alreadyToday >= cfg.maxNewPerDay
        ? `daily_cap_spent: ${alreadyToday} ${book}-book entries already opened for ${day}`
        : `no_slots: ${capacity.openCount}/${maxPositions} ${book}-book positions already open`;
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
  const sectors = new Map(
    db
      .select({ symbol: instruments.symbol, sector: instruments.sector })
      .from(instruments)
      .where(inArray(instruments.symbol, shortlist))
      .all()
      .map((r) => [r.symbol, r.sector]),
  );

  const sectorCounts = { ...capacity.sectorCounts };
  const held = new Set(capacity.heldSymbols);
  let remainingCashE4 = capacity.freeCashE4;
  const perPositionE4 = Math.floor(capacity.bookCapitalE4 / maxPositions);

  for (const pick of picks.slice(0, PANEL_CANDIDATES)) {
    if (result.opened.length >= slots) {
      result.rejections.push({ symbol: pick.symbol, reason: 'slots_full' });
      continue;
    }
    if (held.has(pick.symbol)) {
      result.rejections.push({ symbol: pick.symbol, reason: 'already_held' });
      continue;
    }
    const stance = stances.get(pick.symbol);
    if (stance?.stance === 'not_notable') {
      result.rejections.push({ symbol: pick.symbol, reason: 'panel_not_notable' });
      continue;
    }
    // A pick must be a *company* — a symbol the universe classifier
    // placed in a sector. Everything else in the tracked universe is an
    // ETF, and the engine bought SOXL (a 3x leveraged semiconductor
    // fund) into a six-month book on its first live cycle: the most
    // concentrated possible sector bet, wearing "unknown" as its
    // diversification bucket, and a structural loser to volatility decay
    // over that horizon. The features and the panel both reason about
    // businesses; an instrument with no business behind it is out of
    // scope for this engine, not merely unclassified.
    const sector = sectors.get(pick.symbol) ?? null;
    if (sector === null) {
      result.rejections.push({ symbol: pick.symbol, reason: 'not_a_classified_company' });
      continue;
    }
    if ((sectorCounts[sector] ?? 0) >= cfg.maxPerSector) {
      result.rejections.push({ symbol: pick.symbol, reason: `sector_cap:${sector}` });
      continue;
    }
    const quote = quotes.get(pick.symbol);
    if (!quote || !(quote.price > 0)) {
      result.rejections.push({ symbol: pick.symbol, reason: 'no_quote' });
      continue;
    }
    // quotes.ts prices are minor units (cents); the book stores E4.
    const priceE4 = quote.price * 100;
    const budgetE4 = Math.min(perPositionE4, remainingCashE4);
    const quantity = Math.floor((budgetE4 / priceE4) * 1000) / 1000; // fractional, 3dp
    if (quantity <= 0) {
      result.rejections.push({ symbol: pick.symbol, reason: 'unaffordable' });
      continue;
    }

    const stopPct = stockStopPct(pick.forecastVol, horizonDays, book === 'short' ? 1.5 : 3);
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
      // The target is a volatility distance, not the model's own
      // forecast magnitude. At this IC the ordering may carry
      // information while the magnitude does not — deriving a target
      // from a 5-sigma outlier prediction once set a 21-day price
      // objective 2.7x above entry, which then pushed the breakeven
      // ratchet's halfway mark out of reach. Two sigma up against a
      // 1.5-sigma stop is the asymmetry the position is actually taken
      // for.
      targetPriceE4: Math.round(
        priceE4 * (1 + (book === 'short' ? 2 : 3) * (pick.forecastVol ?? 0.3) * Math.sqrt(horizonDays / 252)),
      ),
      targetExitDate: targetExit,
      notes:
        `Rank ${pick.rank} of the ${target} board: forecast ` +
        `${pick.forecastSigmas !== null ? `${pick.forecastSigmas.toFixed(2)} sigma` : 'n/a'} ` +
        `over ${horizonDays} trading days, stop ${(stopPct * 100).toFixed(0)}% ` +
        `(${book === 'short' ? 1.5 : 3} sigma). ` +
        (stance ? `Panel: ${stance.stance}.` : 'Panel: no stance today.'),
    });
    result.opened.push({ symbol: pick.symbol, quantity, orderId });
    held.add(pick.symbol);
    sectorCounts[sector] = (sectorCounts[sector] ?? 0) + 1;
    remainingCashE4 -= Math.round(priceE4 * quantity);
  }
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

  const quotes = await fetchQuotes([...new Set(orders.map((o) => o.symbol))]);
  const stanceCache = todaysStances(day, [...new Set(orders.map((o) => o.symbol))]);

  for (const order of orders) {
    result.checked += 1;
    const quote = quotes.get(order.symbol);
    if (!quote || !(quote.price > 0)) {
      result.errors.push(`${order.symbol}: no quote — position left unmanaged this pass`);
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
      }
    }
  }
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

  // Only classified companies reach the panel — the same rule entries
  // apply. Sending ETFs was paying for four specialist calls and a
  // synthesis about an instrument the engine would reject anyway, and
  // it marked every run 'partial' on a failure that was really a
  // category error ("SOXL: not found in instruments").
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
