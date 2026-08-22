import { config } from '../../../config.js';
import { getAnthropicClient } from './client.js';
import { ANTHROPIC_CALL_OPTIONS } from './types.js';

/**
 * Turns an open-ended box query ("what looks good in defense right now")
 * into a set of real `instruments.sector` values — one bounded LLM call,
 * only reached when the query didn't resolve as a direct ticker/name match.
 *
 * `matchedSectors` is validated against the actual sector list this call
 * was given, not trusted as-is: a model that returns a sector value it
 * wasn't offered (a hallucination, or a plausible-sounding sector that
 * isn't one of this database's real GICS-normalized values) would otherwise
 * silently resolve to zero real symbols downstream instead of failing
 * loudly enough to notice.
 */

const SYSTEM = `You turn a person's open-ended question about the stock market
into a structured theme, using ONLY the sector list you are given. You do not
have access to real-time information or news — you are mapping a question to
the sectors it's asking about, using general knowledge of what those sectors
mean, not looking anything up.

Rules:

- matchedSectors must be a subset of the exact sector strings you were given
  in the user message. Never return a sector value that isn't in that list,
  even if it seems like a better fit — an unlisted value is worthless to the
  caller and worse than returning fewer sectors.
- If the question doesn't map to any sector in the list at all, return an
  empty matchedSectors array rather than guessing at the closest one.
- keywords are free-form short phrases capturing the theme's actual subject,
  for a caller that might use them elsewhere — not constrained to the
  sector list.`;

const THEME_SCHEMA = {
  type: 'object' as const,
  properties: {
    normalizedTheme: {
      type: 'string' as const,
      description: 'A short, plain restatement of what the question is actually asking about.',
    },
    matchedSectors: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Must be a subset of the sector list provided in the user message.',
    },
    keywords: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: '2-6 short keywords capturing the theme, for use outside the sector match.',
    },
  },
  required: ['normalizedTheme', 'matchedSectors', 'keywords'],
  additionalProperties: false,
};

export interface ThemeResolution {
  normalizedTheme: string;
  matchedSectors: string[];
  keywords: string[];
}

/** Defense in depth against the one failure mode the system prompt can't
 * fully prevent on its own — see this module's own doc comment. Extracted
 * as its own function so the filter itself is unit-testable without a live
 * API call. */
export function filterValidSectors(matchedSectors: string[], availableSectors: string[]): string[] {
  const validSectors = new Set(availableSectors);
  return matchedSectors.filter((s) => validSectors.has(s));
}

export async function resolveThemeQuery(query: string, availableSectors: string[]): Promise<ThemeResolution> {
  if (!config.anthropic.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set — thematic resolution cannot run without it.');
  }

  const response = await getAnthropicClient().messages.create(
    {
      model: config.anthropic.model,
      max_tokens: 1_000,
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: THEME_SCHEMA } },
      messages: [
        {
          role: 'user',
          content:
            `Question: "${query}"\n\n` +
            `Available sectors (matchedSectors must only contain values from this exact list):\n` +
            availableSectors.map((s) => `- ${s}`).join('\n'),
        },
      ],
    },
    ANTHROPIC_CALL_OPTIONS,
  );

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error('Claude returned no content for theme resolution');
  }
  const parsed = JSON.parse(block.text) as ThemeResolution;
  return { ...parsed, matchedSectors: filterValidSectors(parsed.matchedSectors, availableSectors) };
}
