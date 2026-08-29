import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { config } from '../../config.js';
import { sql } from 'drizzle-orm';
import { marketDb, reopenMarketDb } from '../../db/market/index.js';
import { optionQuotes } from '../../db/market/schema.js';

export interface PullResult {
  ok: boolean;
  message: string;
}

/**
 * Pulls the runner's latest snapshot over SSH into this reader's local
 * `market.db`. Deliberately not `rsync`-ing `market.db` itself — that file
 * runs in WAL mode on the runner and can be mid-write at any moment;
 * `snapshot.db` is the point-in-time copy `VACUUM INTO` produces
 * specifically to be safe to copy. See `db/market/snapshot.ts`.
 *
 * Never throws — a reader with no network path to the runner right now
 * (asleep, off-network, SSH not enabled) is a normal night, not a crash;
 * the caller decides how to log or surface `ok: false`. That includes a
 * failure inside `reopenMarketDb()` itself, caught here rather than left to
 * propagate — this function's own contract is the one place all three
 * callers (the nightly cron, the manual route, the CLI) can rely on
 * without each having to duplicate the same try/catch.
 *
 * Runs rsync via the async `spawn`, not `spawnSync` — this function is
 * called directly from a live Fastify request handler (`POST
 * /api/options/pull`) since Node/Fastify is single-threaded, a *synchronous*
 * spawn would block the entire event loop, freezing every other concurrent
 * request on the process (not just options routes — this is one shared
 * server) for the whole transfer. `await`ing an async spawn keeps this
 * process responsive to other requests while the transfer runs.
 *
 * No caller-imposed timeout on the transfer, on purpose: rsync writes to a
 * temp file in the destination directory and renames into place only on
 * its own natural completion, which is what makes "a reader reading
 * mid-transfer sees the previous complete database, never a partial one"
 * actually hold. A timeout that kills rsync mid-flight can leave a
 * truncated file at the destination — found live, the hard way, debugging
 * this exact function's manual precursor.
 *
 * Reopens this process's own `marketDb` connection on success — found live,
 * the same day: a long-running reader server that pulled a fresh snapshot
 * kept answering from the *previous* one, because rsync's rename swaps the
 * file at the path but an already-open connection keeps reading the old,
 * now-unlinked inode. See `reopenMarketDb`'s own doc comment for why that's
 * safe to do from underneath already-registered routes.
 */
export async function pullMarketSnapshot(): Promise<PullResult> {
  if (config.market.isRunner) {
    return { ok: false, message: 'This machine is MARKET_ROLE=runner — nothing to pull.' };
  }
  if (!config.market.runnerSshHost) {
    return { ok: false, message: 'RUNNER_SSH_HOST is not set.' };
  }

  const remoteDir = config.market.runnerDataDir ?? config.market.dataDir;
  const remoteSnapshot = `${config.market.runnerSshHost}:${remoteDir}/snapshot.db`;

  if (!existsSync(config.market.dataDir)) mkdirSync(config.market.dataDir, { recursive: true, mode: 0o700 });

  const { status, stderr } = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn('rsync', ['-az', remoteSnapshot, config.market.dbPath]);
    let stderrOutput = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });
    child.on('error', (err) => resolve({ status: null, stderr: err.message }));
    child.on('close', (code) => resolve({ status: code, stderr: stderrOutput }));
  });

  if (status !== 0) {
    const detail = stderr.trim() || `exit ${status ?? 'unknown'}`;
    return { ok: false, message: `rsync failed: ${detail}` };
  }

  try {
    reopenMarketDb();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Pulled ${remoteSnapshot} → ${config.market.dbPath}, but reopening the database connection failed: ${detail}`,
    };
  }
  return { ok: true, message: `Pulled ${remoteSnapshot} → ${config.market.dbPath}` };
}


/**
 * Is the local corpus older than the most recent session whose snapshot
 * should already exist on the runner?
 *
 * "Should exist" walks back from now in New York time: a weekday counts
 * as available only after 20:00 ET (capture at 16:45, then processing
 * and the snapshot's own VACUUM); before that, and on weekends, the
 * expected day is the previous weekday. Holidays make a weekday with no
 * session, so the corpus legitimately never reaches it — the caller
 * caps its attempts per day for exactly that case rather than this
 * function trying to carry a holiday calendar it would let drift.
 */
export function marketCorpusIsStale(): boolean {
  const latest = marketDb
    .select({ d: sql<string | null>`max(${optionQuotes.tradingDay})` })
    .from(optionQuotes)
    .get()?.d;
  if (!latest) return false; // an empty corpus is a setup problem, not staleness

  const nyParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    // h23, not hour12:false — some ICU versions render midnight as "24"
    // under the latter, which would read as "after 20:00" and spend the
    // day's heal attempts on a snapshot that cannot exist yet.
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string) => nyParts.find((p) => p.type === t)?.value ?? '00';
  const today = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = Number(get('hour'));

  const expected = new Date(`${today}T12:00:00Z`);
  if (expected.getUTCDay() === 0 || expected.getUTCDay() === 6 || hour < 20) {
    do {
      expected.setUTCDate(expected.getUTCDate() - 1);
    } while (expected.getUTCDay() === 0 || expected.getUTCDay() === 6);
  }
  return latest < expected.toISOString().slice(0, 10);
}
