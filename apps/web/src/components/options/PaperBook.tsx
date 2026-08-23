import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatMoney, money } from '@org/shared';
import { Badge, Button, Card, CardHeader, Empty, Input, Skeleton, cn } from '../ui';
import { StatTile } from '../charts';
import { e4ToUsd, optionsApi, type PaperOrder } from '../../lib/optionsApi';

/**
 * Artificial money, real accounting.
 *
 * Positions opened from the Signals tab and positions typed in by hand below
 * both land here, distinguished only by the `manual`/`model` badge on each
 * row — the form below stays for a symbol the ranked board didn't surface.
 *
 * Two returns are shown everywhere money moves, deliberately: the
 * account-level return (this screen's headline number) and each trade's own
 * return (in the table). They answer different questions — a trade risking
 * 2% of the account that doubles is a 2% account day, not a 100% one — and
 * collapsing them into one figure would hide exactly the distinction that
 * "5% a day" turned out to need spelling out.
 */

function usd(e4: number): string {
  return formatMoney(money(Math.round(e4ToUsd(e4) * 100), 'USD'));
}

function pct(value: number | null, digits = 2): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function EquityTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  label?: string;
}) {
  if (!active || !payload?.length || payload[0]?.value === undefined) return null;
  return (
    <div className="rounded-lg border border-border bg-panel px-2.5 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium">{label}</div>
      <span className="tnum font-medium">{formatMoney(money(Math.round(payload[0].value * 100), 'USD'))}</span>
    </div>
  );
}

