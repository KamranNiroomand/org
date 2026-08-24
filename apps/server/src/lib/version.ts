import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What commit is this process actually running?
 *
 * This module exists because of a specific, expensive failure. Over one
 * week three separate bug fixes were written, reviewed, merged — and never
 * ran. The server process had been up since before the first of them
 * landed, and nothing anywhere said so. On 2026-08-24 the auto-entry job,
 * executing week-old code, opened a $122,440 position on a $100,000
 * account: the exact bug the un-deployed fix had corrected. Finding out
 * cost a day, and every layer of review had already passed.
 *
 * The gap was never in the code. It was that "merged" and "running" were
 * different facts and only one of them was visible. So: capture the commit
 * this process booted from, compare it against what the working tree says
 * now, and make the difference loud.
 *
 * **Drift is measured against the local working tree, not a remote.** That
 * is deliberate, and it is the case that actually bit: `git pull` and
 * `gh pr merge` both move the working tree while the running process keeps
 * serving whatever it loaded at boot. Detecting that needs no network, no
 * credentials, and no periodic fetch that could fail silently — just a
 * `rev-parse` against the repo already on disk. A separate "the remote has
 * moved" check would need a fetch and is a different (weaker) signal: code
 * on a remote was never going to be running here anyway.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** `apps/server/src/lib` → repo root. */
const repoRoot = join(here, '..', '..', '..', '..');

/**
 * Runs git and distinguishes *failed* from *succeeded with empty output* —
 * a distinction the first version of this file collapsed, and got wrong in
 * exactly the way the module exists to prevent. `git status --porcelain`
 * prints nothing for a clean tree, so folding failure and empty into one
 * null made an unreadable index or a timed-out call report a clean tree
 * that had never been measured. Verified both: with an unreadable
 * `.git/index`, `status` exits 128 while `rev-parse` still exits 0; past
 * the timeout the call comes back ETIMEDOUT. Null means "could not tell".
 */
function git(...args: string[]): string | null {
  try {
    const out = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 5_000 });
    if (out.error || out.status !== 0) return null;
    return out.stdout ?? '';
  } catch {
    // A deployed build with no git, no repo, or no git binary is a normal
    // state, not an error: drift is simply unknowable there and every
    // field below reports null rather than a guess.
    return null;
  }
}

/** Trimmed, with empty treated as absent — right for a sha or a branch name. */
function gitValue(...args: string[]): string | null {
  const raw = git(...args);
  if (raw === null) return null;
  const value = raw.trim();
  return value ? value : null;
}

export interface VersionStatus {
  /** The commit this process loaded at boot. Null outside a git checkout. */
  bootSha: string | null;
  /** What the working tree points at right now. */
  headSha: string | null;
  branch: string | null;
  /**
   * True when the working tree has moved since this process started — the
   * "merged but not restarted" state. Null when either sha is unknown, so
   * a caller can distinguish "no drift" from "cannot tell", which matters:
   * rendering "up to date" for a state you could not measure is the same
   * class of lie this module exists to prevent.
   */
  drifted: boolean | null;
  /**
   * Uncommitted changes in the tree — the running code may match no commit
   * at all. Null when git could not answer, for the same reason `drifted`
   * is nullable: a clean tree and an unmeasurable one must not look alike.
   */
  dirty: boolean | null;
  startedAt: string;
}

/**
 * Captured at import, which is as close to "what this process loaded" as a
 * Node process can get: modules are already resolved from disk by the time
 * anything here runs, so a later `git checkout` cannot retroactively change
 * what is in memory — only what this value is compared against.
 */
const bootSha = gitValue('rev-parse', 'HEAD');
const bootBranch = gitValue('rev-parse', '--abbrev-ref', 'HEAD');
const startedAt = new Date().toISOString();

/**
 * Cached briefly. Each call shells out to git, and `spawnSync` blocks the
 * event loop for everyone — fine at 20ms against a small tree, much less
 * fine when `git status` is slow, which on this very repo meant minutes
 * while iCloud thrashed it. Drift cannot change faster than a human runs
 * `git pull`, so a few seconds of staleness costs nothing and stops
 * `/api/health` from being a self-inflicted stall.
 */
let cached: { at: number; value: VersionStatus } | null = null;
const CACHE_MS = 5_000;

export function versionStatus(): VersionStatus {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;

  const headSha = gitValue('rev-parse', 'HEAD');
  // Raw, not trimmed-to-null: empty output here means a clean tree, and
  // only a null means git could not answer. See `git` above.
  const dirtyOut = git('status', '--porcelain');
  const value: VersionStatus = {
    bootSha,
    headSha,
    branch: gitValue('rev-parse', '--abbrev-ref', 'HEAD') ?? bootBranch,
    drifted: bootSha === null || headSha === null ? null : bootSha !== headSha,
    dirty: dirtyOut === null ? null : dirtyOut.trim() !== '',
    startedAt,
  };
  cached = { at: now, value };
  return value;
}

/** One line at boot, so the running commit is in the log from the start. */
export function describeBootVersion(): string {
  if (bootSha === null) return 'Running outside a git checkout — deployed commit unknown';
  return `Running commit ${bootSha.slice(0, 8)} on ${bootBranch ?? 'unknown branch'}`;
}
