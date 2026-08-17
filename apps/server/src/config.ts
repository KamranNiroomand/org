import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Environment parsing. Anything invalid stops the process here rather than
 * surfacing as a confusing failure ten minutes into a bank sync.
 */

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(5174),
  BIND_LAN: bool,
  APP_PASSWORD: z.string().optional(),
  DB_PATH: z.string().optional(),

  PLAID_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_COUNTRY_CODES: z.string().default('CA,US'),
  SYNC_CRON: z.string().default('0 6 * * *'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),

  // Options research. Market data lives in its own directory tree, separate
  // from org.db — see src/db/market/schema.ts for why.
  MARKET_DATA_DIR: z.string().optional(),
  MARKET_DB_PATH: z.string().optional(),
  POLYGON_API_KEY: z.string().optional(),
  QUANT_URL: z.string().default('http://127.0.0.1:5175'),
  OPTIONS_CAPTURE_CRON: z.string().default('30 17 * * 1-5'),

  DEFAULT_CALENDAR: z.enum(['miladi', 'shamsi']).default('miladi'),
  BASE_CURRENCY: z.string().default('CAD'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}
const env = parsed.data;

/**
 * Root of the market research corpus. Hoisted because four paths derive from
 * it, and a default repeated four times is a default that eventually disagrees
 * with itself.
 */
const marketDataDir = env.MARKET_DATA_DIR ?? join(homedir(), '.org', 'market');

/**
 * Binding to the LAN puts a database of bank transactions on whatever network
 * you happen to be joined to. The password isn't optional in that case — the
 * two ship together or not at all.
 */
if (env.BIND_LAN && !env.APP_PASSWORD) {
  console.error(
    'BIND_LAN=true exposes this app — and your financial data — to your local\n' +
      'network. Set APP_PASSWORD in .env, or set BIND_LAN=false to stay on\n' +
      'localhost only.',
  );
  process.exit(1);
}

export const config = {
  port: env.PORT,
  host: env.BIND_LAN ? '0.0.0.0' : '127.0.0.1',
  bindLan: env.BIND_LAN,
  password: env.APP_PASSWORD ?? null,

  /** Outside the repo by default, so it can never be committed by accident. */
  dbPath: env.DB_PATH ?? join(homedir(), '.org', 'org.db'),
  dbDir: env.DB_PATH ? join(env.DB_PATH, '..') : join(homedir(), '.org'),

  plaid: {
    env: env.PLAID_ENV,
    clientId: env.PLAID_CLIENT_ID ?? null,
    secret: env.PLAID_SECRET ?? null,
    countryCodes: env.PLAID_COUNTRY_CODES.split(',').map((c) => c.trim()).filter(Boolean),
    configured: Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET),
  },

  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY ?? null,
    model: env.ANTHROPIC_MODEL,
    configured: Boolean(env.ANTHROPIC_API_KEY),
  },

  /**
   * Option chains and bars, kept out of org.db so a multi-gigabyte table never
   * lands inside the backup that covers your bank transactions.
   *
   * Everything lives under one directory so the whole research corpus is a
   * single `rsync` away from another machine. Within it:
   *
   *   quotes/   Parquet, month-partitioned, zstd — the **system of record**
   *   market.db SQLite hot window (~90 days) + metadata — **rebuildable**
   *   models/   trained artifacts
   *
   * Parquet is authoritative rather than the database because option quote
   * data is integer-heavy and compresses five to ten times better there, and
   * because a schema change should cost a local rebuild rather than re-pulling
   * two years of history from the vendor.
   */
  market: {
    dataDir: marketDataDir,
    dbPath: env.MARKET_DB_PATH ?? join(marketDataDir, 'market.db'),
    archiveDir: join(marketDataDir, 'quotes'),
    modelsDir: join(marketDataDir, 'models'),
    /** Days of quotes kept in SQLite before archival moves them to Parquet. */
    hotWindowDays: 90,
    polygonKey: env.POLYGON_API_KEY ?? null,
    configured: Boolean(env.POLYGON_API_KEY),
    /**
     * The Python sidecar. Prices contracts, builds features, trains and
     * backtests; reads market.db directly and returns JSON we persist.
     */
    quantUrl: env.QUANT_URL,
    /**
     * Chains are captured after the US close, not at 06:00 with the rest of
     * the nightly job — a snapshot taken the next morning would carry the
     * following day's underlying price against the previous day's quotes.
     * 17:30 on weekdays, local time, is comfortably after 16:00 ET.
     */
    captureCron: env.OPTIONS_CAPTURE_CRON,
  },

  syncCron: env.SYNC_CRON,
  defaultCalendar: env.DEFAULT_CALENDAR,
  baseCurrency: env.BASE_CURRENCY,
} as const;

export type Config = typeof config;
