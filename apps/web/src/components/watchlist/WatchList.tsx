import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, CardHeader, Empty, Input, Skeleton, cn } from '../ui';
import { api, type WatchlistRow } from '../../lib/api';

/** Symbols followed without a position — add/remove and a live price glance. */
export function WatchList() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [symbol, setSymbol] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['watchlist'],
    queryFn: () => api.get<WatchlistRow[]>('/api/watchlist'),
  });

  const add = useMutation({
    mutationFn: () => api.post('/api/watchlist', { symbol: symbol.trim().toUpperCase() }),
    onSuccess: () => {
      setSymbol('');
      setAdding(false);
      void qc.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });

  const remove = useMutation({
    mutationFn: (s: string) => api.del(`/api/watchlist/${s}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Watching"
        action={
          <Button size="sm" variant="primary" onClick={() => setAdding((v) => !v)}>
            <Plus className="size-3.5" /> Symbol
          </Button>
        }
      />

      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (symbol.trim()) add.mutate();
          }}
          className="flex items-end gap-2 border-b border-border p-3"
        >
          <label className="flex-1 text-xs">
            <span className="mb-1 block text-muted">Symbol</span>
            <Input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="MRNA"
              autoFocus
              required
            />
          </label>
          <Button type="submit" variant="primary" disabled={add.isPending}>
            Add
          </Button>
        </form>
      )}

      {isLoading ? (
        <Skeleton className="m-4 h-40" />
      ) : data?.length === 0 ? (
        <Empty
          icon={<Star className="size-7" />}
          title="Nothing on the watchlist yet"
          hint="Add a symbol to follow it — you'll see it here, and it feeds into news signals once you have some."
          action={
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" /> Add symbol
            </Button>
          }
        />
      ) : (
        <div className="divide-y divide-border">
          {data?.map((w) => (
            <div key={w.symbol} className="group flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{w.symbol}</span>
                  {w.currency && <Badge>{w.currency}</Badge>}
                </div>
                {w.name && <div className="truncate text-xs text-muted">{w.name}</div>}
              </div>

              <div className="text-right">
                {/* instruments.price is a whole-dollar float, not minor units
                    — money()/formatMoney() expect integer cents and would
                    throw. MarketMap.tsx formats this same field the same way. */}
                <div className="tnum text-sm">{w.price !== null ? `$${w.price.toFixed(2)}` : '—'}</div>
                {w.dayChangePercent !== null && (
                  <div className={cn('tnum text-[11px]', w.dayChangePercent >= 0 ? 'text-positive' : 'text-negative')}>
                    {w.dayChangePercent >= 0 ? '+' : ''}
                    {w.dayChangePercent.toFixed(2)}%
                  </div>
                )}
              </div>

              <button
                onClick={() => remove.mutate(w.symbol)}
                className="rounded p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-negative"
                aria-label={`Remove ${w.symbol} from the watchlist`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
