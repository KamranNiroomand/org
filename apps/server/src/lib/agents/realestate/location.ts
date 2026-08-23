import { config } from '../../../config.js';
import { getAnthropicClient } from '../panel/client.js';
import { propertyContextMessage } from './context.js';
import { ANTHROPIC_SEARCH_CALL_OPTIONS, type ComputedFinancials, type LocationAgentResult, type PropertyInput } from './types.js';

/**
 * The location/neighborhood specialist — schools, safety, street type
 * (quiet vs. a busy road or highway backing the lot), walkability, and the
 * area's likely trajectory. Uses the Anthropic `web_search` tool so its
 * read comes from real, current sources rather than training-data recall
 * alone — the honesty-first stance this app already takes with the stock
 * panel, just now grounded in live search instead of a stored database.
 */

const SHARED_RULES = `Rules you follow, regardless of what you find:

- Never use "buy", "should", or any language that reads as advice — you are
  describing the area, not telling anyone what to do with their money.
- Every claim must be grounded either in a specific field from the property
  details you were given, or in a specific web_search result — name what you
  searched for and what you found in citedFindings, and list the sites you
  actually consulted in sourcesUsed. Never invent a school name, a crime
  statistic, or a comparable sale.
- If a search comes back thin or you can't find real information for this
  specific address, say so plainly in low confidence rather than
  manufacturing a confident read from general knowledge about the city.
- appreciationOutlookScore (0-100) follows this rubric: school quality and
  trajectory, crime trend, infrastructure/development plans, how this
  street/block compares to its immediate surroundings (quiet interior street
  vs. backing a highway or arterial road), supply constraints, and — when you
  can find it — how comparable homes in this specific area have appreciated
  versus the broader city. A property with no red flags but nothing
  distinguishing it either should land near 50, not be rounded up to sound
  more decisive than the evidence supports.`;

const PERSONA = `You are the location/neighborhood specialist evaluating one
residential property someone is considering buying. Your lens: is this a
good area — school ratings and trajectory, crime trends, whether the
property sits on a quiet interior street or backs onto a busy main road or
highway, walkability and nearby amenities, and the neighborhood's likely
direction over the next decade. Use web_search to find real, current
information for the specific address and area given — actual school ratings
sites, local crime statistics, recent comparable sales — rather than relying
on what you already know about the city in general.`;

const SHARED_PROPERTIES = {
  areaAssessment: { type: 'string' as const, enum: ['strong', 'average', 'weak'] },
  confidence: { type: 'string' as const, enum: ['low', 'medium', 'high'] },
  reasoning: { type: 'string' as const, description: 'Three to five sentences, from your lens only.' },
  schoolsAndCrimeSummary: { type: 'string' as const, description: 'What you actually found — name the schools/ratings or say search found nothing usable.' },
  comparableSalesSummary: { type: 'string' as const, description: 'Recent comparable sales you found, or say none were found.' },
  appreciationOutlookScore: {
    type: 'number' as const,
    minimum: 0,
    maximum: 100,
    description: 'Rubric score — see your system prompt for the exact factors.',
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
      description: 'Three to five sentences. Must engage directly with the rental agent\'s specific point.',
    },
    revisedFromRound1: { type: 'boolean' as const, description: 'True only if your assessment or score actually changed.' },
    responseToOtherAgent: { type: 'string' as const, description: 'What specifically you are responding to from the rental agent, and how (or whether) it changes your read.' },
  },
  required: [...Object.keys(SHARED_PROPERTIES), 'revisedFromRound1', 'responseToOtherAgent'],
  additionalProperties: false,
};

function lastTextBlockText(content: Array<{ type: string; text?: string }>): string {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  throw new Error('Claude returned no text content for the location agent');
}

interface AgentResponse {
  result: LocationAgentResult;
  webSearches: number;
}

export async function runLocationRound1(input: PropertyInput, computed: ComputedFinancials): Promise<AgentResponse> {
  if (!config.anthropic.configured) throw new Error('ANTHROPIC_API_KEY is not set — the location agent cannot run without it.');

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

  const parsed = JSON.parse(lastTextBlockText(response.content)) as Omit<LocationAgentResult, 'revisedFromRound1' | 'responseToOtherAgent'>;
  return {
    result: { ...parsed, revisedFromRound1: null, responseToOtherAgent: null },
    webSearches: response.usage.server_tool_use?.web_search_requests ?? 0,
  };
}

export async function runLocationRound2(
  input: PropertyInput,
  computed: ComputedFinancials,
  rentalRound1: { reasoning: string; rentabilityAssessment: string; comparableRentsSummary: string; demandFactors: string[] } | null,
): Promise<AgentResponse> {
  if (!config.anthropic.configured) throw new Error('ANTHROPIC_API_KEY is not set — the location agent cannot run without it.');

  const rentalText = rentalRound1
    ? `--- Rental agent (round 1) ---\nAssessment: ${rentalRound1.rentabilityAssessment}\nReasoning: ${rentalRound1.reasoning}\n` +
      `Comparable rents: ${rentalRound1.comparableRentsSummary}\nDemand factors: ${rentalRound1.demandFactors.join(', ')}`
    : 'The rental agent\'s round 1 analysis is unavailable (its call failed) — note this gap rather than assuming anything about rentability.';

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
            `Here is the rental agent's round-1 take on this same property:\n\n${rentalText}\n\n` +
            `Does this change your area assessment or appreciation score? A weak rental market can be a sign of ` +
            `real underlying demand problems, or it can be unrelated to whether this is a good area to own in — say ` +
            `which, concretely, using search if it helps. Engage with their specific point either way. Use web_search ` +
            `again if you need to check something they raised. Set revisedFromRound1 to true only if your ` +
            `assessment or score actually changed.`,
        },
      ],
    },
    ANTHROPIC_SEARCH_CALL_OPTIONS,
  );

  const parsed = JSON.parse(lastTextBlockText(response.content)) as LocationAgentResult;
  return { result: parsed, webSearches: response.usage.server_tool_use?.web_search_requests ?? 0 };
}
