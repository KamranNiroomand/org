import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts'],
    // The calendar code reads local civil dates on purpose. Pinning the zone
    // keeps grid tests deterministic wherever they run — including CI.
    env: { TZ: 'America/Toronto' },
  },
});
