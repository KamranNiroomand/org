import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';

/**
 * The first agent in the pipeline, on purpose — the plan calls for building
 * this one before anything else, because it is the thing that protects
 * every other result from the 5%/day mirage: a feature or backtest config
 * that looks like an edge because it quietly reads the future.
 *
 * This agent never predicts a price, sizes a position, or bypasses the
 * purged walk-forward split in `cv.py`. It reviews code and configuration
 * *before* a human trusts a result from it — an offline critique step, never
 * in the live prediction or trading path. That boundary is enforced by what
 * this module doesn't do: there is no function here that returns a price, a
 * direction, or a trade size, only a review of somebody else's.
 */

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

const SYSTEM = `You are a quantitative research auditor reviewing code for a
personal options-prediction system. Your only job is finding ways a feature,
label, or backtest configuration could leak information from the future into
training, overstate a backtest's realism, or silently exclude the failures
that would have told the truth about a strategy.

Context on this specific codebase, since your review should be concrete
rather than generic:

- Labels are forward-looking by construction (an h-day return or realized-vol
  window). The project's own purged, embargoed walk-forward split (cv.py) is
  supposed to guarantee no training row's label window reaches into a test
  period. Your job is to ask: does the code under review respect that
  guarantee, or does it introduce a path around it — e.g. a feature computed
  with a centered rolling window, a join against same-day data that was not
  actually knowable until end of day, or a normalization statistic (a mean,
  a z-score) computed over the whole dataset including future rows instead of
  only the training fold.
- Money in this codebase is E4 (integer ten-thousandths of a dollar). A
  backtest that fills at a mid price rather than the conservative side (ask
  to open a long, bid to close it) is optimistic about cost — spreads on
  thin option contracts can exceed 20% round trip, and that alone can turn a
  "profitable" backtest into a loss.
- The liquidity gate (gate.ts) marks a quote's basis as "measured" (a real
  captured bid/ask) or "modelled" (an estimate — a last trade, a close, a
  human-typed price). A backtest or feature that treats a modelled price as
  if it were a tradeable quote is overstating realism.
- Universe survivorship: the tracked_underlyings table is a snapshot of
  today's universe, not a historical record of what was listed on any given
  past date. A backtest run over the current 566-symbol universe implicitly
  excludes every name that was delisted, acquired, or went bankrupt during
  the backtest window — which is exactly the population most likely to have
  produced the worst historical returns.

Be specific about *where* a risk is, not just that risk exists in the
abstract. If you cannot find a genuine issue, say so plainly rather than
manufacturing one — a false positive costs real time chasing a non-problem,
and undermines trust in every other finding this agent produces.`;

const AUDIT_SCHEMA = {
  type: 'object' as const,
  properties: {
    riskLevel: {
      type: 'string' as const,
      enum: ['none', 'low', 'medium', 'high'],
      description: 'Overall assessment. "none" means no genuine leakage or realism issue found.',
    },
    summary: {
      type: 'string' as const,
      description: 'One or two sentences: the headline finding, or why nothing was found.',
    },
    findings: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          category: {
            type: 'string' as const,
            enum: ['lookahead', 'survivorship', 'cost-optimism', 'other'],
          },
          location: {
            type: 'string' as const,
            description: 'The specific function, line, or config field this concerns.',
          },
          explanation: { type: 'string' as const },
          suggestedFix: { type: 'string' as const },
        },
        required: ['category', 'location', 'explanation', 'suggestedFix'],
        additionalProperties: false,
      },
    },
  },
  required: ['riskLevel', 'summary', 'findings'],
  additionalProperties: false,
};

export interface AuditTarget {
  name: string;
  kind: 'feature' | 'label' | 'backtest_config' | 'cv_config' | 'other';
  sourceCode: string;
  description?: string;
}

export interface AuditFinding {
  category: 'lookahead' | 'survivorship' | 'cost-optimism' | 'other';
  location: string;
  explanation: string;
  suggestedFix: string;
}

export interface AuditResult {
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  summary: string;
  findings: AuditFinding[];
}

export async function auditForLeakage(target: AuditTarget): Promise<AuditResult> {
  if (!config.anthropic.configured) {
    throw new Error('ANTHROPIC_API_KEY is not set — the leakage auditor cannot run without it.');
  }

  const response = await getClient().messages.create({
    model: config.anthropic.model,
    max_tokens: 16_000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: AUDIT_SCHEMA } },
    messages: [
      {
        role: 'user',
        content:
          `Review this ${target.kind.replace('_', ' ')} named "${target.name}" for lookahead bias, ` +
          `survivorship bias, and cost optimism.${target.description ? `\n\nContext: ${target.description}` : ''}` +
          `\n\n---\n\n${target.sourceCode}`,
      },
    ],
  });

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error('Claude returned no content for the leakage audit');
  }
  return JSON.parse(block.text) as AuditResult;
}
