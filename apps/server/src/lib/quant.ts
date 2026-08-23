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

export interface ExitTarget {
  targetExitPriceE4: number;
  stopLossPriceE4: number;
  targetExitDate: string;
}

export type ExitAction = 'hold' | 'exit_now' | 'needs_review';

export interface ExitDecisionResult {
  action: ExitAction;
  newTargetExitPriceE4: number | null;
  newTargetExitDate: string | null;
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
    reason: string;
    triggered_by: string;
  };
  return {
    action: body.action,
    newTargetExitPriceE4: body.new_target_exit_price !== null ? Math.round(body.new_target_exit_price * 10_000) : null,
    newTargetExitDate: body.new_target_exit_date,
    reason: body.reason,
    triggeredBy: body.triggered_by,
  };
}
