import { ArrowRight, RefreshCw } from 'lucide-react';
import { Badge, cn } from '../ui';
import type { PanelAgentTurn, PanelSymbolAnalysis, Specialist } from '../../lib/api';

/**
 * Renders one symbol's panel analysis exactly as it was persisted — no
 * re-summarization at this layer. The four-specialist grid is the point:
 * a reader should be able to see round 1's independent takes, then round
 * 2's actual responses to each other, not a narrative someone wrote on
 * the panel's behalf.
 */

const SPECIALIST_LABELS: Record<Specialist, string> = {
  momentum: 'Momentum',
  fundamentals: 'Fundamentals',
  news_sentiment: 'News & Sentiment',
  skeptic: 'Skeptic',
};

const STANCE_TONE = {
  bullish: 'positive',
  bearish: 'negative',
  neutral: 'neutral',
} as const;

const SYNTHESIS_TONE = {
  notable: 'accent',
  mixed: 'warning',
  not_notable: 'neutral',
} as const;

function TurnCard({ turn }: { turn: PanelAgentTurn }) {
  return (
    <div className="rounded-lg border border-border p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={STANCE_TONE[turn.stance]}>{turn.stance}</Badge>
        <span className="text-[11px] text-faint">{turn.confidence} confidence</span>
        {turn.revisedPosition && <Badge tone="accent">revised</Badge>}
      </div>
      <p className="text-xs leading-relaxed text-text">{turn.reasoning}</p>
      {turn.respondingTo && turn.respondingTo.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-faint">
          <ArrowRight className="size-3" />
          responding to {turn.respondingTo.map((s) => SPECIALIST_LABELS[s]).join(', ')}
        </div>
      )}
    </div>
  );
}

function SpecialistColumn({ agent, turns }: { agent: Specialist; turns: PanelAgentTurn[] }) {
  const round1 = turns.find((t) => t.round === 1);
  const round2 = turns.find((t) => t.round === 2);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="text-[11px] font-medium tracking-wide text-muted uppercase">{SPECIALIST_LABELS[agent]}</div>
      {round1 && <TurnCard turn={round1} />}
      {round2 && <TurnCard turn={round2} />}
    </div>
  );
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium tracking-wide text-muted uppercase">{title}</div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-xs leading-relaxed text-text">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PanelResult({
  analysis,
  pending,
  stillRunning = pending,
}: {
  analysis: PanelSymbolAnalysis;
  /** True whenever the synthesis hasn't landed yet — including a symbol
   * left permanently incomplete by a 'partial'/'failed' run, not only one
   * that's actively in progress. Never render `analysis.stance` as a real
   * verdict while this is true — the placeholder `not_notable` underneath
   * it means nothing yet. */
  pending?: boolean;
  /** Whether the run is still actually working on this symbol right now —
   * only this state gets the spinning "running" badge. Defaults to
   * `pending` for a caller with no independent way to know the run finished
   * (e.g. Radar's own drill-in preview), but Ask.tsx passes it explicitly
   * so a symbol left incomplete by a finished 'partial' run reads as
   * "incomplete", not as a spinner that will never resolve. */
  stillRunning?: boolean;
}) {
  const agents: Specialist[] = ['momentum', 'fundamentals', 'news_sentiment', 'skeptic'];

  return (
    <div className="rounded-lg border border-border p-3.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-sm font-semibold">{analysis.symbol}</span>
        {pending ? (
          <Badge tone="neutral">
            {stillRunning && <RefreshCw className="size-3 animate-spin" />} {stillRunning ? 'running' : 'incomplete'}
          </Badge>
        ) : (
          <Badge tone={SYNTHESIS_TONE[analysis.stance]}>{analysis.stance.replace('_', ' ')}</Badge>
        )}
      </div>

      {analysis.summary && <p className="mb-3 text-sm leading-relaxed text-text">{analysis.summary}</p>}

      {!pending && (
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <ListSection title="Agreements" items={analysis.agreements} />
          <ListSection title="Disagreements" items={analysis.disagreements} />
          <ListSection title="Open questions" items={analysis.openQuestions} />
        </div>
      )}

      <div className={cn('grid gap-3', 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4')}>
        {agents.map((agent) => (
          <SpecialistColumn key={agent} agent={agent} turns={analysis.turns.filter((t) => t.agent === agent)} />
        ))}
      </div>
    </div>
  );
}
