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

export class QuantUnavailable extends Error {
  constructor(cause: string) {
    super(
      `Quant sidecar unreachable at ${config.market.quantUrl} — ${cause}. ` +
        `Start it with \`npm run dev:quant\`.`,
    );
    this.name = 'QuantUnavailable';
  }
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
