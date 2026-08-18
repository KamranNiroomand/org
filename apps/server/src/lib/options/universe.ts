import { and, eq, gte, sql } from 'drizzle-orm';
import { marketDb } from '../../db/market/index.js';
import { trackedUnderlyings, optionQuotes, optionContracts } from '../../db/market/schema.js';
import { SP500 } from '../../data/sp500.js';
import { NASDAQ_100_SET } from '../../data/indices.js';
import { NON_EQUITY_LIKE, OPTION_ETFS } from '../../data/optionEtfs.js';
import { nowIso } from '../util.js';

/**
 * Which underlyings we capture chains for.
 *
 * Roughly 520 names: the S&P 500, the handful of Nasdaq-100 members outside
 * it, and the ETFs with genuinely active options markets. US listings only —
 * Canadian equity options trade on the Montreal Exchange in far thinner size,
 * and a contract nobody trades produces quotes nobody can fill.
 *
 * Two jobs, deliberately separated:
 *
 *   `research`  breadth for the model to learn from. Cross-sectional context
 *               is most of the signal — a name's implied vol only means
 *               something relative to its sector's and to the market's — so
 *               this wants to be wide.
 *   `core`      names whose contracts routinely clear the liquidity gate, and
 *               therefore where a ranked candidate could actually be filled.
 *
 * The initial tier is a **hypothesis**, not a judgement: ETFs and Nasdaq-100
 * members are a decent first guess at where option liquidity lives. Once
 * capture has run, `retierByLiquidity` replaces the guess with the measured
 * fraction of that name's contracts that actually passed the gate. Guessing is
 * only acceptable until there is data, and then it isn't.
 */

/**
 * Class shares are spelled three different ways by three parties: this repo
 * follows Yahoo (`BRK-B`), Polygon uses a dot (`BRK.B`), and the OCC option
 * root strips the separator entirely (`BRKB`). Normalizing here keeps that
 * mess in one place rather than scattered through capture and backfill.
 */
export const toVendorSymbol = (symbol: string): string => symbol.replace(/-/g, '.');
export const toOccRoot = (symbol: string): string => symbol.replace(/[.-]/g, '');

export interface UniverseRow {
  symbol: string;
  name: string;
  sector: string | null;
  tier: 'core' | 'research';
}

/** The full intended universe, before anything touches the database. */
export function buildUniverse(): UniverseRow[] {
  const rows = new Map<string, UniverseRow>();

  for (const [symbol, name, sector] of SP500) {
    rows.set(symbol, {
      symbol,
      name,
      sector,
      // Nasdaq-100 membership is a rough proxy for option activity: it skews
      // toward large, heavily-traded, high-volatility names.
      tier: NASDAQ_100_SET.has(symbol) ? 'core' : 'research',
    });
  }

  // Nasdaq-100 members outside the S&P 500 — mostly foreign-domiciled. We have
  // no name or sector for these, and inventing one would be worse than null.
  for (const symbol of NASDAQ_100_SET) {
    if (!rows.has(symbol)) {
      rows.set(symbol, { symbol, name: symbol, sector: null, tier: 'core' });
    }
  }

  for (const etf of OPTION_ETFS) {
    rows.set(etf.symbol, {
      symbol: etf.symbol,
      name: etf.name,
      sector: `ETF / ${etf.kind}`,
      // Volatility and leveraged products never start in the core: their
      // prices decay structurally rather than informatively, so a model should
      // meet them as cross-sectional context, not as trade candidates.
      tier: NON_EQUITY_LIKE.has(etf.symbol) ? 'research' : 'core',
    });
  }

  return [...rows.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export interface SeedResult {
  total: number;
  inserted: number;
  reactivated: number;
}

/**
 * Writes the universe into the database, idempotently.
 *
 * Existing rows keep their tier, because by then it may have been set from
 * measured liquidity and re-seeding must not overwrite evidence with a guess.
 */
export function seedUniverse(): SeedResult {
  const rows = buildUniverse();
  const now = nowIso();

  const existing = new Map(
    marketDb
      .select({ symbol: trackedUnderlyings.symbol, active: trackedUnderlyings.active })
      .from(trackedUnderlyings)
      .all()
      .map((r) => [r.symbol, r.active]),
  );

  let inserted = 0;
  let reactivated = 0;

  for (const row of rows) {
    if (!existing.has(row.symbol)) {
      marketDb
        .insert(trackedUnderlyings)
        .values({ ...row, active: true, addedAt: now })
        .run();
      inserted += 1;
      continue;
    }
    if (existing.get(row.symbol) === false) {
      marketDb
        .update(trackedUnderlyings)
        .set({ active: true })
        .where(eq(trackedUnderlyings.symbol, row.symbol))
        .run();
      reactivated += 1;
    }
  }

  return { total: rows.length, inserted, reactivated };
}

export function listUniverse(opts: { tier?: 'core' | 'research'; activeOnly?: boolean } = {}) {
  const conditions = [];
  if (opts.tier) conditions.push(eq(trackedUnderlyings.tier, opts.tier));
  if (opts.activeOnly !== false) conditions.push(eq(trackedUnderlyings.active, true));

  return marketDb
    .select()
    .from(trackedUnderlyings)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(trackedUnderlyings.symbol)
    .all();
}

export interface RetierResult {
  evaluated: number;
  promoted: string[];
  demoted: string[];
}

/**
 * Replaces the seeded tier guess with measured option liquidity.
 *
 * A name is `core` when a meaningful share of its captured contracts cleared
 * the gate. That is the only definition that means anything: index membership
 * says a company is large, not that its options can be traded out of. Names
 * with too few observations are left alone rather than demoted, because
 * absence of data is not evidence of illiquidity.
 */
export function retierByLiquidity(
  lookbackDays = 21,
  minLiquidFraction = 0.15,
  minObservations = 200,
): RetierResult {
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  const stats = marketDb
    .select({
      symbol: optionContracts.underlying,
      total: sql<number>`count(*)`,
      liquid: sql<number>`sum(case when ${optionQuotes.liquid} then 1 else 0 end)`,
    })
    .from(optionQuotes)
    .innerJoin(optionContracts, eq(optionQuotes.occSymbol, optionContracts.occSymbol))
    .where(gte(optionQuotes.tradingDay, since))
    .groupBy(optionContracts.underlying)
    .all();

  const current = new Map(
    marketDb
      .select({ symbol: trackedUnderlyings.symbol, tier: trackedUnderlyings.tier })
      .from(trackedUnderlyings)
      .all()
      .map((r) => [r.symbol, r.tier]),
  );

  const promoted: string[] = [];
  const demoted: string[] = [];

  for (const s of stats) {
    if (s.total < minObservations) continue;
    const fraction = s.liquid / s.total;
    const target = fraction >= minLiquidFraction ? 'core' : 'research';
    const was = current.get(s.symbol);
    if (!was || was === target) continue;

    marketDb
      .update(trackedUnderlyings)
      .set({ tier: target })
      .where(eq(trackedUnderlyings.symbol, s.symbol))
      .run();
    (target === 'core' ? promoted : demoted).push(s.symbol);
  }

  return { evaluated: stats.length, promoted, demoted };
}
