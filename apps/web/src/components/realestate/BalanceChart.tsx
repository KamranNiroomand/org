import { CartesianGrid, ReferenceArea, ResponsiveContainer, Scatter, ScatterChart, XAxis, YAxis, ZAxis } from 'recharts';
import type { BalancePlacement } from '../../lib/api';

/**
 * Where this property sits between appreciation and cash flow — the visual
 * Kamran asked for: appreciation on one side, cash flow on the other,
 * balance in the middle. Both axes and the point are computed entirely
 * server-side (`cashFlowAxisScore` and the location agent's
 * `appreciationOutlookScore` — see `services/quant/app/realestate.py` and
 * `agents/realestate/run.ts`'s `balancePlacement`); this component only
 * plots what it's given.
 *
 * The highlighted zone mirrors `BALANCE_ZONE` in realestate.py (40-75 on
 * both axes) — kept in sync by convention, the same cross-language
 * discipline `options.ts` already uses against `pricing.py`.
 */
const BALANCE_ZONE = { xMin: 40, xMax: 75, yMin: 40, yMax: 75 };

const axisStyle = { fontSize: 11, fill: 'var(--text-muted)' } as const;

export function BalanceChart({ placement }: { placement: BalancePlacement | null }) {
  if (!placement) {
    return (
      <div className="flex h-56 items-center justify-center rounded-lg border border-border text-xs text-muted">
        Not available yet — the location agent hasn't produced an appreciation score.
      </div>
    );
  }

  const point = [{ x: placement.cashFlowScore, y: placement.appreciationScore ?? 0 }];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[11px] text-muted">
        <span>← Appreciation-leaning</span>
        <span className="font-medium text-text">the balanced middle</span>
        <span>Cash-flow-leaning →</span>
      </div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 4 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
            <XAxis
              type="number"
              dataKey="x"
              domain={[0, 100]}
              tick={axisStyle}
              axisLine={false}
              tickLine={false}
              label={{ value: 'Cash-flow strength', position: 'insideBottom', offset: -4, style: { fontSize: 11, fill: 'var(--text-muted)' } }}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={[0, 100]}
              tick={axisStyle}
              axisLine={false}
              tickLine={false}
              width={40}
              label={{ value: 'Appreciation outlook', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: 'var(--text-muted)' } }}
            />
            <ZAxis range={[140, 140]} />
            <ReferenceArea
              x1={BALANCE_ZONE.xMin}
              x2={BALANCE_ZONE.xMax}
              y1={BALANCE_ZONE.yMin}
              y2={BALANCE_ZONE.yMax}
              fill="var(--accent)"
              fillOpacity={0.1}
              stroke="var(--accent)"
              strokeOpacity={0.3}
              strokeDasharray="3 3"
            />
            <Scatter data={point} fill="var(--accent)" />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      {placement.appreciationScore === null && (
        <p className="mt-1.5 text-[11px] text-faint">Appreciation score unavailable — plotted at 0 as a placeholder.</p>
      )}
    </div>
  );
}
