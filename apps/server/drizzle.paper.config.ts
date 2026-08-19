import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

/**
 * Third drizzle config, for the paper trading database. Kept separate from
 * both `drizzle.config.ts` and `drizzle.market.config.ts` so all three
 * schemas generate into their own migration folders and can never be
 * applied to the wrong file — see `src/db/paper/schema.ts` for why paper
 * trading is a physically separate database at all.
 *
 *   npm run db:generate:paper
 *   npm run db:migrate:paper
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/paper/schema.ts',
  out: './drizzle-paper',
  dbCredentials: {
    url: process.env.PAPER_DB_PATH ?? join(homedir(), '.org', 'market', 'paper.db'),
  },
  strict: true,
  verbose: true,
});
