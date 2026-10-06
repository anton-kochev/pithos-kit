import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { applyProposal } from '../src/apply.ts';
import { snapshot, type Proposal } from '../src/evidence.ts';
import { parseConfig } from '../src/config.ts';
import { discoverDestinations } from '../src/destinations.ts';
import { publishCreate } from '../src/create.ts';

test('post-link publisher failure survives cleared or thrown dispatch results', async t => {
  for (const boundary of ['cleared-error', 'thrown-error']) await t.test(boundary, async () => {
    const root = await mkdtemp(join(tmpdir(), 'clio-apply-create-'));
    try {
      await writeFile(join(root, 'cache.ts'), 'export const ttl = 30;');
      const config = parseConfig({});
      const files = await snapshot(root, ['cache.ts'], config);
      const destinations = await discoverDestinations(root, [], config);
      const proposal: Proposal = {
        findings: [{claim: 'ttl 30', kind: 'observed', sources: [{path: 'cache.ts', startLine: 1, endLine: 1}]}],
        edits: [], creates: ['cache', 'second'].map(name => ({path: `docs/${name}.md`, content: 'TTL is 30.', findings: [0]})), unresolved: [],
      };
      let calls = 0;
      const result = await applyProposal(root, proposal, files, config, async () => { throw new Error('unexpected edit'); }, () => {}, {
        destinations, guard: () => {},
        dispatch: async operation => {
          calls++;
          if (calls === 1) {
            await assert.rejects(publishCreate(operation, undefined, {
              link, unlink: async () => { throw new Error('cleanup denied'); },
            }), /cleanup denied/);
            // Model the result boundary after Pi catches execute's rejection.
            if (boundary === 'thrown-error') throw new Error('result hook failed');
          } else await publishCreate(operation);
          return {isError: false};
        },
      });
      assert.deepEqual(result.problems, ['cleanup denied']);
      assert.deepEqual(result.documented, []);
      assert.deepEqual(result.changed, ['docs/cache.md']);
      assert.deepEqual(result.uncertain, []);
      assert.deepEqual(result.createdDirectories, [join(root, 'docs')]);
      const temps = (await readdir(join(root, 'docs'))).filter(name => name.startsWith('.clio-'));
      assert.equal(temps.length, 1);
      assert.deepEqual(result.leftoverTemps, temps.map(name => join(root, 'docs', name)));
      assert.equal(await readFile(result.leftoverTemps![0], 'utf8'), 'TTL is 30.');
      assert.equal(await readFile(join(root, 'docs/cache.md'), 'utf8'), 'TTL is 30.');
      assert.equal(calls, 1);
      await assert.rejects(readFile(join(root, 'docs/second.md')), {code: 'ENOENT'});
    } finally { await rm(root, {recursive: true, force: true}); }
  });
});

test('parent apply revalidates baselines and permissions, honors hook errors and preserves partial outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clio-apply-'));
  try {
    await mkdir(join(root, 'src')); await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'src/cache.ts'), 'export const ttl = 30;');
    await writeFile(join(root, 'README.md'), 'Old');
    await writeFile(join(root, 'docs/cache.md'), 'Old');
    const config = parseConfig({});
    const files = await snapshot(root, ['src/cache.ts'], config);
    const proposal: Proposal = {findings: [{claim: 'ttl 30', kind: 'observed', sources: [{path: 'src/cache.ts', startLine: 1, endLine: 1}]}], edits: ['README.md', 'docs/cache.md'].map(path => ({path, oldText: 'Old', newText: 'ttl 30', findings: [0]})), unresolved: []};
    let calls = 0;
    const executeTool = async (name: string, args: any) => {
      assert.equal(name, 'edit'); assert.deepEqual(Object.keys(args).sort(), ['edits', 'path']);
      calls++;
      if (calls === 2) return {isError: true, result: {content: [{type: 'text', text: 'Permission guard denied'}]}};
      await writeFile(resolve(root, args.path), args.edits[0].newText);
      return {isError: false, result: {content: []}};
    };
    let allowed = true;
    const guard = () => { if (!allowed) throw new Error('Plan active'); };
    await writeFile(join(root, 'src/cache.ts'), 'changed externally');
    const stale = await applyProposal(root, proposal, files, config, executeTool, guard);
    assert.equal(calls, 0); assert.match(stale.problems.join(), /baseline/);
    await writeFile(join(root, 'src/cache.ts'), 'export const ttl = 30;');
    allowed = false;
    const blocked = await applyProposal(root, proposal, files, config, executeTool, guard);
    assert.equal(calls, 0); assert.match(blocked.problems.join(), /Plan/);
    allowed = true;
    const partial = await applyProposal(root, proposal, files, config, executeTool, guard);
    assert.deepEqual(partial.changed, ['README.md']);
    assert.match(partial.problems.join(), /denied|failed/i);
    assert.equal(await readFile(join(root, 'docs/cache.md'), 'utf8'), 'Old');
  } finally { await rm(root, {recursive: true, force: true}); }
});
