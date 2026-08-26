import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts'],
    // Every apps/server test that touches src/db/market shares ONE physical
    // SQLite file at MARKET_DATA_DIR below — there is no per-file isolation
    // of the corpus, only per-file isolation of JS module state, and module
    // isolation does not isolate a file on disk. Running test files in
    // parallel (Vitest's default) races their beforeEach/beforeAll resets
    // against each other's still-running tests: one file deletes a row
    // another file just inserted, or asserts a row count mid-write from a
    // different file. This surfaced as failures that differed between runs
    // of an unchanged suite — the signature of a race, not a logic bug —
    // the moment a second test file (paper.test.ts) started sharing the
    // same fixture contract as an existing one (capture.test.ts).
    fileParallelism: false,
    env: {
      // The calendar code reads local civil dates on purpose. Pinning the zone
      // keeps grid tests deterministic wherever they run — including CI.
      TZ: 'America/Toronto',
      // Importing anything under src/db/market opens a SQLite handle at import
      // time. Redirected here so a test run can never write to — or create — the
      // real research corpus, which by then holds years of captured quotes that
      // cannot be re-fetched.
      MARKET_DATA_DIR: join(tmpdir(), 'org-vitest-market'),
      // Same hazard, third time: paper.ts opens the paper trading database at
      // import time too, and it is a physically separate file from
      // market.db precisely so a real paper trade can never be silently
      // destroyed by a pull — redirecting it here is what keeps a test run
      // from being able to touch it in the first place.
      PAPER_DB_PATH: join(tmpdir(), 'org-vitest-paper', 'paper.db'),
      // The same hazard applies to the personal database — anything that
      // imports src/db/index.ts (categorize.ts, most of routes/) opens a
      // handle to it at import time, with no test ever having exercised that
      // path before this redirect existed. Left unredirected, a test as
      // innocuous-looking as "assert this function returns a category name"
      // would open a connection to real bank transactions as a side effect of
      // its own import chain.
      DB_PATH: join(tmpdir(), 'org-vitest-personal', 'org.db'),
      // Every quant-pricing test assumes the sidecar is unreachable — that's
      // the honest state of a fresh checkout, and capture/reprice must both
      // degrade to null vol rather than fail. Left at the default
      // 127.0.0.1:5175, a developer running `npm run dev` alongside `npm
      // test` gets a real sidecar answering `quantHealthy()`, and tests that
      // silently depend on that assumption start passing or failing on
      // timing rather than logic. Port 1 is privileged and unbound, so the
      // connection refuses immediately instead of timing out.
      QUANT_URL: 'http://127.0.0.1:1',
      // Accounting tests assert exact fill arithmetic; the spread haircut
      // is a *policy* layered on top of it, pinned to zero here so every
      // test states the number it means. The haircut math itself is
      // tested directly (paper.test.ts's haircutE4 cases) with explicit
      // parameters, and its live wiring is verified against the running
      // book, where its entire effect is a visible, intended equity drop.
      // The Tradier overlay tests inject their own fetch; the token just
      // has to exist for tradierConfigured() to say yes.
      TRADIER_API_KEY: 'test-token',
      PAPER_SPREAD_HAIRCUT_PCT: '0',
      PAPER_SPREAD_HAIRCUT_MIN_E4: '0',
      // news.ts/edgar.ts guard on these being present before doing anything,
      // same as every other provider key in this project — but their tests
      // exercise the persist/cutoff logic through an injected fetcher that
      // never makes a real request, so the guard only needs a truthy value
      // here, not a real credential. The one test that exercises the guard
      // itself (edgar.test.ts) overrides this to '' via vi.stubEnv.
      POLYGON_API_KEY: 'test-polygon-key',
      SEC_EDGAR_USER_AGENT: 'OrgTest test@example.com',
    },
  },
});
