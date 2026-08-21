import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatMoney, money } from '@org/shared';
import { cn } from './ui';

/**
 * Chart palette.
 *
 * Two categorical slots, validated against both surfaces (worst adjacent CVD
 * ΔE 9.2 light / 9.4 dark; normal-vision 27.6 / 26.5). Income sits on aqua and
 * expense on orange — hues that read semantically without borrowing the
 * reserved status colors.
 *
 * The aqua step falls below 3:1 on the light surface, so every bar carries a
 * visible value label. That's the documented relief for the contrast warning,
 * not decoration — dropping the labels would make the palette non-compliant.
 */
const SERIES = {
  income: { light: '#1baf7a', dark: '#199e70' },
  expense: { light: '#eb6834', dark: '#d95926' },
  /** Single hue for one-series magnitude charts — no legend needed. */
  single: { light: '#2a78d6', dark: '#3987e5' },
} as const;

function useSeriesColor(slot: keyof typeof SERIES): string {
  const root = document.documentElement;
  const explicit = root.getAttribute('data-theme');
  const dark =
    explicit === 'dark' ||
    (explicit !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? SERIES[slot].dark : SERIES[slot].light;
}

const axisStyle = { fontSize: 11, fill: 'var(--text-muted)' } as const;

/** Compact money for axis ticks: `$1.2k`, `$450`. */
function compact(cents: number, currency: string): string {
  const v = cents / 100;
  if (Math.abs(v) >= 1000) return `${v < 0 ? '-' : ''}$${Math.abs(v / 1000).toFixed(1)}k`;
  return formatMoney(money(Math.round(cents), currency), { bare: false }).replace(/\.00$/, '');
}

function ChartTooltip({
  active,
  payload,
  label,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-panel px-2.5 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-[2px]" style={{ background: p.color }} />
          {/* Text stays in ink tokens; the swatch carries identity. */}
          <span className="text-muted capitalize">{p.name}</span>
          <span className="tnum ml-auto font-medium">
            {formatMoney(money(Math.round(p.value ?? 0), currency))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Income against expense, month by month. Two series, so a legend is required. */
export function CashflowChart({
  data,
  currency,
}: {
  data: Array<{ month: string; income: number; expense: number }>;
  currency: string;
}) {
  const income = useSeriesColor('income');
  const expense = useSeriesColor('expense');

  if (data.length === 0) {
    return <p className="px-4 py-10 text-center text-xs text-muted">No transactions yet.</p>;
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-4 px-4 pt-3 text-xs">
        {[
          ['Income', income],
          ['Expense', expense],
        ].map(([label, color]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: color }} />
            <span className="text-muted">{label}</span>
          </span>
        ))}
      </div>

      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }} barGap={2}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 4" />
            <XAxis
              dataKey="month"
              tickFormatter={(m: string) => m.slice(5)}
              tick={axisStyle}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => compact(v, currency)}
              tick={axisStyle}
              axisLine={false}
              tickLine={false}
              width={54}
            />
            <Tooltip
              content={<ChartTooltip currency={currency} />}
              cursor={{ fill: 'var(--accent-soft)', opacity: 0.35 }}
            />
            {/* 4px rounded data-ends, anchored to the baseline. */}
            <Bar dataKey="income" name="income" fill={income} radius={[4, 4, 0, 0]} maxBarSize={22} />
            <Bar dataKey="expense" name="expense" fill={expense} radius={[4, 4, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * Spending by category as horizontal bars.
 *
 * Bars rather than a pie on purpose: the question is "how much", which is a
 * magnitude comparison, and a pie with a dozen slices would also blow past the
 * three-slot cap that all-pairs forms carry.
 */
export function CategoryBars({
  data,
  currency,
  max = 8,
}: {
  data: Array<{ name: string; total: number }>;
  currency: string;
  max?: number;
}) {
  const color = useSeriesColor('single');

  if (data.length === 0) {
    return <p className="px-4 py-10 text-center text-xs text-muted">Nothing spent this month.</p>;
  }

  // Beyond `max`, the tail folds into one row rather than generating hues.
  const top = data.slice(0, max);
  const rest = data.slice(max);
  const rows =
    rest.length > 0
      ? [...top, { name: `Other (${rest.length})`, total: rest.reduce((s, d) => s + d.total, 0) }]
      : top;

  const peak = Math.max(...rows.map((r) => r.total), 1);

  return (
    <div className="space-y-2 p-4">
      {rows.map((row) => (
        <div key={row.name} className="grid grid-cols-[7.5rem_1fr_5.5rem] items-center gap-3">
          <span className="truncate text-xs text-muted" title={row.name}>
            {row.name}
          </span>
          <div className="h-[18px] overflow-hidden rounded-[4px] bg-bg-subtle">
            <div
              className="h-full rounded-[4px] transition-all"
              style={{ width: `${Math.max((row.total / peak) * 100, 2)}%`, background: color }}
            />
          </div>
          {/* Direct value label — also the relief for the contrast warning. */}
          <span className="tnum text-right text-xs font-medium">
            {formatMoney(money(row.total, currency))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Portfolio allocation. Capped at three coloured slots by the all-pairs rule. */
export function AllocationBars({
  data,
  currency,
}: {
  data: Array<{ symbol: string; value: number }>;
  currency: string;
}) {
  const color = useSeriesColor('single');
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  return (
    <div className="space-y-2 p-4">
      {data.map((d) => (
        <div key={d.symbol} className="grid grid-cols-[5rem_1fr_4rem_5.5rem] items-center gap-3">
          <span className="truncate font-mono text-xs">{d.symbol}</span>
          <div className="h-[18px] overflow-hidden rounded-[4px] bg-bg-subtle">
            <div
              className="h-full rounded-[4px]"
              style={{ width: `${Math.max((d.value / total) * 100, 2)}%`, background: color }}
            />
          </div>
          <span className="tnum text-right text-xs text-muted">
            {((d.value / total) * 100).toFixed(1)}%
          </span>
          <span className="tnum text-right text-xs font-medium">
            {formatMoney(money(d.value, currency))}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A single headline number — the right form when there's one figure to read.
 *
 * Passing `onClick` renders the tile as a button rather than wrapping a
 * plain `<div>` tile in a separate `<button>` — one interactive element
 * with its own hover/focus state, instead of two nested boxes.
 */
export function StatTile({
  label,
  value,
  delta,
  tone = 'neutral',
  className,
  onClick,
  ariaLabel,
}: {
  label: string;
  value: string;
  delta?: string;
  tone?: 'neutral' | 'positive' | 'negative';
  className?: string;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const content = (
    <>
      <div className="text-[11px] tracking-wide text-muted uppercase">{label}</div>
      <div
        className={cn(
          'tnum mt-1 text-xl font-semibold',
          tone === 'positive' && 'text-positive',
          tone === 'negative' && 'text-negative',
        )}
      >
        {value}
      </div>
      {delta && <div className="tnum mt-0.5 text-xs text-muted">{delta}</div>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className={cn(
          'rounded-xl border border-border bg-panel px-4 py-3 text-left transition-opacity hover:opacity-80',
          className,
        )}
      >
        {content}
      </button>
    );
  }

  return <div className={cn('rounded-xl border border-border bg-panel px-4 py-3', className)}>{content}</div>;
}

export { Cell };
