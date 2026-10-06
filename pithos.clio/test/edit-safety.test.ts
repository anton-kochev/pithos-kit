import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createEditTool, type EditToolInput } from '@earendil-works/pi-coding-agent';
import { applyProposal } from '../src/apply.ts';
import { safeFile, type Proposal } from '../src/evidence.ts';
import { parseConfig } from '../src/config.ts';
import { completion } from '../src/ui.ts';

const config = parseConfig({});
function proposal(path: string, oldText = 'Old', newText = 'New'): Proposal {
  return {findings: [{claim: 'Updated documentation', kind: 'observed', sources: [{path, startLine: 1, endLine: 1}]}], edits: [{path, oldText, newText, findings: [0]}], unresolved: []};
}
function builtin(root: string, paths: string[]) {
  const tool = createEditTool(root);
  return async (name: string, args: unknown) => {
    assert.equal(name, 'edit');
    const input = args as EditToolInput;
    paths.push(input.path);
    try { return {isError: false, result: await tool.execute('fixture-edit', input)}; }
    catch (error) { return {isError: true, result: error}; }
  };
}

test('real Pi edit refuses normalization aliases without touching outside files', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'clio-paths-'));
  const previousHome = process.env.HOME;
  try {
    const root = join(sandbox, 'project');
    const home = join(sandbox, 'home');
    await mkdir(root); await mkdir(home);
    process.env.HOME = home;
    const aliases = [
      {path: '@../README.md', outside: join(sandbox, 'README.md')},
      {path: '~/README.md', outside: join(home, 'README.md')},
      {path: 'docs/space\u00a0/README.md', outside: join(sandbox, 'unicode/README.md')},
    ];
    await mkdir(join(root, 'docs'), {recursive: true});
    await mkdir(join(sandbox, 'unicode'));
    await symlink(join(sandbox, 'unicode'), join(root, 'docs/space '));
    for (const {path, outside} of aliases) {
      await mkdir(dirname(join(root, path)), {recursive: true});
      await writeFile(join(root, path), 'Old');
      await writeFile(outside, 'Old');
    }
    const paths: string[] = [];
    const execute = builtin(root, paths);
    for (const {path} of aliases) {
      try {
        const file = await safeFile(root, path, config, true);
        await applyProposal(root, proposal(path), [file], config, execute, () => {});
      } catch (error) { assert.match(String(error), /Clio:.*(?:path|normalization)/); }
    }
    for (const {path, outside} of aliases) {
      assert.equal(await readFile(outside, 'utf8'), 'Old', `outside unchanged: ${path}`);
      assert.equal(await readFile(join(root, path), 'utf8'), 'Old', `literal unchanged: ${path}`);
    }
    assert.deepEqual(paths, [], 'aliases must never reach edit');
    await writeFile(join(root, 'README.md'), 'Old');
    const file = await safeFile(root, 'README.md', config, true);
    const applied = await applyProposal(root, proposal('README.md'), [file], config, execute, () => {});
    assert.deepEqual(applied.problems, []);
    assert.deepEqual(paths, [resolve(root, 'README.md')], 'dispatch canonical absolute path');
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(sandbox, {recursive: true, force: true});
  }
});

test('real Pi edit predicts literal dollar replacements and preserves CRLF and BOM', async t => {
  for (const fixture of [
    {name: 'dollars', text: 'Before Old After', old: 'Old', replacement: '$& $$ $` $\'', expected: 'Before $& $$ $` $\' After'},
    {name: 'CRLF multiline', text: '# Title\r\nOld\r\nbody\r\nEnd\r\n', old: 'Old\r\nbody', replacement: 'New\nbody', expected: '# Title\r\nNew\r\nbody\r\nEnd\r\n'},
    {name: 'BOM and CRLF', text: '\ufeffOld\r\nbody\r\n', old: 'Old\r\nbody', replacement: 'New\nbody', expected: '\ufeffNew\r\nbody\r\n'},
  ]) await t.test(fixture.name, async () => {
    const root = await mkdtemp(join(tmpdir(), 'clio-literal-'));
    try {
      await writeFile(join(root, 'README.md'), fixture.text);
      const file = await safeFile(root, 'README.md', config, true);
      const paths: string[] = [];
      const applied = await applyProposal(root, proposal('README.md', fixture.old, fixture.replacement), [file], config, builtin(root, paths), () => {});
      assert.equal(await readFile(join(root, 'README.md'), 'utf8'), fixture.expected);
      assert.deepEqual(applied.problems, []);
      assert.deepEqual(applied.changed, ['README.md']);
      assert.deepEqual(applied.documented, [0]);
      assert.equal(paths.length, 1);
    } finally { await rm(root, {recursive: true, force: true}); }
  });
});

