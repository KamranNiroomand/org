import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../../config.js';
import { formatRound1Transcript } from './specialists.js';
import { ANTHROPIC_CALL_OPTIONS, type Round1Turn, type Round2Turn, type SymbolContext, type SynthesisResult } from './types.js';

/**
 * The ninth call — a separate, non-adversarial persona whose only job is to
 * represent the panel faithfully. Never a fifth opinion, never a new fact:
 * everything it writes must trace back to something one of the four
 * specialists actually said across both rounds. `stance` is deliberately
 * off the bullish/bearish axis (`notable`/`mixed`/`not_notable`) so the
 * top-line result can never be read as a buy/sell signal — a panel that
 * splits 2-2 with strong reasoning on both sides is exactly as "notable" as
 * one that agrees unanimously, since "notable" means the panel found
 * something concrete to say, not that it leans one way.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

const SYSTEM = `You summarize a four-specialist panel's discussion of one
stock or ETF into a faithful record of what was actually said. You are not a
fifth panelist — you have no opinion of your own about the symbol, and you
add no fact, number, or claim that isn't already present in the transcript
you were given.

Rules:

- "stance" is never bullish/bearish. It answers one question only: did this
  panel produce something concrete worth a person's attention (notable),
  a genuine split with real reasoning on both sides (mixed), or essentially
  nothing beyond "unremarkable, low confidence all around" (not_notable)?
  A 2-2 stance split among the specialists is "mixed" or "notable" depending
  on whether the disagreement itself is substantive — it is never collapsed
  into a fake middle ground to sound more confident than the panel actually
  was.
- List every real disagreement you can find, even if it makes the summary
  read as less decisive. Smoothing over a genuine 2-2 split to sound more
  confident is the single biggest failure mode for this job — never do it.
- agreements/disagreements/openQuestions must each name which specialist(s)
  hold the position, e.g. "momentum and skeptic agree the volume spike lacks
  a clear catalyst" rather than an unattributed claim.
- Never use "buy", "sell", "should", or investment-advice language, for the
  same reason the specialists themselves don't.`;

const SYNTHESIS_SCHEMA = {
  type: 'object' as const,
  properties: {
    stance: { type: 'string' as const, enum: ['notable', 'mixed', 'not_notable'] },
    summary: { type: 'string' as const, description: 'Two to three sentences capturing the panel\'s actual discussion.' },
    agreements: { type: 'array' as const, items: { type: 'string' as const } },
    disagreements: { type: 'array' as const, items: { type: 'string' as const } },
    openQuestions: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'What the panel could not resolve from the data it had — a real gap, not a rhetorical flourish.',
    },
  },
  required: ['stance', 'summary', 'agreements', 'disagreements', 'openQuestions'],
  additionalProperties: false,
};

export async function runSynthesis(
  ctx: SymbolContext,
  round1: Round1Turn[],
  round2: Round2Turn[],
): Promise<SynthesisResult> {
  if (!config.anthropic.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set — the panel cannot run without it.');
  }

  const round2Text = round2
    .map(
      (t) =>
        `--- ${t.agent} (round 2, responding to ${t.respondingTo.join(', ') || 'no one directly'}) ---\n` +
        `Stance: ${t.stance} (confidence: ${t.confidence})${t.revisedPosition ? ' [revised from round 1]' : ''}\n` +
        `Reasoning: ${t.reasoning}\nCited: ${t.citedInputs.join(', ')}`,
    )
    .join('\n\n');

  const response = await getClient().messages.create(
    {
      model: config.anthropic.model,
      max_tokens: 4_000,
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SYNTHESIS_SCHEMA } },
      messages: [
        {
          role: 'user',
          content:
            `Panel discussion of ${ctx.symbol} (${ctx.name}):\n\n` +
            `=== ROUND 1 ===\n${formatRound1Transcript(round1)}\n\n` +
            `=== ROUND 2 ===\n${round2Text}`,
        },
      ],
    },
    ANTHROPIC_CALL_OPTIONS,
  );

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error('Claude returned no content for the synthesis');
  }
  return JSON.parse(block.text) as SynthesisResult;
}
