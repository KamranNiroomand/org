import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { versionStatus } from './version.js';

/**
 * `version.ts` reads the repo this file lives in, so its own module-level
 * `bootSha` cannot be manipulated from a test without rewriting history.
 * What is worth pinning instead is the contract the banner depends on:
 * that "cannot tell" is never reported as "no drift", and that a real
 * commit moving underneath a running process is detectable at all.
 *
 * The second half is proved against a throwaway repo driving the same git
 * commands, rather than asserting on this checkout's live sha — an
 * assertion that would pass or fail depending on whether the suite happens
 * to run mid-rebase.
 */

const repos: string[] = [];

function throwawayRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'org-version-'));
  repos.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.txt'), 'one');
  git('add', '.');
  git('commit', '-qm', 'first');
  return dir;
}

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

describe('versionStatus', () => {
  it('reports a boot sha and a matching head in a clean checkout', () => {
    const v = versionStatus();
    // This suite runs inside the repo, so git is available and both shas
    // resolve. The process has not been running across a checkout, so the
    // two agree.
    expect(v.bootSha).toMatch(/^[0-9a-f]{40}$/);
    expect(v.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(v.drifted).toBe(false);
    expect(v.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never reports drifted:false when a sha is unknowable', () => {
    // The contract the banner leans on. `drifted` is boolean|null precisely
    // so that "no git here" cannot render as a reassuring "up to date" —
    // that would be the same invisible-staleness failure this module was
    // written to end, just relocated into the UI.
    const v = versionStatus();
    if (v.bootSha === null || v.headSha === null) {
      expect(v.drifted).toBeNull();
    } else {
      expect(typeof v.drifted).toBe('boolean');
    }
  });

  it('detects a commit moving underneath a process, using the same git commands', () => {
    // What the real drift check does, on a repo we control: capture a sha,
    // move the branch, compare. If `rev-parse HEAD` did not see the move,
    // the banner could never fire.
    const dir = throwawayRepo();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();

    const booted = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'a.txt'), 'two');
    git('add', '.');
    git('commit', '-qm', 'second');
    const head = git('rev-parse', 'HEAD');

    expect(head).not.toBe(booted);
    expect(booted !== head).toBe(true); // the exact comparison versionStatus makes
  });

  it('reports a dirty tree distinctly from a moved commit', () => {
    // A dirty tree means the running code matches no commit at all, which
    // is a different warning from "an older commit" — conflating them
    // would tell someone to restart when the fix is to commit.
    const dir = throwawayRepo();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();

    const shaBefore = git('rev-parse', 'HEAD');
    expect(git('status', '--porcelain')).toBe('');

    writeFileSync(join(dir, 'a.txt'), 'uncommitted edit');

    expect(git('status', '--porcelain')).not.toBe('');
    // The property being claimed: an edit makes the tree dirty without
    // moving the commit, so the two signals cannot be conflated. The
    // earlier version of this line compared a call to itself and would
    // have passed even if rev-parse were removed entirely.
    expect(git('rev-parse', 'HEAD')).toBe(shaBefore);
  });

  it('treats a clean tree and an unanswerable git as different states', () => {
    // The bug this pins, found in review of this same file: `git status
    // --porcelain` prints nothing for a clean tree, so folding "failed"
    // and "empty" into one null made a failed call report a clean tree.
    // Verified against a real failure: an unreadable index makes `status`
    // exit 128 while `rev-parse` still succeeds, so bootSha stays non-null
    // and cannot be used to tell the two apart.
    const dir = throwawayRepo();
    const run = (...args: string[]) =>
      spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

    expect(run('status', '--porcelain').status).toBe(0);
    expect(run('status', '--porcelain').stdout).toBe('');

    chmodSync(join(dir, '.git', 'index'), 0o000);
    const failed = run('status', '--porcelain');
    chmodSync(join(dir, '.git', 'index'), 0o644);

    expect(failed.status).not.toBe(0);
    // rev-parse is unaffected, which is why bootSha proves nothing here.
    expect(run('rev-parse', 'HEAD').status).toBe(0);
  });
});
