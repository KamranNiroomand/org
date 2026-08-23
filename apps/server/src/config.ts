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
  // The heuristic radar (score.ts/run.ts) — org.db only, no MARKET_ROLE
  // gate, so it runs on a reader just as well as a runner. Right after the
  // market sweep so `instruments` is fresh for that trading day.
  RADAR_CRON: z.string().default('15 6 * * *'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),

  // Multi-agent panel (Milestone 4) — the expensive, bounded-on-purpose part
  // of the signal system. See lib/agents/panel/budget.ts's own module
  // comment for why a hard call cap exists at all: this app already lost
  // 321/566 symbols one night to an unpaced vendor call before that pacer
  // was built, and an LLM panel needs the equivalent guard from day one.
  PANEL_CRON: z.string().default('0 7 * * *'),
  // Each symbol already runs 4 specialists concurrently — a symbol
  // concurrency above 1 multiplies that, so 2 symbols in flight means up to
  // 8 simultaneous Anthropic calls. withBudget caps total *spend*, not
  // concurrent *rate*, so this is the actual knob against tripping
  // claude-opus-5's per-minute/concurrent limits. Sequential across symbols
  // by default — a nightly run has no deadline to hit, so there's nothing
  // bought by parallelizing symbols that isn't also a rate-limit risk.
  PANEL_SYMBOL_CONCURRENCY: z.coerce.number().int().positive().default(1),
  PANEL_MAX_SYMBOLS_PER_NIGHTLY_SHORTLIST: z.coerce.number().int().positive().default(10),
  PANEL_MAX_SYMBOLS_PER_BOX_QUERY: z.coerce.number().int().positive().default(8),
  PANEL_MAX_CALLS_PER_RUN: z.coerce.number().int().positive().default(150),

  // Real-estate investment assistant — location + rental agents (2 rounds
  // each, web_search-enabled) plus one manager synthesis call. 5 is the
  // exact call count the run actually makes (2 agents x 2 rounds + 1), same
  // precision as PANEL_MAX_CALLS_PER_RUN's own sizing against CALLS_PER_SYMBOL.
  RE_MAX_CALLS_PER_RUN: z.coerce.number().int().positive().default(5),

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
  // See polygon.ts's own doc comment: the vendor's per-minute ceiling is
  // undisclosed, and the first real capture runs sustained well past it —
  // 321 of 566 symbols lost to 429s, every night, for three nights running.
  // Conservative default; lower it if 429s persist, raise it once a run
  // shows clean headroom.
  POLYGON_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  QUANT_URL: z.string().default('http://127.0.0.1:5175'),
  OPTIONS_CAPTURE_CRON: z.string().default('45 16 * * 1-5'),
  // News/EDGAR ingestion + classification, independent of the once-nightly
  // capture cadence above — see the module doc comment on why: a headline
  // that breaks at 10am is stale by the time the 16:45 capture job would
  // otherwise be the first thing to notice it. Every 20 minutes, market
  // hours only, matching the actual news-generating window — running it
  // through the night would just spend the same request budget on silence.
  TEXT_SYNC_CRON: z.string().default('*/20 9-16 * * 1-5'),
  // Same idea as TEXT_SYNC_CRON, for the watchlist instead of the options
  // universe — a slower cadence on purpose. The watchlist is a handful of
  // symbols, not ~566, so there's no rate-limit budget to compete for; the
  // slower interval just reflects that a watchlist name breaking news 30
  // minutes late is a non-issue the options universe's own capture window
  // doesn't have the same slack for.
  WATCHLIST_TEXT_SYNC_CRON: z.string().default('*/30 9-16 * * 1-5'),
  // Weekly, Sunday morning — capture only runs weekdays (see
  // OPTIONS_CAPTURE_CRON's 1-5), so by Sunday the corpus already has
  // Friday's close as its latest day; no reason to wait further into the
  // week. Local time, like the nightly bank sync: a quiet moment on the
  // runner's own clock, not the market's.
  RETRAIN_CRON: z.string().default('0 8 * * 0'),
  // Artificial starting balance for the paper book, in whole dollars.
  PAPER_STARTING_BALANCE_USD: z.coerce.number().positive().default(100_000),
  // Auto-entry: once/day, every candidate clearing both bars below (and
  // fitting the capital/count constraints further down) is opened
  // automatically as a `source: 'model'` paper order — see autoEntry.ts and
  // rank.py's select_entries. Explicitly a first-pass gate, same honesty
  // framing as the radar's own eligibility floor: not backtested, just a
  // sanity bar against opening something the ranking itself considers
  // marginal.
  AUTO_ENTRY_MIN_EV_PER_RISK: z.coerce.number().default(0.05),
  AUTO_ENTRY_MIN_PROB_PROFIT: z.coerce.number().min(0).max(1).default(0.5),
  // Capital/count constraints on auto-entry — how many positions to open
  // is decided by what the market offers within these bounds, not a fixed
  // daily number. The reserve is the fraction of current cash never
  // deployed; see select_entries' docstring for the real $122k-contract
  // incident that made an explicit capital constraint non-optional.
  AUTO_ENTRY_MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive().default(10),
  AUTO_ENTRY_MAX_NEW_POSITIONS_PER_DAY: z.coerce.number().int().positive().default(5),
  AUTO_ENTRY_CAPITAL_RESERVE_PCT: z.coerce.number().min(0).max(1).default(0.2),
  // The adaptive exit engine — see exitEngine.ts and exit.py's own module
  // docstring. Market hours only, matching TEXT_SYNC_CRON's cadence
  // reasoning: nothing changes about a position's exit outside trading
  // hours, so polling then would just spend budget on silence.
  EXIT_RECHECK_CRON: z.string().default('*/15 9-16 * * 1-5'),
  // Same naming tier and reasoning as PANEL_MAX_CALLS_PER_RUN — a hard
  // ceiling on the LLM escalation path only (see exitEngine.ts's
  // `needs_review` handling); the deterministic rule path in exit.py never
  // spends an Anthropic call at all.
  EXIT_RECHECK_MAX_CALLS_PER_RUN: z.coerce.number().int().positive().default(30),
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

  panel: {
    cron: env.PANEL_CRON,
    symbolConcurrency: env.PANEL_SYMBOL_CONCURRENCY,
    maxSymbolsPerNightlyShortlist: env.PANEL_MAX_SYMBOLS_PER_NIGHTLY_SHORTLIST,
    maxSymbolsPerBoxQuery: env.PANEL_MAX_SYMBOLS_PER_BOX_QUERY,
    maxCallsPerRun: env.PANEL_MAX_CALLS_PER_RUN,
  },

  realEstate: {
    maxCallsPerRun: env.RE_MAX_CALLS_PER_RUN,
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
    polygonMaxRequestsPerMinute: env.POLYGON_MAX_REQUESTS_PER_MINUTE,
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
     * News/EDGAR ingestion + classification, on its own faster cadence —
     * see TEXT_SYNC_CRON's own comment for why this is split out from the
     * once-nightly capture job it used to live inside.
     */
    textSyncCron: env.TEXT_SYNC_CRON,
    /** Same idea, for the watchlist — see WATCHLIST_TEXT_SYNC_CRON's own comment. */
    watchlistTextSyncCron: env.WATCHLIST_TEXT_SYNC_CRON,
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
    /** See the AUTO_ENTRY_* block above and autoEntry.ts. */
    autoEntry: {
      minEvPerRisk: env.AUTO_ENTRY_MIN_EV_PER_RISK,
      minProbProfit: env.AUTO_ENTRY_MIN_PROB_PROFIT,
      maxConcurrentPositions: env.AUTO_ENTRY_MAX_CONCURRENT_POSITIONS,
      maxNewPositionsPerDay: env.AUTO_ENTRY_MAX_NEW_POSITIONS_PER_DAY,
      capitalReservePct: env.AUTO_ENTRY_CAPITAL_RESERVE_PCT,
    },
    /** See EXIT_RECHECK_CRON/EXIT_RECHECK_MAX_CALLS_PER_RUN above and exitEngine.ts. */
    exitRecheck: {
      cron: env.EXIT_RECHECK_CRON,
      maxCallsPerRun: env.EXIT_RECHECK_MAX_CALLS_PER_RUN,
    },
  },

  syncCron: env.SYNC_CRON,
  radarCron: env.RADAR_CRON,
  defaultCalendar: env.DEFAULT_CALENDAR,
  baseCurrency: env.BASE_CURRENCY,
} as const;

export type Config = typeof config;
