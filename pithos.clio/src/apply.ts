import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Config } from './config.ts';
import { expectedEdit } from './edit-content.ts';
import { assertSafeContent, safeFile, type Proposal, type Snapshot } from './evidence.ts';
import { prepareCreate, type CreateOperation } from './create.ts';
import type { Destination } from './destinations.ts';

export interface Applied { changed: string[]; uncertain: string[]; problems: string[]; documented: number[]; createdDirectories?: string[]; leftoverTemps?: string[] }
interface Creates { destinations: Destination[]; dispatch: (operation: CreateOperation) => Promise<{isError: boolean}>; guard: () => void }
type Execute = (name: string, args: unknown) => Promise<{isError: boolean; result: unknown}>;
export async function applyProposal(root: string, proposal: Proposal, files: Snapshot[], config: Config, execute: Execute, guard: () => void, creates?: Creates): Promise<Applied> {
  const result: Applied = {changed: [], uncertain: [], problems: [], documented: []};
  const snapshots = new Map(files.map(f => [f.path, f]));
  const references = (findings: number[]) => findings.flatMap(i => proposal.findings[i].sources.flatMap(s => 'path' in s ? [s.path] : []));
  const checkBaselines = async (paths: Iterable<string>, destination?: string) => {
    for (const path of new Set(paths)) {
      const base = snapshots.get(path);
      const current = await safeFile(root, path, config, path === destination);
      if (!base || current.hash !== base.hash || current.dev !== base.dev || current.ino !== base.ino) throw new Error(`Clio: baseline conflict: ${path}`);
    }
  };
  for (const edit of proposal.edits) {
    try {
      guard();
      const original = snapshots.get(edit.path);
      if (!original?.doc) throw new Error('Clio: destination not owned by capture');
      await checkBaselines([edit.path, ...references(edit.findings)], edit.path);
      guard();
      const expected = expectedEdit(original.text, edit.oldText, edit.newText);
      assertSafeContent(expected, config);
      if (expected === original.text) continue;
      const target = resolve(await realpath(root), edit.path);
      result.uncertain.push(edit.path); // Dispatch can mutate even if it throws or verification fails.
      const outcome = await execute('edit', {path: target, edits: [{oldText: edit.oldText, newText: edit.newText}]});
      // Observe files, not the success prose: hooks may report failure after a mutation.
      const after = await safeFile(root, edit.path, config, true);
      result.uncertain.pop();
      const identityChanged = after.dev !== original.dev || after.ino !== original.ino;
      if (after.hash !== original.hash || identityChanged) result.changed.push(edit.path);
      if (identityChanged) throw new Error(`Clio: post-edit identity conflict: ${edit.path}`);
      if (outcome.isError) throw new Error(`Clio: guarded edit denied or failed: ${edit.path}`);
      if (after.text !== expected) throw new Error(`Clio: unexpected post-edit contents: ${edit.path}`);
      result.documented.push(...edit.findings.filter(i => !result.documented.includes(i)));
    } catch (error) {
      result.problems.push(error instanceof Error ? error.message : 'Clio: application failed');
      break; // Do not attempt later edits after a conflict or denial; no rollback of accepted writes.
    }
  }
  if (!result.problems.length) for (const create of proposal.creates ?? []) {
    let operation: CreateOperation | undefined;
    try {
      if (!creates) throw new Error('Clio: create dispatch unavailable');
      const check = async () => {
        guard(); creates.guard();
        await checkBaselines(references(create.findings));
        guard(); creates.guard();
      };
      operation = await prepareCreate(root, create, creates.destinations, config, check);
      const outcome = await creates.dispatch(operation);
      guard(); creates.guard();
      if (outcome.isError || operation.completion.state !== 'succeeded' || operation.ledger.state !== 'published') throw new Error(`Clio: guarded create denied or failed: ${create.path}`);
      result.documented.push(...create.findings.filter(i => !result.documented.includes(i)));
    } catch (error) {
      // Hooks can clear or replace execute's error, but not the publisher's failure.
      const failure = operation?.completion.state === 'failed' ? operation.completion.error : error;
      result.problems.push(failure instanceof Error ? failure.message : 'Clio: creation failed');
    } finally {
      if (operation) {
        const ledger = operation.ledger;
        if (ledger.state === 'published') result.changed.push(create.path);
        if (ledger.state === 'uncertain') result.uncertain.push(create.path);
        if (ledger.createdDirectories.length) (result.createdDirectories ??= []).push(...ledger.createdDirectories);
        if (ledger.leftoverTemps.length) (result.leftoverTemps ??= []).push(...ledger.leftoverTemps);
      }
    }
    if (result.problems.length) break;
  }
  return result;
}
