import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

/**
 * Makes a consistent, single-file copy of the database.
 *
 * The database runs in WAL mode, which means the main `.db` file is not the
 * database — at rest it can be a near-empty stub while every recent
 * transaction sits in the `-wal` sidecar. Copying `org.db` on its own is the
 * obvious backup and the wrong one: it restores to a database that is missing
 * most of the data, and you find that out at the worst moment.
 *
 * So this uses SQLite's online backup API, which walks the live database and
 * writes a fully checkpointed copy — safe to run while the server is writing,
 * and safe to restore from as a single file.
 *
 *   npm run backup                  # ~/.org/backups, keeps the last 14
 *   npm run backup -- --keep 30
 *   npm run backup -- --out /Volumes/Backup
 */

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

/** `YYYYMMDD-HHMMSS` in local time, so filenames sort chronologically. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const human = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

async function main(): Promise<void> {
  const outDir = arg('--out') ?? join(config.dbDir, 'backups');
  const keep = Math.max(1, Number(arg('--keep') ?? 14));

  if (!existsSync(config.dbPath)) {
    console.error(`No database at ${config.dbPath}`);
    process.exit(1);
  }

  // 0700 to match the directory the database itself lives in — a backup of
  // bank transactions deserves the same permissions as the original.
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const dest = join(outDir, `org-${stamp()}.db`);
  const source = new Database(config.dbPath, { readonly: true });

  const before = {
    transactions: (source.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n,
    accounts: (source.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
  };

  await source.backup(dest);
  source.close();

  try {
    chmodSync(dest, 0o600);
  } catch {
    // Non-fatal, same reasoning as the main database open.
  }

  /**
   * A backup nobody has opened is a rumour. Read it back, check integrity, and
   * compare row counts against the source before reporting success.
   */
  const copy = new Database(dest, { readonly: true });
  const integrity = (copy.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]
    ?.integrity_check;
  const after = {
    transactions: (copy.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n,
    accounts: (copy.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
  };
  copy.close();

  /**
   * Opening the copy to verify it re-created the WAL sidecars beside it. They
   * are empty — the backup is already checkpointed — but leaving them there
   * reintroduces exactly the confusion this script exists to prevent, so the
   * backup goes back to being one self-contained file.
   */
  for (const sidecar of [`${dest}-wal`, `${dest}-shm`]) {
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }

  const size = statSync(dest).size;
  const ok =
    integrity === 'ok' &&
    after.transactions === before.transactions &&
    after.accounts === before.accounts;

  if (!ok) {
    console.error(
      `Backup verification FAILED for ${dest}\n` +
        `  integrity_check: ${integrity}\n` +
        `  transactions: ${before.transactions} -> ${after.transactions}\n` +
        `  accounts: ${before.accounts} -> ${after.accounts}`,
    );
    process.exit(1);
  }

  console.log(`Backed up to ${dest}`);
  console.log(`  ${human(size)} · ${after.transactions} transactions · ${after.accounts} accounts · integrity ok`);

  // Prune oldest first, by filename — the timestamp format sorts correctly.
  const existing = readdirSync(outDir)
    .filter((f) => /^org-\d{8}-\d{6}\.db$/.test(f))
    .sort();
  const stale = existing.slice(0, Math.max(0, existing.length - keep));
  for (const f of stale) unlinkSync(join(outDir, f));
  if (stale.length > 0) console.log(`  pruned ${stale.length} older backup(s), keeping ${keep}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
