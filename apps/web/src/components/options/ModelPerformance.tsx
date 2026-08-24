import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../../lib/api';
import { StatTile } from '../charts';

/**
 * How the *model* is doing — kept rigidly separate from how the *trades*
 * are doing, which lives on the Paper book tab.
 *
 * That separation is the whole design. A forecast can have real skill and
 * still lose money after costs, and a book can make money on two lucky
 * trades while the forecast has none. Putting them in one number is how
 * those stop being separable claims, so this page never shows a P&L figure
 * and the paper book never shows an IC.
 *
 * Everything here is computed in `services/quant/app/performance.py` and
 * passed straight through — a second definition of "is this model any
 * good" in TypeScript could drift from the training harness's, which is
 * the one disagreement this project can least afford.
 */

interface Metrics {
  ic_mean?: number;
  ic_std?: number;
  icir?: number;
  ic_hit_rate?: number;
  ic_t_stat?: number;
  ic_t_hurdle?: number;
  ic_clears_hurdle?: boolean;
  n_trials?: number;
  beats_baseline?: boolean;
  model_rmse?: number;
  baseline_rmse?: number;
  [k: string]: number | boolean | null | undefined;
}

interface Performance {
  target: string;
  runs: Array<{
    run_id: string;
    registered_at: string;
    status: string;
    metrics: Metrics;
    has_loss_curve: boolean;
  }>;
  /** The run the page should lead with — the champion when one exists.
   * Not the same question as "what was registered last", and conflating
   * them would headline a model the system is not serving. */
  featured_run_id: string | null;
  featured_is_champion: boolean;
  latest_run_id: string | null;
  loss_curve: Record<string, { train?: number[]; validation?: number[] }>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-56 items-center justify-center px-6 text-center text-xs text-muted">{children}</div>;
}

/**
 * Out-of-fold rank IC per registered run, against the significance hurdle
 * that run actually faced.
 *
 * The hurdle is drawn as its own line rather than baked into a pass/fail
 * badge because it *moves*: it rises with the number of configurations
 * tried, so a run can score higher than an earlier one and still be
 * further from significance. A chart of IC alone would show that as
 * straightforward improvement.
 */
function SkillChart({ runs }: { runs: Performance['runs'] }) {
  const points = runs
    .map((r) => ({
      day: r.registered_at.slice(0, 10),
      ic: num(r.metrics.ic_mean),
      t: num(r.metrics.ic_t_stat),
      hurdle: num(r.metrics.ic_t_hurdle),
    }))
    .filter((p) => p.t !== null);

  if (points.length === 0) {
    return (
      <Empty>
        No run has recorded a t-statistic yet. Runs registered before the honest-metrics work carry
        no IC at all — they are listed in the table below rather than plotted as zero.
      </Empty>
    );
  }
  if (points.length === 1) {
    const only = points[0]!;
    return (
      <Empty>
        One run recorded so far (t = {only.t?.toFixed(2)} against a {only.hurdle?.toFixed(2)} hurdle).
        A trend needs at least two.
      </Empty>
    );
  }

  return (
    <div className="h-56 px-2 pt-3">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ left: 4, right: 12, top: 4, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
          <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--color-muted)' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--color-muted)' }} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(v) => (typeof v === 'number' ? v.toFixed(2) : String(v))}
          />
          <ReferenceLine y={0} stroke="var(--color-border)" />
          <Line type="monotone" dataKey="t" name="t-statistic" stroke="var(--color-accent)" strokeWidth={2} dot />
          <Line
            type="monotone"
            dataKey="hurdle"
            name="hurdle"
            stroke="var(--color-warning)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Train vs validation RMSE per boosting round — one curve each, averaged
 * across the walk-forward folds.
 *
 * Averaging rather than drawing four separate charts: the question is
 * whether *this training run* overfits, and four small charts made the
 * reader do the averaging by eye. The folds are averaged per round over
 * whichever folds still have a value there, so a run where early stopping
 * cut some folds short does not get a cliff at the length of its shortest
 * fold.
 *
 * The dashed line marks where mean validation bottomed. That is a
 * *diagnostic*, never a setting: choosing a round count against this curve
 * would select on the same blocks the metrics above are computed from,
 * turning every out-of-fold number on this page into an in-sample one.
 *
 * One caveat the mean cannot express, so it is printed beside it: folds
 * sit at very different error levels — on this corpus roughly 0.04 to 0.18
 * — so the average is dominated by the worst fold and its minimum lands
 * far later than most folds' own. The mean here bottoms around round 58
 * while the individual folds bottom at 1, 6, 7 and 65. Reading only the
 * averaged curve would understate how early most folds stop improving,
 * which is the opposite of the mistake this chart exists to prevent.
 */
