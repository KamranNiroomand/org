import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';

/**
 * Turns one ranked contract's numbers into a sentence a person can sanity-
 * check, not a reason to trust it more.
 *
 * The plan describes this as explaining a signal "from actual SHAP
 * attributions + greeks" — this build has neither a SHAP computation nor
 * greeks surfaced on `RankedContract` yet, so it explains from what
 * `rank.py` actually computes today: the forecast drift and volatility
 * against the market's own implied vol, the resulting expected value, and
 * the probability of profit. Extending to real SHAP values or greeks is an
 * input-shape change here, not a redesign, once `rank.py` carries them.
 *
 * **Never a reason to trust the number more.** This agent explains what the
 * ranking already computed; it does not re-derive the EV, does not adjust
 * it, and every fact it states must trace back to a field on the input —
 * the system prompt says so explicitly and the schema gives it nothing else
 * to work with. If the underlying model has no demonstrated edge (see
 * `rank.py`'s `beats_baseline` gate), a fluent narrative here would be the
 * most persuasive-sounding evidence of a mirage the whole project exists to
 * avoid.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

const SYSTEM = `You explain one ranked options contract to the person who will
decide whether to paper-trade it. You are not a price predictor and you do
not have an opinion of your own about whether the trade is good — you explain
what the numbers you were given already say, in plain language, so the person
reading can judge that for themselves.

Rules, not suggestions:

- State only facts derivable from the input fields. Never invent a number,
  a catalyst, a news event, or a reason not present in what you were given.
  If you don't know why the model predicted what it did, say that plainly
  rather than inventing a plausible-sounding story — a confident wrong
  explanation is worse than an honest "the model does not expose why."
- Name the actual disagreement driving the trade: the forecast's own
  drift/volatility versus the market's implied volatility for this contract.
  That gap, priced against the contract, is the entire economic reason
  rank.py's expected value is nonzero — say so concretely with the real
  numbers, not "the model likes this contract."
- If the underlying model's own out-of-fold metrics show it doesn't beat a
  trivial mean baseline, that fact must appear in your explanation, not be
  omitted for the sake of a cleaner narrative. A ranked position from a model
  with no demonstrated edge is a very different thing to read than one from
  a validated one, and the reader must never have to dig for which case they
  are in.
- Two or three sentences. This is a caption someone reads before opening a
  detail view, not a research report.`;

const NARRATION_SCHEMA = {
  type: 'object' as const,
  properties: {
    narrative: {
      type: 'string' as const,
      description: 'Two to three plain-language sentences explaining the signal.',
    },
    keyDrivers: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'The 1-3 input fields that most drove this explanation, e.g. "forecast_vol vs market_iv".',
    },
    caveat: {
      type: 'string' as const,
      description:
        'Required when model_beats_baseline is false: a plain statement that the model has no demonstrated edge. Empty string otherwise.',
    },
  },
  required: ['narrative', 'keyDrivers', 'caveat'],
  additionalProperties: false,
};

export interface NarrateInput {
  occSymbol: string;
  underlying: string;
  type: 'call' | 'put';
  strike: number;
  dte: number;
  marketPrice: number;
  marketIv: number;
  forecastVol: number;
  forecastDrift: number;
  ev: number;
  evPerRisk: number;
  probProfit: number;
  /** From the model_runs manifest this ranking used — see rank.py's own gate. */
  modelBeatsBaseline: boolean;
  modelInformationCoefficient: number;
}

export interface NarrateResult {
  narrative: string;
  keyDrivers: string[];
  caveat: string;
}

export async function narrateSignal(input: NarrateInput): Promise<NarrateResult> {
  if (!config.anthropic.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set — the narrator cannot run without it.');
  }

  const response = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: 4_000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: NARRATION_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: JSON.stringify(input, null, 2),
      },
    ],
  });

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error('Claude returned no content for the narration');
  }
  return JSON.parse(block.text) as NarrateResult;
}
