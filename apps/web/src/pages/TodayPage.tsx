import { useQuery } from '@tanstack/react-query';
import { Lightbulb } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  civilHoliday,
  civilKey,
  formatDual,
  formatMoney,
  money,
  todayCivil,
} from '@org/shared';
import { StatTile } from '../components/charts';
import { DualDate } from '../components/DualDate';
import { Page, PageHeader } from '../components/PageHeader';
import { Badge, Card, CardHeader, cn } from '../components/ui';
import { api, type MonthSummary, type PortfolioResponse } from '../lib/api';
import { useSettings } from '../lib/settings';

interface Agenda {
  overdue: Array<{ id: string; title: string; dueOn: string; priority: string }>;
  today: Array<{ id: string; title: string; dueOn: string; priority: string }>;
}

interface Idea {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

export function TodayPage() {
  const { baseCurrency, persianDigits } = useSettings();
  const today = todayCivil();
  const monthKey = civilKey(today).slice(0, 7);
  const holiday = civilHoliday(today);
  const dual = formatDual(today, { style: 'full', persian: persianDigits });

  const { data: agenda } = useQuery({
    queryKey: ['agenda'],
    queryFn: () => api.get<Agenda>('/api/tasks/agenda/today'),
  });
  const { data: summary } = useQuery({
    queryKey: ['summary', monthKey],
    queryFn: () => api.get<MonthSummary>(`/api/finance/summary?month=${monthKey}`),
  });
  const { data: portfolio } = useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api.get<PortfolioResponse>('/api/portfolio'),
  });
  const { data: ideas } = useQuery({
    queryKey: ['ideas'],
    queryFn: () => api.get<Idea[]>('/api/ideas'),
  });

  const m = (cents: number) => formatMoney(money(cents, baseCurrency));
  const recentIdeas = ideas?.slice(0, 4) ?? [];
  const openCount = (agenda?.overdue.length ?? 0) + (agenda?.today.length ?? 0);

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={
          <span className="flex items-center gap-2">
            <span className="tnum">{dual.miladi}</span>
            <span className="text-faint">·</span>
            <span className={cn('tnum', persianDigits && 'fa')} dir={persianDigits ? 'rtl' : 'ltr'}>
              {dual.shamsi}
            </span>
            {holiday && (
              <Badge tone={holiday.official ? 'negative' : 'neutral'}>
                {persianDigits ? holiday.nameFa : holiday.name}
              </Badge>
            )}
          </span>
        }
      />

      <Page>
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Due today"
            value={String(openCount)}
            delta={agenda?.overdue.length ? `${agenda.overdue.length} overdue` : undefined}
            tone={agenda?.overdue.length ? 'negative' : 'neutral'}
          />
          <StatTile label="Spent this month" value={m(summary?.expense ?? 0)} />
          <StatTile
            label="Net this month"
            value={m(summary?.net ?? 0)}
            tone={(summary?.net ?? 0) >= 0 ? 'positive' : 'negative'}
          />
          <StatTile
            label="Portfolio"
            value={m(portfolio?.totals.marketValue ?? 0)}
            delta={
              portfolio
                ? `${portfolio.totals.unrealizedPLPercent >= 0 ? '+' : ''}${portfolio.totals.unrealizedPLPercent.toFixed(1)}% unrealized`
                : undefined
            }
            tone={(portfolio?.totals.unrealizedPL ?? 0) >= 0 ? 'positive' : 'negative'}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="overflow-hidden">
            <CardHeader
              title="Tasks"
              subtitle="Due today and overdue"
              action={
                <Link to="/todo" className="text-xs text-accent hover:underline">
                  All tasks
                </Link>
              }
            />
            {openCount === 0 ? (
              <p className="px-4 py-10 text-center text-xs text-muted">
                Nothing due. Enjoy it.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {agenda?.overdue.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="size-1.5 shrink-0 rounded-full bg-negative" />
                    <span className="flex-1 truncate text-sm">{t.title}</span>
                    <span className="shrink-0 text-xs text-negative">
                      <DualDate date={t.dueOn} style="short" />
                    </span>
                  </div>
                ))}
                {agenda?.today.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="size-1.5 shrink-0 rounded-full bg-accent" />
                    <span className="flex-1 truncate text-sm">{t.title}</span>
                    <Badge tone="accent">today</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title="Spending"
              subtitle={`Top categories in ${monthKey}`}
              action={
                <Link to="/finances" className="text-xs text-accent hover:underline">
                  Finances
                </Link>
              }
            />
            {!summary?.byCategory.length ? (
              <p className="px-4 py-10 text-center text-xs text-muted">
                No transactions yet this month.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {summary.byCategory.slice(0, 5).map((c) => (
                  <div key={c.name} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="flex-1 truncate text-sm">{c.name}</span>
                    <span className="tnum text-sm font-medium">{m(c.total)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title="Holdings"
              action={
                <Link to="/investments" className="text-xs text-accent hover:underline">
                  Investments
                </Link>
              }
            />
            {!portfolio?.holdings.length ? (
              <p className="px-4 py-10 text-center text-xs text-muted">No holdings yet.</p>
            ) : (
              <div className="divide-y divide-border">
                {portfolio.holdings.slice(0, 5).map((h) => (
                  <div key={h.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="font-mono text-sm">{h.symbol}</span>
                    <span className="flex-1" />
                    {h.dayChangePercent !== null && (
                      <span
                        className={cn(
                          'tnum text-xs',
                          h.dayChangePercent >= 0 ? 'text-positive' : 'text-negative',
                        )}
                      >
                        {h.dayChangePercent >= 0 ? '+' : ''}
                        {h.dayChangePercent.toFixed(2)}%
                      </span>
                    )}
                    <span className="tnum w-24 text-right text-sm font-medium">
                      {h.marketValueBase !== null ? m(h.marketValueBase) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title="Recent ideas"
              action={
                <Link to="/ideas" className="text-xs text-accent hover:underline">
                  Ideas
                </Link>
              }
            />
            {recentIdeas.length === 0 ? (
              <p className="px-4 py-10 text-center text-xs text-muted">
                Nothing drafted yet.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {recentIdeas.map((i) => (
                  <Link
                    key={i.id}
                    to={`/ideas/${i.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-bg-subtle"
                  >
                    <Lightbulb className="size-3.5 shrink-0 text-faint" />
                    <span className="flex-1 truncate text-sm">{i.title}</span>
                    <Badge>{i.status}</Badge>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </Page>
    </>
  );
}
