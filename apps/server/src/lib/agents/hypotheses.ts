import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';

/**
 * Proposes candidate features for a human to implement and test — never
 * implements one, never scores one, and never gets to skip the purged
 * walk-forward split every hand-written feature already has to clear.
 *
 * The reason this agent exists at all: tonight's real, full-universe
 * direction model (563 symbols, 432 days) does not beat its own mean
 * baseline (information coefficient ≈ 0.01 — see rank.py's module
 * docstring and the PR that trained it). That is not a bug to fix; it is
 * the honest current state of a six-column momentum-and-volume feature set,
 * and the actual next lever is more or better features, not more model.
 * This agent is a structured way to generate candidates for that — not a
 * replacement for testing them, which cv.py's purged split and
 * models.beats_baseline still have to do exactly as fairly as before.
 *
 * A hypothesis this agent proposes is a suggestion with zero epistemic
 * weight of its own until it is implemented as a real feature and run
 * through the identical out-of-fold comparison every other feature already
 * has to survive. Nothing here writes to model_runs, trains anything, or
 * bypasses `models.py`'s baseline gate.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

const SYSTEM = `You propose candidate features for a LightGBM model predicting
option-relevant targets (forward underlying return, volatility risk premium)
in a personal options-research codebase. You do not implement features, do
not score them, and do not claim any of your proposals will work — every one
must still be built and run through the project's purged, embargoed
walk-forward split before it means anything.

Context on this specific codebase, since proposals should be concrete and
buildable from data that actually exists, not generic ML-feature-engineering
advice:

- Two data sources exist: \`equity_bars\` (2 years, 566 symbols, OHLCV — full
  history) and \`option_quotes\` (captured nightly, currently one real
  trading day of history — chain-surface features like term slope, skew,
  and put/call ratios can be *computed* today but cannot yet be *trained on*,
  because a walk-forward split needs many days of history, not a
  cross-section from a single day).
- The current feature set is six columns: five momentum windows
  (1/5/10/21/63-day) and a 21-day volume z-score, all computed from bars
  alone. The direction model built on exactly these six columns does not
  beat a trivial mean-baseline prediction (information coefficient ≈ 0.01
  on 158,419 out-of-fold rows) — so the bar for a genuinely new idea is low,
  but "another momentum window" is not a new idea.
- Every proposal must say plainly whether it can be built and evaluated
  *today* (bars-only, 2 years of history) or must wait for more chain
  history to accumulate (needs option_quotes across many days) — that
  distinction is the single most useful thing you can tell the person
  deciding what to build next.
- Favour ideas with a stated economic mechanism over ideas that are merely
  statistically fashionable. "Volume z-score" already exists because unusual
  volume plausibly precedes a real move; propose things with a similarly
  nameable reason to work, not a feature just because gradient-boosted trees
  can exploit arbitrary nonlinearity in it.

If you cannot think of a genuinely different idea beyond variations on what
already exists, say so plainly rather than padding the list — a padded list
of near-duplicate momentum windows costs real implementation time chasing
ideas with no reason to differ from what already failed.`;

const HYPOTHESES_SCHEMA = {
  type: 'object' as const,
  properties: {
    summary: {
      type: 'string' as const,
      description: 'One or two sentences on the overall direction of these proposals.',
    },
    hypotheses: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'A short feature-column-style name.' },
          description: { type: 'string' as const, description: 'What it computes, concretely.' },
          mechanism: {
            type: 'string' as const,
            description: 'The stated economic reason this might predict the target.',
          },
          dataAvailability: {
            type: 'string' as const,
            enum: ['available_today', 'needs_more_chain_history'],
          },
          dataSource: {
            type: 'string' as const,
            enum: ['equity_bars', 'option_quotes', 'both'],
          },
        },
        required: ['name', 'description', 'mechanism', 'dataAvailability', 'dataSource'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'hypotheses'],
  additionalProperties: false,
};

export interface HypothesesContext {
  target: 'dir' | 'vrp';
  currentFeatureCols: string[];
  currentInformationCoefficient: number;
  currentBeatsBaseline: boolean;
  nSymbols: number;
  nTrainDays: number;
}

export interface Hypothesis {
  name: string;
  description: string;
  mechanism: string;
  dataAvailability: 'available_today' | 'needs_more_chain_history';
  dataSource: 'equity_bars' | 'option_quotes' | 'both';
}

export interface HypothesesResult {
  summary: string;
  hypotheses: Hypothesis[];
}

export async function proposeHypotheses(context: HypothesesContext): Promise<HypothesesResult> {
  if (!config.anthropic.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set — the hypothesis generator cannot run without it.');
  }

  const response = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: 8_000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: HYPOTHESES_SCHEMA } },
    messages: [
      {
        role: 'user',
        content:
          `Current model for target "${context.target}": ${context.currentFeatureCols.length} features ` +
          `(${context.currentFeatureCols.join(', ')}), trained on ${context.nSymbols} symbols across ` +
          `${context.nTrainDays} days. Information coefficient ${context.currentInformationCoefficient.toFixed(4)}, ` +
          `${context.currentBeatsBaseline ? 'beats' : 'does NOT beat'} the mean baseline out-of-fold.\n\n` +
          `Propose 5-8 candidate features to try next.`,
      },
    ],
  });

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error('Claude returned no content for the hypotheses');
  }
  return JSON.parse(block.text) as HypothesesResult;
}
