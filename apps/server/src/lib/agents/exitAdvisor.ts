import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';

/**
 * Judges a paper position the deterministic exit rules in
 * `services/quant/app/exit.py` flagged `needs_review` — an EV sign flip
 * since entry, or new documents on the underlying since the last check.
 * See `exitEngine.ts` for why this is only ever called on that escalation:
 * the large majority of rechecks resolve via cheap arithmetic in Python and
 * never reach an LLM call at all.
 *
 * **Never a reason to trust the position more.** Like narrate.ts, this
 * agent explains and judges from the numbers and documents it was given —
 * it does not re-derive EV, does not fetch its own data, and every claim
 * must trace back to an input field.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

const SYSTEM = `You judge one open paper options position that a deterministic
rule has already flagged as ambiguous — either its expected value flipped
sign since entry, or new documents about the underlying appeared since the
last check. You are not a price predictor; you decide, from the numbers and
documents you were given, whether to hold, exit now, or move the position's
exit target.

Rules, not suggestions:

- State only facts derivable from the input. Never invent a catalyst, a
  number, or a document that was not given to you.
- Say plainly why the escalation happened (the EV sign flip, or what the new
  documents actually say) before recommending anything — the reader must be
  able to see the same evidence you saw.
- If the model behind this position's EV has no demonstrated edge (a false
  modelBeatsBaseline), that fact must appear in your reasoning, not be
  smoothed over.
- Prefer "hold" unless the evidence is concrete: a single ambiguous headline
  or a small EV wobble is not, by itself, a reason to exit a position early
  — that is what would turn "adaptive" into "jumpy."
- Two or three sentences of reasoning. This is read by someone deciding
  whether to trust an automated close, not a research report.`;

const EXIT_ADVISOR_SCHEMA = {
  type: 'object' as const,
  properties: {
    action: {
      type: 'string' as const,
      enum: ['hold', 'exit_now', 'move_target'],
      description: '"move_target" means hold, but with a revised target price/date.',
    },
    newTargetExitPriceE4: {
      type: ['integer', 'null'] as const,
      description: 'Required when action is "move_target"; null otherwise.',
    },
    newTargetExitDate: {
      type: ['string', 'null'] as const,
      description: 'Required when action is "move_target"; null otherwise.',
    },
    reasoning: { type: 'string' as const },
    citedInputs: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'The 1-3 input fields that most drove this judgment.',
    },
  },
  required: ['action', 'newTargetExitPriceE4', 'newTargetExitDate', 'reasoning', 'citedInputs'],
  additionalProperties: false,
};

export interface ExitAdvisorInput {
  occSymbol: string;
  underlying: string;
  escalationReason: string;
  entryPriceE4: number;
  currentPriceE4: number;
  targetExitPriceE4: number;
  stopLossPriceE4: number;
  targetExitDate: string;
  entryEv: number | null;
  currentEv: number | null;
  modelBeatsBaseline: boolean;
  newDocuments: Array<{ title: string; eventType: string | null; publishedAt: string }>;
}

export interface ExitAdvisorResult {
  action: 'hold' | 'exit_now' | 'move_target';
  newTargetExitPriceE4: number | null;
  newTargetExitDate: string | null;
  reasoning: string;
  citedInputs: string[];
}

export async function adviseOnExit(input: ExitAdvisorInput): Promise<ExitAdvisorResult> {
  if (!config.anthropic.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set — the exit advisor cannot run.');
  }

  const response = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: 4_000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: EXIT_ADVISOR_SCHEMA } },
    messages: [{ role: 'user', content: JSON.stringify(input, null, 2) }],
  });

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error('Claude returned no content for the exit advisory');
  }
  return JSON.parse(block.text) as ExitAdvisorResult;
}
