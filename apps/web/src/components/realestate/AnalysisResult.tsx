import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatMoney, money } from '@org/shared';
import { Badge, Card, CardHeader, Notice, Skeleton, cn } from '../ui';
import { StatTile } from '../charts';
import { BalanceChart } from './BalanceChart';
import { useSettings } from '../../lib/settings';
import { api, type LocationAgentResult, type RealEstateRunDetail, type RentalAgentResult } from '../../lib/api';

/** Same circuit-breaker reasoning as `Ask.tsx`'s `MAX_POLL_MS` — a stuck
 * run (a crash that never reached its own status update) should stop
 * polling forever, not loop silently. */
const MAX_POLL_MS = 10 * 60_000;

const VERDICT_TONE = {
  strong_opportunity: 'positive',
  workable: 'accent',
  weak_fit: 'negative',
} as const;

const ASSESSMENT_TONE = {
  strong: 'positive',
  average: 'neutral',
  weak: 'negative',
} as const;

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium tracking-wide text-muted uppercase">{title}</div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-xs leading-relaxed text-text">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LocationCard({ round1, round2 }: { round1: LocationAgentResult | null; round2: LocationAgentResult | null }) {
  if (!round1) return <p className="text-xs text-muted">No result — the call failed.</p>;
  const current = round2 ?? round1;
  return (
    <div className="space-y-2.5">
      <div className="rounded-lg border border-border p-2.5">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <Badge tone={ASSESSMENT_TONE[round1.areaAssessment]}>{round1.areaAssessment}</Badge>
          <span className="text-[11px] text-faint">round 1 · {round1.confidence} confidence · score {round1.appreciationOutlookScore}/100</span>
        </div>
        <p className="text-xs leading-relaxed text-text">{round1.reasoning}</p>
        <p className="mt-1.5 text-[11px] text-faint">Schools/crime: {round1.schoolsAndCrimeSummary}</p>
        <p className="mt-1 text-[11px] text-faint">Comparable sales: {round1.comparableSalesSummary}</p>
      </div>
      {round2 && (
        <div className="rounded-lg border border-border p-2.5">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={ASSESSMENT_TONE[round2.areaAssessment]}>{round2.areaAssessment}</Badge>
            <span className="text-[11px] text-faint">round 2 · score {round2.appreciationOutlookScore}/100</span>
            {round2.revisedFromRound1 && <Badge tone="accent">revised</Badge>}
          </div>
          <p className="text-xs leading-relaxed text-text">{round2.reasoning}</p>
          {round2.responseToOtherAgent && (
            <div className="mt-1.5 flex items-start gap-1 text-[11px] text-faint">
              <ArrowRight className="mt-0.5 size-3 shrink-0" />
              {round2.responseToOtherAgent}
            </div>
          )}
        </div>
      )}
      {current.sourcesUsed.length > 0 && (
        <p className="text-[11px] text-faint">Sources: {current.sourcesUsed.join(', ')}</p>
      )}
    </div>
  );
}

