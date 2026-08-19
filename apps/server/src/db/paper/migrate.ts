import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../../config.js';
import { paperDb } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', '..', 'drizzle-paper');

export function runPaperMigrations(): void {
  migrate(paperDb, { migrationsFolder });
}

// Also runnable directly via `npm run db:migrate:paper`.
//
// Compared as filesystem paths, not as URLs — see the identical comment in
// ../market/migrate.ts for why.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runPaperMigrations();
  console.log(`Migrated ${config.market.paperDbPath}`);
}
