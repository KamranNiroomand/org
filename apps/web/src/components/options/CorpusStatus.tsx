import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Database, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Skeleton, cn } from '../ui';
import { StatTile } from '../charts';
import { optionsApi } from '../../lib/optionsApi';
import { ApiError } from '../../lib/api';

/**
 * What is actually collecting data, and how much of it exists.
 *
 * The corpus can only grow forward — a night nothing captures is a night
 * permanently missing — so this screen leads with dates and counts rather
 * than anything derived from them. There is no ranked signal to show yet;
 * this page exists to answer "is the pipeline actually working" before
 * anything built on top of it can be trusted.
 */
export function CorpusStatus() {
  const qc = useQueryClient();
  const [pullError, setPullError] = useState<string | null>(null);
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['options-status'],
    queryFn: () => optionsApi.status(),
    refetchInterval: 60_000,
  });

  const trigger = async () => {
    await optionsApi.triggerCapture();
    void qc.invalidateQueries({ queryKey: ['options-status'] });
  };

  const triggerTextSync = async () => {
    await optionsApi.triggerTextSync();
    void qc.invalidateQueries({ queryKey: ['options-status'] });
  };

  // Deliberately calls the server's /api/options/pull rather than shelling
  // out to `npm run market:pull` — an in-process pull is the one that can
  // actually reopen the connection this same server answers every other
  // request from. See marketPull.ts's own doc comment.
  const pull = async () => {
    setPullError(null);
    try {
      await optionsApi.triggerPull();
      void qc.invalidateQueries({ queryKey: ['options-status'] });
    } catch (err) {
      setPullError(err instanceof ApiError ? err.message : 'Pull failed');
    }
  };

  if (isLoading) return <Skeleton className="h-64" />;
  if (!data) return null;

  const nextCapture = data.nextCapture ? new Date(data.nextCapture) : null;
  const nextTextSync = data.nextTextSync ? new Date(data.nextTextSync) : null;
  const core = data.universe.core ?? 0;
  const research = data.universe.research ?? 0;

  return (
    <div className="space-y-4">
      {!data.configured && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="size-3.5 shrink-0" />
          POLYGON_API_KEY is not set — nothing can be captured until it is.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Quotes captured" value={data.totals.quotes.toLocaleString()} />
        <StatTile
          label="Coverage"
          value={data.totals.firstDay ? `${data.totals.firstDay} → ${data.totals.lastDay}` : 'None yet'}
        />
        <StatTile label="Universe" value={`${core} core / ${research} research`} />
        <StatTile
          label="Pricing sidecar"
          value={data.quantUp ? 'Up' : 'Down'}
          tone={data.quantUp ? 'positive' : 'negative'}
        />
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Capture"
          subtitle={data.role === 'runner' ? 'This machine captures chains' : 'Reading a corpus captured elsewhere'}
          action={
            data.role === 'runner' ? (
              <Button size="sm" variant="ghost" onClick={() => void trigger()} disabled={isFetching}>
                <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} /> Run now
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => void pull()} disabled={isFetching}>
                <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} /> Pull now
              </Button>
            )
          }
        />
        {pullError && (
          <div className="flex items-center gap-2 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning">
            <AlertTriangle className="size-3.5 shrink-0" />
            {pullError}
          </div>
        )}
        <div className="grid grid-cols-2 gap-4 p-4 text-xs sm:grid-cols-3">
          <div>
            <div className="text-muted">Next scheduled</div>
            <div className="tnum mt-0.5">
              {nextCapture
                ? nextCapture.toLocaleString(undefined, {
                    weekday: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })
                : '—'}
            </div>
          </div>
          <div>
            <div className="text-muted">Last run</div>
            <div className="mt-0.5">
              {data.lastRun ? (
                <Badge tone={data.lastRun.status === 'failed' ? 'negative' : 'neutral'}>
                  {data.lastRun.status}
                </Badge>
              ) : (
                'Never'
              )}
            </div>
          </div>
          <div>
            <div className="text-muted">Quotes / symbols last run</div>
            <div className="tnum mt-0.5">
              {data.lastRun ? `${data.lastRun.quotesWritten.toLocaleString()} / ${data.lastRun.symbolsDone}` : '—'}
            </div>
          </div>
        </div>
        {data.lastRun && data.lastRun.errors.length > 0 && (
          <div className="border-t border-border px-4 py-3 text-xs text-muted">
            <div className="mb-1 font-medium text-warning">{data.lastRun.errors.length} error(s) last run</div>
            <div className="max-h-24 space-y-0.5 overflow-y-auto font-mono text-[11px]">
              {data.lastRun.errors.slice(0, 20).map((e, i) => (
                <div key={i} className="truncate">
                  {e}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Text sync"
          subtitle="News + EDGAR, market hours — independent of the once-nightly capture above"
          action={
            data.role === 'runner' ? (
              <Button size="sm" variant="ghost" onClick={() => void triggerTextSync()} disabled={isFetching}>
                <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} /> Run now
              </Button>
            ) : undefined
          }
        />
        <div className="grid grid-cols-2 gap-4 p-4 text-xs sm:grid-cols-3">
          <div>
            <div className="text-muted">Next scheduled</div>
            <div className="tnum mt-0.5">
              {nextTextSync
                ? nextTextSync.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
                : '—'}
            </div>
          </div>
          <div>
            <div className="text-muted">Last run</div>
            <div className="mt-0.5">
              {data.lastTextSync ? (
                <Badge tone={data.lastTextSync.errors.length > 0 ? 'warning' : 'neutral'}>
                  {data.lastTextSync.documentsWritten} new doc{data.lastTextSync.documentsWritten === 1 ? '' : 's'}
                </Badge>
              ) : (
                'Never this session'
              )}
            </div>
          </div>
          <div>
            <div className="text-muted">Classified last run</div>
            <div className="tnum mt-0.5">{data.lastTextSync ? data.lastTextSync.classified : '—'}</div>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Daily quotes" subtitle="Most recent captures — a gap here cannot be recovered" />
        {data.days.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs text-muted">
            <Database className="mx-auto mb-2 size-6 text-faint" />
            Nothing captured yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {data.days.map((d) => (
              <div key={d.day} className="flex items-center gap-3 px-4 py-2 text-xs">
                <span className="w-24 font-mono text-muted">{d.day}</span>
                <span className="tnum flex-1">{d.quotes.toLocaleString()} quotes</span>
                <span className="tnum text-muted">{d.liquid.toLocaleString()} liquid</span>
                <span className="tnum text-muted">{d.priced.toLocaleString()} priced</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
