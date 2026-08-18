import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { marketDb } from '../../db/market/index.js';
import { runMarketMigrations } from '../../db/market/migrate.js';
import { modelRuns } from '../../db/market/schema.js';
import { registerModelRun } from './modelRegistry.js';

/**
 * Shaped exactly like a manifest `train.py` actually produces — the real
 * one, registered against the real running server, is what this was
 * validated against before this suite was written. See PR history for that
 * live run: 4 symbols, 183 days, does not beat baseline.
 */
function writeManifest(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'model-run-'));
  const manifest = {
    run_id: 'test-run-1',
    target: 'dir',
    horizon: 5,
    git_sha: 'abc1234',
    trained_at: null,
    train_days: { first: '2026-01-01', last: '2026-06-01', count: 100 },
    n_splits: 4,
    embargo: 2,
    metrics: { model_rmse: 0.04, baseline_rmse: 0.036, beats_baseline: false, information_coefficient: -0.03 },
    ...overrides,
  };
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

beforeEach(() => {
  runMarketMigrations();
  marketDb.delete(modelRuns).run();
});

describe('registerModelRun', () => {
  it('inserts a new run as a challenger', () => {
    const path = writeManifest();
    const result = registerModelRun(path);
    expect(result.created).toBe(true);

    const row = marketDb.select().from(modelRuns).all().find((r) => r.runId === 'test-run-1')!;
    expect(row.status).toBe('challenger');
    expect(row.promotedAt).toBeNull();
    expect(row.target).toBe('dir');
    expect((row.metrics as { beats_baseline: boolean }).beats_baseline).toBe(false);
  });

  it('derives artifactDir from the manifest\'s own directory name', () => {
    const path = writeManifest();
    registerModelRun(path);
    const row = marketDb.select().from(modelRuns).all()[0]!;
    // mkdtempSync produces a name like "model-run-XXXXXX"; the important
    // property is that it is the directory the manifest actually lives in,
    // not a hardcoded or guessed value.
    expect(path).toContain(row.artifactDir);
  });

  it('re-registering updates metrics without disturbing status or promotedAt', () => {
    const path = writeManifest();
    registerModelRun(path);

    // Promote it, exactly as a person would through the API.
    marketDb.update(modelRuns).set({ status: 'champion', promotedAt: '2026-08-18T12:00:00Z' }).run();

    // A re-run of the same run_id with slightly different metrics.
    const updatedPath = writeManifest({ metrics: { model_rmse: 0.039, baseline_rmse: 0.036, beats_baseline: false } });
    const result = registerModelRun(updatedPath);

    expect(result.created).toBe(false);
    const row = marketDb.select().from(modelRuns).all().find((r) => r.runId === 'test-run-1')!;
    // The metric changed...
    expect((row.metrics as { model_rmse: number }).model_rmse).toBe(0.039);
    // ...but a re-registration must never silently un-promote a champion.
    expect(row.status).toBe('champion');
    expect(row.promotedAt).toBe('2026-08-18T12:00:00Z');
  });

  it('rejects a manifest missing a required field', () => {
    const path = writeManifest({ target: undefined });
    expect(() => registerModelRun(path)).toThrow();
  });

  it('rejects a nonexistent path', () => {
    expect(() => registerModelRun('/nonexistent/manifest.json')).toThrow();
  });
});