test('unsafe resulting content is rejected before dispatch by the shared file policy', async t => {
  for (const fixture of [
    {name: 'NUL', text: 'Old', replacement: 'New\0content'},
    {name: 'credential', text: 'Old', replacement: 'password=hunter23456789'},
    {name: 'generated across replacement boundary', text: 'auto-Old', replacement: 'generated'},
    {name: 'UTF-8 byte budget', text: 'Old', replacement: '界'.repeat(334)},
    {name: 'whole file byte budget', text: 'x'.repeat(990) + 'Old', replacement: 'More than ten bytes'},
    {name: 'restored CRLF byte budget', text: 'Old\r\n', replacement: 'x\n'.repeat(334)},
  ]) await t.test(fixture.name, async () => {
    const root = await mkdtemp(join(tmpdir(), 'clio-preflight-'));
    try {
      const limited = parseConfig({maxContextBytes: 1000});
      await writeFile(join(root, 'README.md'), fixture.text);
      const file = await safeFile(root, 'README.md', limited, true);
      const paths: string[] = [];
      const applied = await applyProposal(root, proposal('README.md', 'Old', fixture.replacement), [file], limited, builtin(root, paths), () => {});
      assert.deepEqual(paths, [], 'unsafe output must never reach edit');
      assert.equal(await readFile(join(root, 'README.md'), 'utf8'), fixture.text);
      assert.deepEqual(applied.changed, []);
      assert.deepEqual(applied.documented, []);
      assert.match(applied.problems.join(), /sensitive|generated|budget/);
    } finally { await rm(root, {recursive: true, force: true}); }
  });
});

test('postwrite failures preserve uncertain paths and conflicts without claiming capture', async t => {
  for (const scenario of ['read failure', 'unsafe postwrite', 'dispatch throws', 'content conflict', 'identity conflict']) await t.test(scenario, async () => {
    const root = await mkdtemp(join(tmpdir(), 'clio-postwrite-'));
    try {
      const path = join(root, 'README.md');
      await writeFile(path, 'Old');
      const file = await safeFile(root, 'README.md', config, true);
      const paths: string[] = [];
      const realEdit = builtin(root, paths);
      const applied = await applyProposal(root, proposal('README.md'), [file], config, async (name, args) => {
        const result = await realEdit(name, args);
        assert.equal(result.isError, false);
        if (scenario === 'read failure') await rm(path);
        if (scenario === 'unsafe postwrite') await writeFile(path, 'New\0');
        if (scenario === 'dispatch throws') throw new Error('hook failed after mutation');
        if (scenario === 'content conflict') await writeFile(path, 'Concurrent update');
        if (scenario === 'identity conflict') {
          await writeFile(join(root, 'replacement'), 'New');
          const {rename} = await import('node:fs/promises');
          await rename(join(root, 'replacement'), path);
        }
        return result;
      }, () => {});
      const uncertain = ['read failure', 'unsafe postwrite', 'dispatch throws'].includes(scenario);
      assert.deepEqual(applied.uncertain, uncertain ? ['README.md'] : []);
      assert.deepEqual(applied.changed, uncertain ? [] : ['README.md']);
      assert.deepEqual(applied.documented, []);
      assert.equal(applied.problems.length, 1);
      const summary = completion(applied, 1000, undefined, [])!;
      assert.match(summary, /0 findings captured/);
      if (uncertain) {
        assert.match(summary, /Possibly modified \(unverified\): README.md/);
        assert.doesNotMatch(summary, /0 files changed/);
      } else assert.match(summary, /Changed: README.md/);
    } finally { await rm(root, {recursive: true, force: true}); }
  });
});
