import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ResponsiveContainer, Tooltip, Treemap } from 'recharts';
import { Button, Card, CardHeader, Skeleton, cn } from './ui';
import { api } from '../lib/api';

interface MarketRow {
  symbol: string;
  name: string;
  exchange: string;
  country: string;
  sector: string | null;
  price: number | null;
  currency: string;
  dayChangePercent: number | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  dividendYield: number | null;
  firstTradeMs: number | null;
}

interface Snapshot {
  asOf: string | null;
  quoted: number;
  universe: number;
  exchanges: string[];
  rows: MarketRow[];
}

const INDICES: Array<[string, string]> = [
  ['all', 'US + Canada'],
  ['us', 'United States'],
  ['ca', 'Canada'],
  ['sp500', 'S&P 500'],
  ['nasdaq100', 'Nasdaq-100'],
];

/**
 * Heat palette.
 *
 * Deliberately *not* the conventional red/green of every other market map.
 * Colour is the primary channel here — it encodes the day's move across five
 * hundred boxes — and red/green is precisely the pair that red-green colour
 * blindness collapses, which is around 8% of men. These are the same two hues
 * already validated for the cashflow chart, and they stay distinguishable
 * under deuteranopia and protanopia.
 *
 * Each box also prints its percentage, so the reading never depends on colour
 * alone. That's the same relief the bar charts use.
 */
const HEAT = {
  up: { light: '#0f7a52', dark: '#12855c' },
  down: { light: '#c04a17', dark: '#bf4a1c' },
  flat: { light: '#6b7480', dark: '#5b6675' },
} as const;