function meanPerRound(curve: Performance['loss_curve'], key: 'train' | 'validation'): number[] {
  const series = Object.values(curve)
    .map((c) => c[key] ?? [])
    .filter((a) => a.length > 0);
  if (series.length === 0) return [];

  const rounds = Math.max(...series.map((a) => a.length));
  return Array.from({ length: rounds }, (_, i) => {
    const values = series.map((a) => a[i]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length;
  });
}

function LossCurves({ curve }: { curve: Performance['loss_curve'] }) {
  const train = meanPerRound(curve, 'train');
  const validation = meanPerRound(curve, 'validation');

  if (train.length === 0 && validation.length === 0) {
    return (
      <Empty>
        Not recorded for this run. Loss history is written from each training run that followed it —
        an absent curve is shown as absent rather than as a flat line, which is the shape a
        perfectly fit model would have.
      </Empty>
    );
  }

  const rounds = Math.max(train.length, validation.length);
  const points = Array.from({ length: rounds }, (_, i) => ({
    round: i + 1,
    train: Number.isFinite(train[i]) ? train[i] : null,
    validation: Number.isFinite(validation[i]) ? validation[i] : null,
  }));

  // Per-fold minima, printed alongside the mean because averaging hides
  // them — see the note above.
  const perFoldBest = Object.entries(curve)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([fold, series]) => {
      const v = (series.validation ?? []).filter((x) => Number.isFinite(x));
      if (v.length === 0) return null;
      return { fold, best: (series.validation ?? []).indexOf(Math.min(...v)) + 1 };
    })
    .filter((x): x is { fold: string; best: number } => x !== null);

  const finite = validation.filter((v) => Number.isFinite(v));
  // Guarded against a curve with no finite values at all: `Math.min()` of
  // nothing is Infinity, whose indexOf is -1, which would render as
  // "best round 0" and drop a reference line at the y-axis.
  const best = finite.length > 0 ? validation.indexOf(Math.min(...finite)) + 1 : null;
  const foldCount = Object.keys(curve).length;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-2 text-xs">
        <span className="text-muted">
          Mean of {foldCount} walk-forward fold{foldCount === 1 ? '' : 's'}
        </span>
        <span className="text-muted">
          {best === null ? (
            'no validation curve'
          ) : (
            <>
              validation bottoms at round {best} of {rounds}
              {best < rounds ? (
                <span className="text-warning"> · {rounds - best} rounds past it</span>
              ) : null}
            </>
          )}
        </span>
      </div>
      {perFoldBest.length > 1 && (
        <div className="border-b border-border px-3 py-1.5 text-xs text-muted">
          Per fold, validation bottoms at{' '}
          {perFoldBest.map((f, i) => (
            <span key={f.fold}>
              {i > 0 ? ', ' : ''}
              <span className="text-fg">{f.best}</span>
            </span>
          ))}
          . Folds sit at different error levels, so the averaged curve above is pulled toward the
          worst of them and bottoms later than most folds do on their own.
        </div>
      )}
      <div className="h-72 px-2 pt-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ left: 4, right: 12, top: 4, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="round"
              tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
              tickLine={false}
              axisLine={false}
              label={{ value: 'boosting round', position: 'insideBottom', offset: -2, fontSize: 11, fill: 'var(--color-muted)' }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
              tickLine={false}
              axisLine={false}
              width={62}
              domain={['auto', 'auto']}
              tickFormatter={(v: number) => v.toFixed(4)}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(v) => (typeof v === 'number' ? v.toFixed(5) : String(v))}
              labelFormatter={(r) => `Round ${r}`}
            />
            <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: 12 }} />
            {best !== null && <ReferenceLine x={best} stroke="var(--color-muted)" strokeDasharray="3 3" />}
            <Line type="monotone" dataKey="train" name="Train loss" stroke="var(--color-accent)" strokeWidth={2} dot={false} />
            <Line
              type="monotone"
              dataKey="validation"
              name="Validation loss"
              stroke="var(--color-warning)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function ModelPerformance() {
  // Which run's curves to show. Null means "whatever the server features",
  // which is the champion — the model actually being served.
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['quant', 'performance', selectedRun],
    queryFn: () =>
      api.get<Performance>(
        selectedRun ? `/api/quant/performance?run=${encodeURIComponent(selectedRun)}` : '/api/quant/performance',
      ),
  });

  if (isLoading) return <div className="p-6 text-sm text-muted">Loading model performance…</div>;
  if (error) {
    return (
      <div className="p-6 text-sm text-negative">
        Could not load model performance: {(error as Error).message}
      </div>
    );
  }
  if (!data || data.runs.length === 0) {
    return <div className="p-6 text-sm text-muted">No training runs are registered yet.</div>;
  }

  const featured =
    data.runs.find((r) => r.run_id === data.featured_run_id) ?? data.runs[data.runs.length - 1]!;
  const m = featured.metrics;
  const t = num(m.ic_t_stat);
  const hurdle = num(m.ic_t_hurdle);
  const ic = num(m.ic_mean);
  const clears = t !== null && hurdle !== null && t >= hurdle;

  return (
    <div className="space-y-6 p-6">
      {/* The claim this page must never let a reader make by accident. */}
      {!clears && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] leading-relaxed">
          <span className="font-medium">This model has not cleared its significance hurdle.</span>{' '}
          {t !== null && hurdle !== null ? (
            <>
              t = {t.toFixed(2)} against {hurdle.toFixed(2)}
              {num(m.n_trials) !== null ? ` at ${m.n_trials} trial(s)` : ''}. The hurdle rises with every
              configuration tried, so a higher IC is not by itself progress toward significance.
            </>
          ) : (
            <>This run recorded no t-statistic, so its significance cannot be assessed at all.</>
          )}{' '}
          Numbers below describe a plausible edge, not an established one.
        </div>
      )}

      {!data.featured_is_champion && (
        <div className="rounded-lg border border-border bg-bg-subtle px-4 py-3 text-[13px] leading-relaxed text-muted">
          No run is promoted for this target, so the figures below describe the most recently
          registered run — which is not necessarily what the ranker serves.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Daily rank IC" value={ic !== null ? ic.toFixed(4) : '—'} />
        <StatTile
          label="ICIR"
          value={num(m.icir) !== null ? (m.icir as number).toFixed(3) : '—'}
          delta={num(m.ic_std) !== null ? `std ${(m.ic_std as number).toFixed(3)}` : undefined}
        />
        <StatTile
          label="Hit rate"
          value={num(m.ic_hit_rate) !== null ? `${((m.ic_hit_rate as number) * 100).toFixed(0)}%` : '—'}
        />
        <StatTile
          label="Beats baseline"
          value={m.beats_baseline === true ? 'Yes' : m.beats_baseline === false ? 'No' : '—'}
          tone={m.beats_baseline === true ? 'positive' : 'neutral'}
        />
      </div>

      <section>
        <h3 className="mb-1 text-sm font-medium">Significance over time</h3>
        <p className="mb-2 text-xs text-muted">
          Each run's t-statistic against the hurdle it faced. The hurdle moves — it rises with the
          number of configurations tried.
        </p>
        <div className="rounded-lg border border-border">
          <SkillChart runs={data.runs} />
        </div>
      </section>

      <section>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">
            Loss curves — {featured.run_id}{' '}
            <span className="font-normal text-muted">
              ({data.featured_is_champion ? 'champion' : featured.status})
            </span>
          </h3>
          <label className="flex items-center gap-2 text-xs text-muted">
            Training run
            <select
              className="rounded border border-border bg-bg px-2 py-1 text-xs"
              value={featured.run_id}
              onChange={(e) => setSelectedRun(e.target.value)}
            >
              {data.runs.map((r) => (
                <option key={r.run_id} value={r.run_id} disabled={!r.has_loss_curve}>
                  {r.registered_at.slice(0, 10)} · {r.status}
                  {r.has_loss_curve ? '' : ' · no curve'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mb-2 text-xs text-muted">
          Root-mean-square error per boosting round, averaged across the walk-forward folds.
          Validation turning up while train keeps falling is overfitting; the dashed line marks
          where validation bottomed. That mark is a diagnostic, never a setting — choosing a round
          count against it would select on the same blocks the metrics above are computed from.
        </p>
        <LossCurves curve={data.loss_curve} />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Registered runs</h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[13px]">
            <thead className="border-b border-border text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Run</th>
                <th className="px-3 py-2 font-medium">Registered</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Rank IC</th>
                <th className="px-3 py-2 text-right font-medium">t</th>
                <th className="px-3 py-2 text-right font-medium">Hurdle</th>
                <th className="px-3 py-2 text-right font-medium">Baseline</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {[...data.runs].reverse().map((r) => {
                const rt = num(r.metrics.ic_t_stat);
                const rh = num(r.metrics.ic_t_hurdle);
                const ri = num(r.metrics.ic_mean);
                return (
                  <tr key={r.run_id} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">{r.run_id}</td>
                    <td className="px-3 py-2">{r.registered_at.slice(0, 10)}</td>
                    <td className="px-3 py-2">{r.status}</td>
                    <td className="px-3 py-2 text-right">{ri !== null ? ri.toFixed(4) : '—'}</td>
                    <td className="px-3 py-2 text-right">{rt !== null ? rt.toFixed(2) : '—'}</td>
                    <td className="px-3 py-2 text-right">{rh !== null ? rh.toFixed(2) : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {r.metrics.beats_baseline === true ? 'beats' : r.metrics.beats_baseline === false ? 'no' : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          An em dash means the run predates that metric, not that it scored zero.
        </p>
      </section>
    </div>
  );
}
