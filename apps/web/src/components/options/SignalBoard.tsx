import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatMoney, money } from '@org/shared';
import { Badge, Button, Card, CardHeader, Empty, Input, Skeleton, cn } from '../ui';
import { StatTile } from '../charts';
import { optionsApi, type RankedContract } from '../../lib/optionsApi';
import { ApiError } from '../../lib/api';

/**
 * The ranked signal board: every gate-passing contract for one trading day,
 * priced under the current model's forecast and sorted by expected value.
 *
 * The model does not beat its own out-of-fold baseline yet (see
 * `services/quant/app/rank.py`'s module docstring) — that fact is fetched
 * and rendered every time, not hidden behind a refusal, because the whole
 * point of this screen is to watch the system's real behaviour and judge it
 * honestly, not to pretend a demonstrated edge exists before one does.
 */

function usd(dollars: number): string {
  return formatMoney(money(Math.round(dollars * 100), 'USD'));
}

function pct(value: number, digits = 1): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// Every option contract covers 100 shares — matches rank.py's own
// DEFAULT_MULTIPLIER. `market_price` from the API is quoted per share, which
// reads as far cheaper than what buying one contract actually costs; this is
// the number that answers "how much do I actually spend".
const CONTRACT_MULTIPLIER = 100;

function contractCost(contract: RankedContract): number {
  return contract.market_price * CONTRACT_MULTIPLIER;
}

function SignalRow({ contract, onOpened }: { contract: RankedContract; onOpened: () => void }) {
  const [quantity, setQuantity] = useState('1');
  const [opened, setOpened] = useState(false);
  const open = useMutation({
    mutationFn: () =>
      optionsApi.openOrder({
        occSymbol: contract.occ_symbol,
        quantity: Number(quantity),
        // The current data plan carries no bid/ask entitlement (see
        // option_quotes.bidE4's doc comment in schema.ts) — openOrder's
        // auto-fetched-ask path never has anything to find, so this passes
        // the contract's own market_price explicitly, the same number
        // already shown in this row. It fills as `modelled`, not
        // `measured`, and the equity curve reports that distinction
        // honestly rather than silently.
        entryPriceE4: Math.round(contract.market_price * 10_000),
        source: 'model',
      }),
    onSuccess: () => {
      setOpened(true);
      onOpened();
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono">{contract.occ_symbol}</span>
          <Badge tone={contract.type === 'call' ? 'positive' : 'negative'}>{contract.type}</Badge>
          <span className="tnum text-muted">{contract.dte}d</span>
        </div>
        <div className="tnum mt-0.5 text-muted">
          {contract.underlying} strike {usd(contract.strike)} · costs {usd(contractCost(contract))}
          <span className="text-faint"> ({usd(contract.market_price)}/share)</span>
          {contract.market_iv !== null && ` · IV ${(contract.market_iv * 100).toFixed(0)}%`}
        </div>
      </div>

      <div className="tnum w-28 text-right">
        <div className={cn('font-medium', contract.ev >= 0 ? 'text-positive' : 'text-negative')}>{usd(contract.ev)} EV</div>
        <div className="text-muted">{pct(contract.ev_per_risk)} of risk</div>
      </div>

      <div className="tnum w-20 text-right text-muted">P(profit)&nbsp;{(contract.prob_profit * 100).toFixed(0)}%</div>

      {opened ? (
        <Badge tone="accent">opened</Badge>
      ) : (
        <div className="flex items-center gap-1.5">
          <Input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="h-7 w-14 text-xs"
            inputMode="numeric"
          />
          <Button size="sm" variant="secondary" onClick={() => open.mutate()} disabled={open.isPending}>
            Open
          </Button>
        </div>
      )}
      {open.isError && <p className="w-full text-[11px] text-negative">{(open.error as Error).message}</p>}
    </div>
  );
}

export function SignalBoard() {
  const qc = useQueryClient();
  // `null` means "not yet chosen" — defaults to the corpus's own latest
  // captured day below, not today, because tonight's capture usually
  // hasn't run yet when this loads and today would just be empty.
  const [day, setDay] = useState<string | null>(null);
  // Filters out any contract costing more than this to buy one of — the
  // ranked list is sorted by *absolute* dollar EV, which structurally
  // favours expensive contracts (EV scales with the same 100-share
  // multiplier the cost does), so without this an affordable contract
  // would rarely make the top 25 regardless of how good a deal it is
  // relative to its own cost. Empty string means "no cap".
  const [maxCapital, setMaxCapital] = useState('200');

  const { data: status } = useQuery({
    queryKey: ['options-status'],
    queryFn: () => optionsApi.status(),
  });
  const effectiveDay = day ?? status?.totals.lastDay ?? todayKey();
  const maxCapitalNum = maxCapital.trim() ? Number(maxCapital) : undefined;

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['quant-rank', effectiveDay, maxCapitalNum],
    queryFn: () => optionsApi.rank(effectiveDay, 25, maxCapitalNum),
    retry: false,
  });

  const onOpened = () => void qc.invalidateQueries({ queryKey: ['paper-equity'] });

  const refusal = error instanceof ApiError ? error : null;

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader
          title="Ranked signal board"
          subtitle="Every gate-passing contract for one day, priced under the current forecast and sorted by expected value"
          action={
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-muted">
                Max $/contract
                <Input
                  value={maxCapital}
                  onChange={(e) => setMaxCapital(e.target.value)}
                  placeholder="No limit"
                  inputMode="decimal"
                  className="h-7 w-20 text-xs"
                />
              </label>
              <Input
                type="date"
                value={effectiveDay}
                onChange={(e) => setDay(e.target.value)}
                className="h-7 w-36 text-xs"
              />
              <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
                Refresh
              </Button>
            </div>
          }
        />

        {data && (
          <div className="grid grid-cols-2 gap-3 border-b border-border p-4 lg:grid-cols-3">
            <StatTile label="Model run" value={data.model_run_id} />
            <StatTile
              label="Beats baseline?"
              value={data.model_beats_baseline ? 'Yes' : 'No'}
              tone={data.model_beats_baseline ? 'positive' : 'negative'}
            />
            <StatTile label="Information coefficient" value={data.model_information_coefficient.toFixed(4)} />
          </div>
        )}

        {data && !data.model_beats_baseline && (
          <div className="flex items-center gap-2 border-b border-border bg-warning/10 px-4 py-2 text-xs text-warning">
            <AlertTriangle className="size-3.5 shrink-0" />
            This model does not beat its own out-of-fold baseline — treat every ranking below as unproven, not a
            recommendation.
          </div>
        )}

        {isLoading && <Skeleton className="m-4 h-48" />}

        {refusal && (
          <div className="m-4 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="size-3.5 shrink-0" />
            {refusal.message}
          </div>
        )}

        {data && data.contracts.length === 0 && (
          <Empty
            title="No gate-passing contracts for this day"
            hint={
              maxCapitalNum !== undefined
                ? `Nothing in the top 25 by expected value costs $${maxCapitalNum} or less per contract — try raising the cap, or a different trading day.`
                : 'Try a different trading day, or check the corpus status tab.'
            }
          />
        )}

        {data && data.contracts.length > 0 && (
          <div className="divide-y divide-border">
            {data.contracts.map((c) => (
              <SignalRow key={c.occ_symbol} contract={c} onOpened={onOpened} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
