import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import { db } from './index.js';
import { seedCategories } from './categories.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'drizzle');

export function runMigrations(): void {
  migrate(db, { migrationsFolder });
  seedCategories();
}

// Also runnable directly via `npm run db:migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  console.log(`Migrated ${config.dbPath}`);
}
