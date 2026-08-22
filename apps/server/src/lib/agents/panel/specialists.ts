import { config } from '../../../config.js';
import { todayKey } from '../../util.js';
import { getAnthropicClient } from './client.js';
import { ANTHROPIC_CALL_OPTIONS, SPECIALISTS, type Round1Turn, type Round2Turn, type Specialist, type SymbolContext } from './types.js';

/**
 * The four specialists and the two-round structure that makes "agents that
 * discuss with each other" real rather than decorative.
 *
 * Round 1 is four independent calls against the identical `SymbolContext` —
 * nobody sees another specialist's opinion yet. Round 2's user message *is*
 * round 1's actual transcript, formatted plainly (see `formatRound1Transcript`
 * below) — not a summary a fifth model produced on their behalf. That
 * distinction is the entire mechanism: a specialist that revises its
 * position in round 2 is doing so because it read what the others actually
 * wrote, not because a synthesizer told it what they meant.
 */

const SHARED_RULES = `Rules every specialist follows, regardless of persona:

- Never use "buy", "sell", "should", or any other language that reads as
  investment advice. You are reasoning about what the data shows, not
  telling anyone what to do with their money.
- A radar score, if present in the context, is an unvalidated heuristic
  composite (momentum, 52-week proximity, volume spike, news sentiment,
  unweighted) — never backtested. Treat a high score as "flagged by a
  first-pass screen", never as evidence of anything on its own.
- Every claim must trace back to a specific field in the SymbolContext you
  were given. List those fields in citedInputs. Never invent a fact, a
  catalyst, or a news event not present in the input.
- If the data genuinely doesn't support a strong view, say so in low
  confidence rather than manufacturing conviction — a confident wrong take
  is worse than an honest "not enough here to tell".`;

const PERSONAS: Record<Specialist, string> = {
  momentum: `You are the momentum specialist on a four-person panel reviewing
one stock or ETF. Your lens: price action, volume, and proximity to the
52-week range. Consider day change, the 52-week high/low position, and the
volume-to-average ratio. A volume spike without a price move and a price
move without volume support tell different stories — say which one this is,
concretely, using the actual numbers in the context.`,

  fundamentals: `You are the fundamentals specialist on a four-person panel
reviewing one stock or ETF. Your lens: valuation (trailing/forward P/E,
price-to-book, dividend yield) and sector context. A stock can be moving for
reasons that make sense against its fundamentals or reasons that look
disconnected from them — say which, using the actual numbers in the context.
If the fundamentals fields are mostly null (common for a thinly-covered or
newly-listed name), say that plainly rather than reasoning past the gap.`,

  news_sentiment: `You are the news/sentiment specialist on a four-person
panel reviewing one stock or ETF. Your lens: the recentDocuments in the
context — their sentiment, their recency, and whether they form a trend or
are just noise. If recentDocuments is empty or has only one or two items,
say plainly that coverage is thin and that a real news-driven view isn't
possible from this little — do not invent a narrative from a single
article's headline. If EDGAR filings are present, they carry no sentiment
score (only Polygon news does) — describe what the filing is about, not a
sentiment you weren't given.`,

  skeptic: `You are the skeptic on a four-person panel reviewing one stock or
ETF. Your job is to actively argue the bear case and stress-test whatever
looks compelling about this symbol: a radar score is an unvalidated
heuristic and never evidence on its own; a volume spike can be one large
trade, an index rebalance, or a scheduled event rather than new information;
a "52-week high" is close to meaningless for a stock that IPO'd eight months
ago; a single positive article is not a trend. If you genuinely cannot find
a real objection after considering the context honestly, say so plainly
rather than manufacturing a bear case that isn't there — a manufactured
objection is exactly the kind of confident-but-hollow reasoning this panel
exists to avoid, from either direction.`,
};

const CITED_INPUTS_SCHEMA = {
  type: 'array' as const,
  items: { type: 'string' as const },
  description: 'The specific SymbolContext field names this reasoning actually rests on, e.g. "dayChangePercent", "radar.volumeRatio", "recentDocuments[0].sentiment".',
};

