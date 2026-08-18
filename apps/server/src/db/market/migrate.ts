import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../../config.js';
import { marketDb } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', '..', 'drizzle-market');

export function runMarketMigrations(): void {
  migrate(marketDb, { migrationsFolder });
}

// Also runnable directly via `npm run db:migrate:market`.
//
// Compared as filesystem paths, not as URLs: `import.meta.url` percent-encodes
// spaces and other characters, so a checkout under a path like
// "Kamran's softwares" never matches a raw `file://` + argv[1] concatenation,
// and the script exits silently having done nothing.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runMarketMigrations();
  console.log(`Migrated ${config.market.dbPath}`);
}
