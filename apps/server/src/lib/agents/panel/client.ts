import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../../config.js';

/**
 * One shared client getter for every panel module that calls the Anthropic
 * API (specialists.ts, synthesize.ts, resolveTheme.ts) — this PR was about
 * to add a third copy of the same 4-line function already duplicated across
 * narrate.ts/hypotheses.ts/leakageAudit.ts; three near-simultaneous copies
 * in one PR was the moment to stop, not the moment to make it four more.
 */

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}
