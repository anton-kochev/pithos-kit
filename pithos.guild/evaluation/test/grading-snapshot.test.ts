import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, chmod, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, snapshot, git } from '../src/fixture.ts';
import { readTree } from '../src/grading-owner.ts';
import { approvedGitDigest, inertSnapshotExport, confinedSnapshotExport } from '../src/grading-snapshot.ts';

test('reconstructed approved snapshot ignores callback config and retains modes, index, status and diff', async t => {
  const root = await mkdtemp(join(tmpdir(), 'snapshot-inert-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await createFixture(repo, { files: { 'run.sh': 'old\n' }, staged: { 'run.sh': 'staged\n' }, untracked: { 'new.txt': 'new\n' } });
  await chmod(join(repo, 'run.sh'), 0o755);
  await mkdir(join(repo, 'empty'));
  const expected = await snapshot(repo);
  const approved = approvedGitDigest(await readTree(repo));
  const sentinel = join(root, 'sentinel');
  await writeFile(join(repo, '.git/config'), `[core]\n repositoryformatversion = 0\n fsmonitor = "printf touched > ${sentinel}"\n hooksPath = ${root}\n[diff]\n external = "printf touched > ${sentinel}"\n[include]\n path = /not-approved\n`);
  const tree = await readTree(repo);
  const result = await inertSnapshotExport(tree, approved);
  assert.deepEqual(result, expected);
  await assert.rejects(access(sentinel));
  // Positive control: the safe, locally authored callback is live in the source
  // repository. Only this inert fixture may deliberately exercise it on host.
  await git(repo, ['status', '--porcelain=v1']);
  await access(sentinel);
  await assert.rejects(inertSnapshotExport(tree, '0'.repeat(64)), /approval/);
  const oversized = new Map(tree);
  for (let i = 0; i < 2001; i++) oversized.set(`empty-${i}`, { kind: 'directory', mode: 0o700 });
  await assert.rejects(inertSnapshotExport(oversized, approved), /entry limit/);
  const nested = new Map(tree);
  nested.set('nested/.git/config', { kind: 'file', bytes: Buffer.from('unsafe'), mode: 0o600 });
  await assert.rejects(inertSnapshotExport(nested, approved), /Unsupported nested/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inertSnapshotExport(tree, approved, controller.signal), /abort/i);
  await writeFile(join(repo, '.git/commondir'), '/elsewhere');
  await assert.rejects(inertSnapshotExport(await readTree(repo), approved), /Unsupported/);
  assert.throws(() => confinedSnapshotExport(), /unavailable/);
});

// Caller-owned Map, entry records and Buffer storage must stop being live inputs
// synchronously at invocation, including both approved Git and working bytes.
for (const mutation of ['map replacement', 'index buffer', 'working buffer', 'entry modes'] as const) {
  test(`snapshot detaches caller ${mutation} before its first await`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-detached-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, 'repo');
    await createFixture(repo, { files: { 'run.sh': 'original\n' }, staged: { 'run.sh': 'staged\n' }, untracked: {} });
    const expected = await snapshot(repo);
    const tree = await readTree(repo);
    const approved = approvedGitDigest(tree);
    const pending = inertSnapshotExport(tree, approved);
    if (mutation === 'map replacement') {
      tree.set('run.sh', { kind: 'file', bytes: Buffer.from('replacement\n'), mode: 0o755 });
      tree.set('injected.txt', { kind: 'file', bytes: Buffer.from('injected\n'), mode: 0o600 });
    } else if (mutation === 'entry modes') {
      tree.get('run.sh')!.mode = 0o755;
    } else {
      const entry = tree.get(mutation === 'index buffer' ? '.git/index' : 'run.sh');
      assert.equal(entry?.kind, 'file');
      if (entry?.kind === 'file') entry.bytes.fill(0);
    }
    assert.deepEqual(await pending, expected);
  });
}
