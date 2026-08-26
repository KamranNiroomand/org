import { config } from '../config.js';

/**
 * Client for the Python sidecar (`services/quant`).
 *
 * Only what Fastify cannot compute for itself crosses this boundary — today
 * implied vol and greeks. Everything heavier reads the Parquet corpus off disk
 * on the Python side, because shipping millions of rows over localhost HTTP to
 * price them would cost more than the pricing.
 */

export interface PriceRow {
  key: string;
  price: number;
  spot: number;
  strike: number;
  years: number;
  rate: number;
  div_yield?: number;
  is_call: boolean;
  american?: boolean;
}

export interface PriceResult {
  key: string;
  iv_bps: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  skipped: string | null;
}

export interface RankedContract {
  occ_symbol: string;
  underlying: string;
  expiry: string;
  type: string;
  strike: number;
  dte: number;
  market_price: number;
  market_iv: number | null;
  forecast_vol: number;
  forecast_drift: number;
  forecast_value: number;
  ev: number;
  ev_per_risk: number;
  prob_profit: number;
  /** Populated on a fresh `/rank` entry candidate, null on a `/position-health`
   * re-score — see `exit.py`'s `compute_initial_exit_target`. A tunable
   * first-pass plan, not a validated one. */
  suggested_target_exit_price: number | null;
  suggested_stop_loss_price: number | null;
  suggested_target_exit_date: string | null;
}

export interface RankResult {
  model_run_id: string;
  model_beats_baseline: boolean;
  model_information_coefficient: number;
  contracts: RankedContract[];
}

export class QuantRefusal extends Error {
  constructor(detail: string) {
    // rank_day's own refusal (no trained model, no bars, model doesn't beat
    // baseline unless forced) — distinct from QuantUnavailable so callers
    // can render this as "the model says X", not "the service is down".
    super(detail);
    this.name = 'QuantRefusal';
  }
}

export class QuantUnavailable extends Error {
  constructor(cause: string) {
    super(
      `Quant sidecar unreachable at ${config.market.quantUrl} — ${cause}. ` +
        `Start it with \`npm run dev:quant\`.`,
    );
    this.name = 'QuantUnavailable';
  }
}

/**
 * Separates SPAC-derivative warrants/units/rights from real common stock —
 * see `services/quant/app/classify.py`'s module docstring for why this needs
 * real fuzzy name matching rather than a ticker-shape regex, and
 * `universe.ts`'s own call site for what happens when the sidecar is down.
 */
