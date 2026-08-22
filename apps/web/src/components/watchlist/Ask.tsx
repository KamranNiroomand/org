import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, MessageCircleQuestion, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CardHeader, Empty, Input, Notice, Skeleton, cn } from '../ui';
import { PanelResult } from './PanelResult';
import { api, type BoxQueryResponse, type PanelRunDetail } from '../../lib/api';

/** A real panel run finishes in well under a minute per symbol in normal
 * operation — this is a circuit breaker for the genuinely stuck case (a
 * server crash mid-run that never reaches its own status update), not a
 * realistic timing for a healthy run. Without it, `refetchIntervalInBackground`
 * means a stuck run polls forever with no way for the user to tell "still
 * working" apart from "will never finish". */
const MAX_POLL_MS = 10 * 60_000;

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
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const pollStartedAt = useRef<number | null>(null);

  const submit = useMutation({
    mutationFn: (q: string) => api.post<BoxQueryResponse>('/api/signals/box', { query: q }),
    onSuccess: (res) => {
      setActiveRunId(res.runId);
      setResolved(res);
      pollStartedAt.current = Date.now();
      setPollTimedOut(false);
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

  const { data: detail, isLoading: isLoadingDetail, refetch: refetchDetail } = useQuery({
    queryKey: ['panel', activeRunId],
    queryFn: () => api.get<PanelRunDetail>(`/api/signals/panel/${activeRunId}`),
    enabled: activeRunId !== null,
    refetchInterval: (q) => {
      if (q.state.data?.run.status !== 'running') return false;
      if (pollStartedAt.current && Date.now() - pollStartedAt.current > MAX_POLL_MS) {
        setPollTimedOut(true);
        return false;
      }
      return 2500;
    },
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

      {(detail?.disclaimer ?? resolved?.disclaimer) && <Notice>{detail?.disclaimer ?? resolved?.disclaimer}</Notice>}

      {submit.isError && (
        <Notice tone="negative" icon={<AlertTriangle className="size-3.5" />}>
          {submit.error instanceof Error ? submit.error.message : 'The request failed.'}
        </Notice>
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

          {pollTimedOut && detail?.run.status === 'running' && (
            <Notice tone="warning" icon={<AlertTriangle className="size-3.5" />}>
              This is taking much longer than a healthy run should — it may be stuck.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  pollStartedAt.current = Date.now();
                  setPollTimedOut(false);
                  void refetchDetail();
                }}
              >
                Check again
              </button>
            </Notice>
          )}

          {detail?.run.status === 'failed' && (
            <Notice tone="negative" icon={<AlertTriangle className="size-3.5" />}>
              {detail.run.errors.join(' ') || 'The panel run failed.'}
            </Notice>
          )}
          {detail?.run.status === 'partial' && (
            <Notice tone="warning" icon={<AlertTriangle className="size-3.5" />}>
              Only partially completed: {detail.run.errors.join(' ')}
            </Notice>
          )}

          {isLoadingDetail && !detail ? (
            <Skeleton className="h-40" />
          ) : (
            detail?.run.symbols.map((symbol) => {
              const analysis = detail.analyses.find((a) => a.symbol === symbol);
              if (!analysis) {
                return (
                  <div key={symbol} className={cn('rounded-lg border border-border p-3.5 text-xs text-muted')}>
                    <span className="font-mono font-medium text-text">{symbol}</span> —{' '}
                    {detail.run.status === 'running' ? 'queued' : 'not analyzed (see errors above)'}
                  </div>
                );
              }
              return (
                <PanelResult
                  key={symbol}
                  analysis={analysis}
                  pending={!analysis.synthesisComplete}
                  stillRunning={!analysis.synthesisComplete && detail.run.status === 'running'}
                />
              );
            })
          )}
        </div>
      )}
    </Card>
  );
}
