import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, MessageCircleQuestion, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardHeader, Empty, Input, Skeleton, cn } from '../ui';
import { PanelResult } from './PanelResult';
import { api, type BoxQueryResponse, type PanelRunDetail } from '../../lib/api';

/**
 * The box: a ticker/company lookup or an open-ended thematic question,
 * resolved to a bounded symbol list and run through the multi-agent panel.
 * `disclaimer` always comes from the server response, never a hand-typed
 * copy here — see Radar.tsx's own history with exactly that drift.
 */
export function Ask({ prefill }: { prefill?: { symbol: string; token: number } | null }) {
  const [query, setQuery] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [resolved, setResolved] = useState<BoxQueryResponse | null>(null);

  const submit = useMutation({
    mutationFn: (q: string) => api.post<BoxQueryResponse>('/api/signals/box', { query: q }),
    onSuccess: (res) => {
      setActiveRunId(res.runId);
      setResolved(res);
    },
  });

  useEffect(() => {
    if (!prefill) return;
    setQuery(prefill.symbol);
    submit.mutate(prefill.symbol);
    // Deliberately keyed on prefill.token alone — it re-fires only when a
    // *new* drill-in arrives from Radar.tsx, not on every render or every
    // time `submit` (a fresh function from useMutation) is recreated.
  }, [prefill?.token]);

  const { data: detail, isLoading: isLoadingDetail } = useQuery({
    queryKey: ['panel', activeRunId],
    queryFn: () => api.get<PanelRunDetail>(`/api/signals/panel/${activeRunId}`),
    enabled: activeRunId !== null,
    refetchInterval: (q) => (q.state.data?.run.status === 'running' ? 2500 : false),
    // A panel run takes tens of seconds — long enough that tabbing away to
    // check something else while it finishes is the realistic case, not an
    // edge case. The app disables refetchOnWindowFocus globally, so without
    // this override, tabbing back would show the same stale "running" state
    // forever: React Query pauses refetchInterval in a backgrounded tab by
    // default, and nothing here would ever ask again.
    refetchIntervalInBackground: true,
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Ask"
        subtitle="A ticker, a company name, or an open-ended question — resolved to a few symbols and reasoned through by four specialists"
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length >= 2) submit.mutate(query.trim());
        }}
        className="flex items-center gap-2 border-b border-border p-3"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Try "MRNA" or "what looks interesting in defense right now"'
            className="pl-8"
          />
        </div>
        <Button type="submit" variant="primary" disabled={submit.isPending || query.trim().length < 2}>
          Ask
        </Button>
      </form>

      {(detail?.disclaimer ?? resolved?.disclaimer) && (
        <div className="border-b border-border bg-warning/5 px-4 py-2.5 text-xs text-muted">
          {detail?.disclaimer ?? resolved?.disclaimer}
        </div>
      )}

      {submit.isError && (
        <div className="flex items-start gap-2 border-b border-border bg-negative/10 px-4 py-2.5 text-xs text-negative">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{submit.error instanceof Error ? submit.error.message : 'The request failed.'}</span>
        </div>
      )}

      {!activeRunId ? (
        <Empty
          icon={<MessageCircleQuestion className="size-7" />}
          title="Nothing asked yet"
          hint='A specific ticker resolves instantly. An open question ("what looks good in biotech") takes one extra step to resolve to symbols, then the panel reasons through each.'
        />
      ) : (
        <div className="space-y-3 p-4">
          {resolved && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              {resolved.normalizedTheme && <span>Resolved to: {resolved.normalizedTheme} —</span>}
              {resolved.resolvedSymbols.map((s) => (
                <Badge key={s}>{s}</Badge>
              ))}
            </div>
          )}

          {detail?.run.status === 'failed' && (
            <div className="flex items-start gap-2 rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{detail.run.errors.join(' ') || 'The panel run failed.'}</span>
            </div>
          )}
          {detail?.run.status === 'partial' && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>Only partially completed: {detail.run.errors.join(' ')}</span>
            </div>
          )}

          {isLoadingDetail && !detail ? (
            <Skeleton className="h-40" />
          ) : (
            detail?.run.symbols.map((symbol) => {
              const analysis = detail.analyses.find((a) => a.symbol === symbol);
              if (!analysis) {
                return (
                  <div key={symbol} className={cn('rounded-lg border border-border p-3.5 text-xs text-muted')}>
                    <span className="font-mono font-medium text-text">{symbol}</span> — queued
                  </div>
                );
              }
              return (
                <PanelResult key={symbol} analysis={analysis} pending={detail.run.status === 'running' && analysis.summary === ''} />
              );
            })
          )}
        </div>
      )}
    </Card>
  );
}
