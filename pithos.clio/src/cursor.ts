import { isClioCommit, type CommitInfo, type Git } from './git.ts';

/**
 * What a run should do, decided from the branch's cursor (the last commit Clio processed).
 * - none: nothing new.
 * - reset: no usable cursor (first run, rebase, reset); move it to HEAD without capturing,
 *   so Clio never backfills old history.
 * - skip: only Clio's own commits are new; advance the cursor.
 * - capture: document `from..to`.
 */
export type CapturePlan =
  | { kind: 'none'; reason: string }
  | { kind: 'reset'; branch: string; head: string; reason: string }
  | { kind: 'skip'; branch: string; head: string }
  | { kind: 'capture'; branch: string; from: string; to: string; commits: CommitInfo[]; truncated: boolean };

export async function planCapture(git: Git, maxCommits: number, since?: string): Promise<CapturePlan> {
  const branch = await git.branch();
  if (!branch) return { kind: 'none', reason: 'HEAD is detached' };
  const head = await git.head();
  if (!head) return { kind: 'none', reason: 'the branch has no commits yet' };
  const cursor = since ?? await git.readCursor(branch);
  if (!cursor) return { kind: 'reset', branch, head, reason: 'first run on this branch' };
  if (cursor === head) return { kind: 'none', reason: 'no new commits' };
  if (!(await git.isAncestor(cursor, head))) return { kind: 'reset', branch, head, reason: 'history was rewritten since the last capture' };

  // Ask for one extra commit to learn whether the range was capped.
  const all = await git.commits(cursor, head, maxCommits + 1);
  const truncated = all.length > maxCommits;
  const range = truncated ? all.slice(1) : all;
  const from = truncated ? (await git.parent(range[0].sha)) ?? cursor : cursor;
  const commits = range.filter(c => !isClioCommit(c));
  if (!commits.length) return { kind: 'skip', branch, head };
  return { kind: 'capture', branch, from, to: head, commits, truncated };
}
