import { desc, eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { stockAgentReads } from '../../db/schema.js';
import { config } from '../../config.js';
import { getAnthropicClient } from './panel/client.js';
import { ANTHROPIC_CALL_OPTIONS } from './panel/types.js';
import { clampProbUp } from './panel/specialists.js';
import { newId, nowIso } from '../util.js';

/**
 * The stock reader — the skew reader's sibling for the stock boards.
 *
 * Same standalone contract (no engine reads its verdicts; its Brier
 * record decides its future) with one deliberate difference: this agent
 * SEES the research layers — model rank, panel stance, the skew map's
 * read, and the insider/congressional tape — because its job is
 * synthesis: fold everything the system knows about a name into one
 * verdict a non-technical reader can act on. Independence from the
 * ENGINES is the contract; ignorance of the data is not.
 *
 * Reads the top of each book's board (short = ~3 weeks, long = ~6
 * months) plus current holdings, once per day per book, idempotent per
 * (day, book, symbol).
 */

const SYSTEM = `You are an equity analyst writing one-line verdicts for a
completely non-technical reader. For each candidate you receive every
research signal the system has. Discipline:

- Outside view first: most model picks are noise; most insider/political
  buying is routine; a high model rank alone is weak evidence.
- Convergence is the story: a name where the statistical model, the
  news-reading panel, the options-positioning map, and real insider or
  congressional money AGREE deserves conviction; one signal alone
  rarely does. Say which signals drove you.
- verdict vocabulary: enter_candidate (worth the reader's research
  hours — never an order), avoid (looks tempting, evidence says stand
  back), hold_if_held (fine to keep, not to add), ignore (nothing here).
- plain: the FIRST thing the reader sees. Zero market jargon — no
  "momentum", "sigma", "IC", "options", "skew", "long/short book". Say
  what is happening to the company's stock in everyday words and what
  the reader should do. Example register: "The computer models, the
  news, and several members of Congress are all quietly positive on
  this one at the same time — rare, and worth an hour of your reading."
- probability: your committed P(this name beats its own sector over the
  book's horizon), 0.05-0.95. It WILL be scored; a reflex 0.5 is only
  honest when the evidence is genuinely balanced.
- falsifier: the concrete observation that would change your verdict.`;

const READ_SCHEMA = {
  type: 'object' as const,
  properties: {
    verdict: {
      type: 'string' as const,
      enum: ['enter_candidate', 'avoid', 'hold_if_held', 'ignore'],
    },
    plain: {
      type: 'string' as const,
      description:
        'One or two sentences for someone who knows nothing about markets. Forbidden: momentum, sigma, model rank, options, skew, volatility, book, long, short, IC — any trading concept. What is happening and what to do, in everyday words.',
    },
    probability: { type: 'number' as const, description: 'P(beats own sector over the horizon), 0.05-0.95. Scored.' },
    reasoning: { type: 'string' as const, description: 'Three to five sentences, outside view first, naming which signals drove the verdict.' },
    falsifier: { type: 'string' as const, description: 'The concrete observation that would change this verdict.' },
  },
  required: ['verdict', 'plain', 'probability', 'reasoning', 'falsifier'],
  additionalProperties: false,
};

export interface StockRowForAgent {
  symbol: string;
  book: 'short' | 'long';
  modelRank: number | null;
  forecastSigmas: number | null;
  ret1mPct: number | null;
  panelStance: string | null;
  skewVerdict: string | null;
  /** Net open-market insider buying, trailing 90 days, dollars. */
  insiderNet90dUsd: number | null;
  /** Net congressional buying (range midpoints), trailing 90 days by FILED date. */
  congressNet90dUsd: number | null;
  congressBuyers90d: string[];
  held: boolean;
}

export interface StockAgentRunResult {
  day: string;
  read: number;
  skipped: number;
  errors: string[];
}

export async function runStockReader(day: string, rows: StockRowForAgent[]): Promise<StockAgentRunResult> {
  const result: StockAgentRunResult = { day, read: 0, skipped: 0, errors: [] };
  if (!config.anthropic.configured) {
    result.errors.push('ANTHROPIC_API_KEY is not set');
    return result;
  }
  const already = new Set(
    db
      .select({ book: stockAgentReads.book, symbol: stockAgentReads.symbol })
      .from(stockAgentReads)
      .where(eq(stockAgentReads.day, day))
      .all()
      .map((r) => `${r.book}:${r.symbol}`),
  );

  for (const row of rows) {
    if (already.has(`${row.book}:${row.symbol}`)) {
      result.skipped += 1;
      continue;
    }
    try {
      const horizon = row.book === 'short' ? 'the next three weeks' : 'the next six months';
      const response = await getAnthropicClient().messages.create(
        {
          model: config.anthropic.model,
          max_tokens: 1500,
          system: SYSTEM,
          output_config: { format: { type: 'json_schema', schema: READ_SCHEMA } },
          messages: [
            {
              role: 'user',
              content:
                `Candidate ${row.symbol} for the ${horizon} horizon, ${day}:\n\n` +
                JSON.stringify(row, null, 2) +
                `\n\nJudge: information or noise?`,
            },
          ],
        },
        ANTHROPIC_CALL_OPTIONS,
      );
      const block = response.content.find((b) => b.type === 'text');
      if (!block || block.type !== 'text') throw new Error('no content');
      const read = JSON.parse(block.text) as {
        verdict: 'enter_candidate' | 'avoid' | 'hold_if_held' | 'ignore';
        plain: string;
        probability: number;
        reasoning: string;
        falsifier: string;
      };
      db.insert(stockAgentReads)
        .values({
          id: newId(),
          day,
          book: row.book,
          symbol: row.symbol,
          verdict: read.verdict,
          probability: clampProbUp(read.probability),
          reasoning: `${read.plain}\n\n${read.reasoning}`,
          falsifier: read.falsifier,
          inputs: {
            modelRank: row.modelRank,
            forecastSigmas: row.forecastSigmas,
            panelStance: row.panelStance,
            skewVerdict: row.skewVerdict,
            insiderNet90dUsd: row.insiderNet90dUsd,
            congressNet90dUsd: row.congressNet90dUsd,
            held: row.held,
          },
          createdAt: nowIso(),
        })
        .run();
      result.read += 1;
    } catch (err) {
      result.errors.push(`${row.book}:${row.symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** Assembles the day's candidates for both books with every research
 * signal joined, then runs the reader. Shared by the route and the
 * daily schedule. Top N of each board plus current holdings. */
export async function runStockReaderForLatestDay(top = 12): Promise<StockAgentRunResult> {
  const { stockRank } = await import('../quant.js');
  const { skewAgentReads } = await import('../../db/schema.js');
  const { marketDb } = await import('../../db/market/index.js');
  const { congressTrades, insiderTrades } = await import('../../db/market/schema.js');
  const { sql } = await import('drizzle-orm');
  const { nyToday } = await import('../options/positionHealth.js');
  const { stancesForSymbols } = await import('../stockEngine.js');

  const day = nyToday();
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

  const heldByBook = new Map<string, Set<string>>();
  try {
    const { ownsPaperBook } = await import('../options/role.js');
    if (ownsPaperBook()) {
      const { openStockOrders } = await import('../stockBook.js');
      for (const b of ['short', 'long'] as const)
        heldByBook.set(b, new Set(openStockOrders(b).map((o) => o.symbol)));
    } else if (config.market.runnerHttpUrl) {
      const res = await fetch(`${config.market.runnerHttpUrl}/api/stocks/book`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const book = (await res.json()) as { orders: Array<{ status: string; symbol: string; book: string }> };
        for (const b of ['short', 'long'] as const)
          heldByBook.set(b, new Set(book.orders.filter((o) => o.status === 'open' && o.book === b).map((o) => o.symbol)));
      }
    }
  } catch {
    // Held marking is decoration; an unreachable runner leaves it empty.
  }

  const rows: StockRowForAgent[] = [];
  for (const book of ['short', 'long'] as const) {
    const target = book === 'short' ? 'stk_short' : 'stk_long';
    let picks: Array<{ symbol: string; rank: number; forecastSigmas: number | null }> = [];
    try {
      const ranked = await stockRank(day, target, 50);
      picks = ranked.picks.slice(0, top).map((p) => ({ symbol: p.symbol, rank: p.rank, forecastSigmas: p.forecastSigmas }));
    } catch {
      continue; // a refusing/unavailable sidecar skips the book, not the run
    }
    const held = heldByBook.get(book) ?? new Set<string>();
    const symbols = [...new Set([...picks.map((p) => p.symbol), ...held])];
    const stances = stancesForSymbols(symbols);
    const skewReads = new Map(
      db
        .select({ symbol: skewAgentReads.symbol, verdict: skewAgentReads.verdict })
        .from(skewAgentReads)
        .orderBy(desc(skewAgentReads.day))
        .limit(300)
        .all()
        .map((r) => [r.symbol, r.verdict] as const),
    );
    for (const symbol of symbols) {
      const pick = picks.find((p) => p.symbol === symbol);
      const insider = marketDb
        .select({
          net: sql<number | null>`sum(case when ${insiderTrades.code}='P' then ${insiderTrades.valueUsd} when ${insiderTrades.code}='S' then -${insiderTrades.valueUsd} else 0 end)`,
        })
        .from(insiderTrades)
        .where(and(eq(insiderTrades.symbol, symbol), sql`${insiderTrades.filedDate} >= ${cutoff}`))
        .get();
      const congress = marketDb
        .select({
          net: sql<number | null>`sum((${congressTrades.amountMin}+${congressTrades.amountMax})/2.0 * case when ${congressTrades.code}='P' then 1 else -1 end)`,
        })
        .from(congressTrades)
        .where(and(eq(congressTrades.symbol, symbol), sql`${congressTrades.filedDate} >= ${cutoff}`))
        .get();
      const buyers = marketDb
        .select({ member: congressTrades.member })
        .from(congressTrades)
        .where(and(eq(congressTrades.symbol, symbol), eq(congressTrades.code, 'P'), sql`${congressTrades.filedDate} >= ${cutoff}`))
        .all()
        .map((r) => r.member);
      rows.push({
        symbol,
        book,
        modelRank: pick?.rank ?? null,
        forecastSigmas: pick?.forecastSigmas ?? null,
        ret1mPct: null,
        panelStance: stances[symbol]?.stance ?? null,
        skewVerdict: skewReads.get(symbol) ?? null,
        insiderNet90dUsd: insider?.net ?? null,
        congressNet90dUsd: congress?.net ?? null,
        congressBuyers90d: [...new Set(buyers)].slice(0, 6),
        held: held.has(symbol),
      });
    }
  }
  return runStockReader(day, rows);
}

export function latestStockReads(day: string) {
  return db
    .select()
    .from(stockAgentReads)
    .where(eq(stockAgentReads.day, day))
    .orderBy(desc(stockAgentReads.probability))
    .all();
}
