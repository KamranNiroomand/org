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
    probability: {
      type: 'number' as const,
      description: 'P(outperforms own sector, 21 sessions), 0.05-0.95. Scored against outcomes.',
    },
    reasoning: { type: 'string' as const, description: 'Three to five sentences, outside view first.' },
    falsifier: { type: 'string' as const, description: 'The concrete observation that would change this verdict.' },
  },
  required: ['verdict', 'probability', 'reasoning', 'falsifier'],
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

/** The disagreement shortlist — the only names worth an LLM's opinion.
 * Everything else is the map's ordinary weather. Capped so a wild day
 * cannot stampede the budget. */
export function shortlistForAgent(rows: SkewRowForAgent[], cap = 12): SkewRowForAgent[] {
  const usable = rows.filter((r) => r.quadrant !== null);
  const picked = new Map<string, SkewRowForAgent>();
  for (const r of usable) {
    if (r.quadrant === 'contrarian_bid' && !r.event_flag) picked.set(r.symbol, r);
  }
  for (const r of usable) {
    if (r.quadrant === 'hedged_rally' && (r.held || (r.delta_5d ?? 0) > 0.15)) picked.set(r.symbol, r);
  }
  const movers = [...usable]
    .filter((r) => r.delta_5d !== null)
    .sort((a, b) => Math.abs(b.delta_5d!) - Math.abs(a.delta_5d!));
  for (const r of movers) {
    if (picked.size >= cap) break;
    picked.set(r.symbol, r);
  }
  return [...picked.values()].slice(0, cap);
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
          reasoning: read.reasoning,
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
