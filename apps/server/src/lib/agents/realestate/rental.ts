import { config } from '../../../config.js';
import { getAnthropicClient } from '../panel/client.js';
import { lastTextBlockText, propertyContextMessage } from './context.js';
import { ANTHROPIC_SEARCH_CALL_OPTIONS, type ComputedFinancials, type PropertyInput, type RentalAgentResult } from './types.js';

/**
 * The rental-viability specialist — realistic market rent, tenant pool
 * depth, vacancy risk, and rent-growth outlook. Web_search-enabled for the
 * same reason as the location agent: comparable rentals in this specific
 * area are a fact to look up, not something to recall from training data.
 */

const SHARED_RULES = `Rules you follow, regardless of what you find:

- Never use "buy", "should", or any language that reads as advice.
- Every claim must be grounded either in a specific field from the property
  details you were given, or in a specific web_search result — name what you
  searched for and what you found in citedFindings, and list the sites you
  actually consulted in sourcesUsed. Never invent a comparable listing or a
  vacancy rate.
- The property details include the user's own assumed monthly rent
  (expectedMonthlyRentCents) and the computed financials that were built
  from it. Your job is to independently research what this specific property
  could actually rent for — your rentEstimateLowCents/HighCents is a
  cross-check against their assumption, not a restatement of it. If your
  researched range and their assumption disagree meaningfully, say so
  plainly in your reasoning.
- If search comes back thin for this specific address/area, say so in low
  confidence rather than reasoning from a generic sense of "rent in this
  city".`;

const PERSONA = `You are the rental-viability specialist evaluating one
residential property someone is considering buying. Your lens: what could
this property realistically rent for, how deep and reliable is the tenant
pool in this area (students, young professionals, families — and whether
that pool is durable or thin), vacancy risk, and the rent-growth outlook.
Use web_search to find real comparable rental listings and rental-market
data for the specific address and area given.`;

const SHARED_PROPERTIES = {
  rentEstimateLowCents: { type: 'integer' as const, description: 'Your own researched low end, in cents.' },
  rentEstimateHighCents: { type: 'integer' as const, description: 'Your own researched high end, in cents.' },
  rentabilityAssessment: { type: 'string' as const, enum: ['strong', 'average', 'weak'] },
  confidence: { type: 'string' as const, enum: ['low', 'medium', 'high'] },
  reasoning: { type: 'string' as const, description: 'Three to five sentences, from your lens only.' },
  comparableRentsSummary: { type: 'string' as const, description: 'The actual comparable rentals you found, or say none were found.' },
  demandFactors: {
    type: 'array' as const,
    items: { type: 'string' as const },
    description: 'Concrete factors driving (or hurting) tenant demand here — transit, employers, schools, oversupply, etc.',
  },
  citedFindings: { type: 'array' as const, items: { type: 'string' as const } },
  sourcesUsed: {
    type: 'array' as const,
    items: { type: 'string' as const },
    description: 'Sites actually consulted via web_search, or ["training knowledge only"] if search found nothing useful.',
  },
};

const ROUND1_SCHEMA = {
  type: 'object' as const,
  properties: SHARED_PROPERTIES,
  required: Object.keys(SHARED_PROPERTIES),
  additionalProperties: false,
};

const ROUND2_SCHEMA = {
  type: 'object' as const,
  properties: {
    ...SHARED_PROPERTIES,
    reasoning: {
      type: 'string' as const,
      description: 'Three to five sentences. Must engage directly with the location agent\'s specific point.',
    },
    revisedFromRound1: { type: 'boolean' as const, description: 'True only if your estimate or assessment actually changed.' },
    responseToOtherAgent: { type: 'string' as const, description: 'What specifically you are responding to from the location agent, and how (or whether) it changes your read.' },
  },
  required: [...Object.keys(SHARED_PROPERTIES), 'revisedFromRound1', 'responseToOtherAgent'],
  additionalProperties: false,
};


interface AgentResponse {
  result: RentalAgentResult;
  webSearches: number;
}

export async function runRentalRound1(input: PropertyInput, computed: ComputedFinancials): Promise<AgentResponse> {
  if (!config.anthropic.configured) throw new Error('ANTHROPIC_API_KEY is not set — the rental agent cannot run without it.');

  const response = await getAnthropicClient().messages.create(
    {
      model: config.anthropic.model,
      max_tokens: 4_000,
      system: `${PERSONA}\n\n${SHARED_RULES}`,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      output_config: { format: { type: 'json_schema', schema: ROUND1_SCHEMA } },
      messages: [{ role: 'user', content: propertyContextMessage(input, computed) }],
    },
    ANTHROPIC_SEARCH_CALL_OPTIONS,
  );

  const parsed = JSON.parse(lastTextBlockText(response.content)) as Omit<RentalAgentResult, 'revisedFromRound1' | 'responseToOtherAgent'>;
  return {
    result: { ...parsed, revisedFromRound1: null, responseToOtherAgent: null },
    webSearches: response.usage.server_tool_use?.web_search_requests ?? 0,
  };
}

export async function runRentalRound2(
  input: PropertyInput,
  computed: ComputedFinancials,
  locationRound1: { reasoning: string; areaAssessment: string; schoolsAndCrimeSummary: string; appreciationOutlookScore: number } | null,
): Promise<AgentResponse> {
  if (!config.anthropic.configured) throw new Error('ANTHROPIC_API_KEY is not set — the rental agent cannot run without it.');

  const locationText = locationRound1
    ? `--- Location agent (round 1) ---\nAssessment: ${locationRound1.areaAssessment} (appreciation outlook score: ${locationRound1.appreciationOutlookScore}/100)\n` +
      `Reasoning: ${locationRound1.reasoning}\nSchools/crime: ${locationRound1.schoolsAndCrimeSummary}`
    : 'The location agent\'s round 1 analysis is unavailable (its call failed) — note this gap rather than assuming anything about the area.';

  const response = await getAnthropicClient().messages.create(
    {
      model: config.anthropic.model,
      max_tokens: 4_000,
      system: `${PERSONA}\n\n${SHARED_RULES}`,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      output_config: { format: { type: 'json_schema', schema: ROUND2_SCHEMA } },
      messages: [
        { role: 'user', content: propertyContextMessage(input, computed) },
        {
          role: 'user',
          content:
            `Here is the location agent's round-1 take on this same property:\n\n${locationText}\n\n` +
            `Does this change your rentability read? A strong area can still have a thin tenant pool (e.g. mostly ` +
            `owner-occupied, low turnover), and a weaker area can still rent reliably — say which, concretely, using ` +
            `search if it helps. Engage with their specific point either way. Use web_search again if you need to ` +
            `check something they raised. Set revisedFromRound1 to true only if your estimate or assessment actually ` +
            `changed.`,
        },
      ],
    },
    ANTHROPIC_SEARCH_CALL_OPTIONS,
  );

  const parsed = JSON.parse(lastTextBlockText(response.content)) as RentalAgentResult;
  return { result: parsed, webSearches: response.usage.server_tool_use?.web_search_requests ?? 0 };
}
