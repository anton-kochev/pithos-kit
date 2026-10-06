import { opendir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Config } from './config.ts';
import { safeDirectory, safeFile, type Snapshot } from './evidence.ts';

const Parameters = Type.Object({action: Type.Union([Type.Literal('list'), Type.Literal('read')]), path: Type.String({minLength: 1, maxLength: 500})}, {additionalProperties: false});
export function evidenceTool(root: string, files: Snapshot[], config: Config): AgentTool<typeof Parameters> {
  // Root-level observations permit root-level files, not arbitrary subtrees.
  const scopes = new Set([...files.filter(f => !f.doc).map(f => dirname(f.path)), ...files.filter(f => f.doc && dirname(f.path) !== '.').map(f => dirname(f.path)), 'docs', ...config.docsDirs]);
  const scoped = (path: string) => files.some(f => f.path === path) || [...scopes].some(scope => scope === '.' ? dirname(path) === '.' : path === scope || path.startsWith(scope + '/'));
  return {
    name: 'clio_evidence', label: 'Clio evidence',
    description: `Read-only bounded evidence. Read a whole eligible UTF-8 file or list an immediate directory. No shell, writes or resources. Scopes: ${JSON.stringify([...scopes])}. Existing snapshot paths also readable.`,
    parameters: Parameters, executionMode: 'sequential',
    async execute(_id, {action, path}, signal) {
      signal?.throwIfAborted();
      if (!scoped(path)) throw new Error('Clio: evidence outside observed scope');
      let value: unknown;
      if (action === 'read') {
        const file = await safeFile(root, path, config);
        signal?.throwIfAborted();
        const prior = files.find(f => f.path === path);
        if (prior && (prior.hash !== file.hash || prior.dev !== file.dev || prior.ino !== file.ino)) throw new Error('Clio: evidence baseline changed');
        if (!prior) {
          if (files.length >= config.maxFiles || Buffer.byteLength(JSON.stringify([...files, file])) > config.maxContextBytes) throw new Error('Clio: evidence budget exceeded');
          files.push(file);
        }
        value = {path: file.path, text: file.text, doc: file.doc};
      } else {
        const directory = await safeDirectory(root, path);
        const entries: string[] = [];
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
            else if (entry.isFile()) { await safeFile(root, child, config); entries.push(child); }
          } catch { /* Do not disclose excluded/sensitive names or content. */ }
        }
        value = {path, entries, truncated};
      }
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > config.maxContextBytes) throw new Error('Clio: evidence response budget exceeded');
      return {content: [{type: 'text', text}], details: undefined};
    },
  };
}