function EquityChart({ points }: { points: Array<{ day: string; equity: number }> }) {
  if (points.length < 2) {
    return (
      <div className="flex h-56 items-center justify-center text-xs text-muted">
        Needs at least two marked days to draw a curve.
      </div>
    );
  }
  return (
    <div className="h-56 px-2 pt-3">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ left: 4, right: 12, top: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="paperEquityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
          <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--color-muted)' }} tickLine={false} axisLine={false} />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
            tickLine={false}
            axisLine={false}
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
          />
          <Tooltip content={<EquityTooltip />} />
          <Area type="monotone" dataKey="equity" stroke="var(--color-accent)" fill="url(#paperEquityFill)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function OpenOrderForm({ onOpened }: { onOpened: () => void }) {
  const [occSymbol, setOccSymbol] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [entryPrice, setEntryPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const open = useMutation({
    mutationFn: () =>
      optionsApi.openOrder({
        occSymbol: occSymbol.trim().toUpperCase(),
        quantity: Number(quantity),
        entryPriceE4: entryPrice.trim() ? Math.round(Number(entryPrice) * 10_000) : undefined,
      }),
    onSuccess: () => {
      setOccSymbol('');
      setQuantity('1');
      setEntryPrice('');
      setError(null);
      onOpened();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Card className="p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          open.mutate();
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="min-w-[220px] flex-1 text-xs">
          <span className="mb-1 block text-muted">OCC symbol</span>
          <Input
            value={occSymbol}
            onChange={(e) => setOccSymbol(e.target.value)}
            placeholder="NVDA  260819C00227500"
            className="font-mono"
            required
          />
        </label>
        <label className="w-24 text-xs">
          <span className="mb-1 block text-muted">Contracts</span>
          <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="numeric" required />
        </label>
        <label className="w-32 text-xs">
          <span className="mb-1 block text-muted">Entry price</span>
          <Input
            value={entryPrice}
            onChange={(e) => setEntryPrice(e.target.value)}
            placeholder="1.14 (ask)"
            inputMode="decimal"
          />
        </label>
        <Button type="submit" variant="primary" disabled={open.isPending}>
          Open (long)
        </Button>
      </form>
      <p className="mt-2 text-[11px] text-muted">
        Long only — a short's loss and margin requirement aren't modelled yet. Leave entry price
        blank once real quotes exist to fill at the captured ask automatically.
      </p>
      {error && <p className="mt-2 text-[11px] text-negative">{error}</p>}
    </Card>
  );
}

function OrderRow({ order, onClosed }: { order: PaperOrder; onClosed: () => void }) {
  const [exitPrice, setExitPrice] = useState('');
  const close = useMutation({
    mutationFn: () =>
      optionsApi.closeOrder(order.id, exitPrice.trim() ? Math.round(Number(exitPrice) * 10_000) : undefined),
    onSuccess: onClosed,
  });

  const current = order.exitPriceE4 ?? order.entryPriceE4;
  const tradeReturn = ((current - order.entryPriceE4) / order.entryPriceE4) * 100;

  const autoManaged = order.targetExitPriceE4 !== null;

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono">{order.occSymbol}</span>
          <Badge tone={order.status === 'open' ? 'accent' : 'neutral'}>{order.status}</Badge>
          <Badge tone={autoManaged ? 'accent' : 'neutral'}>{autoManaged ? 'auto-managed' : order.source}</Badge>
        </div>
        <div className="tnum mt-0.5 text-muted">
          {order.quantity} @ {usd(order.entryPriceE4)}
          {order.entryBasis === 'modelled' && ' · estimated'}
        </div>
        {autoManaged && order.status === 'open' && (
          <div className="tnum mt-0.5 text-muted">
            target {usd(order.targetExitPriceE4!)} · stop {usd(order.stopLossPriceE4!)} · by{' '}
            {order.targetExitDate}
          </div>
        )}
      </div>
      <div className="tnum text-right">
        <div className={cn('font-medium', tradeReturn >= 0 ? 'text-positive' : 'text-negative')}>
          {order.exitPriceE4 !== null ? pct(tradeReturn) : `${pct(tradeReturn)} unrealized`}
        </div>
        {order.exitPriceE4 !== null && (
          <div className="text-muted">
            exit {usd(order.exitPriceE4)}
            {order.exitBasis === 'modelled' && ' · estimated'}
          </div>
        )}
      </div>
      {order.status === 'open' && (
        <div className="flex items-center gap-1.5">
          <Input
            value={exitPrice}
            onChange={(e) => setExitPrice(e.target.value)}
            placeholder="bid"
            className="h-7 w-16 text-xs"
            inputMode="decimal"
          />
          <Button size="sm" variant="secondary" onClick={() => close.mutate()} disabled={close.isPending}>
            Close
          </Button>
        </div>
      )}
      {order.status === 'open' && <PositionHealthLine health={order.health} />}
      {autoManaged && order.exitRevisions.length > 0 && <ExitRevisionTimeline revisions={order.exitRevisions} />}
    </div>
  );
}

/**
 * Why the exit target moved, not just its current value — one line per
 * revision, newest first, in the same plain-text "show your work" style as
 * `PositionHealthLine` and the multi-agent panel's own transcript.
 */
function ExitRevisionTimeline({ revisions }: { revisions: PaperOrder['exitRevisions'] }) {
  return (
    <div className="tnum flex w-full flex-col gap-1 border-t border-border/60 pt-1.5 text-[11px] text-muted">
      {revisions.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-x-2">
          <Badge tone={r.triggeredBy === 'llm' ? 'warning' : 'neutral'}>{r.triggeredBy}</Badge>
          <span>
            target {r.oldTargetExitPriceE4 !== null ? usd(r.oldTargetExitPriceE4) : '—'} →{' '}
            {r.newTargetExitPriceE4 !== null ? usd(r.newTargetExitPriceE4) : '—'}
          </span>
          <span className="truncate">{r.reason}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Today's re-evaluation of an open position — the model's forecast recomputed
 * against today's data, plus any real news since the position opened. A
 * static "the model liked this when you opened it" snapshot is a bad model
 * of how a real day goes; this is what changed since then. Never null-vs-
 * hidden: a `health` of `null` means the nightly job hasn't scored this
 * position yet, and `currentEv === null` inside a real health row means the
 * model itself has no current view (expired, no quote) — both are shown
 * plainly rather than left blank.
 */
function PositionHealthLine({ health }: { health: PaperOrder['health'] }) {
  if (!health) {
    return <div className="w-full text-[11px] text-muted">Not checked yet — runs nightly, or click "Check health" above.</div>;
  }
  return (
    <div className="tnum flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-1.5 text-[11px] text-muted">
      <span>As of {health.day}:</span>
      {health.currentEv !== null ? (
        <span className={cn('font-medium', health.currentEv >= 0 ? 'text-positive' : 'text-negative')}>
          model now sees {usd(Math.round(health.currentEv * 10_000))} EV
          {health.currentProbProfit !== null && `, ${(health.currentProbProfit * 100).toFixed(0)}% P(profit)`}
        </span>
      ) : (
        <span>model has no current view (expired or no quote today)</span>
      )}
      {health.newDocumentsCount > 0 ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <Badge tone="warning">
            {health.newDocumentsCount} new doc{health.newDocumentsCount === 1 ? '' : 's'}
          </Badge>
          {health.latestDocumentTitle && <span className="truncate">{health.latestDocumentTitle}</span>}
        </span>
      ) : (
        <span>no new news</span>
      )}
    </div>
  );
}

export function PaperBook() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['paper-equity'],
    queryFn: () => optionsApi.paperEquity(),
    refetchInterval: 60_000,
  });
  // Whether the signal behind every auto-managed order below has actually
  // demonstrated an edge — see rank.py's own module docstring on why this
  // fact must travel with the numbers, not be buried in a README.
  const { data: runs } = useQuery({ queryKey: ['model-runs', 'dir'], queryFn: () => optionsApi.modelRuns('dir') });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['paper-equity'] });
  const mark = useMutation({ mutationFn: () => optionsApi.markNow(), onSuccess: invalidate });
  const checkHealth = useMutation({ mutationFn: () => optionsApi.checkHealthNow(), onSuccess: invalidate });
  const exitRecheck = useMutation({ mutationFn: () => optionsApi.exitRecheckNow(), onSuccess: invalidate });

  if (isLoading) return <Skeleton className="h-64" />;
  if (!data) return null;

  const last = data.equity.at(-1);
  const open = data.orders.filter((o) => o.status === 'open');
  const closed = data.orders.filter((o) => o.status === 'closed');
  const points = data.equity.map((e) => ({ day: e.day.slice(5), equity: e4ToUsd(e.totalEquityE4) }));
  const autoManagedOpen = open.some((o) => o.targetExitPriceE4 !== null);
  const latestRun = runs?.[0];
  const modelBeatsBaseline = latestRun?.metrics?.beats_baseline ?? null;

  return (
    <div className="space-y-4">
      {autoManagedOpen && modelBeatsBaseline === false && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="size-3.5 shrink-0" />
          The model behind your auto-managed positions ({latestRun!.runId}) does not beat its own
          out-of-fold baseline — every entry and exit below is acting on an unproven signal, not a
          validated one.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Starting balance" value={usd(data.startingBalanceE4)} />
        <StatTile
          label="Equity now"
          value={last ? usd(last.totalEquityE4) : usd(data.startingBalanceE4)}
          tone={last && last.cumulativeReturnPct >= 0 ? 'positive' : last ? 'negative' : 'neutral'}
        />
        <StatTile
          label="Cumulative return"
          value={last ? pct(last.cumulativeReturnPct) : pct(0)}
          tone={last && last.cumulativeReturnPct >= 0 ? 'positive' : last ? 'negative' : 'neutral'}
        />
        <StatTile label="Open / closed" value={`${open.length} / ${closed.length}`} />
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Equity curve"
          subtitle="Account-level — marked nightly at the conservative side of the market"
          action={
            <Button size="sm" variant="ghost" onClick={() => mark.mutate()} disabled={mark.isPending}>
              Mark now
            </Button>
          }
        />
        <EquityChart points={points} />
      </Card>

      <OpenOrderForm onOpened={invalidate} />

      <Card className="overflow-hidden">
        <CardHeader
          title="Positions"
          subtitle="Per-trade return — distinct from the account-level curve above"
          action={
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => checkHealth.mutate()} disabled={checkHealth.isPending}>
                Check health
              </Button>
              <Button size="sm" variant="ghost" onClick={() => exitRecheck.mutate()} disabled={exitRecheck.isPending}>
                Exit recheck
              </Button>
            </div>
          }
        />
        {data.orders.length === 0 ? (
          <Empty title="No paper trades yet" hint="Open one above with an OCC symbol from a captured chain." />
        ) : (
          <div className="divide-y divide-border">
            {data.orders.map((o) => (
              <OrderRow key={o.id} order={o} onClosed={invalidate} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
