import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { Badge, Card, CardHeader, Empty, Skeleton, cn } from '../ui';
import { optionsApi, type SkewAgentRead, type SkewRow } from '../../lib/optionsApi';

/**
 * The skew map — what option traders are paying for, crossed with what
 * price already did. Every number is computed in the quant sidecar
 * (services/quant/app/skew.py, where the four quadrants and the five
 * disciplines are documented); this component only plots and repeats
 * the fixed per-name sentence, so the same read follows a name whether
 * it's a dot on the map or a row in the table.
 */

const QUADRANT_META = {
  contrarian_bid: {
    label: 'Falling, optimism building',
    color: 'var(--color-accent)',
    blurb: 'Down on the month, but calls are bid — tape and chain disagree. Watchlist; the only box where two sources of information split.',
  },
  chase: {
    label: 'Rising, crowd is in',
    color: '#e8923c',
    blurb: 'Up, and calls still bid. Everyone agrees — crowded, late, not wrong.',
  },
  hedged_rally: {
    label: 'Rising, being insured',
    color: '#d4b83c',
    blurb: 'Up, but puts are bid — the rally is not trusted. Tighten stops on anything held here.',
  },
  fear: {
    label: 'Falling, getting scarier',
    color: 'var(--color-negative, #e05252)',
    blurb: 'Down, and protection keeps getting pricier. Not a bargain. Leave it alone.',
  },
} as const;

function SkewTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: SkewRow }> }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="max-w-xs rounded-lg border border-border bg-panel px-2.5 py-2 text-xs shadow-lg">
      <div className="font-medium">
        {row.symbol}
        {row.held && <span className="ml-1 text-accent">· held</span>}
        {!row.chain_ok && <span className="ml-1 text-faint">· thin chain</span>}
        {row.suspect && <span className="ml-1 text-negative">· suspect quote</span>}
      </div>
      <div className="mt-1 text-muted">{row.sentence}</div>
    </div>
  );
}

