import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Radar as RadarIcon, TrendingUp } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Empty, Skeleton, cn } from '../ui';
import { api, type RadarResponse } from '../../lib/api';

/**
 * The heuristic growth/momentum radar — a market-wide scan, not just the
 * watchlist. `RADAR_DISCLAIMER` travels with every response and renders
 * here as a persistent banner, not a dismissible tooltip: this is a first-
 * pass composite score, never backtested, never a recommendation.
 */
export function Radar() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['radar'],
    queryFn: () => api.get<RadarResponse>('/api/signals/radar'),
  });

  const run = useMutation({
    mutationFn: () => api.post('/api/signals/radar/run'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['radar'] }),
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Radar"
        subtitle="Momentum, 52-week proximity, volume spikes, and news sentiment, scanned across the full market"
        action={
          <Button size="sm" variant="ghost" onClick={() => run.mutate()} disabled={run.isPending}>
            <RefreshCw className={cn('size-3.5', run.isPending && 'animate-spin')} /> Run now
          </Button>
        }
      />

      <div className="border-b border-border bg-warning/5 px-4 py-2.5 text-xs text-muted">
        {data?.disclaimer ??
          'Heuristic screen only — not backtested, not validated against forward returns, not a recommendation.'}
      </div>

      {isLoading ? (
        <Skeleton className="m-4 h-40" />
      ) : !data || data.items.length === 0 ? (
        <Empty
          icon={<RadarIcon className="size-7" />}
          title="No shortlist yet"
          hint="Run the scan to score today's market — it only takes a moment."
          action={
            <Button size="sm" variant="primary" onClick={() => run.mutate()} disabled={run.isPending}>
              <RefreshCw className={cn('size-3.5', run.isPending && 'animate-spin')} /> Run now
            </Button>
          }
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
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-sm font-medium">{row.symbol}</span>
                      {row.newHigh && (
                        <Badge tone="positive">
                          <TrendingUp className="size-3" />
                        </Badge>
                      )}
                    </div>
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