function RentalCard({ round1, round2, currency }: { round1: RentalAgentResult | null; round2: RentalAgentResult | null; currency: string }) {
  if (!round1) return <p className="text-xs text-muted">No result — the call failed.</p>;
  const current = round2 ?? round1;
  const range = (r: RentalAgentResult) =>
    `${formatMoney(money(r.rentEstimateLowCents, currency))}–${formatMoney(money(r.rentEstimateHighCents, currency))}/mo`;
  return (
    <div className="space-y-2.5">
      <div className="rounded-lg border border-border p-2.5">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <Badge tone={ASSESSMENT_TONE[round1.rentabilityAssessment]}>{round1.rentabilityAssessment}</Badge>
          <span className="text-[11px] text-faint">round 1 · {round1.confidence} confidence · {range(round1)}</span>
        </div>
        <p className="text-xs leading-relaxed text-text">{round1.reasoning}</p>
        <p className="mt-1.5 text-[11px] text-faint">Comparable rents: {round1.comparableRentsSummary}</p>
        {round1.demandFactors.length > 0 && (
          <p className="mt-1 text-[11px] text-faint">Demand factors: {round1.demandFactors.join(', ')}</p>
        )}
      </div>
      {round2 && (
        <div className="rounded-lg border border-border p-2.5">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={ASSESSMENT_TONE[round2.rentabilityAssessment]}>{round2.rentabilityAssessment}</Badge>
            <span className="text-[11px] text-faint">round 2 · {range(round2)}</span>
            {round2.revisedFromRound1 && <Badge tone="accent">revised</Badge>}
          </div>
          <p className="text-xs leading-relaxed text-text">{round2.reasoning}</p>
          {round2.responseToOtherAgent && (
            <div className="mt-1.5 flex items-start gap-1 text-[11px] text-faint">
              <ArrowRight className="mt-0.5 size-3 shrink-0" />
              {round2.responseToOtherAgent}
            </div>
          )}
        </div>
      )}
      {current.sourcesUsed.length > 0 && (
        <p className="text-[11px] text-faint">Sources: {current.sourcesUsed.join(', ')}</p>
      )}
    </div>
  );
}

