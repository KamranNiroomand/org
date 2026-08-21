import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, TrendingUp, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatMoney, money, parseMoney } from '@org/shared';
import { AllocationBars, StatTile } from '../components/charts';
import { MarketMap } from '../components/MarketMap';
import { OptionsTab } from '../components/options/OptionsTab';
import { WatchlistTab } from '../components/watchlist/WatchlistTab';
import { Page, PageHeader } from '../components/PageHeader';
import { Badge, Button, Card, CardHeader, Empty, Input, Skeleton, cn } from '../components/ui';
import { api, type PortfolioResponse } from '../lib/api';
import { useSettings } from '../lib/settings';

type Tab = 'market' | 'portfolio' | 'options' | 'watchlist' | 'screener';

const TABS: Array<[Tab, string]> = [
  ['market', 'Market'],
  ['portfolio', 'Portfolio'],
  ['options', 'Options'],
  ['watchlist', 'Watchlist'],
  ['screener', 'Screener'],
];

/** Reserved so the shell is right; screener isn't built yet. */
function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <Card className="overflow-hidden">
      <Empty icon={<TrendingUp className="size-7" />} title={title} hint={hint} />
    </Card>
  );
}

export function InvestmentsPage() {
  const [tab, setTab] = useState<Tab>('market');
  const { baseCurrency } = useSettings();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ symbol: '', quantity: '', avgCost: '', currency: 'CAD' });

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api.get<PortfolioResponse>('/api/portfolio'),
  });

  const add = useMutation({
    mutationFn: () => {
      const cost = parseMoney(form.avgCost, form.currency);
      return api.post('/api/holdings', {
        symbol: form.symbol.trim().toUpperCase(),
        quantity: Number(form.quantity),
        avgCost: cost?.cents ?? 0,
        currency: form.currency,
      });
    },
    onSuccess: () => {
      setForm({ symbol: '', quantity: '', avgCost: '', currency: 'CAD' });
      setAdding(false);
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/holdings/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['portfolio'] }),
  });

  const t = data?.totals;
  const m = (cents: number) => formatMoney(money(cents, baseCurrency));

  const allocation =
    data?.holdings
      .filter((h) => h.marketValueBase !== null)
      .map((h) => ({ symbol: h.symbol, value: h.marketValueBase! }))
      .sort((a, b) => b.value - a.value) ?? [];

  return (
    <>
      <PageHeader
        title="Investments"
        subtitle={
          data?.usdCad
            ? `USD/CAD ${data.usdCad.toFixed(4)} · Bank of Canada`
            : 'Prices from Yahoo Finance'
        }
        actions={
          tab === 'portfolio' ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => void refetch()} disabled={isFetching}>
                <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
              </Button>
              <Button size="sm" variant="primary" onClick={() => setAdding((v) => !v)}>
                <Plus className="size-3.5" /> Holding
              </Button>
            </>
          ) : null
        }
      />

      <Page>
        <div className="mb-4 flex gap-1 border-b border-border">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                tab === key
                  ? 'border-accent text-text'
                  : 'border-transparent text-muted hover:text-text',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'market' && <MarketMap />}

        {tab === 'options' && <OptionsTab />}

        {tab === 'watchlist' && <WatchlistTab />}

        {tab === 'screener' && (
          <Placeholder
            title="Screener"
            hint="Reserved for saved filters across the index — value, yield, growth. Not built yet."
          />
        )}

        {tab === 'portfolio' && (
          <>
          {adding && (
            <Card className="mb-4 p-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  add.mutate();
                }}
                className="flex flex-wrap items-end gap-2"
              >
                <label className="flex-1 text-xs">
                  <span className="mb-1 block text-muted">Symbol</span>
                  <Input
                    value={form.symbol}
                    onChange={(e) => setForm({ ...form, symbol: e.target.value })}
                    placeholder="VFV.TO"
                    required
                  />
                </label>
                <label className="flex-1 text-xs">
                  <span className="mb-1 block text-muted">Quantity</span>
                  <Input
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                    placeholder="40"
                    inputMode="decimal"
                    required
                  />
                </label>
                <label className="flex-1 text-xs">
                  <span className="mb-1 block text-muted">Avg cost / share</span>
                  <Input
                    value={form.avgCost}
                    onChange={(e) => setForm({ ...form, avgCost: e.target.value })}
                    placeholder="152.00"
                    inputMode="decimal"
                    required
                  />
                </label>
                <label className="w-24 text-xs">
                  <span className="mb-1 block text-muted">Currency</span>
                  <select
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm"
                  >
                    <option>CAD</option>
                    <option>USD</option>
                  </select>
                </label>
                <Button type="submit" variant="primary" disabled={add.isPending}>
                  Add
                </Button>
              </form>
              <p className="mt-2 text-[11px] text-muted">
                TSX symbols take a <code className="font-mono">.TO</code> suffix — VFV.TO, SHOP.TO.
              </p>
            </Card>
          )}

          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Market value" value={m(t?.marketValue ?? 0)} />
            <StatTile label="Cost basis" value={m(t?.costBasis ?? 0)} />
            <StatTile
              label="Unrealized"
              value={m(t?.unrealizedPL ?? 0)}
              tone={(t?.unrealizedPL ?? 0) >= 0 ? 'positive' : 'negative'}
            />
            <StatTile
              label="Return"
              value={`${(t?.unrealizedPLPercent ?? 0) >= 0 ? '+' : ''}${(t?.unrealizedPLPercent ?? 0).toFixed(2)}%`}
              tone={(t?.unrealizedPLPercent ?? 0) >= 0 ? 'positive' : 'negative'}
            />
          </div>

          {data && t?.pricedCount !== undefined && t.pricedCount < (t.totalCount ?? 0) && (
            <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              {(t.totalCount ?? 0) - t.pricedCount} holding(s) could not be converted to{' '}
              {baseCurrency} and are excluded from the totals — the figures above understate the
              portfolio rather than mixing currencies.
            </div>
          )}

          {data && data.stale.length > 0 && (
            <div className="mb-4 rounded-lg border border-border bg-bg-subtle px-3 py-2 text-xs text-muted">
              Showing last known prices for {data.stale.join(', ')} — the live quote lookup failed.
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Card className="overflow-hidden">
              <CardHeader title="Holdings" />
              {isLoading ? (
                <Skeleton className="m-4 h-40" />
              ) : data?.holdings.length === 0 ? (
                <Empty
                  icon={<TrendingUp className="size-7" />}
                  title="No holdings yet"
                  hint="Add a position to track its value and unrealized gain."
                  action={
                    <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
                      <Plus className="size-3.5" /> Add holding
                    </Button>
                  }
                />
              ) : (
                <div className="divide-y divide-border">
                  {data?.holdings.map((h) => (
                    <div key={h.id} className="group flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-medium">{h.symbol}</span>
                          {h.currency !== baseCurrency && <Badge>{h.currency}</Badge>}
                        </div>
                        <div className="tnum text-xs text-muted">
                          {h.quantity} @ {formatMoney(money(h.avgCost, h.currency))}
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="tnum text-sm">
                          {h.price !== null
                            ? formatMoney(money(h.price, h.priceCurrency ?? h.currency))
                            : '—'}
                        </div>
                        {h.dayChangePercent !== null && (
                          <div
                            className={cn(
                              'tnum text-[11px]',
                              h.dayChangePercent >= 0 ? 'text-positive' : 'text-negative',
                            )}
                          >
                            {h.dayChangePercent >= 0 ? '+' : ''}
                            {h.dayChangePercent.toFixed(2)}%
                          </div>
                        )}
                      </div>

                      <div className="w-28 text-right">
                        <div className="tnum text-sm font-medium">
                          {h.marketValue !== null
                            ? formatMoney(money(h.marketValue, h.priceCurrency ?? h.currency))
                            : '—'}
                        </div>
                        {h.unrealizedPLPercent !== null && (
                          <div
                            className={cn(
                              'tnum text-[11px]',
                              h.unrealizedPL! >= 0 ? 'text-positive' : 'text-negative',
                            )}
                          >
                            {h.unrealizedPL! >= 0 ? '+' : ''}
                            {h.unrealizedPLPercent.toFixed(1)}%
                          </div>
                        )}
                      </div>

                      <button
                        onClick={() => remove.mutate(h.id)}
                        className="rounded p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-negative"
                        aria-label={`Remove ${h.symbol}`}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="overflow-hidden">
              <CardHeader title="Allocation" subtitle={`by market value in ${baseCurrency}`} />
              {allocation.length === 0 ? (
                <p className="px-4 py-10 text-center text-xs text-muted">Nothing to allocate yet.</p>
              ) : (
                <AllocationBars data={allocation} currency={baseCurrency} />
              )}
            </Card>
          </div>
          </>
        )}
      </Page>
    </>
  );
}
