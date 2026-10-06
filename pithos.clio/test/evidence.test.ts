import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { snapshot, validateProposal, safeFile } from '../src/evidence.ts';

test('host evidence bounds scope, canonical paths and exact source-backed patches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-'));
  try {
    await mkdir(join(root, 'src')); await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'src/cache.ts'), 'export const ttl = 30;\n');
    await writeFile(join(root, 'README.md'), '# Cache\nOld description.\n');
    await writeFile(join(root, 'docs/AGENTS.md'), 'instructions');
    await writeFile(join(root, 'docs/instructions.md'), 'instructions');
    await link(join(root, 'docs/AGENTS.md'), join(root, 'docs/alias.md'));
    await writeFile(join(root, 'docs/generated.md'), '<!-- generated -->');
    await writeFile(join(root, 'docs/invalid.md'), Buffer.from([0xff, 0xfe]));
    await writeFile(join(root, 'docs/auth.json'), '{"secret":"no"}');
    await symlink(join(root, 'README.md'), join(root, 'docs/link.md'));
    const config = parseConfig({});
    const files = await snapshot(root, ['src/cache.ts'], config);
    assert.deepEqual(files.map(f => f.path).sort(), ['README.md', 'src/cache.ts']);
    for (const path of ['../README.md', '.pi/clio.json', 'docs/AGENTS.md', 'docs/instructions.md', 'docs/alias.md', 'docs/generated.md', 'docs/invalid.md', 'docs/auth.json', 'docs/link.md']) {
      await assert.rejects(safeFile(root, path, config, true));
    }
    const valid = {findings: [{claim: 'Cache lifetime is 30.', kind: 'observed', sources: [{path: 'src/cache.ts', startLine: 1, endLine: 1}]}], edits: [{path: 'README.md', oldText: 'Old description.', newText: 'Cache lifetime is 30.', findings: [0]}], unresolved: []};
    assert.equal(validateProposal(JSON.stringify(valid), files, config).edits.length, 1);
    for (const proposal of [
      {...valid, extra: true}, {...valid, edits: [{...valid.edits[0], path: 'new.md'}]},
      {...valid, edits: [{...valid.edits[0], path: 'src/cache.ts'}]},
      {...valid, edits: [{...valid.edits[0], oldText: 'missing'}]},
      {...valid, findings: [{...valid.findings[0], sources: [{path: 'unknown.ts', startLine: 1, endLine: 1}]}]},
      {...valid, findings: [{...valid.findings[0], sources: [{path: 'src/cache.ts', startLine: 1, endLine: 100}]}]},
      {...valid, edits: [{...valid.edits[0], findings: [99]}]},
    ]) assert.throws(() => validateProposal(JSON.stringify(proposal), files, config), /Clio/);
    assert.throws(() => validateProposal('x'.repeat(config.maxResultBytes + 1), files, config), /Clio/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
