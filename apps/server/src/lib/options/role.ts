import { config } from '../../config.js';

/**
 * Guards the shared corpus against a second writer.
 *
 * When the research corpus lives in a synced folder, exactly one machine may
 * produce it. The failure mode for getting this wrong is quiet: Google Drive
 * and iCloud resolve concurrent writes by keeping both versions under names
 * like `part-0001 (1).parquet`, which no reader looks for, so data appears to
 * vanish rather than to conflict. A Parquet file captured mid-sync is worse —
 * it is simply unreadable, and only discovered when a training run fails weeks
 * later.
 *
 * So writes are refused rather than merged. A reader that tries to capture is
 * a misconfiguration, and it should say so on the first attempt.
 */
export class ReadOnlyCorpusError extends Error {
  constructor(action: string) {
    super(
      `This machine is configured as MARKET_ROLE=reader and cannot ${action}. ` +
        `The corpus at ${config.market.dataDir} is produced by the runner machine ` +
        `and synced here. Set MARKET_ROLE=runner only on the machine that captures.`,
    );
    this.name = 'ReadOnlyCorpusError';
  }
}

/** Throws unless this process owns the corpus. */
export function assertRunner(action: string): void {
  if (!config.market.isRunner) throw new ReadOnlyCorpusError(action);
}

export const isRunner = (): boolean => config.market.isRunner;
