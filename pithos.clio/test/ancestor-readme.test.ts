import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { safeFile } from '../src/evidence.ts';
import { evidenceTool } from '../src/exploration.ts';

// Behaviors: uncaptured ancestor README reads; no ancestor/sibling tree expansion;
// safeFile exclusions and shared snapshot budgets remain authoritative.
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'clio-ancestor-'));
  try {
    await mkdir(join(root, 'pithos.clio/src'), {recursive: true});
    await writeFile(join(root, 'pithos.clio/src/exploration.ts'), 'export const explore = true;');
    await writeFile(join(root, 'pithos.clio/src/config.ts'), 'export const config = true;');
    await writeFile(join(root, 'README.md'), 'Root documentation');
    await writeFile(join(root, 'pithos.clio/README.md'), 'Clio documentation');
    await run(root);
  } finally { await rm(root, {recursive: true, force: true}); }
}
const observed = ['pithos.clio/src/exploration.ts', 'pithos.clio/src/config.ts', 'README.md'];

test('uncaptured relevant ancestor README can be read and registered as documentation', async () => fixture(async root => {
  const config = parseConfig({});
  const files = await Promise.all(observed.map(path => safeFile(root, path, config)));
  const tool = evidenceTool(root, files, config);
  const result = await tool.execute('ancestor', {action: 'read', path: 'pithos.clio/README.md'}, undefined);
  assert.match(JSON.stringify(result.content), /Clio documentation/);
  assert.equal(files.find(f => f.path === 'pithos.clio/README.md')?.doc, true);
}));

test('ancestor README eligibility does not open ancestor directories or sibling trees', async () => fixture(async root => {
  await mkdir(join(root, 'pithos.clio/other'));
  await mkdir(join(root, 'pithos.other'));
  await writeFile(join(root, 'pithos.clio/other/README.md'), 'Unrelated nested docs');
  await writeFile(join(root, 'pithos.other/README.md'), 'Unrelated package');
  await writeFile(join(root, 'pithos.clio/other.ts'), 'export const unrelated = true;');
  const config = parseConfig({});
  const files = await Promise.all(observed.map(path => safeFile(root, path, config)));
  const tool = evidenceTool(root, files, config);
  for (const path of ['pithos.clio/other/README.md', 'pithos.other/README.md', 'pithos.clio/other.ts']) {
    await assert.rejects(tool.execute('sibling', {action: 'read', path}, undefined), /outside observed scope/);
  }
  await assert.rejects(tool.execute('ancestor-list', {action: 'list', path: 'pithos.clio'}, undefined), /outside observed scope/);
  assert.deepEqual(files.map(f => f.path), observed);
}));

test('uncaptured ancestor README still passes safeFile checks and shared evidence budgets', async () => fixture(async root => {
  const path = 'pithos.clio/README.md';
  for (const settings of [{maxFiles: 3}, {maxContextBytes: 1000}]) {
    const config = parseConfig(settings);
    const files = await Promise.all(observed.map(path => safeFile(root, path, config)));
    // Each file fits individually, but the combined snapshots exceed the budget.
    if (settings.maxContextBytes) await writeFile(join(root, path), 'Documentation '.repeat(60));
    const result = await evidenceTool(root, files, config).execute('budget', {action: 'read', path}, undefined);
    assert.match(JSON.stringify(result.content), settings.maxFiles ? /file-count/ : /evidence-bytes/);
    assert.deepEqual(files.map(f => f.path), observed);
  }
  const config = parseConfig({});
  const files = await Promise.all(observed.map(path => safeFile(root, path, config)));
  const tool = evidenceTool(root, files, config);
  for (const text of ['// auto-generated documentation', 'api_key=verySensitiveValue', 'binary\0content']) {
    await writeFile(join(root, path), text);
    await assert.rejects(tool.execute('unsafe', {action: 'read', path}, undefined), /generated or sensitive content refused/);
  }
  await rm(join(root, path));
  await symlink(join(root, 'README.md'), join(root, path));
  await assert.rejects(tool.execute('symlink', {action: 'read', path}, undefined), /symlink refused/);
  await rm(join(root, path));
  await link(join(root, 'README.md'), join(root, path));
  await assert.rejects(tool.execute('hardlink', {action: 'read', path}, undefined), /file budget exceeded/);
  assert.deepEqual(files.map(f => f.path), observed);
}));