export async function classifyUniverse(
  rows: Array<{ symbol: string; name: string }>,
): Promise<Record<string, string>> {
  if (rows.length === 0) return {};
  let res: Response;
  try {
    res = await fetch(`${config.market.quantUrl}/classify-universe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbols: rows }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new QuantUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    throw new QuantUnavailable(`HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { excluded?: unknown };
  // A type assertion alone would trust a malformed 200 body (contract drift
  // between this file and the sidecar's actual response shape) as if it were
  // a real, empty result — silently classifying nothing instead of failing
  // loud enough for universe.ts's catch to log it as the degradation it is.
  if (typeof body.excluded !== 'object' || body.excluded === null) {
    throw new QuantUnavailable('malformed response: missing "excluded"');
  }
  return body.excluded as Record<string, string>;
}

export async function quantHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${config.market.quantUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Batched, because a nightly capture solves on the order of a hundred thousand
 * contracts and one round trip each would dominate the runtime.
 */
export async function priceBatch(rows: PriceRow[], chunkSize = 2000): Promise<PriceResult[]> {
  const out: PriceResult[] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    let res: Response;
    try {
      res = await fetch(`${config.market.quantUrl}/price`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rows: chunk }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new QuantUnavailable(err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) {
      throw new QuantUnavailable(`HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { results: PriceResult[] };
    out.push(...body.results);
  }
  return out;
}

/**
 * Ranks gate-passing contracts by expected value for one trading day. See
 * `services/quant/app/rank.py`'s own module docstring for what this forecast
 * actually is and, just as importantly, what it is not.
 */
export async function rankDay(
  day: string,
  top = 25,
  force = true,
  maxCapital?: number,
): Promise<RankResult> {
  let res: Response;
  try {
    res = await fetch(`${config.market.quantUrl}/rank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ day, top, force, max_capital: maxCapital }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new QuantUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (res.status === 409) {
    const body = (await res.json()) as { detail: string };
    throw new QuantRefusal(body.detail);
  }
  if (!res.ok) {
    throw new QuantUnavailable(`HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as RankResult;
}

export interface HeldContract {
  occSymbol: string;
  underlying: string;
}

export interface PositionHealthResult {
  model_run_id: string;
  model_beats_baseline: boolean;
  //: keyed by occSymbol; a null value means no current view could be
  //: computed for that contract (expired, no quote today, no rate for its
  //: DTE) — see score_held_contracts's own docstring.
  contracts: Record<string, RankedContract | null>;
}

/**
 * Re-scores specific, already-held contracts against **today's** forecast
 * — the position-monitor path, not a fresh ranking. See
 * `services/quant/app/rank.py`'s `score_held_contracts` for why this is not
 * just `rankDay` called again.
 */
export async function positionHealth(day: string, contracts: HeldContract[]): Promise<PositionHealthResult> {
  if (contracts.length === 0) {
    return { model_run_id: '', model_beats_baseline: false, contracts: {} };
  }
  let res: Response;
  try {
    res = await fetch(`${config.market.quantUrl}/position-health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        day,
        contracts: contracts.map((c) => ({ occ_symbol: c.occSymbol, underlying: c.underlying })),
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new QuantUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (res.status === 409) {
    const body = (await res.json()) as { detail: string };
    throw new QuantRefusal(body.detail);
  }
  if (!res.ok) {
    throw new QuantUnavailable(`HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as PositionHealthResult;
}

export interface SelectEntriesInput {
  day: string;
  heldUnderlyings: string[];
  availableCapital: number;
  openPositionCount: number;
  /** Model entries already opened for this trading day, across every
   * invocation — counted from the decision log so a rerun after a server
   * restart tops up instead of double-spending the daily budget. */
  openedToday: number;
  maxConcurrentPositions: number;
  maxNewPositions: number;
  minEvPerRisk: number;
  minProbProfit: number;
  minDte: number;
  maxDte: number;
}

/**
 * A chosen contract and how much of it to buy. Size comes back from the
 * sidecar rather than being decided here — see `select_entries` for why
 * position sizing is part of the selection decision, not a caller detail.
 */
export interface SelectedEntry {
  contract: RankedContract;
  quantity: number;
  cost: number;
}

/** A candidate the allocator considered and did not take, with the rule
 * that stopped it. Persisted to `paper_decision_log` — see that table on
 * why the reasoning behind a *rejection* is worth as much as the pick. */
export interface RejectedEntry {
  contract: RankedContract;
  reason: string;
  detail: Record<string, unknown>;
}

/** A contract the quote screens rejected before ranking priced it — no EV,
 * but still loggable, or "why didn't it buy X" answers with silence for
 * the exact class of contract that motivated the decision log. */
export interface ScreenedOutEntry {
  occ_symbol: string;
  underlying: string;
  reason: string;
}

export interface SelectEntriesResult {
  model_run_id: string;
  model_beats_baseline: boolean;
  selected: SelectedEntry[];
  rejected: RejectedEntry[];
  /** Optional for compatibility with a sidecar one release behind. */
  screened_out?: ScreenedOutEntry[];
}

/**
 * Ranks and then capital-constrains today's entry candidates in one call —
 * see `select_entries` in `services/quant/app/rank.py` for the allocation
 * rule. The account's real state (available capital, open position count,
 * held underlyings) is supplied by the caller; the selection itself is
 * Python's, so the sizing logic lives with the rest of the decision math.
 */
export async function selectEntries(input: SelectEntriesInput): Promise<SelectEntriesResult> {
  let res: Response;
  try {
    res = await fetch(`${config.market.quantUrl}/select-entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        day: input.day,
        held_underlyings: input.heldUnderlyings,
        available_capital: input.availableCapital,
        open_position_count: input.openPositionCount,
        opened_today: input.openedToday,
        max_concurrent_positions: input.maxConcurrentPositions,
        max_new_positions: input.maxNewPositions,
        min_ev_per_risk: input.minEvPerRisk,
        min_prob_profit: input.minProbProfit,
        min_dte: input.minDte,
        max_dte: input.maxDte,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new QuantUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (res.status === 409) {
    const body = (await res.json()) as { detail: string };
    throw new QuantRefusal(body.detail);
  }
  if (!res.ok) {
    throw new QuantUnavailable(`HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as SelectEntriesResult;
}

/**
 * The model-performance dashboard's payload. A pass-through: every number
 * here is computed in `services/quant/app/performance.py`, because a
 * TypeScript reimplementation of a model-quality statistic would be a
 * second definition of "is this model any good" free to drift from the
 * one the training harness uses.
 *
 * `metrics` is deliberately loose. Runs registered before a metric existed
 * simply lack that key — the two runs from before the honest-IC work carry
 * no `ic_mean` at all — and the UI must render that as "not recorded"
 * rather than as a zero, which would plot a real model as having no skill.
 */
export interface ModelPerformance {
  target: string;
  runs: Array<{
    run_id: string;
    registered_at: string;
    status: string;
    metrics: Record<string, number | boolean | null | undefined>;
    /** Whether this run has a curve, without shipping it — lets the UI
     * offer only the runs that have one. */
    has_loss_curve: boolean;
  }>;
  /** The run the dashboard should lead with — the champion when one
   * exists. Distinct from `latest_run_id` on purpose: the system serves
   * the champion, so headlining the newest registration would describe a
   * model that is not running. */
  featured_run_id: string | null;
  featured_is_champion: boolean;
  latest_run_id: string | null;
  /** `{fold: {train: number[], validation: number[]}}`, empty when the run
   * predates loss-history recording. */
  loss_curve: Record<string, { train?: number[]; validation?: number[] }>;
}

export async function modelPerformance(target = 'dir', run?: string): Promise<ModelPerformance> {
  let res: Response;
  const query = new URLSearchParams({ target });
  // Only one run's curve travels per request — see performance.py on why
  // inlining every run's would grow the payload without bound.
  if (run) query.set('run', run);
  try {
    res = await fetch(`${config.market.quantUrl}/stock/performance?${query}`, {
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new QuantUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new QuantUnavailable(`HTTP ${res.status} ${res.statusText}`);
  return (await res.json()) as ModelPerformance;
}

export interface ExitTarget {
  targetExitPriceE4: number;
  stopLossPriceE4: number;
  targetExitDate: string;
}

export type ExitAction = 'hold' | 'exit_now' | 'needs_review';

/**
 * A first-pass exit plan for a position that is *already* open.
 *
 * The entry-time paths (`/rank`, `/select-entries`) attach a plan to every
 * contract they suggest, so this exists only for positions that ended up
 * with none — opened before the exit engine existed, or through a path
 * whose plan-write did not land. Such a position is invisible to
 * `managedOpenOrders()` and so is never managed at all, which is strictly
 * worse than a plan computed a few days late.
 *
 * `targetE4` is null when the contract is too close to expiry for any
 * honest target to exist; `refusal` then says why. That is not an error —
 * the position stays unmanaged, which is the correct answer rather than a
 * fabricated target inside the DTE floor.
 */
export interface ComputeExitTargetResult {
  targetE4: ExitTarget | null;
  refusal: string | null;
  horizon: number;
  modelRunId: string;
}

export interface ComputeExitTargetInput {
  entryPriceE4: number;
  expiry: string;
  /** Normally today, not the original entry day — see the Python docstring. */
  anchorDay: string;
}

export async function computeExitTarget(input: ComputeExitTargetInput): Promise<ComputeExitTargetResult> {
  let res: Response;
  try {
    res = await fetch(`${config.market.quantUrl}/exit-target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entry_price: input.entryPriceE4 / 10_000,
        expiry: input.expiry,
        anchor_day: input.anchorDay,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new QuantUnavailable(err instanceof Error ? err.message : String(err));
  }
  // A 409 means the sidecar has no usable model to read a horizon from —
  // a refusal about the model, not about this position, so it surfaces as
  // QuantRefusal the same way the ranking paths' 409s do.
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new QuantRefusal(body.detail ?? 'Quant service refused to compute an exit target.');
  }
  if (!res.ok) {
    throw new QuantUnavailable(`HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    target: { target_exit_price: number; stop_loss_price: number; target_exit_date: string } | null;
    refusal: string | null;
    horizon: number;
    model_run_id: string;
  };
  return {
    targetE4:
      body.target === null
        ? null
        : {
            targetExitPriceE4: Math.round(body.target.target_exit_price * 10_000),
            stopLossPriceE4: Math.round(body.target.stop_loss_price * 10_000),
            targetExitDate: body.target.target_exit_date,
          },
    refusal: body.refusal,
    horizon: body.horizon,
    modelRunId: body.model_run_id,
  };
}

export interface ExitDecisionResult {
  action: ExitAction;
  newTargetExitPriceE4: number | null;
  newTargetExitDate: string | null;
  /** A raised trailing stop the caller must persist, or null when the stop
   * is unchanged. Only ever higher than the stop it replaces — see
   * `evaluate_exit` in exit.py. */
  newStopLossPriceE4: number | null;
  reason: string;
  triggeredBy: string;
}

export interface EvaluateExitInput {
  currentPriceE4: number;
  dte: number;
  target: ExitTarget;
  entryEv?: number;
  currentEv?: number;
  newDocumentsCount?: number;
  /** Operating trading day, for the horizon time-stop — see exit.py. */
  today?: string;
  /** Entry price E4, for the breakeven ratchet. */
  entryPriceE4?: number;
  /** "Would this clear the entry bar today" floor for the horizon
   * time-stop, in per-contract dollars — see evaluate_exit. */
  horizonEvFloor?: number;
}

/**
 * Every time the intraday exit job fires — see
 * `apps/server/src/lib/options/exitEngine.ts` and `exit.py`'s own module
 * docstring for why this never re-derives EV or re-runs the model itself:
 * the caller already has a live price and today's once-daily health view,
 * and this call is cheap arithmetic against both.
 */
export async function evaluateExit(input: EvaluateExitInput): Promise<ExitDecisionResult> {
  let res: Response;
  try {
    res = await fetch(`${config.market.quantUrl}/exit-decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        current_price: input.currentPriceE4 / 10_000,
        dte: input.dte,
        target: {
          target_exit_price: input.target.targetExitPriceE4 / 10_000,
          stop_loss_price: input.target.stopLossPriceE4 / 10_000,
          target_exit_date: input.target.targetExitDate,
        },
        entry_ev: input.entryEv ?? null,
        current_ev: input.currentEv ?? null,
        new_documents_count: input.newDocumentsCount ?? 0,
        today: input.today ?? null,
        entry_price: input.entryPriceE4 !== undefined ? input.entryPriceE4 / 10_000 : null,
        horizon_ev_floor: input.horizonEvFloor ?? 0,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new QuantUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    throw new QuantUnavailable(`HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    action: ExitAction;
    new_target_exit_price: number | null;
    new_target_exit_date: string | null;
    new_stop_loss_price: number | null;
    reason: string;
    triggered_by: string;
  };
  return {
    action: body.action,
    newTargetExitPriceE4: body.new_target_exit_price !== null ? Math.round(body.new_target_exit_price * 10_000) : null,
    newTargetExitDate: body.new_target_exit_date,
    newStopLossPriceE4: body.new_stop_loss_price !== null ? Math.round(body.new_stop_loss_price * 10_000) : null,
    reason: body.reason,
    triggeredBy: body.triggered_by,
  };
}
