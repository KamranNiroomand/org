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
    },
  },
});
