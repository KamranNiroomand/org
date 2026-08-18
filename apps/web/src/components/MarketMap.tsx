import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  matched: number;
  quoted: number;
  universe: number;
  exchanges: string[];
  sectors: string[];
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

/**
 * GICS sector names are written for prospectuses, not for a column that has to
 * share a row with eleven others. Truncation turns three of them into
 * "Information ...", which identifies nothing — these abbreviations keep the
 * distinction visible. Display only; the full name stays in the title and in
 * the filter.
 */
const SECTOR_SHORT: Record<string, string> = {
  'Information Technology': 'Info Tech',
  'Consumer Discretionary': 'Cons. Disc.',
  'Consumer Staples': 'Cons. Staples',
  'Communication Services': 'Comm. Svcs.',
  'Health Care': 'Health Care',
};

const shortSector = (s: string | null): string => (s === null ? '—' : (SECTOR_SHORT[s] ?? s));

const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const num = (v: number | null, digits = 1): string => (v === null ? '—' : v.toFixed(digits));
const listedYear = (ms: number | null): number | null =>
  ms === null ? null : new Date(ms).getUTCFullYear();

const CAP_BANDS: Array<[string, string]> = [
  ['all', 'Any size'],
  ['mega', 'Mega · >$200B'],
  ['large', 'Large · $10–200B'],
  ['mid', 'Mid · <$10B'],
];

const AGE_BANDS: Array<[string, string]> = [
  ['all', 'Any age'],
  ['recent', 'Listed since 2015'],
  ['mature', 'Listed 1990–2014'],
  ['old', 'Listed before 1990'],
];

const PE_BANDS: Array<[string, string]> = [
  ['all', 'Any P/E'],
  ['value', 'P/E under 15'],
  ['fair', 'P/E 15–25'],
  ['growth', 'P/E 25–40'],
  ['rich', 'P/E over 40'],
  ['none', 'No P/E (loss-making)'],
];

/**
 * A treemap box only carries information if it can be read. Below the size the
 * `Box` renderer needs for a symbol, a rectangle conveys nothing but colour —
 * and a field of unlabelled rectangles reads as a rendering fault rather than
 * as "these companies are small".
 *
 * `MAX_BOXES` is the ceiling; the count actually drawn is derived from the
 * canvas, because 120 boxes are legible on a wide desktop and are not on a
 * narrow window. See `labelableBoxCount`.
 */
const MAX_BOXES = 120;

/**
 * Must match the thresholds in `Box`, which is what decides to draw a label.
 *
 * Measured rather than guessed. On a 971x372 canvas the treemap lays boxes out
 * in bands of roughly constant height — 60px at the small end — so the binding
 * constraint is *width*, not area: a 19x60 box has plenty of area and still
 * cannot hold a ticker. At the old 42px threshold only 51 of 121 boxes carried
 * a label; at 28px, 95 do, and a four-character symbol at 8px still reads
 * cleanly in 28px.
 */
const MIN_LABEL_WIDTH = 28;
const MIN_LABEL_HEIGHT = 14;
/**
 * Area needed to imply the width above. Using `MIN_LABEL_WIDTH x
 * MIN_LABEL_HEIGHT` is far too generous — a 19x41 box clears it on area and
 * still cannot hold a ticker — so this multiplies the width by a
 * representative band height instead.
 *
 * 45 is measured, not assumed: across a full render the boxes that failed the
 * width test were 28 to 45 pixels tall. Taking the tallest band (60) instead
 * over-corrects badly, cutting the map from 120 boxes to 58 and throwing away
 * half its breadth to eliminate a handful of blanks.
 */
const TYPICAL_BAND = 45;
const MIN_LABEL_AREA = MIN_LABEL_WIDTH * TYPICAL_BAND;

/**
 * How many of `values` (descending) can be drawn and still be labelled.
 *
 * A treemap gives each box an area proportional to its share of the total
 * drawn, so the smallest box of the first N is `area * v[N-1] / sum(v[0..N-1])`.
 * Adding a box both shrinks the smallest value and grows the denominator, so
 * that quantity falls monotonically and the largest workable N is found by
 * walking until it drops under the threshold.
 *
 * Area is a fair proxy here because squarified treemaps keep boxes close to
 * square; a long thin box of sufficient area is possible but rare.
 */
