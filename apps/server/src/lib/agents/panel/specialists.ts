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
  is worse than an honest "not enough here to tell".

Forecast like a superforecaster, not a pundit:

- OUTSIDE VIEW FIRST. Before reasoning about this specific company, ask
  what usually happens in situations shaped like this one — most stocks
  near a 52-week high stay volatile but trend-follow for weeks; most
  single-day spikes without news mean-revert; most earnings drifts run
  for about a quarter. Anchor on that base rate, then adjust for what is
  genuinely specific here. An inside-view story with no base rate behind
  it is the classic way confident forecasts go wrong.
- probUp is your probability, as a number, that this symbol OUTPERFORMS
  its own sector over the next 21 trading sessions. Commit to a number
  between 0.05 and 0.95 — never 0.5 as a reflex (0.5 means you judged
  the evidence balanced, not that you skipped judging), and never the
  extremes (certainty about a three-week stock move is miscalibration by
  definition). Your probabilities will be scored against what actually
  happens, so state the number you would want to be graded on.
- falsifier: name the single concrete, observable thing that would most
  change your stance — a specific price level breaking, a filing, a
  metric crossing a line, coverage flipping direction. "New information
  could change things" is not a falsifier; it is an evasion. A view you
  cannot say what would falsify is not a view, it is a mood.`;

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

/** The schema cannot carry numeric bounds (the API rejects them), so
 * calibration's floor and ceiling are enforced here: certainty and
 * reflex-zero are equally inadmissible, whatever the model wrote. */
export function clampProbUp(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.min(0.95, Math.max(0.05, n));
}

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
  probUp: {
    type: 'number' as const,
    // No minimum/maximum keys: the structured-output API rejects them
    // on number types (400, found live — the first weekday panel run
    // failed whole). The [0.05, 0.95] bounds live in the prompt and are
    // enforced by clampProbUp on the way out of every parse.
    description: 'Your probability, between 0.05 and 0.95, that this symbol outperforms its own sector over the next 21 trading sessions. A committed number, not a reflex 0.5 — it will be scored against outcomes.',
  },
  falsifier: {
    type: 'string' as const,
    description: 'The single concrete, observable thing that would most change your stance. Specific — a level, a filing, a metric — never "new information".',
  },
  reasoning: { type: 'string' as const, description: 'Two to four sentences, from your persona\'s lens only. Outside view (base rate) first, then the case-specific adjustment.' },
  citedInputs: CITED_INPUTS_SCHEMA,
};

const ROUND1_SCHEMA = {
  type: 'object' as const,
  properties: SHARED_TURN_PROPERTIES,
  required: ['stance', 'confidence', 'probUp', 'falsifier', 'reasoning', 'citedInputs'],
  additionalProperties: false,
};

const ROUND2_SCHEMA = {
  type: 'object' as const,
  properties: {
    ...SHARED_TURN_PROPERTIES,
    reasoning: {
      type: 'string' as const,
      description: 'Two to four sentences. Engage the STRONGEST opposing point on the table — steelman it, then answer it or concede to it. Rebutting the weakest objection is the failure mode this round exists to prevent.',
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
  required: ['stance', 'confidence', 'probUp', 'falsifier', 'reasoning', 'citedInputs', 'respondingTo', 'revisedPosition'],
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
        `--- ${t.agent} (round 1) ---\nStance: ${t.stance} (confidence: ${t.confidence}, P(outperform sector, 21 sessions): ${t.probUp.toFixed(2)})\n` +
        `Reasoning: ${t.reasoning}\nWould change my mind: ${t.falsifier}\nCited: ${t.citedInputs.join(', ')}`,
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
  parsed.probUp = clampProbUp(parsed.probUp);
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
  parsed.probUp = clampProbUp(parsed.probUp);
  return { agent, ...parsed };
}
