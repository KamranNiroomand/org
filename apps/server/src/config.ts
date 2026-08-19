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
  // runner = produces the corpus. reader = displays it. See config.market.role.
  MARKET_ROLE: z.enum(['runner', 'reader']).default('runner'),
  // Reader only: SSH target the corpus is pulled from, e.g. "user@host.local".
  RUNNER_SSH_HOST: z.string().optional(),
  // Path to MARKET_DATA_DIR on the runner, if different from this machine's.
  RUNNER_DATA_DIR: z.string().optional(),
  MARKET_DB_PATH: z.string().optional(),
  // Separate from market.db on purpose — see config.market.paperDbPath.
  PAPER_DB_PATH: z.string().optional(),
  POLYGON_API_KEY: z.string().optional(),
  QUANT_URL: z.string().default('http://127.0.0.1:5175'),
  OPTIONS_CAPTURE_CRON: z.string().default('45 16 * * 1-5'),
  // Weekly, Sunday morning — capture only runs weekdays (see
  // OPTIONS_CAPTURE_CRON's 1-5), so by Sunday the corpus already has
  // Friday's close as its latest day; no reason to wait further into the
  // week. Local time, like the nightly bank sync: a quiet moment on the
  // runner's own clock, not the market's.
  RETRAIN_CRON: z.string().default('0 8 * * 0'),
  // Artificial starting balance for the paper book, in whole dollars.
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive().default(100_000),
  // SEC EDGAR's fair-access policy requires every request to identify a real
  // contact — an unidentified or generic User-Agent gets rate-limited or
  // blocked outright. No default: this one has to name a real person or org.
  SEC_EDGAR_USER_AGENT: z.string().optional(),

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
    /**
     * A paper trade is the user's own decision, made from whichever machine
     * they're looking at the UI on — a reader as often as the runner. Kept
     * as a physically separate file from `market.db`, in the same directory
     * but never touched by `market:pull`'s single-file rsync, because that
     * pull replaces `market.db` wholesale: a paper order that lived inside
     * it would be silently destroyed by the next pull. See paper/schema.ts.
     */
    paperDbPath: env.PAPER_DB_PATH ?? join(marketDataDir, 'paper.db'),
    archiveDir: join(marketDataDir, 'quotes'),
    modelsDir: join(marketDataDir, 'models'),
    /** Days of quotes kept in SQLite before archival moves them to Parquet. */
    hotWindowDays: 90,

    /**
     * Which side of a two-machine setup this process is.
     *
     * The corpus can live in a synced folder — Google Drive, iCloud, Dropbox —
     * shared between a machine that produces it and one that displays it. That
     * arrangement has exactly one rule, and breaking it is silent and
     * expensive: **one writer, many readers.** Two machines writing the same
     * synced files produce conflicted copies, and a Parquet file caught
     * mid-sync is simply corrupt.
     *
     *   runner  captures chains, trains, writes the corpus. One machine only.
     *   reader  reads the corpus and renders it. Never writes to the shared
     *           directory, and never schedules a capture.
     *
     * A reader still writes its *own* local SQLite, which is a cache rebuilt
     * from the Parquet rather than shared state. That distinction is the whole
     * reason the corpus is Parquet-first: the file two machines both touch has
     * to be one that tolerates being copied whole.
     */
    role: env.MARKET_ROLE,
    isRunner: env.MARKET_ROLE === 'runner',
    runnerSshHost: env.RUNNER_SSH_HOST ?? null,
    runnerDataDir: env.RUNNER_DATA_DIR ?? null,
    polygonKey: env.POLYGON_API_KEY ?? null,
    configured: Boolean(env.POLYGON_API_KEY),
    /**
     * The Python sidecar. Prices contracts, builds features, trains and
     * backtests; reads market.db directly and returns JSON we persist.
     */
    quantUrl: env.QUANT_URL,
    /**
     * Chains are captured after the US close, not at 06:00 with the rest of
     * the nightly job — a snapshot taken next morning would pair tomorrow's
     * underlying price with yesterday's quotes.
     *
     * **Interpreted in US Eastern, not the host's local time.** This schedule
     * belongs to the market's clock rather than yours: the same wall-clock
     * time is 45 minutes after the close in Toronto and exactly on the bell in
     * Newfoundland. The 06:00 bank sync is correctly local, because that one
     * is about your morning; this one is about the closing auction.
     *
     * 16:45 Eastern leaves room for the closing prints and for the 15-minute
     * delay on the data plan.
     */
    captureCron: env.OPTIONS_CAPTURE_CRON,
    captureTimezone: 'America/New_York',
    /**
     * Weekly retrain — runs `train.py` on an expanding window and registers
     * the result as a new challenger. Never promotes anything automatically;
     * see the `model_runs` doc comment and the manual
     * `/api/quant/runs/:id/promote` route for why.
     */
    retrainCron: env.RETRAIN_CRON,
    /** E4 — same unit as every other dollar figure in this database. */
    paperStartingBalanceE4: Math.round(env.PAPER_STARTING_BALANCE_USD * 10_000),
    /** See SEC_EDGAR_USER_AGENT above — null disables EDGAR ingestion cleanly. */
    edgarUserAgent: env.SEC_EDGAR_USER_AGENT ?? null,
  },

  syncCron: env.SYNC_CRON,
  defaultCalendar: env.DEFAULT_CALENDAR,
  baseCurrency: env.BASE_CURRENCY,
} as const;

export type Config = typeof config;
