import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { config } from '../../config.js';
import type { TradierQuote } from './tradier.js';

/**
 * IBKR quote overlay — real NBBO bid/ask via the Client Portal Gateway.
 *
 * Same contract as the Tradier overlay it can stand in for (see
 * tradier.ts): NOT a corpus provider, just "the touchable price for the
 * contract in front of me, right now", asked once per engine pass for
 * the handful of open positions. Never throws into the engine — any
 * failure degrades to an empty map and the print-basis path takes over.
 *
 * Why the Gateway and not the Web API's OAuth: IBKR's hosted Web API
 * authenticates with private_key_jwt (RFC 7523), which requires client
 * registration — an institutional integration path. The Client Portal
 * Gateway is the retail path: a small IBKR-provided app the user runs
 * and logs into once; it holds the brokerage session and exposes the
 * same REST endpoints on localhost. `IBKR_GATEWAY_URL` (e.g.
 * "https://localhost:5000/v1/api") is the only configuration, and this
 * module is dormant until it is set.
 *
 * The gateway serves a self-signed certificate. TLS verification is
 * relaxed ONLY for loopback hosts — a non-local gateway URL gets full
 * verification, so the relaxation can never be repurposed to talk to an
 * arbitrary host insecurely.
 *
 * Quote flow, per the CP API's own shape:
 *   1. underlying conid:  GET /trsrv/stocks?symbols=GWW
 *   2. option conid:      GET /iserver/secdef/info?conid=..&sectype=OPT
 *                             &month=OCT26&strike=1380&right=C
 *      (filtered to the exact maturityDate — one month can hold several
 *      weeklies), cached per OCC symbol for the process lifetime.
 *   3. quotes:            GET /iserver/marketdata/snapshot?conids=..
 *                             &fields=31,84,86  (last, bid, ask)
 *      The first snapshot for a conid primes the subscription and may
 *      return no fields; one short retry covers it.
 */

const FIELD_LAST = '31';
const FIELD_BID = '84';
const FIELD_ASK = '86';

export function ibkrConfigured(): boolean {
  return config.market.ibkrGatewayUrl !== null;
}

/** conid cache — resolution costs two round-trips; contracts don't move. */
const conidByOcc = new Map<string, number>();

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

interface OccParts {
  underlying: string;
  /** YYYYMMDD, the CP API's maturityDate spelling. */
  maturity: string;
  /** e.g. "OCT26" — the CP API's month parameter. */
  month: string;
  strike: number;
  right: 'C' | 'P';
}

/** Our padded 21-char OCC symbol, split into the CP API's vocabulary. */
export function parseOcc(occSymbol: string): OccParts | null {
  const m = occSymbol.match(/^([A-Z.]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, underlying, yy, mm, dd, right, strikeRaw] = m;
  if (!underlying || !yy || !mm || !dd || !right || !strikeRaw) return null;
  const monthIdx = Number(mm) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return {
    underlying,
    maturity: `20${yy}${mm}${dd}`,
    month: `${MONTHS[monthIdx]}${yy}`,
    strike: Number(strikeRaw) / 1000,
    right: right as 'C' | 'P',
  };
}

/** JSON GET tolerant of the gateway's self-signed loopback certificate. */
export function gatewayGet(base: string, path: string): Promise<unknown> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(base.replace(/\/$/, '') + path);
    } catch {
      resolve(null);
      return;
    }
    const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    // Plain http is permitted for the gateway on loopback only (its
    // listenSsl:false mode — traffic never leaves the machine); any
    // remote gateway URL must be https, full verification.
    if (url.protocol === 'http:' && !isLoopback) {
      resolve(null);
      return;
    }
    const makeRequest = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = makeRequest(
      url,
      {
        method: 'GET',
        rejectUnauthorized: !isLoopback,
        headers: { accept: 'application/json', 'user-agent': 'org-paper-engine' },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

type GetFn = typeof gatewayGet;

async function resolveConid(base: string, occ: string, get: GetFn): Promise<number | null> {
  const cached = conidByOcc.get(occ);
  if (cached !== undefined) return cached;
  const parts = parseOcc(occ);
  if (!parts) return null;

  const stocks = (await get(base, `/trsrv/stocks?symbols=${encodeURIComponent(parts.underlying)}`)) as
    | Record<string, Array<{ contracts?: Array<{ conid?: number; isUS?: boolean }> }>>
    | null;
  const listings = stocks?.[parts.underlying]?.flatMap((s) => s.contracts ?? []) ?? [];
  const underlyingConid = listings.find((c) => c.isUS !== false && typeof c.conid === 'number')?.conid;
  if (underlyingConid === undefined) return null;

  const info = (await get(
    base,
    `/iserver/secdef/info?conid=${underlyingConid}&sectype=OPT` +
      `&month=${parts.month}&strike=${parts.strike}&right=${parts.right}`,
  )) as Array<{ conid?: number; maturityDate?: string; right?: string }> | null;
  const exact = (Array.isArray(info) ? info : []).find(
    (c) => c.maturityDate === parts.maturity && typeof c.conid === 'number',
  );
  if (!exact?.conid) return null;
  conidByOcc.set(occ, exact.conid);
  return exact.conid;
}

const toE4 = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10_000) : null;
};

export async function fetchIbkrQuotes(
  occSymbols: readonly string[],
  get: GetFn = gatewayGet,
  primeDelayMs = 400,
): Promise<Map<string, TradierQuote>> {
  const out = new Map<string, TradierQuote>();
  const base = config.market.ibkrGatewayUrl;
  if (!base || occSymbols.length === 0) return out;

  // Nudges the gateway's brokerage session — required before market
  // data; the result itself is irrelevant and failure is not fatal
  // (the snapshot call below fails on its own terms if the session is
  // truly dead).
  await get(base, '/iserver/accounts');

  const conids = new Map<number, string>();
  for (const occ of occSymbols) {
    const conid = await resolveConid(base, occ, get);
    if (conid !== null) conids.set(conid, occ);
  }
  if (conids.size === 0) return out;

  const path =
    `/iserver/marketdata/snapshot?conids=${[...conids.keys()].join(',')}` +
    `&fields=${FIELD_LAST},${FIELD_BID},${FIELD_ASK}`;
  let rows = (await get(base, path)) as Array<Record<string, unknown>> | null;
  const hasQuotes = (r: typeof rows) =>
    Array.isArray(r) && r.some((row) => FIELD_BID in row || FIELD_ASK in row || FIELD_LAST in row);
  if (!hasQuotes(rows)) {
    // First snapshot primes the subscription; ask once more.
    await new Promise((r) => setTimeout(r, primeDelayMs));
    rows = (await get(base, path)) as Array<Record<string, unknown>> | null;
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const conid = typeof row.conid === 'number' ? row.conid : Number(row.conid);
    const occ = conids.get(conid);
    if (!occ) continue;
    out.set(occ, { bidE4: toE4(row[FIELD_BID]), askE4: toE4(row[FIELD_ASK]), lastE4: toE4(row[FIELD_LAST]) });
  }
  return out;
}