export function AnalysisResult({ runId }: { runId: string }) {
  const { baseCurrency } = useSettings();
  const currency = baseCurrency || 'CAD';
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const pollStartedAt = useRef<number>(Date.now());

  const { data, isLoading } = useQuery({
    queryKey: ['realestate', runId],
    queryFn: () => api.get<RealEstateRunDetail>(`/api/realestate/${runId}`),
    refetchInterval: (q) => {
      if (q.state.data?.run.status !== 'running') return false;
      if (Date.now() - pollStartedAt.current > MAX_POLL_MS) {
        setPollTimedOut(true);
        return false;
      }
      return 2500;
    },
    refetchIntervalInBackground: true,
  });

  if (isLoading && !data) return <Skeleton className="h-64" />;
  if (!data) return null;

  const { run, disclaimer } = data;
  const c = run.computedFinancials;
  const m = (cents: number) => formatMoney(money(Math.round(cents), currency));

  return (
    <div className="space-y-4">
      <Notice>{disclaimer}</Notice>

      {pollTimedOut && run.status === 'running' && (
        <Notice tone="warning" icon={<AlertTriangle className="size-3.5" />}>
          This is taking much longer than a healthy run should — it may be stuck.
        </Notice>
      )}
      {run.status === 'failed' && (
        <Notice tone="negative" icon={<AlertTriangle className="size-3.5" />}>
          {run.errors.join(' ') || 'The analysis failed.'}
        </Notice>
      )}
      {run.status === 'partial' && (
        <Notice tone="warning" icon={<AlertTriangle className="size-3.5" />}>
          Only partially completed: {run.errors.join(' ')}
        </Notice>
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title={run.propertyInput.address || 'Property'}
          subtitle={`${run.propertyInput.propertyType} · ${m(run.propertyInput.askingPriceCents)}`}
          action={
            run.managerResult ? (
              <Badge tone={VERDICT_TONE[run.managerResult.overallVerdict]}>{run.managerResult.overallVerdict.replace('_', ' ')}</Badge>
            ) : run.status === 'running' ? (
              <Badge tone="neutral">running</Badge>
            ) : null
          }
        />

        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
          <StatTile label="Down payment" value={m(c.downPaymentAmountCents)} />
          <StatTile label="Loan principal" value={m(c.loanPrincipalCents)} />
          <StatTile label="Mortgage payment / mo" value={m(c.monthlyMortgagePaymentCents)} />
          <StatTile
            label="Cash flow / mo"
            value={m(c.monthlyCashFlow.netCents)}
            tone={c.monthlyCashFlow.netCents >= 0 ? 'positive' : 'negative'}
          />
          <StatTile label="Cap rate" value={`${c.capRatePct.toFixed(2)}%`} />
          <StatTile label="Cash-on-cash return" value={`${c.cashOnCashReturnPct.toFixed(2)}%`} />
          <StatTile label="Total cash invested" value={m(c.totalCashInvestedCents)} />
          <StatTile label="Land transfer tax" value={c.landTransferTax.modeled ? m(c.landTransferTax.totalCents) : 'Not modeled'} />
        </div>

        {c.cmhcNote && (
          <div className="mx-4 mb-4">
            <Notice tone="warning">{c.cmhcNote}</Notice>
          </div>
        )}
        {!c.landTransferTax.modeled && (
          <div className="mx-4 mb-4">
            <Notice tone="warning">Land transfer tax isn't modeled for this province yet — treated as $0, not a real estimate.</Notice>
          </div>
        )}

        <div className="border-t border-border p-4">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">
            Net proceeds after tax, at a fixed {(c.assumedAnnualAppreciationRate * 100).toFixed(1)}%/yr appreciation
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[11px] text-faint">
                  <th className="py-1 pr-3 font-normal">Horizon</th>
                  <th className="py-1 pr-3 font-normal">Projected value</th>
                  <th className="py-1 pr-3 font-normal">Equity</th>
                  <th className="py-1 pr-3 font-normal">Cash flow (after tax)</th>
                  <th className="py-1 pr-3 font-normal">Capital gains tax</th>
                  <th className="py-1 font-normal">Total net proceeds</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {c.horizons.map((h) => (
                  <tr key={h.year} className="tnum">
                    <td className="py-1.5 pr-3 font-medium">{h.year} yr</td>
                    <td className="py-1.5 pr-3">{m(h.projectedValueCents)}</td>
                    <td className="py-1.5 pr-3">{m(h.equityCents)}</td>
                    <td className={cn('py-1.5 pr-3', h.accumulatedAfterTaxCashFlowCents >= 0 ? 'text-positive' : 'text-negative')}>
                      {m(h.accumulatedAfterTaxCashFlowCents)}
                    </td>
                    <td className="py-1.5 pr-3">{m(h.capitalGainsTaxCents)}</td>
                    <td className="py-1.5 font-medium">{m(h.totalNetProceedsAfterTaxCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="border-t border-border p-4">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Appreciation vs. cash flow</div>
          <BalanceChart placement={run.balancePlacement} />
        </div>
      </Card>

      {run.managerResult && (
        <Card className="overflow-hidden p-4">
          <p className="mb-3 text-sm leading-relaxed text-text">{run.managerResult.narrativeSummary}</p>
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <ListSection title="Key risks" items={run.managerResult.keyRisks} />
            <ListSection title="Conflicts / mismatches" items={run.managerResult.conflicts} />
          </div>
          <div className="grid gap-2.5 text-xs sm:grid-cols-3">
            <div>
              <div className="mb-0.5 text-[11px] text-faint">7 years</div>
              <p className="leading-relaxed text-text">{run.managerResult.horizonNotes.year7}</p>
            </div>
            <div>
              <div className="mb-0.5 text-[11px] text-faint">10 years</div>
              <p className="leading-relaxed text-text">{run.managerResult.horizonNotes.year10}</p>
            </div>
            <div>
              <div className="mb-0.5 text-[11px] text-faint">15 years</div>
              <p className="leading-relaxed text-text">{run.managerResult.horizonNotes.year15}</p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden p-3.5">
          <div className="mb-2.5 text-[11px] font-medium tracking-wide text-muted uppercase">Location</div>
          <LocationCard round1={run.locationRound1} round2={run.locationRound2} />
        </Card>
        <Card className="overflow-hidden p-3.5">
          <div className="mb-2.5 text-[11px] font-medium tracking-wide text-muted uppercase">Rental</div>
          <RentalCard round1={run.rentalRound1} round2={run.rentalRound2} currency={currency} />
        </Card>
      </div>
    </div>
  );
}