// Shared by both rounds' schemas, so a future change to one (a confidence
// enum value, the citedInputs description) can't be applied to only one of
// two independent copies — round2's own `reasoning` field still overrides
// this with its own round-specific description below.
const SHARED_TURN_PROPERTIES = {
  stance: { type: 'string' as const, enum: ['bullish', 'bearish', 'neutral'] },
  confidence: { type: 'string' as const, enum: ['low', 'medium', 'high'] },
  reasoning: { type: 'string' as const, description: 'Two to four sentences, from your persona\'s lens only.' },
  citedInputs: CITED_INPUTS_SCHEMA,
};

const ROUND1_SCHEMA = {
  type: 'object' as const,
  properties: SHARED_TURN_PROPERTIES,
  required: ['stance', 'confidence', 'reasoning', 'citedInputs'],
  additionalProperties: false,
};

const ROUND2_SCHEMA = {
  type: 'object' as const,
  properties: {
    ...SHARED_TURN_PROPERTIES,
    reasoning: {
      type: 'string' as const,
      description: 'Two to four sentences. Must engage directly with at least one other panelist\'s specific point.',
    },
    respondingTo: {
      type: 'array' as const,
      items: { type: 'string' as const, enum: SPECIALISTS },
      description: 'Which other specialist(s) this reasoning directly engages with.',
    },
    revisedPosition: {
      type: 'boolean' as const,
      description: 'True only if your stance or confidence actually changed from round 1.',
    },
  },
  required: ['stance', 'confidence', 'reasoning', 'citedInputs', 'respondingTo', 'revisedPosition'],
  additionalProperties: false,
};

function contextMessage(ctx: SymbolContext): string {
  // recentDocuments carries only each document's absolute publishedAt —
  // without today's date as an anchor, "recency" has no meaning, and the
  // news_sentiment persona's own instruction to call out thin/stale
  // coverage is unenforceable (see this repo's own PR review that caught
  // this gap).
  return `Today's date: ${todayKey()}\n\nSymbolContext for ${ctx.symbol}:\n\n${JSON.stringify(ctx, null, 2)}`;
}

/** Round 1's real transcript, formatted plainly — this is what round 2's
 * user message actually contains, not a synthesized summary. */
export function formatRound1Transcript(turns: Round1Turn[]): string {
  return turns
    .map(
      (t) =>
        `--- ${t.agent} (round 1) ---\nStance: ${t.stance} (confidence: ${t.confidence})\n` +
        `Reasoning: ${t.reasoning}\nCited: ${t.citedInputs.join(', ')}`,
    )
    .join('\n\n');
}

export async function runRound1(agent: Specialist, ctx: SymbolContext): Promise<Round1Turn> {
  if (!config.anthropic.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set — the panel cannot run without it.');
  }

  const response = await getAnthropicClient().messages.create(
    {
      model: config.anthropic.model,
      max_tokens: 4_000,
      system: `${PERSONAS[agent]}\n\n${SHARED_RULES}`,
      output_config: { format: { type: 'json_schema', schema: ROUND1_SCHEMA } },
      messages: [{ role: 'user', content: contextMessage(ctx) }],
    },
    ANTHROPIC_CALL_OPTIONS,
  );

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error(`Claude returned no content for ${agent}'s round 1 turn`);
  }
  const parsed = JSON.parse(block.text) as Omit<Round1Turn, 'agent'>;
  return { agent, ...parsed };
}

export async function runRound2(agent: Specialist, ctx: SymbolContext, round1: Round1Turn[]): Promise<Round2Turn> {
  if (!config.anthropic.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set — the panel cannot run without it.');
  }

  const response = await getAnthropicClient().messages.create(
    {
      model: config.anthropic.model,
      max_tokens: 4_000,
      system: `${PERSONAS[agent]}\n\n${SHARED_RULES}`,
      output_config: { format: { type: 'json_schema', schema: ROUND2_SCHEMA } },
      messages: [
        { role: 'user', content: contextMessage(ctx) },
        {
          role: 'user',
          content:
            `Here is what all four panelists (including you) said in round 1:\n\n` +
            `${formatRound1Transcript(round1)}\n\n` +
            `Revise your position if what you just read genuinely changes your mind about ${ctx.symbol} — ` +
            `but engage directly with at least one other panelist's specific point either way. ` +
            `Set revisedPosition to true only if your stance or confidence actually changed.`,
        },
      ],
    },
    ANTHROPIC_CALL_OPTIONS,
  );

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error(`Claude returned no content for ${agent}'s round 2 turn`);
  }
  const parsed = JSON.parse(block.text) as Omit<Round2Turn, 'agent'>;
  return { agent, ...parsed };
}
