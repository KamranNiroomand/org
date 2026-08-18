import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts'],
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
