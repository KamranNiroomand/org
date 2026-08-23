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
