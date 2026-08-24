import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
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
  runs: Array<{ run_id: string; registered_at: string; status: string; metrics: Metrics }>;
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
 * Train vs validation RMSE per boosting round, for the most recent run.
 *
 * The one question the out-of-fold summary metrics cannot answer: a
 * validation curve that turns upward while training keeps falling is
 * overfitting, and a single end-of-run number has already absorbed that
 * into itself.
 *
 * Fold 0 only. Each fold trains on a different span of an expanding
 * window, so overlaying them compares curves of different lengths on
 * different data — visually busy and not actually a comparison.
 */
function LossCurve({ curve }: { curve: Performance['loss_curve'] }) {
  const folds = Object.keys(curve).sort((a, b) => Number(a) - Number(b));
  const first = folds[0];
  const series = first ? curve[first] : undefined;
  const train = series?.train ?? [];
  const validation = series?.validation ?? [];

  if (train.length === 0 && validation.length === 0) {
    return (
      <Empty>
        Not recorded for this run. Loss history is written from the next training run onward — an
        absent curve is shown as absent rather than as a flat line, which is the shape a perfectly
        fit model would have.
      </Empty>
    );
  }

  const rounds = Math.max(train.length, validation.length);
  const points = Array.from({ length: rounds }, (_, i) => ({
    round: i + 1,
    train: train[i] ?? null,
    validation: validation[i] ?? null,
  }));

  return (
    <div className="h-56 px-2 pt-3">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ left: 4, right: 12, top: 4, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
          <XAxis dataKey="round" tick={{ fontSize: 11, fill: 'var(--color-muted)' }} tickLine={false} axisLine={false} />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--color-muted)' }}
            tickLine={false}
            axisLine={false}
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
          <Line type="monotone" dataKey="train" name="train" stroke="var(--color-accent)" strokeWidth={2} dot={false} />
          <Line
            type="monotone"
            dataKey="validation"
            name="validation"
            stroke="var(--color-warning)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ModelPerformance() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['quant', 'performance'],
    queryFn: () => api.get<Performance>('/api/quant/performance'),
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
        <h3 className="mb-1 text-sm font-medium">
          Loss curve — {featured.run_id}{' '}
          <span className="font-normal text-muted">({data.featured_is_champion ? 'champion' : 'latest registered'})</span>
        </h3>
        <p className="mb-2 text-xs text-muted">
          Train and validation RMSE per boosting round, fold 0. Validation turning up while train
          keeps falling is overfitting.
        </p>
        <div className="rounded-lg border border-border">
          <LossCurve curve={data.loss_curve} />
        </div>
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
