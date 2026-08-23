import { useQuery } from '@tanstack/react-query';
import { Home } from 'lucide-react';
import { formatMoney, money } from '@org/shared';
import { Badge, Card, Empty, Skeleton } from '../ui';
import { useSettings } from '../../lib/settings';
import { api, type RealEstateRunsResponse } from '../../lib/api';

const VERDICT_TONE = {
  strong_opportunity: 'positive',
  workable: 'accent',
  weak_fit: 'negative',
} as const;

const STATUS_TONE = {
  running: 'neutral',
  done: 'neutral',
  partial: 'warning',
  failed: 'negative',
} as const;

export function RunHistoryList({ onSelect }: { onSelect: (runId: string) => void }) {
  const { baseCurrency } = useSettings();
  const { data, isLoading } = useQuery({
    queryKey: ['realestate-runs'],
    queryFn: () => api.get<RealEstateRunsResponse>('/api/realestate'),
  });

  if (isLoading) return <Skeleton className="h-40" />;

  if (!data || data.runs.length === 0) {
    return (
      <Card className="overflow-hidden">
        <Empty icon={<Home className="size-7" />} title="No properties analyzed yet" hint="Run an analysis from the Analyze tab and it'll show up here." />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="divide-y divide-border">
        {data.runs.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => onSelect(run.id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-subtle"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{run.propertyInput.address || 'Property'}</div>
              <div className="tnum text-xs text-muted">
                {formatMoney(money(run.propertyInput.askingPriceCents, baseCurrency || 'CAD'))} · {new Date(run.startedAt).toLocaleDateString()}
              </div>
            </div>
            {run.managerResult ? (
              <Badge tone={VERDICT_TONE[run.managerResult.overallVerdict]}>{run.managerResult.overallVerdict.replace('_', ' ')}</Badge>
            ) : (
              <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
            )}
          </button>
        ))}
      </div>
    </Card>
  );
}
