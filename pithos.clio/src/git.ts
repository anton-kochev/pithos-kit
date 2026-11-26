import { isAbsolute, join } from 'node:path';
import { access } from 'node:fs/promises';

export interface ExecResult { stdout: string; stderr: string; code: number }
export type Exec = (command: string, args: string[], options: { cwd: string; signal?: AbortSignal }) => Promise<ExecResult>;

export interface CommitInfo { sha: string; subject: string; body: string; time: number }

/** Marks commits Clio made, so it never documents its own work. */
export const TRAILER = 'Clio-Capture';
const CURSOR_PREFIX = 'refs/clio/cursor/';

export class GitError extends Error {}

/** Thin wrapper around the git CLI. Every call runs in the project root. */
export class Git {
  readonly exec: Exec;
  readonly cwd: string;

  constructor(exec: Exec, cwd: string) {
    this.exec = exec;
    this.cwd = cwd;
  }

  async run(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await this.exec('git', args, { cwd: this.cwd, signal });
    if (result.code !== 0) throw new GitError(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().split('\n')[0] ?? ''}`);
    return result.stdout;
  }

  async tryRun(args: string[], signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.exec('git', args, { cwd: this.cwd, signal });
    return result.code === 0 ? result.stdout : undefined;
  }

  async isRepository(): Promise<boolean> {
    return (await this.tryRun(['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
  }

  async head(): Promise<string | undefined> {
    return (await this.tryRun(['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim() || undefined;
  }

  /** Short branch name, or undefined when HEAD is detached. */
  async branch(): Promise<string | undefined> {
    return (await this.tryRun(['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || undefined;
  }

  async readCursor(branch: string): Promise<string | undefined> {
    return (await this.tryRun(['rev-parse', '--verify', '--quiet', `${CURSOR_PREFIX}${branch}^{commit}`]))?.trim() || undefined;
  }

  async writeCursor(branch: string, sha: string): Promise<void> {
    await this.run(['update-ref', '-m', 'clio: cursor', `${CURSOR_PREFIX}${branch}`, sha]);
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.exec('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: this.cwd });
    return result.code === 0;
  }

  /** Commits in `from..to`, oldest first, capped to the newest `max`. */
  async commits(from: string, to: string, max: number): Promise<CommitInfo[]> {
    const out = await this.run(['log', '--first-parent', `--max-count=${max}`, '--format=%H%x1f%ct%x1f%s%x1f%b%x1e', `${from}..${to}`]);
    return out.split('\x1e').map(r => r.trim()).filter(Boolean).map(record => {
      const [sha, time, subject, body] = record.split('\x1f');
      return { sha, time: Number(time) * 1000, subject, body: (body ?? '').trim() };
    }).reverse();
  }

  async commitTime(sha: string): Promise<number> {
    return Number((await this.run(['show', '-s', '--format=%ct', sha])).trim()) * 1000;
  }

  async parent(sha: string): Promise<string | undefined> {
    return (await this.tryRun(['rev-parse', '--verify', '--quiet', `${sha}^`]))?.trim() || undefined;
  }

  /** Unified diff for `from..to`, without lockfiles, build output and other noise. */
  async diff(from: string, to: string): Promise<string> {
    return this.run(['diff', '--no-color', '--no-ext-diff', '--find-renames', `${from}..${to}`, '--', '.', ...DIFF_EXCLUDES]);
  }

  async changedPaths(from: string, to: string): Promise<string[]> {
    return (await this.run(['diff', '--name-only', '--no-renames', `${from}..${to}`])).split('\n').filter(Boolean);
  }

  /** True when the path has no staged or unstaged changes and is not untracked. */
  async isClean(path: string): Promise<boolean> {
    return (await this.run(['status', '--porcelain', '--untracked-files=all', '--', path])).trim() === '';
  }

  async isTracked(path: string): Promise<boolean> {
    return (await this.tryRun(['ls-files', '--error-unmatch', '--', path])) !== undefined;
  }

  /** A merge, rebase, cherry-pick, revert or bisect is in progress. */
  async operationInProgress(): Promise<boolean> {
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']) {
      const path = (await this.run(['rev-parse', '--git-path', marker])).trim();
      try { await access(isAbsolute(path) ? path : join(this.cwd, path)); return true; } catch { /* absent */ }
    }
    return false;
  }

  /** Absolute path of a Clio-owned directory inside the common git dir (shared by worktrees). */
  async clioDir(): Promise<string> {
    const common = (await this.run(['rev-parse', '--git-common-dir'])).trim();
    return join(isAbsolute(common) ? common : join(this.cwd, common), 'clio');
  }

  /**
   * Commits exactly `paths` with `--only`, so anything else the user staged stays staged
   * and out of the commit. New files must be added first so git knows the pathspec.
   */
  async commitOnly(paths: string[], subject: string, body: string, trailer: string, newFiles: string[]): Promise<string> {
    if (newFiles.length) await this.run(['add', '--', ...newFiles]);
    await this.run(['commit', '--only', '--quiet', '-m', subject, ...(body ? ['-m', body] : []), '-m', `${TRAILER}: ${trailer}`, '--', ...paths]);
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  async unstage(paths: string[]): Promise<void> {
    if (paths.length) await this.tryRun(['reset', '--quiet', '--', ...paths]);
  }

  async message(sha: string): Promise<string> {
    return this.run(['show', '-s', '--format=%B', sha]);
  }

  async revert(sha: string): Promise<string> {
    await this.run(['revert', '--no-edit', sha]);
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  /** Most recent Clio commit among the last `depth` first-parent commits. */
  async lastClioCommit(depth = 50): Promise<CommitInfo | undefined> {
    const head = await this.head();
    if (!head) return;
    const out = await this.run(['log', '--first-parent', `--max-count=${depth}`, '--format=%H%x1f%ct%x1f%s%x1f%b%x1e', head]);
    for (const record of out.split('\x1e').map(r => r.trim()).filter(Boolean)) {
      const [sha, time, subject, body] = record.split('\x1f');
      if (isClioMessage(body ?? '')) return { sha, time: Number(time) * 1000, subject, body: (body ?? '').trim() };
    }
  }
}

export function isClioMessage(body: string): boolean {
  return new RegExp(`^${TRAILER}:`, 'm').test(body);
}

/** Clio's own commits, and reverts of them, are never documented. */
export function isClioCommit(commit: Pick<CommitInfo, 'subject' | 'body'>): boolean {
  return isClioMessage(commit.body) || /^Revert "docs\(clio\)/.test(commit.subject);
}

const DIFF_EXCLUDES = [
  ':(exclude,glob)**/package-lock.json', ':(exclude,glob)**/pnpm-lock.yaml', ':(exclude,glob)**/yarn.lock',
  ':(exclude,glob)**/go.sum', ':(exclude,glob)**/Cargo.lock', ':(exclude,glob)**/*.min.*',
  ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/dist/**', ':(exclude,glob)**/build/**',
  ':(exclude,glob)**/coverage/**', ':(exclude,glob)**/vendor/**', ':(exclude,glob)**/generated/**',
  ':(exclude,glob)**/*.png', ':(exclude,glob)**/*.jpg', ':(exclude,glob)**/*.svg', ':(exclude,glob)**/*.ico',
];
