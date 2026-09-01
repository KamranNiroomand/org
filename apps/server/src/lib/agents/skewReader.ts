import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { skewAgentReads } from '../../db/schema.js';
import { config } from '../../config.js';
import { getAnthropicClient } from './panel/client.js';
import { ANTHROPIC_CALL_OPTIONS } from './panel/types.js';
import { clampProbUp } from './panel/specialists.js';
import { newId, nowIso } from '../util.js';

/**
 * The skew reader — a STANDALONE research agent over the skew map.
 *
 * Deliberately separate from the stock and options engines (the user's
 * explicit design): it receives no model ranks, no panel stances, and
 * nothing it writes is read by any trading path. The math (skew.py)
 * sees every name and surfaces only the disagreement cases; this agent
 * judges those few, commits a verdict and a scoreable probability, and
 * the ledger decides later — via the same Brier grader as the panel —
 * whether its judgment earns a seat at any table.
 *
 * Verdict vocabulary, fixed in advance like the map's quadrants:
 *   enter_candidate — worth a human's research hours, never a buy
 *   avoid           — looks tempting, positioning says stand back
 *   tighten_if_held — keep it, shorten the leash
 *   ignore          — the disagreement dissolves on inspection
 */

const SYSTEM = `You are a positioning analyst reading one day's option-skew
map. Skew is what traders PAY to be positioned — insurance prices, not
price predictions. You judge only names the math flagged as interesting;
your job is to decide whether each flag is information or noise.

Discipline, non-negotiable:
- Outside view first: most contrarian bids resolve as nothing; most
  hedged rallies are ordinary insurance on gains; most skew spikes with
  an event flag are a dated catalyst being priced correctly. Anchor
  there, then ask what is genuinely specific here.
- Never treat a quadrant as a prediction. "Enter-candidate" means the
  disagreement between price and positioning deserves research hours —
  it is NOT a buy call, and you never use the words buy or sell.
- An event_flag means measured skew likely reflects a dated catalyst:
  discount the sentiment reading accordingly, and say so.
- plain: the first thing a completely non-technical reader sees. If a
  sentence needs ANY market concept explained to be understood, rewrite
  it until it doesn't. Say what is happening and what to do, nothing
  about how you know.
- probability: your committed P(this symbol outperforms its own sector
  over the next 21 trading sessions), between 0.05 and 0.95. It will be
  scored. A reflex 0.5 is only honest when the evidence is balanced.
- falsifier: the one concrete observation that would change your
  verdict. "New information" is an evasion, not a falsifier.`;

const READ_SCHEMA = {
  type: 'object' as const,
  properties: {
    verdict: {
      type: 'string' as const,
      enum: ['enter_candidate', 'avoid', 'tighten_if_held', 'ignore'],
    },
    plain: {
      type: 'string' as const,
      description:
        'One or two sentences for someone who knows NOTHING about options or markets. Forbidden: options, puts, calls, insurance, hedging, protection, premium, skew, volatility, positioning — any trading concept at all. Allowed: only what it means for the stock in everyday life terms and what the reader should do. Example of the register: "Nothing unusual is happening with Apple — big investors are just being routinely careful, like they always are. If you own it, keep it, but decide in advance at what price you would sell." Write at that level.',
    },
    probability: {
      type: 'number' as const,
      description: 'P(outperforms own sector, 21 sessions), 0.05-0.95. Scored against outcomes.',
    },
    reasoning: { type: 'string' as const, description: 'Three to five sentences, outside view first.' },
    falsifier: { type: 'string' as const, description: 'The concrete observation that would change this verdict.' },
  },
  required: ['verdict', 'plain', 'probability', 'reasoning', 'falsifier'],
  additionalProperties: false,
};

export interface SkewRowForAgent {
  symbol: string;
  sector: string | null;
  quadrant: string | null;
  skew_norm: number;
  skew_pts: number;
  delta_5d: number | null;
  sector_rank_pct: number | null;
  ret_1m: number | null;
  ret_1m_vs_spy: number | null;
  rvol: number | null;
  event_flag: boolean;
  held: boolean;
  sentence: string;
}

/** The whole usable board, interesting names first — the user's
 * explicit design: the agent judges everything it can see, not just
 * what the math flagged. Ordering matters because runs are resumable
 * (idempotent per day+symbol): contrarian bids, held names, and big
 * movers get read first, ordinary weather last, so an interrupted run
 * has already covered what matters most. The cap is a stampede guard,
 * set above any realistic board size. */
export function shortlistForAgent(rows: SkewRowForAgent[], cap = 150): SkewRowForAgent[] {
  const usable = rows.filter((r) => r.quadrant !== null);
  const priority = (r: SkewRowForAgent): number => {
    if (r.quadrant === 'contrarian_bid') return 0;
    if (r.held) return 1;
    if (Math.abs(r.delta_5d ?? 0) > 0.15) return 2;
    if (r.quadrant === 'hedged_rally' || r.quadrant === 'fear') return 3;
    return 4;
  };
  return [...usable]
    .sort((a, b) => priority(a) - priority(b) || Math.abs(b.delta_5d ?? 0) - Math.abs(a.delta_5d ?? 0))
    .slice(0, cap);
}

export interface SkewAgentRunResult {
  day: string;
  read: number;
  skipped: number;
  errors: string[];
}

export async function runSkewReader(
  day: string,
  rows: SkewRowForAgent[],
): Promise<SkewAgentRunResult> {
  const result: SkewAgentRunResult = { day, read: 0, skipped: 0, errors: [] };
  if (!config.anthropic.configured) {
    result.errors.push('ANTHROPIC_API_KEY is not set');
    return result;
  }
  const shortlist = shortlistForAgent(rows);
  const already = new Set(
    db
      .select({ symbol: skewAgentReads.symbol })
      .from(skewAgentReads)
      .where(eq(skewAgentReads.day, day))
      .all()
      .map((r) => r.symbol),
  );

  for (const row of shortlist) {
    if (already.has(row.symbol)) {
      result.skipped += 1;
      continue;
    }
    try {
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
                `Skew map row for ${row.symbol}, ${day}:\n\n` +
                JSON.stringify(row, null, 2) +
                `\n\nJudge this flag: information or noise?`,
            },
          ],
        },
        ANTHROPIC_CALL_OPTIONS,
      );
      const block = response.content.find((b) => b.type === 'text');
      if (!block || block.type !== 'text') throw new Error('no content');
      const read = JSON.parse(block.text) as {
        verdict: 'enter_candidate' | 'avoid' | 'tighten_if_held' | 'ignore';
        plain: string;
        probability: number;
        reasoning: string;
        falsifier: string;
      };
      db.insert(skewAgentReads)
        .values({
          id: newId(),
          day,
          symbol: row.symbol,
          verdict: read.verdict,
          probability: clampProbUp(read.probability),
          // Plain first, detail after — the card's audience said "I am
          // not technical", and an analyst who cannot say it simply is
          // not done thinking.
          reasoning: `${read.plain}\n\n${read.reasoning}`,
          falsifier: read.falsifier,
          inputs: {
            quadrant: row.quadrant,
            skew_norm: row.skew_norm,
            delta_5d: row.delta_5d,
            event_flag: row.event_flag,
            held: row.held,
          },
          createdAt: nowIso(),
        })
        .run();
      result.read += 1;
    } catch (err) {
      result.errors.push(`${row.symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

export function latestSkewReads(day: string) {
  return db
    .select()
    .from(skewAgentReads)
    .where(eq(skewAgentReads.day, day))
    .orderBy(desc(skewAgentReads.probability))
    .all();
}
