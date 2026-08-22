import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, Radar as RadarIcon, TrendingUp } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Empty, Skeleton, cn } from '../ui';
import { api, type RadarResponse, type RadarRunSummary } from '../../lib/api';

/**
 * The heuristic growth/momentum radar — a market-wide scan, not just the
 * watchlist. `RADAR_DISCLAIMER` travels with every response and renders
 * here as a persistent banner, not a dismissible tooltip: this is a first-
 * pass composite score, never backtested, never a recommendation.
 *
 * The banner only ever shows the server's own `disclaimer` string, never a
 * hand-typed paraphrase — a copy here that drifted from `RADAR_DISCLAIMER`
 * would quietly weaken exactly the promise it exists to make.
 */

function RunNowButton({ variant, onRun, pending }: { variant: 'ghost' | 'primary'; onRun: () => void; pending: boolean }) {
  return (
    <Button size="sm" variant={variant} onClick={onRun} disabled={pending}>
      <RefreshCw className={cn('size-3.5', pending && 'animate-spin')} /> Run now
    </Button>
  );
}

/** A run that returned 200 but did no work — currently only the "already in
 * progress" guard — reads as a silent no-op if we don't say so out loud. */
function RunNotice({ result }: { result: RadarRunSummary }) {
  if (result.errors.length === 0) return null;
  return (
    <div className="flex items-start gap-2 border-b border-border bg-warning/10 px-4 py-2.5 text-xs text-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{result.errors.join(' ')}</span>
    </div>
  );
}

export function Radar({ onDrillIn }: { onDrillIn?: (symbol: string) => void }) {
  const qc = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['radar'],
    queryFn: () => api.get<RadarResponse>('/api/signals/radar'),
  });

  const run = useMutation({
    mutationFn: () => api.post<RadarRunSummary>('/api/signals/radar/run'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['radar'] }),
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Radar"
        subtitle="Momentum, 52-week proximity, volume spikes, and news sentiment, scanned across the full market"
        action={<RunNowButton variant="ghost" onRun={() => run.mutate()} pending={run.isPending} />}
      />

      {data && (
        <div className="border-b border-border bg-warning/5 px-4 py-2.5 text-xs text-muted">{data.disclaimer}</div>
      )}
      {run.data && <RunNotice result={run.data} />}

      {isLoading ? (
        <Skeleton className="m-4 h-40" />
      ) : isError ? (
        <Empty
          icon={<AlertTriangle className="size-7" />}
          title="Couldn't load the radar"
          hint="The request to the server failed — try again in a moment."
          action={<RunNowButton variant="primary" onRun={() => qc.invalidateQueries({ queryKey: ['radar'] })} pending={false} />}
        />
      ) : !data || data.items.length === 0 ? (
        <Empty
          icon={<RadarIcon className="size-7" />}
          title="No shortlist yet"
          hint="Run the scan to score today's market — it only takes a moment."
          action={<RunNowButton variant="primary" onRun={() => run.mutate()} pending={run.isPending} />}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[11px] tracking-wide text-muted uppercase">
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-2 py-2 font-medium">Symbol</th>
                <th className="px-2 py-2 text-right font-medium">Score</th>
                <th className="px-2 py-2 text-right font-medium">Day %</th>
                <th className="px-2 py-2 text-right font-medium">52w range</th>
                <th className="px-2 py-2 text-right font-medium">Vol / avg</th>
                <th className="px-2 py-2 font-medium">News</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.items.map((row) => (
                <tr key={row.id} className="hover:bg-bg-subtle/60">
                  <td className="px-4 py-2 tnum text-faint">{row.rank}</td>
                  <td className="px-2 py-2">
                    {onDrillIn ? (
                      <button
                        type="button"
                        onClick={() => onDrillIn(row.symbol)}
                        className="flex items-center gap-1.5 hover:underline"
                        title={`Ask the panel about ${row.symbol}`}
                      >
                        <span className="font-mono text-sm font-medium">{row.symbol}</span>
                        {row.newHigh && (
                          <Badge tone="positive">
                            <TrendingUp className="size-3" />
                          </Badge>
                        )}
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sm font-medium">{row.symbol}</span>
                        {row.newHigh && (
                          <Badge tone="positive">
                            <TrendingUp className="size-3" />
                          </Badge>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tnum font-medium">{row.score.toFixed(2)}</td>
                  <td
                    className={cn(
                      'px-2 py-2 text-right tnum',
                      row.momentumZ !== null && (row.momentumZ >= 0 ? 'text-positive' : 'text-negative'),
                    )}
                  >
                    {row.momentumZ !== null ? `z ${row.momentumZ >= 0 ? '+' : ''}${row.momentumZ.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-2 py-2 text-right tnum text-muted">
                    {row.trendPct !== null ? `${Math.round(row.trendPct * 100)}%` : '—'}
                  </td>
                  <td className="px-2 py-2 text-right tnum text-muted">
                    {row.volumeRatio !== null ? `${row.volumeRatio.toFixed(1)}x` : '—'}
                  </td>
                  <td className="px-2 py-2">
                    {row.sentimentDocCount > 0 ? (
                      <Badge tone={row.sentimentZ !== null && row.sentimentZ >= 0 ? 'positive' : 'negative'}>
                        {row.sentimentDocCount} doc{row.sentimentDocCount === 1 ? '' : 's'}
                      </Badge>
                    ) : (
                      <span className="text-faint">not covered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