function labelableBoxCount(values: readonly number[], width: number, height: number): number {
  const ceiling = Math.min(values.length, MAX_BOXES);
  // Before the first measurement, draw the ceiling rather than nothing — one
  // frame of over-drawing beats a visibly empty panel on load.
  if (width <= 0 || height <= 0) return ceiling;

  const area = width * height;
  let total = 0;
  let count = 0;
  for (let i = 0; i < ceiling; i += 1) {
    const v = values[i] ?? 0;
    if (v <= 0) break;
    total += v;
    if ((area * v) / total < MIN_LABEL_AREA) break;
    count = i + 1;
  }
  // Always show something, even on a canvas too small for the rule.
  return Math.max(count, Math.min(ceiling, 1));
}

/**
 * Tracks an element's rendered size, so the box count can follow the window.
 *
 * A **callback ref** rather than `useRef` + `useLayoutEffect`. The chart only
 * mounts once the query resolves, so an effect with an empty dependency list
 * runs while the node is still absent, bails, and never retries — leaving the
 * size permanently at zero and the box count permanently at its ceiling. A
 * callback ref fires on attach and detach, whenever those happen.
 */
function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return [ref, size] as const;
}

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
  const [cap, setCap] = useState('all');
  const [age, setAge] = useState('all');
  const [pe, setPe] = useState('all');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('marketCap');
  const [asc, setAsc] = useState(false);

  /**
   * Debounced so typing a symbol doesn't fire a query per keystroke.
   */
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['market', index, exchange, sector, cap, age, pe, debouncedQuery],
    queryFn: () => {
      const params = new URLSearchParams({ index, exchange, sector, cap, age, pe });
      if (debouncedQuery) params.set('search', debouncedQuery);
      return api.get<Snapshot>(`/api/investments/market?${params.toString()}`);
    },
    placeholderData: (prev) => prev,
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

  const sectors = data?.sectors ?? [];

  const filtered = data?.rows ?? [];

  const dark = isDark();

  const [mapRef, mapSize] = useElementSize<HTMLDivElement>();

  const byCap = useMemo(
    () => [...filtered].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)),
    [filtered],
  );

  const boxCount = useMemo(
    () => labelableBoxCount(byCap.map((r) => r.marketCap ?? 0), mapSize.width, mapSize.height),
    [byCap, mapSize.width, mapSize.height],
  );

  const treeData = useMemo(() => {
    const top = byCap.slice(0, boxCount);
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
  }, [byCap, boxCount, dark]);

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

  /**
   * Header cells reserve room for the sort caret whether or not they carry it,
   * so activating a sort doesn't shift every column beside it.
   */
  const th = (k: SortKey, label: string, align: 'left' | 'right' = 'right') => (
    <th
      scope="col"
      aria-sort={sortKey === k ? (asc ? 'ascending' : 'descending') : 'none'}
      className={cn(
        'group cursor-pointer select-none whitespace-nowrap px-3 py-2.5 font-semibold',
        'transition-colors hover:text-text',
        sortKey === k ? 'text-text' : 'text-muted',
        align === 'left' ? 'text-left' : 'text-right',
      )}
      onClick={() => toggleSort(k)}
    >
      {label}
      <span
        aria-hidden
        className={cn(
          'ml-1 inline-block w-2 text-[9px]',
          sortKey === k ? 'text-accent' : 'text-transparent group-hover:text-border-strong',
        )}
      >
        {sortKey === k && !asc ? '▼' : '▲'}
      </span>
    </th>
  );

  /** Plain, non-sortable header cell. */
  const thPlain = (label: string, align: 'left' | 'right' = 'right') => (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-3 py-2.5 font-semibold text-muted',
        align === 'left' ? 'text-left' : 'text-right',
      )}
    >
      {label}
    </th>
  );

  return (
    <>
      <Card className="mb-4 overflow-hidden">
        <CardHeader
          title="Market map"
          subtitle={
            data
              ? `${data.matched.toLocaleString()} matching · ${data.universe.toLocaleString()} instruments · sized by market cap`
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
            onChange={setCap}
            options={CAP_BANDS}
          />
          <Select
            value={age}
            onChange={setAge}
            options={AGE_BANDS}
          />
          <Select
            value={pe}
            onChange={setPe}
            options={PE_BANDS}
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
            <div ref={mapRef} className="h-[380px] px-2 pt-2">
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
            {(data?.matched ?? 0) > boxCount && (
              <p className="px-4 pb-2 pt-1 text-[11px] text-faint">
                Drawing the {boxCount} largest of {data!.matched.toLocaleString()} matches — smaller
                boxes would be unreadable.
                {data!.matched > filtered.length &&
                  ` The table lists the largest ${filtered.length.toLocaleString()}.`}
              </p>
            )}
          </>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Companies"
          subtitle={`${sorted.length.toLocaleString()} shown${
            (data?.matched ?? 0) > sorted.length ? ` of ${data!.matched.toLocaleString()} matching` : ''
          }`}
        />
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            {/**
             * Header type is small, uppercase and letter-spaced — the
             * convention in financial tables, and it separates label from
             * datum by shape rather than by making the labels louder.
             */}
            <thead className="sticky top-0 z-10 bg-panel text-[10px] uppercase tracking-[0.07em] [&_th]:border-b [&_th]:border-border">
              <tr>
                {th('symbol', 'Symbol', 'left')}
                {thPlain('Company', 'left')}
                {thPlain('Sector', 'left')}
                {thPlain('Exchange', 'left')}
                {thPlain('Price')}
                {th('dayChangePercent', 'Day')}
                {th('marketCap', 'Market cap')}
                {th('trailingPE', 'P/E')}
                {thPlain('Fwd P/E')}
                {thPlain('P/B')}
                {th('dividendYield', 'Yield')}
                {thPlain('Listed')}
              </tr>
            </thead>
            <tbody className="[&_td]:border-b [&_td]:border-border/60">
              {sorted.map((r) => {
                const change = r.dayChangePercent;
                return (
                  <tr key={r.symbol} className="transition-colors hover:bg-bg-subtle">
                    {/* Tickers are codes, not words — monospace makes them scan. */}
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] font-semibold tracking-tight text-text">
                      {r.symbol}
                    </td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-text" title={r.name}>
                      {r.name}
                    </td>
                    <td
                      className="max-w-[112px] truncate whitespace-nowrap px-3 py-2 text-muted"
                      title={r.sector ?? ''}
                    >
                      {shortSector(r.sector)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">{r.exchange}</td>
                    <td className="tnum whitespace-nowrap px-3 py-2 text-right text-text">
                      {r.price === null ? '—' : `$${r.price.toFixed(2)}`}
                    </td>
                    <td
                      className={cn(
                        'tnum whitespace-nowrap px-3 py-2 text-right font-medium',
                        change === null && 'text-muted',
                        (change ?? 0) > 0 && 'text-positive',
                        (change ?? 0) < 0 && 'text-negative',
                      )}
                    >
                      {pct(change)}
                    </td>
                    <td className="tnum whitespace-nowrap px-3 py-2 text-right font-medium text-text">
                      {bn(r.marketCap)}
                    </td>
                    <td className="tnum whitespace-nowrap px-3 py-2 text-right text-text">
                      {num(r.trailingPE)}
                    </td>
                    <td className="tnum whitespace-nowrap px-3 py-2 text-right text-muted">
                      {num(r.forwardPE)}
                    </td>
                    <td className="tnum whitespace-nowrap px-3 py-2 text-right text-muted">
                      {num(r.priceToBook)}
                    </td>
                    <td className="tnum whitespace-nowrap px-3 py-2 text-right text-muted">
                      {r.dividendYield === null ? '—' : `${r.dividendYield.toFixed(2)}%`}
                    </td>
                    <td className="tnum whitespace-nowrap px-3 py-2 text-right text-muted">
                      {listedYear(r.firstTradeMs) ?? '—'}
                    </td>
                  </tr>
                );
              })}
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
  const showSymbol = width > MIN_LABEL_WIDTH && height > MIN_LABEL_HEIGHT;
  // The percentage needs a second line, so it asks for meaningfully more room.
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
          // Floored at 8px: below that a ticker is present but unreadable,
          // which is worse than the honest blank it replaced.
          fontSize={Math.max(8, Math.min(13, width / 4.2))}
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
