import assert from 'node:assert/strict';
import test from 'node:test';
import { inertDockerGradingOwner, confinedDockerGradingOwner } from '../src/grading-composition.ts';
import { superviseAuthorization } from '../src/grading-boundary.ts';
import { fixture, backend } from './inert-docker-composition-fixture.ts';
const binding = { attemptId: 'attempt', gradingRunId: 'run', artifactDigest: 'a'.repeat(64), observerDigest: 'b'.repeat(64) };
test('concrete Docker composition exports separately, destroys exporter before grading, preserves modes', async t => {
  const selection = await fixture(t), fake = backend(selection);
  const owner = inertDockerGradingOwner(selection, fake.launch);
  assert.equal((await superviseAuthorization(binding, owner)).state, 'passed');
  const evidence = await owner.snapshotEvidence!();
  assert.equal(evidence.snapshot.files['src/users.mjs'].mode, 0o751);
  assert.equal(fake.early(), false);
  assert.equal(fake.removed.size, 3);
  for (const command of fake.calls.filter(args => args[0] === 'create')) {
    assert.equal(command.filter(a => a === '--mount').length, 2);
    assert(!command.join(' ').includes(selection.grading.retained));
    assert(!command.join(' ').includes(selection.grading.producer));
  }
});
for (const fault of ['collision', 'unknown-id', 'late-id', 'private-mount', 'uncertain-destruction', 'bad-frame']) test(`composition refuses ${fault} without releasing snapshot or starting grader`, async t => {
  const selection = await fixture(t), fake = backend(selection, fault), owner = inertDockerGradingOwner(selection, fake.launch);
  assert.equal((await superviseAuthorization(binding, owner)).state, 'cleanup-pending');
  await assert.rejects(owner.snapshotEvidence!());
  assert.equal(fake.calls.filter(a => a[0] === 'create').length, 1);
  if (fault === 'late-id') await new Promise(resolve => setTimeout(resolve, 200));
  if (['collision', 'unknown-id', 'late-id', 'private-mount'].includes(fault)) assert.equal(fake.removed.size, 1);
  assert(fake.calls.filter(a => a[0] === 'rm').every(a => /^[a-f0-9]{64}$/.test(a.at(-1)!)));
});
test('operational Docker composition remains unconditionally closed', async t => {
  const selection = await fixture(t);
  assert.throws(() => confinedDockerGradingOwner(selection), /CLOSED/);
});
