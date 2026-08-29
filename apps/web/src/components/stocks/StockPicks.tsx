import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatMoney, money } from '@org/shared';
import { Badge, Button, Card, CardHeader, Empty, Skeleton, cn } from '../ui';
import { StatTile } from '../charts';
import { e4ToUsd, stocksApi, type StockOrderRow } from '../../lib/optionsApi';
import { ModelPerformance } from '../options/ModelPerformance';

function usd(e4: number): string {
  return formatMoney(money(Math.round(e4ToUsd(e4) * 100), 'USD'));
}

function pct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

const BOOK_LABEL = {
  short: { title: 'Short term', hint: '~1 month horizon · faster turnover, tighter stops' },
  long: { title: 'Long term', hint: '~6 month horizon · wider stops, exits on thesis change' },
} as const;

/**
 * The stock engine has two faces: what the model *recommends* today, and
 * what the book actually *owns*. They deliberately differ — the ranking
 * is raw, the book is that ranking after slots, capital, one-per-symbol
 * and the sector cap have had their say — and showing both makes the
 * constraints visible instead of leaving a reader to wonder why the top
 * pick was skipped.
 */
function PickList({ book }: { book: 'short' | 'long' }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['stock-picks', book],
    queryFn: () => stocksApi.picks(book),
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) return <Skeleton className="h-48" />;
  if (error || !data) {
    return (
      <Empty
        title="No ranking yet"
        hint="The stock model has not produced a board for today — it trains nightly on the runner."
      />
    );
  }

  return (
    <div className="divide-y divide-border">
      {data.picks.map((p) => {
        const stance = data.stances[p.symbol];
        return (
          <div key={p.symbol} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-xs">
            <span className="tnum w-6 text-faint">{p.rank}</span>
            <span className="w-16 font-medium">{p.symbol}</span>
            {/* The model's own units. Showing the implied return instead
                would put a precise-looking "+170%" on a 21-day board
                whose information content is an ordering, not a
                magnitude. */}
            <span className={cn('tnum w-20', (p.forecastSigmas ?? 0) >= 0 ? 'text-positive' : 'text-negative')}>
              {p.forecastSigmas !== null ? `${p.forecastSigmas >= 0 ? '+' : ''}${p.forecastSigmas.toFixed(2)}σ` : '—'}
            </span>
            <span className="tnum w-24 text-muted">
              {p.forecastVol !== null ? `vol ${(p.forecastVol * 100).toFixed(0)}%` : 'vol —'}
            </span>
            {stance ? (
              <Badge
                tone={
                  stance.stance === 'notable'
                    ? 'positive'
                    : stance.stance === 'not_notable'
                      ? 'negative'
                      : 'neutral'
                }
              >
                {stance.stance.replace('_', ' ')}
                {!stance.isToday && ` · ${stance.day.slice(5)}`}
              </Badge>
            ) : (
              <span className="text-faint">no panel read</span>
            )}
            {stance?.summary && <span className="min-w-0 flex-1 truncate text-muted">{stance.summary}</span>}
          </div>
        );
      })}
      <div className="px-4 py-2 text-[11px] text-faint">
        Forecast is stated in each symbol’s own volatility units over {data.horizonDays} trading
        days — the model’s native output. Its <em>ordering</em> is what carries information at this
        signal strength; the magnitude does not. Run {data.modelRunId}.
      </div>
    </div>
  );
}

function PositionRow({ order }: { order: StockOrderRow }) {
  const current = order.exitPriceE4 ?? order.markPriceE4;
  const ret = current === null ? null : ((current - order.entryPriceE4) / order.entryPriceE4) * 100;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-xs">
      <span className="w-16 font-medium">{order.symbol}</span>
      <Badge tone={order.status === 'open' ? 'neutral' : 'accent'}>{order.status}</Badge>
      <span className="tnum text-muted">
        {order.quantity.toFixed(3)} @ {usd(order.entryPriceE4)}
      </span>
      {order.stopPriceE4 !== null && order.status === 'open' && (
        <span className="tnum text-negative">stop {usd(order.stopPriceE4)}</span>
      )}
      {order.targetPriceE4 !== null && order.status === 'open' && (
        <span className="tnum text-positive">target {usd(order.targetPriceE4)}</span>
      )}
      {order.targetExitDate !== null && order.status === 'open' && (
        <span className="text-muted">by {order.targetExitDate}</span>
      )}
      {ret !== null ? (
        <span className={cn('tnum font-medium', ret >= 0 ? 'text-positive' : 'text-negative')}>
          {pct(ret)}
          {order.status === 'open' ? ' unrealized' : ''}
        </span>
      ) : (
        <span className="text-muted">not marked yet</span>
      )}
      {order.exitReason && <span className="text-faint">{order.exitReason.replace(/_/g, ' ')}</span>}
      {order.sector && <span className="text-faint">{order.sector}</span>}
    </div>
  );
}

