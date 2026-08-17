import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarPlus, Link2, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, CardHeader, Empty, cn } from './ui';
import { api } from '../lib/api';

interface Feed {
  id: string;
  name: string;
  color: string;
  status: 'ok' | 'error';
  error: string | null;
  lastSyncAt: string | null;
  eventCount: number;
}

interface SyncOutcome {
  name: string;
  added: number;
  updated: number;
  removed: number;
  error: string | null;
}

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function CalendarFeeds() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const { data: feeds } = useQuery({
    queryKey: ['calendar-feeds'],
    queryFn: () => api.get<Feed[]>('/api/calendar/feeds'),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['calendar-feeds'] });
    void qc.invalidateQueries({ queryKey: ['calendar'] });
  };

  const add = useMutation({
    mutationFn: () =>
      api.post<{ feedId: string; sync: SyncOutcome }>('/api/calendar/feeds', {
        name: name.trim(),
        url: url.trim(),
      }),
    onSuccess: (r) => {
      // The URL is a credential; drop it from component state the moment the
      // server has it, so it isn't sitting in memory behind a closed form.
      setUrl('');
      setName('');
      setAdding(false);
      setNotice(
        r.sync.error
          ? `Added, but the first sync failed: ${r.sync.error}`
          : `Added — pulled ${r.sync.added} events.`,
      );
      refresh();
    },
    onError: (e) => setNotice((e as Error).message),
  });

  const sync = useMutation({
    mutationFn: (feedId?: string) => api.post<SyncOutcome[]>('/api/calendar/feeds/sync', { feedId }),
    onSuccess: (rows) => {
      const added = rows.reduce((s, r) => s + r.added, 0);
      const errors = rows.filter((r) => r.error);
      setNotice(
        errors.length > 0
          ? errors.map((r) => `${r.name}: ${r.error}`).join(' · ')
          : `Synced — ${added} new event${added === 1 ? '' : 's'}.`,
      );
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/calendar/feeds/${id}`),
    onSuccess: refresh,
  });

  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader
        title="Subscribed calendars"
        subtitle={feeds?.length ? `${feeds.length} connected` : 'Google and Outlook, read-only'}
        action={
          <div className="flex items-center gap-1.5">
            {feeds && feeds.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => sync.mutate(undefined)}
                disabled={sync.isPending}
              >
                <RefreshCw className={cn('size-3.5', sync.isPending && 'animate-spin')} />
                {sync.isPending ? 'Syncing…' : 'Sync now'}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => setAdding((v) => !v)}>
              <CalendarPlus className="size-3.5" /> Add
            </Button>
          </div>
        }
      />

      {notice && (
        <div className="border-b border-border bg-bg-subtle px-4 py-2 text-xs text-muted">
          {notice}
        </div>
      )}

      {adding && (
        <div className="space-y-2 border-b border-border px-4 py-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name — e.g. Gmail (personal)"
            className="h-8 w-full rounded-lg border border-border bg-panel px-2 text-xs"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="password"
            placeholder="Secret iCal address (https://… or webcal://…)"
            className="h-8 w-full rounded-lg border border-border bg-panel px-2 font-mono text-xs"
          />
          <p className="text-[11px] leading-relaxed text-faint">
            Google Calendar → Settings → your calendar → Integrate calendar → <em>Secret address in
            iCal format</em>. Outlook → Settings → Calendar → Shared calendars → Publish a calendar →
            ICS link. Treat it like a password: anyone with the URL can read the calendar.
          </p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="primary"
              onClick={() => add.mutate()}
              disabled={add.isPending || !name.trim() || !url.trim()}
            >
              {add.isPending ? 'Checking…' : 'Add calendar'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {feeds?.length === 0 && !adding ? (
        <Empty
          icon={<Link2 className="size-7" />}
          title="No calendars subscribed"
          hint="Add a Google or Outlook iCal address and Org pulls its events in every night."
        />
      ) : (
        <div className="divide-y divide-border">
          {feeds?.map((f) => (
            <div key={f.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: `var(--color-${f.color}, currentColor)` }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{f.name}</div>
                <div className="text-xs text-muted">
                  {f.eventCount} event{f.eventCount === 1 ? '' : 's'} · synced {relative(f.lastSyncAt)}
                </div>
                {f.status === 'error' && f.error && (
                  <div className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                    <AlertTriangle className="mt-px size-3 shrink-0" />
                    <span>{f.error}</span>
                  </div>
                )}
              </div>
              {f.status === 'error' && <Badge tone="warning">error</Badge>}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => sync.mutate(f.id)}
                disabled={sync.isPending}
                aria-label={`Sync ${f.name}`}
              >
                <RefreshCw className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove.mutate(f.id)}
                aria-label={`Remove ${f.name}`}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
