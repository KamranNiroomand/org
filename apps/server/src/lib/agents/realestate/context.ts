import type { ComputedFinancials, PropertyInput } from './types.js';

/**
 * Everything an agent sees about one property — the raw form inputs plus
 * the already-computed financials, handed over as one JSON blob exactly
 * the way `specialists.ts`'s own `contextMessage` hands over a
 * `SymbolContext`. The computed numbers are marked as ground truth in the
 * accompanying instruction (see each agent's system prompt) — an agent
 * must never recompute or contradict them.
 */
export function propertyContextMessage(input: PropertyInput, computed: ComputedFinancials): string {
  return (
    `Property details, as entered by the person considering this purchase:\n${JSON.stringify(input, null, 2)}\n\n` +
    `Already-computed financials — treat every number here as ground truth; never recompute, ` +
    `round differently, or contradict them:\n${JSON.stringify(computed, null, 2)}`
  );
}

/**
 * The *last* text content block in an Anthropic response — not the first.
 * A `web_search`-enabled call (both location and rental agents, every
 * round) can emit several text blocks: commentary before/between searches,
 * then the final structured-output block. The panel's own
 * `.find(b => b.type === 'text')` (first match) predates `web_search` in
 * this codebase and would grab the wrong block here. Shared by
 * `location.ts` and `rental.ts` rather than duplicated — they're
 * byte-identical otherwise.
 */
export function lastTextBlockText(content: Array<{ type: string; text?: string }>): string {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  throw new Error('Claude returned no text content for a real-estate agent call');
}