export function StockPicks() {
  const qc = useQueryClient();
  const [book, setBook] = useState<'short' | 'long'>('short');
  // The three questions this tab answers: what does the model like, is
  // the model any good, and what did the engine actually do about it.
  const [view, setView] = useState<'picks' | 'model' | 'decisions'>('picks');
  const { data: bookData, isLoading } = useQuery({
    queryKey: ['stock-book'],
    queryFn: () => stocksApi.book(),
    refetchInterval: 60_000,
  });
  const cycle = useMutation({
    mutationFn: () => stocksApi.runCycle(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stock-book'] });
      void qc.invalidateQueries({ queryKey: ['stock-picks'] });
    },
  });

  const equity = bookData?.equity;
  const orders = bookData?.orders ?? [];
  const openOrders = orders.filter((o) => o.status === 'open' && o.book === book);
  const closedOrders = orders.filter((o) => o.status === 'closed' && o.book === book);
  const cumulative =
    equity && equity.startingBalanceE4 > 0
      ? ((equity.totalEquityE4 - equity.startingBalanceE4) / equity.startingBalanceE4) * 100
      : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
        <AlertTriangle className="size-3.5 shrink-0" />
        The stock models have not cleared their significance hurdle. Every pick and position below
        acts on a signal that is plausible, not established — and fills are modelled, not executed.
      </div>

      {isLoading || !equity ? (
        <Skeleton className="h-20" />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Starting balance" value={usd(equity.startingBalanceE4)} />
          <StatTile label="Equity now" value={usd(equity.totalEquityE4)} />
          <StatTile label="Cumulative return" value={pct(cumulative)} />
          <StatTile label="Cash" value={usd(equity.cashE4)} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {(['short', 'long'] as const).map((b) => (
          <Button key={b} size="sm" variant={book === b ? 'primary' : 'ghost'} onClick={() => setBook(b)}>
            {BOOK_LABEL[b].title}
          </Button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {(['picks', 'model', 'decisions'] as const).map((v) => (
          <Button key={v} size="sm" variant={view === v ? 'primary' : 'ghost'} onClick={() => setView(v)}>
            {v === 'picks' ? 'Picks & book' : v === 'model' ? 'Model' : 'Decision log'}
          </Button>
        ))}
        <div className="ml-auto">
          <Button size="sm" variant="ghost" onClick={() => cycle.mutate()} disabled={cycle.isPending}>
            {cycle.isPending ? 'Running…' : 'Run cycle'}
          </Button>
        </div>
      </div>

      {view === 'model' && (
        <Card className="overflow-hidden">
          <CardHeader
            title={`${BOOK_LABEL[book].title} model`}
            subtitle="Train and validation loss per fold, and whether the run cleared its hurdle"
          />
          <ModelPerformance target={book === 'short' ? 'stk_short' : 'stk_long'} />
        </Card>
      )}

      {view === 'decisions' && <DecisionLog book={book} />}

      {view === 'picks' && (
        <Card>
          <CardHeader title={`${BOOK_LABEL[book].title} picks`} subtitle={BOOK_LABEL[book].hint} />
          <PickList book={book} />
        </Card>
      )}

      {view === 'picks' && (
      <Card>
        <CardHeader
          title="Positions"
          subtitle="What the book owns — the ranking above, after slots, capital and the sector cap"
        />
        {openOrders.length === 0 && closedOrders.length === 0 ? (
          <Empty title="No positions" hint="The nightly cycle opens these; “Run cycle” does it now." />
        ) : (
          <div className="divide-y divide-border">
            {[...openOrders, ...closedOrders].map((o) => (
              <PositionRow key={o.id} order={o} />
            ))}
          </div>
        )}
      </Card>
      )}
    </div>
  );
}

/**
 * What the engine decided today and which rule was binding. Kept because
 * the answer to "why wasn't that bought" is only useful if it survives
 * the run that produced it.
 */
function DecisionLog({ book }: { book: 'short' | 'long' }) {
  const { data, isLoading } = useQuery({
    queryKey: ['stock-decisions'],
    queryFn: () => stocksApi.decisions(),
    refetchInterval: 60_000,
  });
  if (isLoading) return <Skeleton className="h-48" />;
  const rows = (data?.decisions ?? []).filter((d) => d.book === book);
  if (rows.length === 0) {
    return <Empty title="No decisions logged today" hint="The nightly cycle writes these; “Run cycle” does it now." />;
  }
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.reason] = (acc[r.reason] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <Card>
      <CardHeader
        title={`${BOOK_LABEL[book].title} decision log`}
        subtitle={`${data?.day} · ${rows.length} decisions · binding rules: ${Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([r, n]) => `${r.replace(/_/g, ' ')} ${n}`)
          .join(', ')}`}
      />
      <div className="divide-y divide-border">
        {rows.map((d) => (
          <div key={d.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-xs">
            <span className="w-16 font-medium">{d.symbol}</span>
            <Badge
              tone={d.decision === 'opened' ? 'positive' : d.decision === 'exited' ? 'negative' : 'neutral'}
            >
              {d.decision}
            </Badge>
            <span className="text-muted">{d.reason.replace(/_/g, ' ')}</span>
            {d.panelStance && <span className="text-faint">panel: {d.panelStance.replace('_', ' ')}</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}
