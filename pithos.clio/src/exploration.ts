import { opendir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Config } from './config.ts';
import { DirectoryNotFoundError, safeDirectory, safeFile, type Snapshot } from './evidence.ts';
import { BudgetError, capacityText, evidenceBudget } from './budget.ts';

const Parameters = Type.Object({action: Type.Union([Type.Literal('list'), Type.Literal('read')]), path: Type.String({minLength: 1, maxLength: 500})}, {additionalProperties: false});
export function evidenceTool(root: string, files: Snapshot[], config: Config, provenance: readonly Pick<Snapshot, 'path' | 'doc'>[] = files, admit?: (id: string, text: string) => void): AgentTool<typeof Parameters> {
  const authorized = provenance.map(({path, doc}) => ({path, doc}));
  // Root-level observations permit root-level files, not arbitrary subtrees.
  const scopes = new Set([...authorized.filter(f => !f.doc).map(f => dirname(f.path)), ...authorized.filter(f => f.doc && dirname(f.path) !== '.').map(f => dirname(f.path)), 'docs', ...config.docsDirs]);
  // Discovery considers ancestor READMEs even when they do not fit the initial
  // snapshots. Authorize exact paths, never the surrounding ancestor trees.
  const ancestorReadmes = new Set<string>();
  for (const file of authorized) {
    let dir = dirname(file.path);
    for (let depth = 0; depth < 12 && dir !== '..'; depth++) {
      ancestorReadmes.add(dir === '.' ? 'README.md' : `${dir}/README.md`);
      scopes.add(dir === '.' ? 'docs' : `${dir}/docs`);
      if (dir === '.') break;
      dir = dirname(dir);
    }
  }
  const scoped = (path: string) => ancestorReadmes.has(path) || authorized.some(f => f.path === path) || files.some(f => f.path === path) || [...scopes].some(scope => scope === '.' ? dirname(path) === '.' : path === scope || path.startsWith(scope + '/'));
  return {
    name: 'clio_evidence', label: 'Clio evidence',
    description: `Read-only bounded evidence. Read a whole eligible UTF-8 file or list an immediate directory with eligible fileSizes and remaining budget. Capacity or authorized directory not-found feedback contains no readable/citable evidence; finalize from registered snapshots without retries. Directory absence does not authorize creation; missing reads and unsafe paths remain fatal. No shell, writes or resources. Authorization: ${JSON.stringify({scopes: [...scopes], readPaths: [...new Set([...authorized.map(f => f.path), ...ancestorReadmes])]})}. Exact readable paths do not authorize listing their parent or sibling directories. A scope "." permits only immediate root-level files, not subtrees. Other scopes permit their own directory and descendants. Scope refusals end capture; if relevant evidence is inaccessible, return a valid empty proposal.`,
    parameters: Parameters, executionMode: 'sequential',
    async execute(_id, {action, path}, signal) {
      signal?.throwIfAborted();
      if (!scoped(path)) throw new Error('Clio: evidence outside observed scope');
      const response = (text: string) => ({content: [{type: 'text' as const, text}], details: undefined});
      const feedback = (error: BudgetError) => {
        const text = capacityText(error, files, config);
        // Feedback is counted too. If it cannot fit, the worker stops locally.
        admit?.(_id, text);
        return response(text);
      };
      const admittedResponse = (text: string) => {
        try { admit?.(_id, text); }
        catch (error) { if (error instanceof BudgetError) return feedback(error); throw error; }
        return response(text);
      };
      let value: unknown;
      let candidate: Snapshot | undefined;
      if (action === 'read') {
        let file: Snapshot;
        try { file = await safeFile(root, path, config); }
        catch (error) { if (error instanceof BudgetError && !files.some(f => f.path === path)) return feedback(error); throw error; }
        signal?.throwIfAborted();
        const prior = files.find(f => f.path === path);
        if (prior && (prior.hash !== file.hash || prior.dev !== file.dev || prior.ino !== file.ino)) throw new Error('Clio: evidence baseline changed');
        value = {path: file.path, text: file.text, doc: file.doc};
        const responseBytes = Buffer.byteLength(JSON.stringify(value));
        if (responseBytes > config.maxContextBytes) return feedback(new BudgetError('response-bytes', 0, responseBytes, config.maxContextBytes));
        if (!prior) {
          if (files.length >= config.maxFiles) return feedback(new BudgetError('file-count', files.length, 1, config.maxFiles));
          const current = evidenceBudget(files, config).evidenceBytes;
          const requested = Buffer.byteLength(JSON.stringify([...files, file])) - current;
          if (current + requested > config.maxContextBytes) return feedback(new BudgetError('evidence-bytes', current, requested, config.maxContextBytes));
          candidate = file;
        }
      } else {
        let directory: string;
        try { directory = await safeDirectory(root, path); }
        catch (error) {
          if (!(error instanceof DirectoryNotFoundError)) throw error;
          signal?.throwIfAborted();
          const text = JSON.stringify({status: 'not-found', action: 'list', path});
          if (Buffer.byteLength(text) > config.maxContextBytes) return feedback(new BudgetError('response-bytes', 0, Buffer.byteLength(text), config.maxContextBytes));
          return admittedResponse(text);
        }
        const entries: string[] = [];
        const fileSizes: Record<string, number> = {};
        let visited = 0;
        let truncated = false;
        const dir = await opendir(directory);
        for await (const entry of dir) {
          signal?.throwIfAborted();
          if (++visited > 100) { truncated = true; break; }
          const child = path === '.' ? entry.name : `${path}/${entry.name}`;
          if (!scoped(child)) continue;
          try {
            if (entry.isDirectory()) { await safeDirectory(root, child); entries.push(child + '/'); }
            else if (entry.isFile()) {
              const file = await safeFile(root, child, config);
              entries.push(child);
              fileSizes[child] = Buffer.byteLength(file.text);
            }
          } catch { /* Do not disclose excluded/sensitive names or content. */ }
        }
        value = {path, entries, fileSizes, truncated, budget: evidenceBudget(files, config)};
      }
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > config.maxContextBytes) return feedback(new BudgetError('response-bytes', 0, Buffer.byteLength(text), config.maxContextBytes));
      // Never register a body until the projected complete continuation fits.
      try { admit?.(_id, text); }
      catch (error) { if (error instanceof BudgetError) return feedback(error); throw error; }
      if (candidate) files.push(candidate);
      return response(text);
    },
  };
}
