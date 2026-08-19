import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';

/**
 * Tags one document into a fixed event taxonomy. The classifier, never the
 * predictor — the plan's own phrase for this agent, and the whole reason it
 * is safe to run automatically where narrate.ts and hypotheses.ts still
 * expect a human on the other end. Classifying "this document concerns an
 * executive change" carries no forecast, no direction, and no size; it is
 * metadata a feature builder can group by, not a signal on its own.
 *
 * The third and last of the plan's three remaining agents, and the one that
 * had to wait: it needs a real document to classify, and news.ts/edgar.ts
 * are what finally produced one. Point-in-time correctness is not this
 * module's concern — classifying a document from its own published text
 * cannot leak anything into the future the document itself wasn't already
 * public with — that guarantee belongs entirely to `readDocumentsBefore` in
 * news.ts, which is what a feature builder must call instead of this
 * output to stay leak-free.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

export const EVENT_TYPES = [
  'earnings',
  'executive_change',
  'ma_activity',
  'capital_action',
  'regulatory_legal',
  'product_or_strategy',
  'macro_or_sector',
  'other',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const SYSTEM = `You classify one financial news article or SEC filing into
exactly one category from a fixed taxonomy, for a personal options-research
codebase. You are a classifier, not an analyst — you do not predict what the
document's news means for the stock, you only say which kind of event it
describes.

Categories, in the exact order a document should be checked against them:

- earnings: quarterly/annual results, guidance, EPS or revenue beats/misses.
- executive_change: CEO/CFO/board appointments, departures, or successions.
- ma_activity: mergers, acquisitions, divestitures, spinoffs, tender offers.
- capital_action: buybacks, dividends, debt or equity issuance, credit
  rating changes, stock splits.
- regulatory_legal: lawsuits, investigations, regulatory approval or denial,
  fines, settlements.
- product_or_strategy: product launches, partnerships, major contracts,
  strategic pivots not covered above.
- macro_or_sector: commentary about the broad market, the economy, or a
  sector generally, where this specific company is incidental rather than
  the subject.
- other: none of the above fit and forcing one would misrepresent the
  document — do not default here just because classification feels
  ambiguous; work through the list above first.

An 8-K's own SEC item numbers, when present in the input, are a strong prior
— item 5.02 is officer/director changes, item 2.02 is results of operations,
and so on — but the title and summary are the ground truth if they disagree
with what the item number alone would suggest. State your reasoning in one
sentence tied to specific words in the input, not a generic description of
the category.`;

const CLASSIFICATION_SCHEMA = {
  type: 'object' as const,
  properties: {
    eventType: { type: 'string' as const, enum: EVENT_TYPES as unknown as string[] },
    confidence: {
      type: 'string' as const,
      enum: ['high', 'medium', 'low'],
      description: '"low" when the document could plausibly fit more than one category.',
    },
    reasoning: {
      type: 'string' as const,
      description: 'One sentence, tied to specific words in the input.',
    },
  },
  required: ['eventType', 'confidence', 'reasoning'],
  additionalProperties: false,
};

export interface ClassifyInput {
  title: string;
  summary: string | null;
  docType: string | null;
  /** EDGAR item codes, e.g. "2.02,9.01" — null for news. */
  items: string | null;
}

export interface ClassifyResult {
  eventType: EventType;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export async function classifyDocument(input: ClassifyInput): Promise<ClassifyResult> {
  if (!config.anthropic.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set — the event classifier cannot run without it.');
  }

  const response = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: 2_000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: CLASSIFICATION_SCHEMA } },
    messages: [{ role: 'user', content: JSON.stringify(input, null, 2) }],
  });

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error('Claude returned no content for the classification');
  }
  return JSON.parse(block.text) as ClassifyResult;
}
