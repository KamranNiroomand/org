import { config } from '../../../config.js';
import { getAnthropicClient } from '../panel/client.js';
import { ANTHROPIC_CALL_OPTIONS } from '../panel/types.js';
import { propertyContextMessage } from './context.js';
import type { ComputedFinancials, LocationAgentResult, ManagerSynthesisResult, PropertyInput, RentalAgentResult } from './types.js';

/**
 * The manager — one non-adversarial synthesis call, the real-estate
 * equivalent of the stock panel's `synthesize.ts`. Reads both agents' full
 * two-round discussion plus the deterministic financials and produces the
 * final verdict. Never re-derives a number, never re-emits
 * appreciationOutlookScore or any cash-flow figure — those are assembled
 * server-side (see `run.ts`'s `balancePlacement`). No web_search: everything
 * it needs to say has already been researched by the two specialists.
 */

const SYSTEM = `You are the manager summarizing two specialists' discussion
of one property — a location/neighborhood specialist and a rental-viability
specialist — into a faithful final read for the person deciding whether to
buy it. You are not a third specialist: you add no fact, search result, or
number that isn't already present in what you were given. The deterministic
financial figures you're handed (mortgage, cash flow, tax, horizon
projections) are ground truth — restate them in plain language, never
recompute or contradict them.

Rules:

- Never use "buy", "should", or investment-advice language.
- overallVerdict is about the property as a whole, weighing both location
  and rental findings against the actual financial projections — not a
  simple average of two scores.
- If the user's assumed monthly rent (in the property details) falls
  outside the rental agent's own researched range, name that mismatch
  explicitly in conflicts — this is the single most important cross-check
  this run can surface, and burying it would defeat the point of having an
  independent rental agent at all.
- List every real disagreement between the two agents in conflicts, even if
  it makes the summary read as less decisive — the same reasoning the stock
  panel already applies to its own specialists.
- If either agent's analysis is wholly or partly missing (a call failed),
  say so plainly in narrativeSummary and keyRisks rather than writing around
  the gap as if it weren't there.
- horizonNotes must translate the 7/10/15-year figures you were given into
  plain language, without inventing any number not already present.`;

const SCHEMA = {
  type: 'object' as const,
  properties: {
    overallVerdict: { type: 'string' as const, enum: ['strong_opportunity', 'workable', 'weak_fit'] },
    narrativeSummary: { type: 'string' as const, description: 'Three to five sentences weighing location, rentability, and the actual numbers together.' },
    keyRisks: { type: 'array' as const, items: { type: 'string' as const } },
    conflicts: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Real disagreements between the two agents, or between the user\'s assumptions and what either agent found — never smoothed over.',
    },
    horizonNotes: {
      type: 'object' as const,
      properties: {
        year7: { type: 'string' as const },
        year10: { type: 'string' as const },
        year15: { type: 'string' as const },
      },
      required: ['year7', 'year10', 'year15'],
      additionalProperties: false,
    },
  },
  required: ['overallVerdict', 'narrativeSummary', 'keyRisks', 'conflicts', 'horizonNotes'],
  additionalProperties: false,
};

function formatLocation(round1: LocationAgentResult | null, round2: LocationAgentResult | null): string {
  if (!round1) return 'Location agent: no result — every call failed.';
  const r1 = `Round 1 — ${round1.areaAssessment} (score ${round1.appreciationOutlookScore}/100, ${round1.confidence} confidence): ${round1.reasoning}\nSchools/crime: ${round1.schoolsAndCrimeSummary}\nComparable sales: ${round1.comparableSalesSummary}`;
  if (!round2) return `${r1}\n(Round 2 unavailable — that call failed.)`;
  return `${r1}\n\nRound 2 — ${round2.areaAssessment} (score ${round2.appreciationOutlookScore}/100)${round2.revisedFromRound1 ? ' [revised]' : ''}: ${round2.reasoning}\nResponding to rental agent: ${round2.responseToOtherAgent}`;
}

function formatRental(round1: RentalAgentResult | null, round2: RentalAgentResult | null): string {
  if (!round1) return 'Rental agent: no result — every call failed.';
  const r1 = `Round 1 — ${round1.rentabilityAssessment} (researched range $${(round1.rentEstimateLowCents / 100).toFixed(0)}-$${(round1.rentEstimateHighCents / 100).toFixed(0)}/mo, ${round1.confidence} confidence): ${round1.reasoning}\nComparable rents: ${round1.comparableRentsSummary}\nDemand factors: ${round1.demandFactors.join(', ')}`;
  if (!round2) return `${r1}\n(Round 2 unavailable — that call failed.)`;
  return `${r1}\n\nRound 2 — ${round2.rentabilityAssessment} (range $${(round2.rentEstimateLowCents / 100).toFixed(0)}-$${(round2.rentEstimateHighCents / 100).toFixed(0)}/mo)${round2.revisedFromRound1 ? ' [revised]' : ''}: ${round2.reasoning}\nResponding to location agent: ${round2.responseToOtherAgent}`;
}

export async function runManagerSynthesis(
  input: PropertyInput,
  computed: ComputedFinancials,
  locationRound1: LocationAgentResult | null,
  locationRound2: LocationAgentResult | null,
  rentalRound1: RentalAgentResult | null,
  rentalRound2: RentalAgentResult | null,
): Promise<ManagerSynthesisResult> {
  if (!config.anthropic.configured) throw new Error('ANTHROPIC_API_KEY is not set — the manager cannot run without it.');

  const response = await getAnthropicClient().messages.create(
    {
      model: config.anthropic.model,
      max_tokens: 4_000,
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [
        {
          role: 'user',
          content:
            `${propertyContextMessage(input, computed)}\n\n` +
            `=== LOCATION AGENT ===\n${formatLocation(locationRound1, locationRound2)}\n\n` +
            `=== RENTAL AGENT ===\n${formatRental(rentalRound1, rentalRound2)}`,
        },
      ],
    },
    ANTHROPIC_CALL_OPTIONS,
  );

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('Claude returned no content for the manager synthesis');
  return JSON.parse(block.text) as ManagerSynthesisResult;
}
