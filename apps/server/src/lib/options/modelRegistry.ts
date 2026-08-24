import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { marketDb } from '../../db/market/index.js';
import { modelRuns } from '../../db/market/schema.js';
import { assertRunner } from './role.js';
import { nowIso } from '../util.js';

/**
 * Turns a manifest.json `train.py` wrote into a queryable row.
 *
 * Python never writes to this database — the manifest is a file, this is
 * the read of it. See the `model_runs` table comment in schema.ts for why
 * registration is restricted to the runner.
 */
const manifestSchema = z.object({
  run_id: z.string().min(1),
  target: z.string().min(1),
  horizon: z.number().int().positive(),
  git_sha: z.string().nullable(),
  train_days: z.object({
    first: z.string(),
    last: z.string(),
    count: z.number().int().positive(),
  }),
  n_splits: z.number().int().positive(),
  embargo: z.number().int().nonnegative(),
  metrics: z.record(z.string(), z.unknown()),
});

export function registerModelRun(manifestPath: string): { runId: string; created: boolean } {
  assertRunner('register a model run');

  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifest = manifestSchema.parse(raw);
  const artifactDir = basename(dirname(manifestPath));

  // The loss curve lives beside the manifest, written by train.py. Read
  // here so it lands in the database alongside the metrics rather than
  // only on disk: the question worth asking spans runs — is this fit
  // overfitting worse than the last one — and answering that from files
  // means one JSON read per run.
  //
  // Absent for any run trained before it was recorded, which is a normal
  // state and not an error. Unreadable is treated the same way: a
  // malformed curve must not stop a run being registered, since the
  // metrics are the part that gates promotion.
  let history: Record<string, { train?: number[]; validation?: number[] }> | null = null;
  const historyPath = join(dirname(manifestPath), 'history.json');
  if (existsSync(historyPath)) {
    try {
      const parsed = JSON.parse(readFileSync(historyPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) history = parsed;
    } catch {
      history = null;
    }
  }

  const existing = marketDb.select({ runId: modelRuns.runId }).from(modelRuns).all().find((r) => r.runId === manifest.run_id);

  marketDb
    .insert(modelRuns)
    .values({
      runId: manifest.run_id,
      target: manifest.target,
      horizon: manifest.horizon,
      gitSha: manifest.git_sha,
      trainDaysFirst: manifest.train_days.first,
      trainDaysLast: manifest.train_days.last,
      trainDaysCount: manifest.train_days.count,
      nSplits: manifest.n_splits,
      embargo: manifest.embargo,
      metrics: manifest.metrics,
      history,
      artifactDir,
      registeredAt: nowIso(),
      status: 'challenger',
    })
    .onConflictDoUpdate({
      target: modelRuns.runId,
      // Re-registering the same run_id updates metrics/metadata but never
      // touches status or promotedAt — a re-run must not silently un-promote
      // a champion or erase a manual decision already made about it.
      set: {
        gitSha: manifest.git_sha,
        metrics: manifest.metrics,
        history,
        registeredAt: nowIso(),
      },
    })
    .run();

  return { runId: manifest.run_id, created: !existing };
}
