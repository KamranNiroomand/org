import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Empty, Skeleton, cn } from '../ui';
import { api, type SignalEvent } from '../../lib/api';

/**
 * The fired-alert feed — every price/momentum (and, once wired, news) alert
 * that has fired, grouped by whether it's on something you own, something
 * you're watching, or a name the market-wide scan surfaced on its own. The
 * server already returns rows sorted holdings-first, newest-first within
 * each group — this component just draws the group boundaries.
 */

const GROUPS: Array<[SignalEvent['context'], string]> = [
  ['holding', 'Holdings'],
  ['watchlist', 'Watchlist'],
  ['unwatched', 'Market-wide'],
];

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Row({ event, onAck }: { event: SignalEvent; onAck: (id: string) => void }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3',
        event.context === 'holding' && !event.acknowledged && 'bg-warning/5',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{event.symbol}</span>
          <Badge tone={event.context === 'holding' ? 'warning' : 'neutral'}>{event.context}</Badge>
        </div>
        <div className="mt-0.5 text-xs text-muted">{event.headline}</div>
      </div>
      <div className="shrink-0 text-right text-[11px] text-faint">{relative(event.triggeredAt)}</div>
      {!event.acknowledged && (
        <button
          onClick={() => onAck(event.id)}
          className="shrink-0 rounded p-1 text-faint hover:text-text"
          aria-label={`Acknowledge ${event.symbol} alert`}
        >
          <Check className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function AlertFeed() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['signals'],
    queryFn: () => api.get<SignalEvent[]>('/api/signals'),
  });

  const evaluate = useMutation({
    mutationFn: () => api.post('/api/signals/evaluate'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['signals'] }),
  });

  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/api/signals/${id}/ack`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['signals'] }),
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Alerts"
        subtitle="Price moves, volume spikes, and 52-week highs/lows across everything tracked"
        action={
          <Button size="sm" variant="ghost" onClick={() => evaluate.mutate()} disabled={evaluate.isPending}>
            <RefreshCw className={cn('size-3.5', evaluate.isPending && 'animate-spin')} /> Check now
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="m-4 h-40" />
      ) : !data || data.length === 0 ? (
        <Empty title="No alerts yet" hint="They'll show up here once a tracked symbol makes a real move." />
      ) : (
        GROUPS.map(([context, label]) => {
          const rows = data.filter((e) => e.context === context);
          if (rows.length === 0) return null;
          return (
            <div key={context} className="border-b border-border last:border-b-0">
              <div className="bg-bg-subtle px-4 py-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
                {label}
              </div>
              <div className="divide-y divide-border">
                {rows.map((event) => (
                  <Row key={event.id} event={event} onAck={(id) => ack.mutate(id)} />
                ))}
              </div>
            </div>
          );
        })
      )}
    </Card>
  );
}
