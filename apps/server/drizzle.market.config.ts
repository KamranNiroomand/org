import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

/**
 * Second drizzle config, for the market research database. Kept separate from
 * `drizzle.config.ts` so the two schemas generate into their own migration
 * folders and can never be applied to the wrong file.
 *
 *   npm run db:generate:market
 *   npm run db:migrate:market
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/market/schema.ts',
  out: './drizzle-market',
  dbCredentials: {
    url: process.env.MARKET_DB_PATH ?? join(homedir(), '.org', 'market.db'),
  },
  strict: true,
  verbose: true,
});
