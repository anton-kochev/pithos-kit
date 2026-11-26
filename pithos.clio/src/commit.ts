import { rm, writeFile } from 'node:fs/promises';
import { expectedEdit } from './edit-content.ts';
import { changePath, changePurpose, type Change } from './gate.ts';
import type { Git } from './git.ts';
import { absolutePath, looksGenerated, newFileTarget, readExact } from './paths.ts';

export interface Deferred { change: Change; reason: string }
export interface ApplyOutcome {
  /** Sha of Clio's docs commit, when one was made. */
  committed?: string;
  paths: string[];
  deferred: Deferred[];
}

interface Written { path: string; absolute: string; original?: string }

async function rollback(git: Git, written: Written[]): Promise<void> {
  for (const file of written.reverse()) {
    if (file.original === undefined) await rm(file.absolute, { force: true });
    else await writeFile(file.absolute, file.original);
  }
  await git.unstage(written.filter(f => f.original === undefined).map(f => f.path));
}

function subjectFor(paths: string[]): string {
  return paths.length === 1 ? `docs(clio): update ${paths[0]}` : `docs(clio): update ${paths.length} docs`;
}

/**
 * Writes the changes and commits exactly those files as one `docs(clio):` commit.
 * A change is deferred (for the inbox) when its file has uncommitted changes, its text moved,
 * or anything about the repository changed under Clio. Never pushes, amends or touches other paths.
 */
export async function applyAndCommit(git: Git, root: string, changes: Change[], expectedHead: string, trailer: string): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { paths: [], deferred: [] };
  const deferAll = (reason: string) => { outcome.deferred.push(...changes.map(change => ({ change, reason }))); return outcome; };
  if (!changes.length) return outcome;
  if (await git.operationInProgress()) return deferAll('a merge, rebase or similar operation is in progress');
  if ((await git.head()) !== expectedHead) return deferAll('HEAD moved while Clio was working');

  const written: Written[] = [];
  const accepted: Change[] = [];
  for (const change of changes) {
    const path = changePath(change);
    try {
      if (change.type === 'edit') {
        if (!(await git.isClean(path))) { outcome.deferred.push({ change, reason: 'the file has uncommitted changes' }); continue; }
        const original = await readExact(root, path);
        if (looksGenerated(original)) { outcome.deferred.push({ change, reason: 'the file looks generated' }); continue; }
        let next: string;
        try { next = expectedEdit(original, change.edit.oldText, change.edit.newText); }
        catch { outcome.deferred.push({ change, reason: 'the text to replace changed or is no longer unique' }); continue; }
        const absolute = await absolutePath(root, path);
        written.push({ path, absolute, original });
        await writeFile(absolute, next);
      } else {
        const absolute = await newFileTarget(root, path);
        if (await git.isTracked(path)) { outcome.deferred.push({ change, reason: 'the page already exists' }); continue; }
        try { await writeFile(absolute, change.create.content.endsWith('\n') ? change.create.content : `${change.create.content}\n`, { flag: 'wx' }); }
        catch { outcome.deferred.push({ change, reason: 'the page already exists' }); continue; }
        written.push({ path, absolute });
      }
      accepted.push(change);
    } catch (error) {
      outcome.deferred.push({ change, reason: error instanceof Error ? error.message : 'could not write the file' });
    }
  }
  if (!accepted.length) return outcome;

  const paths = accepted.map(changePath);
  const body = accepted.map(change => `- ${changePath(change)}: ${changePurpose(change)}`).join('\n');
  try {
    if ((await git.head()) !== expectedHead) throw new Error('HEAD moved while Clio was working');
    outcome.committed = await git.commitOnly(paths, subjectFor(paths), body, trailer, written.filter(f => f.original === undefined).map(f => f.path));
    outcome.paths = paths;
  } catch (error) {
    await rollback(git, written);
    const reason = `commit failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    outcome.deferred.push(...accepted.map(change => ({ change, reason })));
  }
  return outcome;
}
