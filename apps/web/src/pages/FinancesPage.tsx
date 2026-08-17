import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Eye, EyeOff, Landmark, RefreshCw, Wallet } from 'lucide-react';
import { useState } from 'react';
import { formatMoney, money, todayCivil, civilKey } from '@org/shared';
import { BankSync } from '../components/BankSync';
import { CashflowChart, CategoryBars, StatTile } from '../components/charts';
import { DualDate } from '../components/DualDate';
import { Page, PageHeader } from '../components/PageHeader';
import { Badge, Button, Card, CardHeader, Empty, Skeleton, cn } from '../components/ui';
import { api, type CashflowPoint, type MonthSummary, type TransactionRow } from '../lib/api';
import { useSettings } from '../lib/settings';

interface Account {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  currency: string;
  currentBalance: number | null;
  creditLimit: number | null;
  institutionName: string | null;
  isManual: boolean;
  includeInStats: boolean;
}

interface Category {
  id: string;
  name: string;
  kind: string;
}

export function FinancesPage() {
  const { baseCurrency, health } = useSettings();
  const [month, setMonth] = useState(() => civilKey(todayCivil()).slice(0, 7));
  const qc = useQueryClient();

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<Account[]>('/api/accounts'),
  });
  const { data: summary, isLoading } = useQuery({
    queryKey: ['summary', month],
    queryFn: () => api.get<MonthSummary>(`/api/finance/summary?month=${month}`),
  });
  const { data: cashflow } = useQuery({
    queryKey: ['cashflow'],
    queryFn: () => api.get<CashflowPoint[]>('/api/finance/cashflow?months=12'),
  });
  const { data: transactions } = useQuery({
    queryKey: ['transactions', month],
    queryFn: () =>
      api.get<TransactionRow[]>(`/api/transactions?from=${month}-01&to=${month}-31&limit=200`),
  });
  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<Category[]>('/api/categories'),
  });

  const recategorize = useMutation({
    mutationFn: ({ id, categoryId, learn }: { id: string; categoryId: string; learn: boolean }) =>
      api.patch(`/api/transactions/${id}`, { categoryId, learn }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['summary'] });
    },
  });

  /**
   * Excluding an account is a display choice, not a destructive one — the
   * account and its transactions stay exactly where they are, they just stop
   * feeding the tiles and charts. Every aggregate query has to be invalidated
   * together or the tiles and the charts disagree for a beat.
   */
  const toggleAccount = useMutation({
    mutationFn: (vars: { id: string; includeInStats: boolean }) =>
      api.patch(`/api/accounts/${vars.id}`, { includeInStats: vars.includeInStats }),
    onSuccess: () => {
      for (const key of ['accounts', 'summary', 'cashflow', 'budgets']) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const m = (cents: number) => formatMoney(money(cents, baseCurrency));

  const counted = accounts?.filter((a) => a.includeInStats) ?? [];
  const debt = counted
    .filter((a) => a.type === 'credit')
    .reduce((s, a) => s + Math.abs(a.currentBalance ?? 0), 0);
  const cash = counted
    .filter((a) => a.type === 'depository')
    .reduce((s, a) => s + (a.currentBalance ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Finances"
        subtitle={
          health?.features.plaid
            ? `Plaid connected (${health.features.plaidEnv})`
            : 'Manual entry — connect a bank to sync automatically'
        }
        actions={
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="h-8 rounded-lg border border-border bg-panel px-2 text-xs"
          />
        }
      />

      <Page>
        <BankSync />

        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Income" value={m(summary?.income ?? 0)} tone="positive" />
          <StatTile label="Spent" value={m(summary?.expense ?? 0)} />
          <StatTile
            label="Net"
            value={m(summary?.net ?? 0)}
            tone={(summary?.net ?? 0) >= 0 ? 'positive' : 'negative'}
          />
          <StatTile label="Card debt" value={m(debt)} delta={cash ? `${m(cash)} in cash` : undefined} />
        </div>

        <div className="mb-5 grid gap-4 lg:grid-cols-2">
          <Card className="overflow-hidden">
            <CardHeader title="Cashflow" subtitle="Last 12 months" />
            <CashflowChart data={cashflow ?? []} currency={baseCurrency} />
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Where it went" subtitle={month} />
            {isLoading ? (
              <Skeleton className="m-4 h-40" />
            ) : (
              <CategoryBars data={summary?.byCategory ?? []} currency={baseCurrency} />
            )}
          </Card>
        </div>

        <Card className="mb-5 overflow-hidden">
          <CardHeader
            title="Accounts"
            subtitle={
              accounts?.length
                ? counted.length === accounts.length
                  ? `${accounts.length} connected`
                  : `${counted.length} of ${accounts.length} counted`
                : undefined
            }
          />
          {accounts?.length === 0 ? (
            <Empty
              icon={<Wallet className="size-7" />}
              title="No accounts yet"
              hint={
                health?.features.plaid
                  ? 'Connect your bank to pull in credit-card transactions automatically.'
                  : 'Add Plaid keys to .env to connect a bank, or add an account manually.'
              }
            />
          ) : (
            <div className="divide-y divide-border">
              {accounts?.map((a) => {
                const utilization =
                  a.type === 'credit' && a.creditLimit
                    ? Math.abs(a.currentBalance ?? 0) / a.creditLimit
                    : null;
                return (
                  <div
                    key={a.id}
                    className={cn(
                      'flex items-center gap-3 px-4 py-3',
                      !a.includeInStats && 'opacity-45',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        toggleAccount.mutate({ id: a.id, includeInStats: !a.includeInStats })
                      }
                      title={
                        a.includeInStats
                          ? 'Counted in totals and charts — click to exclude'
                          : 'Excluded from totals and charts — click to include'
                      }
                      aria-label={
                        a.includeInStats ? `Exclude ${a.name} from totals` : `Include ${a.name} in totals`
                      }
                      aria-pressed={a.includeInStats}
                      className="rounded-md p-1 text-faint transition-colors hover:bg-bg-subtle hover:text-text"
                    >
                      {a.includeInStats ? (
                        <Eye className="size-3.5" />
                      ) : (
                        <EyeOff className="size-3.5" />
                      )}
                    </button>
                    <div className="rounded-lg bg-bg-subtle p-2 text-muted">
                      {a.type === 'credit' ? (
                        <CreditCard className="size-4" />
                      ) : (
                        <Landmark className="size-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {a.name}
                        {a.mask && <span className="ml-1.5 text-xs text-faint">••{a.mask}</span>}
                      </div>
                      <div className="text-xs text-muted">
                        {a.institutionName ?? (a.isManual ? 'Manual' : a.type)}
                        {utilization !== null && (
                          <span
                            className={cn('ml-2', utilization > 0.7 && 'text-warning')}
                          >
                            {(utilization * 100).toFixed(0)}% of limit
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="tnum text-right text-sm font-medium">
                      {a.currentBalance !== null ? m(a.currentBalance) : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            title="Transactions"
            subtitle={`${transactions?.length ?? 0} in ${month}`}
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void qc.invalidateQueries({ queryKey: ['transactions'] })}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            }
          />
          {transactions?.length === 0 ? (
            <Empty title="No transactions this month" hint="Import a statement or add one by hand." />
          ) : (
            <div className="divide-y divide-border">
              {transactions?.map(({ transaction: t, account, category }) => (
                <div key={t.id} className="group flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{t.merchantName ?? t.name}</div>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <DualDate date={t.date} style="short" />
                      {account && <span className="text-faint">{account.name}</span>}
                      {t.pending && <Badge tone="warning">pending</Badge>}
                    </div>
                  </div>

                  <select
                    value={category?.id ?? ''}
                    onChange={(e) =>
                      recategorize.mutate({
                        id: t.id,
                        categoryId: e.target.value,
                        // Correcting a category offers to make it permanent —
                        // the system learns instead of asking again next month.
                        learn: window.confirm(
                          `Always categorize “${t.merchantName ?? t.name}” this way?`,
                        ),
                      })
                    }
                    className="h-7 max-w-[9rem] shrink-0 rounded-md border border-border bg-panel px-1.5 text-xs text-muted opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  >
                    <option value="">Uncategorized</option>
                    {categories?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>

                  {category && (
                    <Badge className="shrink-0 group-hover:hidden">{category.name}</Badge>
                  )}

                  <span
                    className={cn(
                      'tnum w-24 shrink-0 text-right text-sm font-medium',
                      t.amount > 0 && 'text-positive',
                    )}
                  >
                    {formatMoney(money(t.amount, t.currency), { signed: t.amount > 0 })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Page>
    </>
  );
}