export function SkewMap() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['skew-map'],
    queryFn: () => optionsApi.skewMap(),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
  const [crosshair, setCrosshair] = useState<'zero' | 'median'>('zero');
  const qc = useQueryClient();
  const agentReads = useQuery({
    queryKey: ['skew-agent'],
    queryFn: () => optionsApi.skewAgentReads(),
    refetchInterval: 5 * 60_000,
  });
  const runAgent = useMutation({
    mutationFn: () => optionsApi.runSkewAgent(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['skew-agent'] }),
  });

  const groups = useMemo(() => {
    const rows = data?.rows ?? [];
    const usable = rows.filter((r) => r.chain_ok && !r.suspect && r.ret_1m !== null);
    const flagged = rows.filter((r) => !r.chain_ok || r.suspect);
    return { usable, flagged };
  }, [data]);

  if (isLoading) return <Skeleton className="h-96" />;
  if (error || !data) {
    return (
      <Empty
        title="No skew board yet"
        hint="The map needs a day of captured option chains — it appears after the nightly capture."
      />
    );
  }

  const yCross = crosshair === 'median' ? (data.median_skew_norm ?? 0) : 0;
  const byQuadrant = (q: keyof typeof QUADRANT_META) => groups.usable.filter((r) => r.quadrant === q);
  const axisStyle = { fontSize: 11, fill: 'var(--color-muted)' } as const;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={`Skew map — ${data.day}`}
          subtitle="What traders pay for protection vs upside (25Δ, ~45 DTE), against the month's move. Positioning, not prediction — the change is the signal, the level is just the stock's personality."
        />
        <div className="flex items-center gap-3 px-4 pb-1 text-[11px] text-faint">
          {Object.entries(QUADRANT_META).map(([k, m]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-full" style={{ background: m.color }} />
              {m.label} ({byQuadrant(k as keyof typeof QUADRANT_META).length})
            </span>
          ))}
          <button
            className="ml-auto rounded border border-border px-1.5 py-0.5 text-muted hover:bg-panel"
            onClick={() => setCrosshair(crosshair === 'zero' ? 'median' : 'zero')}
          >
            crosshair: {crosshair}
          </button>
        </div>
        <div className="h-96 w-full px-2 pb-3">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="ret_1m"
                name="1M return"
                unit="%"
                tick={axisStyle}
                stroke="var(--color-border)"
              />
              <YAxis
                type="number"
                dataKey="skew_norm"
                name="skew"
                tick={axisStyle}
                stroke="var(--color-border)"
                width={48}
              />
              <ZAxis range={[70, 70]} />
              <ReferenceLine x={0} stroke="var(--color-muted)" strokeDasharray="4 4" />
              <ReferenceLine y={yCross} stroke="var(--color-muted)" strokeDasharray="4 4" />
              <Tooltip content={<SkewTooltip />} cursor={{ strokeDasharray: '3 3' }} />
              {(Object.keys(QUADRANT_META) as Array<keyof typeof QUADRANT_META>).map((q) => (
                <Scatter key={q} data={byQuadrant(q)} fill={QUADRANT_META[q].color} fillOpacity={0.85} />
              ))}
              {/* Held names ring on top; thin/suspect shown hollow — visible, never hidden. */}
              <Scatter
                data={groups.usable.filter((r) => r.held)}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={2}
                shape="circle"
              />
              <Scatter
                data={groups.flagged.filter((r) => r.ret_1m !== null)}
                fill="none"
                stroke="var(--color-muted)"
                strokeWidth={1}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </Card>


      <Card>
        <CardHeader
          title="Worth looking into"
          subtitle="The agent's enter candidates — names where falling prices and quiet optimism disagree enough to deserve your research time. Never a buy list: each one is a homework assignment, not an order."
        />
        <div className="px-4 pb-3">
          {(agentReads.data?.reads ?? []).filter((r: SkewAgentRead) => r.verdict === 'enter_candidate')
            .length === 0 ? (
            <p className="text-xs text-faint">
              None today — most days there are none, and the tool saying so is it working, not failing.
            </p>
          ) : (
            (agentReads.data?.reads ?? [])
              .filter((r: SkewAgentRead) => r.verdict === 'enter_candidate')
              .map((r: SkewAgentRead) => (
                <div key={r.symbol} className="mb-2 rounded-lg border border-positive/40 bg-positive/5 p-2.5 text-xs">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{r.symbol}</span>
                    <Badge tone="positive">worth looking into</Badge>
                    <span className="tnum text-muted">confidence {Math.round(r.probability * 100)}%</span>
                  </div>
                  <p className="mt-1">{r.reasoning.split(String.fromCharCode(10) + String.fromCharCode(10))[0]}</p>
                </div>
              ))
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Agent read"
          subtitle="A standalone research layer — the agent judges only the names the math flagged, commits a scoreable probability, and influences nothing: no engine reads these verdicts. Its track record decides its future."
        />
        <div className="flex items-center gap-2 px-4 pb-2">
          <button
            className="rounded border border-border px-2 py-1 text-xs text-muted hover:bg-panel disabled:opacity-50"
            disabled={runAgent.isPending}
            onClick={() => runAgent.mutate()}
          >
            {runAgent.isPending ? 'Reading the map…' : 'Run agent read'}
          </button>
          {agentReads.data && agentReads.data.reads.length === 0 && (
            <span className="text-xs text-faint">No verdicts for {agentReads.data.day} yet.</span>
          )}
        </div>
        <div className="divide-y divide-border">
          {(agentReads.data?.reads ?? []).map((r: SkewAgentRead) => (
            <div key={r.symbol} className="px-4 py-2.5 text-xs">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="w-14 font-medium">{r.symbol}</span>
                <Badge
                  tone={
                    r.verdict === 'enter_candidate'
                      ? 'positive'
                      : r.verdict === 'avoid'
                        ? 'negative'
                        : r.verdict === 'tighten_if_held'
                          ? 'accent'
                          : 'neutral'
                  }
                >
                  {r.verdict.replace(/_/g, ' ')}
                </Badge>
                <span className="tnum text-muted">P {Math.round(r.probability * 100)}%</span>
              </div>
              {r.reasoning.split('\n\n').map((para, i) => (
                <p key={i} className={i === 0 ? 'mt-1' : 'mt-1 text-faint'}>
                  {para}
                </p>
              ))}
              <p className="mt-0.5 text-faint">Would change this: {r.falsifier}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="The four verdicts"
          subtitle="Decided in advance, so a red afternoon can't renegotiate them"
        />
        <div className="grid gap-2 px-4 pb-4 sm:grid-cols-2">
          {Object.entries(QUADRANT_META).map(([k, m]) => (
            <div key={k} className="rounded-lg border border-border p-2.5 text-xs">
              <span className="font-medium" style={{ color: m.color }}>
                {m.label}
              </span>
              <p className="mt-1 text-muted">{m.blurb}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Sectors, in raw vol points"
          subtitle="Cross-sector comparisons never use the normalized number — ATM IV varies ~3x between sectors and dividing by a small number manufactures fear"
        />
        <div className="space-y-1 px-4 pb-3">
          {data.sectors.map((s) => (
            <div key={s.sector} className="flex items-center gap-2 text-xs">
              <span className="w-48 truncate text-muted">{s.sector}</span>
              <div className="h-3 flex-1 overflow-hidden rounded bg-panel">
                <div
                  className={cn('h-full', s.mean_skew_pts >= 0 ? 'bg-negative/60' : 'bg-positive/60')}
                  style={{ width: `${Math.min(100, Math.abs(s.mean_skew_pts) * 800)}%` }}
                />
              </div>
              <span className="tnum w-14 text-right">{(s.mean_skew_pts * 100).toFixed(1)}pt</span>
              <span className={cn('tnum w-24 text-right', s.agreement < 0.7 && 'text-warning')}>
                {(s.agreement * 100).toFixed(0)}% agree · {s.n}
              </span>
            </div>
          ))}
          <div className="pt-1 text-[11px] text-faint">
            Benchmarks:{' '}
            {data.benchmarks.map((b) => `${b.symbol} ${(b.skew_pts * 100).toFixed(1)}pt`).join(' · ')} — a
            sector above its index carries more hedging than the market it lives in. Agreement below 70% is
            flagged: that average is being dragged, not led.
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Ranked by five-session change"
          subtitle="The level is structural; the change is the signal. Thin chains and suspect quotes sit at the bottom, named — never silently dropped."
        />
        <div className="flex flex-wrap items-baseline gap-x-3 border-b border-border px-4 py-1.5 text-[10px] uppercase tracking-wide text-faint">
          <span className="w-14">Name</span>
          <span className="w-28">Situation</span>
          <span className="w-40" title="What big investors are paying more for right now">What's being paid for</span>
          <span className="w-40" title="Which way that changed over the last week — the list is sorted by this">This week's change</span>
          <span className="w-24">Trading</span>
          <span className="min-w-0 flex-1">The read</span>
        </div>
        <div className="max-h-[32rem] divide-y divide-border overflow-y-auto">
          {data.rows.map((r) => (
            <div key={r.symbol} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-xs">
              <span className="w-14 font-medium">
                {r.symbol}
                {r.held && <span className="text-accent">*</span>}
              </span>
              {r.quadrant ? (
                <span className="w-28" style={{ color: QUADRANT_META[r.quadrant].color }}>
                  {QUADRANT_META[r.quadrant].label}
                </span>
              ) : (
                <span className="w-28 text-faint">—</span>
              )}
              <span className="w-40 text-muted">
                {Math.abs(r.skew_norm) < 0.05
                  ? 'balanced'
                  : r.skew_norm >= 0
                    ? `protection ${Math.abs(r.skew_norm) >= 0.3 ? 'very ' : ''}expensive`
                    : `optimism ${Math.abs(r.skew_norm) >= 0.3 ? 'very ' : ''}expensive`}
                <span className="tnum text-faint"> {r.skew_norm.toFixed(2)}</span>
              </span>
              <span
                className={cn(
                  'w-40',
                  r.delta_5d === null ? 'text-faint' : r.delta_5d >= 0.05 ? 'text-negative' : r.delta_5d <= -0.05 ? 'text-positive' : 'text-muted',
                )}
              >
                {r.delta_5d === null
                  ? 'no history yet'
                  : r.delta_5d >= 0.05
                    ? '▲ worry rising this week'
                    : r.delta_5d <= -0.05
                      ? '▼ worry easing this week'
                      : 'steady this week'}
              </span>
              <span className="w-24 text-muted">
                {r.rvol === null ? '' : r.rvol >= 1.5 ? 'busy day' : r.rvol <= 0.6 ? 'quiet day' : 'normal day'}
              </span>
              {r.event_flag && (
                <span title="A company announcement is coming up — some caution is just that date being priced in">
                  📅
                </span>
              )}
              {!r.chain_ok && <Badge tone="neutral">thin chain</Badge>}
              {r.suspect && <Badge tone="negative">suspect quote</Badge>}
              <span className="min-w-0 flex-1 truncate text-muted">{r.sentence}</span>
            </div>
          ))}
        </div>
        <div className="px-4 py-2 text-[11px] text-faint">
          How to use this: "falling, optimism building" goes on your research list; "rising, crowd is in"
          means you're late; "rising, being insured" means keep it but set your exit price; "falling,
          getting scarier" means don't go bargain-hunting. Red = worry growing; green = worry fading.
          📅 = announcement coming up. * = we own it.
        </div>
      </Card>
    </div>
  );
}