function isDark(): boolean {
  const explicit = document.documentElement.getAttribute('data-theme');
  return (
    explicit === 'dark' ||
    (explicit !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

/** Blends a hex colour toward the surface, so small moves read as muted. */
function fade(hex: string, amount: number, dark: boolean): string {
  const base = dark ? [22, 26, 33] : [246, 247, 249];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = (c: number, i: number) => Math.round(c * amount + base[i]! * (1 - amount));
  return `rgb(${mix(r, 0)}, ${mix(g, 1)}, ${mix(b, 2)})`;
}

/** WCAG relative luminance of an `rgb(r, g, b)` string. */
function luminance(rgb: string): number {
  const m = rgb.match(/(\d+), (\d+), (\d+)/);
  if (!m) return 0;
  const channel = (v: string) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(m[1]!) + 0.7152 * channel(m[2]!) + 0.0722 * channel(m[3]!);
}

/**
 * Picks the label colour that actually contrasts with the box under it.
 *
 * A single fixed colour cannot work: the strongest gainers are light enough
 * that white text falls to 3.4:1, and on the light surface small moves fade
 * almost to the background, where white would vanish entirely. Choosing per
 * box keeps every label above the 4.5:1 the 13px semibold type needs.
 */
function labelColor(fill: string): string {
  const l = luminance(fill);
  const againstWhite = 1.05 / (l + 0.05);
  const againstInk = (l + 0.05) / 0.05;
  return againstWhite >= againstInk ? '#ffffff' : '#0d1117';
}

function heatColor(pct: number | null, dark: boolean): string {
  if (pct === null || Math.abs(pct) < 0.05) return dark ? HEAT.flat.dark : HEAT.flat.light;
  const slot = pct > 0 ? HEAT.up : HEAT.down;
  // Saturation saturates at ±3%: beyond that the eye stops reading degrees anyway.
  const intensity = Math.min(Math.abs(pct) / 3, 1);
  return fade(dark ? slot.dark : slot.light, 0.35 + intensity * 0.65, dark);
}

const bn = (v: number | null): string => {
  if (v === null) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  return `$${(v / 1e6).toFixed(0)}M`;
};

const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const num = (v: number | null, digits = 1): string => (v === null ? '—' : v.toFixed(digits));
const listedYear = (ms: number | null): number | null =>
  ms === null ? null : new Date(ms).getUTCFullYear();

const CAP_BANDS = {
  all: { label: 'Any size', test: () => true },
  mega: { label: 'Mega · >$200B', test: (c: number) => c > 200e9 },
  large: { label: 'Large · $10–200B', test: (c: number) => c >= 10e9 && c <= 200e9 },
  mid: { label: 'Mid · <$10B', test: (c: number) => c < 10e9 },
} as const;

const AGE_BANDS = {
  all: { label: 'Any age', test: () => true },
  recent: { label: 'Listed since 2015', test: (y: number) => y >= 2015 },
  mature: { label: 'Listed 1990–2014', test: (y: number) => y >= 1990 && y < 2015 },
  old: { label: 'Listed before 1990', test: (y: number) => y < 1990 },
} as const;

const PE_BANDS = {
  all: { label: 'Any P/E', test: () => true },
  value: { label: 'P/E under 15', test: (p: number | null) => p !== null && p < 15 },
  fair: { label: 'P/E 15–25', test: (p: number | null) => p !== null && p >= 15 && p <= 25 },
  growth: { label: 'P/E 25–40', test: (p: number | null) => p !== null && p > 25 && p <= 40 },
  rich: { label: 'P/E over 40', test: (p: number | null) => p !== null && p > 40 },
  none: { label: 'No P/E (loss-making)', test: (p: number | null) => p === null },
} as const;

/** Boxes below this share of the canvas cannot fit a legible label. */
const MAX_BOXES = 120;

type SortKey = 'marketCap' | 'trailingPE' | 'dayChangePercent' | 'symbol' | 'dividendYield';

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-lg border border-border bg-panel px-2 text-xs text-text"
    >
      {options.map(([k, label]) => (
        <option key={k} value={k}>
          {label}
        </option>
      ))}
    </select>
  );
}

export function MarketMap() {
  const [index, setIndex] = useState('all');
  const [exchange, setExchange] = useState('all');
  const [sector, setSector] = useState('all');
  const [cap, setCap] = useState<keyof typeof CAP_BANDS>('all');
  const [age, setAge] = useState<keyof typeof AGE_BANDS>('all');
  const [pe, setPe] = useState<keyof typeof PE_BANDS>('all');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('marketCap');
  const [asc, setAsc] = useState(false);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['market', index, exchange],
    queryFn: () =>
      api.get<Snapshot>(`/api/investments/market?index=${index}&exchange=${exchange}`),
  });

  /**
   * The universe is swept nightly; this re-quotes only the symbols currently
   * drawn. Asking Yahoo for seven thousand quotes whenever someone opens the
   * tab would be both slow and a good way to get rate-limited.
   */
  const refreshVisible = useMutation({
    mutationFn: (symbols: string[]) =>
      api.post<{ refreshed: number }>('/api/investments/market/refresh', { symbols }),
    onSuccess: () => void refetch(),
  });

  const sectors = useMemo(
    () => [...new Set((data?.rows ?? []).map((r) => r.sector).filter((x): x is string => !!x))].sort(),
    [data],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => {
      if (sector !== 'all' && r.sector !== sector) return false;
      if (r.marketCap === null || !CAP_BANDS[cap].test(r.marketCap)) return false;
      const y = listedYear(r.firstTradeMs);
      if (age !== 'all' && (y === null || !AGE_BANDS[age].test(y))) return false;
      if (!PE_BANDS[pe].test(r.trailingPE)) return false;
      if (q && !r.symbol.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, sector, cap, age, pe, query]);

  const dark = isDark();

  const treeData = useMemo(() => {
    const top = [...filtered]
      .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
      .slice(0, MAX_BOXES);
    return top.map((r) => {
      const fill = heatColor(r.dayChangePercent, dark);
      return {
        name: r.symbol,
        size: r.marketCap ?? 0,
        change: r.dayChangePercent,
        company: r.name,
        sector: r.sector,
        fill,
        label: labelColor(fill),
      };
    });
  }, [filtered, dark]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => {
      if (sortKey === 'symbol') return asc ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol);
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return asc ? av - bv : bv - av;
    });
    return rows;
  }, [filtered, sortKey, asc]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(false);
    }
  };

  const th = (k: SortKey, label: string, align = 'text-right') => (
    <th
      className={cn('cursor-pointer select-none px-2 py-1.5 font-medium hover:text-text', align)}
      onClick={() => toggleSort(k)}
    >
      {label}
      {sortKey === k && <span className="ml-0.5 text-faint">{asc ? '↑' : '↓'}</span>}
    </th>
  );

  return (
    <>
      <Card className="mb-4 overflow-hidden">
        <CardHeader
          title="Market map"
          subtitle={
            data
              ? `${filtered.length.toLocaleString()} shown · ${data.quoted.toLocaleString()} of ${data.universe.toLocaleString()} instruments quoted · sized by market cap`
              : 'Loading…'
          }
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => refreshVisible.mutate(treeData.map((d) => d.name))}
              disabled={isFetching || refreshVisible.isPending}
              title="Re-quote the companies currently shown"
            >
              <RefreshCw
                className={cn('size-3.5', (isFetching || refreshVisible.isPending) && 'animate-spin')}
              />
            </Button>
          }
        />

        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Symbol or company"
              className="h-8 w-44 rounded-lg border border-border bg-panel pl-7 pr-2 text-xs"
            />
          </div>
          <Select
            value={index}
            onChange={(v) => {
              setIndex(v);
              setExchange('all');
            }}
            options={INDICES}
          />
          <Select
            value={exchange}
            onChange={setExchange}
            options={[
              ['all', 'All exchanges'],
              ...((data?.exchanges ?? []).map((e) => [e, e]) as Array<[string, string]>),
            ]}
          />
          <Select
            value={sector}
            onChange={setSector}
            options={[['all', 'All sectors'], ...sectors.map((s) => [s, s] as [string, string])]}
          />
          <Select
            value={cap}
            onChange={(v) => setCap(v as keyof typeof CAP_BANDS)}
            options={Object.entries(CAP_BANDS).map(([k, v]) => [k, v.label])}
          />
          <Select
            value={age}
            onChange={(v) => setAge(v as keyof typeof AGE_BANDS)}
            options={Object.entries(AGE_BANDS).map(([k, v]) => [k, v.label])}
          />
          <Select
            value={pe}
            onChange={(v) => setPe(v as keyof typeof PE_BANDS)}
            options={Object.entries(PE_BANDS).map(([k, v]) => [k, v.label])}
          />
        </div>

        {isLoading ? (
          <Skeleton className="m-4 h-[380px]" />
        ) : treeData.length === 0 ? (
          <div className="px-4 py-14 text-center text-xs text-muted">
            Nothing matches those filters.
          </div>
        ) : (
          <>
            <div className="h-[380px] px-2 pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <Treemap
                  data={treeData}
                  dataKey="size"
                  stroke="var(--color-bg)"
                  isAnimationActive={false}
                  content={<Box />}
                >
                  <Tooltip content={<MapTooltip />} />
                </Treemap>
              </ResponsiveContainer>
            </div>
            {filtered.length > MAX_BOXES && (
              <p className="px-4 pb-2 pt-1 text-[11px] text-faint">
                Showing the {MAX_BOXES} largest of {filtered.length} matches — smaller boxes would be
                unreadable. All {filtered.length} appear in the table below.
              </p>
            )}
          </>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Companies" subtitle={`${sorted.length} matching`} />
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel text-muted shadow-[0_1px_0_var(--color-border)]">
              <tr>
                {th('symbol', 'Symbol', 'text-left')}
                <th className="px-2 py-1.5 text-left font-medium">Company</th>
                <th className="px-2 py-1.5 text-left font-medium">Sector</th>
                <th className="px-2 py-1.5 text-left font-medium">Exchange</th>
                <th className="px-2 py-1.5 text-right font-medium">Price</th>
                {th('dayChangePercent', 'Day')}
                {th('marketCap', 'Market cap')}
                {th('trailingPE', 'P/E')}
                <th className="px-2 py-1.5 text-right font-medium">Fwd P/E</th>
                <th className="px-2 py-1.5 text-right font-medium">P/B</th>
                {th('dividendYield', 'Yield')}
                <th className="px-2 py-1.5 text-right font-medium">Listed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((r) => (
                <tr key={r.symbol} className="hover:bg-bg-subtle">
                  <td className="px-2 py-1.5 font-medium">{r.symbol}</td>
                  <td className="max-w-[200px] truncate px-2 py-1.5 text-muted">{r.name}</td>
                  <td className="max-w-[130px] truncate px-2 py-1.5 text-faint">{r.sector ?? '—'}</td>
                  <td className="px-2 py-1.5 text-faint">{r.exchange}</td>
                  <td className="tnum px-2 py-1.5 text-right">
                    {r.price === null ? '—' : `$${r.price.toFixed(2)}`}
                  </td>
                  <td
                    className={cn(
                      'tnum px-2 py-1.5 text-right',
                      (r.dayChangePercent ?? 0) > 0 && 'text-positive',
                      (r.dayChangePercent ?? 0) < 0 && 'text-negative',
                    )}
                  >
                    {pct(r.dayChangePercent)}
                  </td>
                  <td className="tnum px-2 py-1.5 text-right">{bn(r.marketCap)}</td>
                  <td className="tnum px-2 py-1.5 text-right">{num(r.trailingPE)}</td>
                  <td className="tnum px-2 py-1.5 text-right text-muted">{num(r.forwardPE)}</td>
                  <td className="tnum px-2 py-1.5 text-right text-muted">{num(r.priceToBook)}</td>
                  <td className="tnum px-2 py-1.5 text-right text-muted">
                    {r.dividendYield === null ? '—' : `${r.dividendYield.toFixed(2)}%`}
                  </td>
                  <td className="tnum px-2 py-1.5 text-right text-faint">
                    {listedYear(r.firstTradeMs) ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

interface BoxProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  change?: number | null;
  fill?: string;
  label?: string;
}

/** One company. Label and percentage appear only where they actually fit. */
function Box({ x = 0, y = 0, width = 0, height = 0, name, change, fill, label = '#ffffff' }: BoxProps) {
  const showSymbol = width > 42 && height > 24;
  const showChange = width > 52 && height > 38;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="var(--color-bg)" strokeWidth={1} />
      {showSymbol && (
        <text
          x={x + width / 2}
          y={y + height / 2 - (showChange ? 6 : 0)}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={label}
          fontSize={Math.min(13, width / 4.2)}
          fontWeight={600}
        >
          {name}
        </text>
      )}
      {showChange && (
        <text
          x={x + width / 2}
          y={y + height / 2 + 9}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={label}
          fontSize={Math.min(11, width / 5.4)}
          opacity={0.92}
        >
          {change === null || change === undefined ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
        </text>
      )}
    </g>
  );
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: { name?: string; company?: string; sector?: string; size?: number; change?: number | null } }>;
}

function MapTooltip({ active, payload }: TooltipProps) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="rounded-lg border border-border bg-panel px-2.5 py-2 text-xs shadow-lg">
      <div className="font-medium">
        {p.name} <span className="text-muted">{p.company}</span>
      </div>
      <div className="mt-0.5 text-faint">{p.sector}</div>
      <div className="tnum mt-1">
        {bn(p.size ?? null)} · {pct(p.change ?? null)}
      </div>
    </div>
  );
}
