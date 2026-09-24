import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { deploymentFixture } from './inert-producer-deployment-fixture.ts';
import { backend } from './inert-docker-composition-fixture.ts';
import { installInertProducerDeployment } from '../src/producer-deployment.ts';
import { prepareInertProducerAttempt, submitInertProducerCreate, producerAttemptState, producerCommand, producerAttemptSelection, launchProducer } from '../src/producer-launcher.ts';
import { reserveFinalizationStorage } from '../src/finalization-storage.ts';
import { issueRegisteredFinalizationOrigin, finalizeOwnedTrial, auditRetainedFinalization } from '../src/trial-finalization.ts';
import { readTree } from '../src/grading-owner.ts';
import { inertDockerGradingOwner } from '../src/grading-composition.ts';
import { approvedGitDigest } from '../src/grading-snapshot-core.ts';
import { digest } from '../src/manifest.ts';
import { loadDevelopmentBank } from '../src/bank.ts';
async function preparation(t: import('node:test').TestContext, fault = '') {
  const root = await mkdtemp(join(tmpdir(), 'producer-chain-')); t.after(() => rm(root, { recursive: true, force: true }));
  const data = deploymentFixture(root), deployment = installInertProducerDeployment(data);
  const trialId = '00000000-0000-4000-8000-000000000001', directory = join(data.retention.trialParent, trialId);
  for (const path of [data.retention.trialParent, directory, join(directory, 'repo'), data.exchange]) await mkdir(path, { mode: 0o700 });
  for (const roster of [data.producer, data.grader, data.exporter]) for (const name of Object.keys(roster.files)) {
    await mkdir(dirname(join(roster.root, name)), { recursive: true }); await writeFile(join(roster.root, name), name);
  }
  await mkdir(join(directory, 'repo/src')); await mkdir(join(directory, 'repo/.git'));
  await writeFile(join(directory, 'repo/src/users.mjs'), 'inert never executed', { mode: 0o751 });
  await writeFile(join(directory, 'repo/.git/HEAD'), 'ref: refs/heads/eval\n');
  await writeFile(join(directory, 'repo/.git/index'), 'inert index never read by host Git');
  const baseline = { files: {}, index: 'inert', status: '', diff: '' };
  const identity = { trialId, requestDigest: digest('request'), baselineDigest: digest(baseline), campaignDigest: digest('campaign'), admissionDigest: digest('admission'), launchDigest: digest('launch') };
  const git = approvedGitDigest(await readTree(join(directory, 'repo')));
  const attempt = prepareInertProducerAttempt(deployment, directory, identity, git);
  const selection = producerAttemptSelection(attempt), command = producerCommand(attempt);
  selection.grading.producerIdentity.id = 'c'.repeat(64); // Authored daemon outcome only.
  const fake = backend(selection, fault, data.producer.root, command.args);
  const storage = await reserveFinalizationStorage(deployment, directory, attempt);
  return { data, deployment, directory, identity, baseline, attempt, selection, fake, storage, git,
    task: loadDevelopmentBank().tasks.find(t => t.grader === 'authorization')! };
}
for (const pass of [true, false]) test(`registered producer -> concrete composition -> retained audit pass=${pass}`, async t => {
  const p = await preparation(t, pass ? '' : 'rejected');
  assert.equal(producerAttemptState(p.attempt), 'prepared');
  await submitInertProducerCreate(p.attempt, p.fake.launch);
  assert.equal(producerAttemptState(p.attempt), 'handed');
  const origin = await issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage);
  assert.equal(producerAttemptState(p.attempt), 'consumed');
  const result = await finalizeOwnedTrial(origin, p.directory, p.identity, p.task, p.baseline);
  assert.equal(result.finalization.state, 'completed'); assert.equal(result.grade?.behavior, pass);
  assert.equal(result.grade?.final.files['src/users.mjs'].mode, 0o751);
  assert.deepEqual((await auditRetainedFinalization(p.directory, p.identity, p.task, p.baseline, result.finalization)).grade, result.grade);
  assert.equal(p.fake.removed.size, 3);
  await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage));
  await assert.rejects(finalizeOwnedTrial(origin, p.directory, p.identity, p.task, p.baseline));
});
test('attempt reservation cannot be replaced or cloned, and mutation cannot change a plan', async t => {
  const p = await preparation(t);
  assert.throws(() => prepareInertProducerAttempt(p.deployment, p.directory, p.identity, p.git));
  assert.throws(() => producerCommand(structuredClone(p.attempt)));
  const original = producerCommand(p.attempt);
  const changed = producerCommand(p.attempt); changed.args.push('--privileged');
  p.data.producer.root = '/other'; p.identity.requestDigest = digest('other');
  assert.deepEqual(producerCommand(p.attempt), original);
  await submitInertProducerCreate(p.attempt, p.fake.launch);
  await assert.rejects(submitInertProducerCreate(p.attempt, p.fake.launch));
});
for (const fault of ['producer-unknown-id', 'producer-collision', 'producer-late-id', 'producer-mount', 'producer-remount', 'producer-uncertain', 'producer-image', 'producer-token'] as const) test(`registered producer rejects ${fault} without name cleanup or retry`, async t => {
  const p = await preparation(t, fault);
  if (['producer-unknown-id', 'producer-collision', 'producer-late-id', 'producer-mount', 'producer-image', 'producer-token'].includes(fault)) {
    await assert.rejects(submitInertProducerCreate(p.attempt, p.fake.launch));
    await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage));
    assert.equal(p.fake.calls.filter(c => c[0] === 'rm').length, 0);
  } else {
    await submitInertProducerCreate(p.attempt, p.fake.launch);
    const origin = await issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage);
    const result = await finalizeOwnedTrial(origin, p.directory, p.identity, p.task, p.baseline);
    assert.equal(result.finalization.state, 'pending'); assert.equal(result.grade, undefined);
    assert.equal(p.fake.calls.filter(c => c[0] === 'create').length, 1);
    if (fault === 'producer-remount') assert.equal(p.fake.removed.size, 0);
  }
  await assert.rejects(submitInertProducerCreate(p.attempt, p.fake.launch));
  assert(p.fake.calls.filter(c => c[0] === 'rm').every(c => /^[a-f0-9]{64}$/.test(c[2])));
  if (fault === 'producer-late-id') await new Promise(resolve => setTimeout(resolve, 200));
});
for (const kind of ['clone', 'storage', 'deployment', 'daemon', 'storage-replaced'] as const) test(`registered origin rejects ${kind} substitution`, async t => {
  const p = await preparation(t); await submitInertProducerCreate(p.attempt, p.fake.launch);
  if (kind === 'clone') await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, structuredClone(p.attempt), p.storage));
  if (kind === 'storage') {
    const other = await preparation(t);
    await assert.rejects(issueRegisteredFinalizationOrigin(p.deployment, p.attempt, other.storage));
  }
  if (kind === 'deployment') await assert.rejects(issueRegisteredFinalizationOrigin(installInertProducerDeployment(p.data), p.attempt, p.storage));
  if (kind === 'daemon') {
    const s = producerAttemptSelection(p.attempt); s.docker.endpoint = 'unix:///another/daemon.sock';
    assert.throws(() => inertDockerGradingOwner(s, p.fake.launch, p.attempt), /daemon/);
  }
  if (kind === 'storage-replaced') {
    const root = join(p.data.retention.trialParent, '.finalization', p.identity.trialId);
    const origin = await issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage);
    await rename(root, root + '-old'); await mkdir(root, { mode: 0o700 });
    await assert.rejects(finalizeOwnedTrial(origin, p.directory, p.identity, p.task, p.baseline));
  }
  assert.equal(p.fake.removed.size, 0);
});
test('operational producer launch remains closed even in test context', () => { assert.throws(launchProducer, /CLOSED/); });
test('attempt identity mismatch consumes origin without producer destruction', async t => {
  const p = await preparation(t); await submitInertProducerCreate(p.attempt, p.fake.launch);
  const origin = await issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage);
  const otherIdentity = { ...p.identity, launchDigest: digest('other') };
  await assert.rejects(finalizeOwnedTrial(origin, p.directory, otherIdentity, p.task, p.baseline));
  await assert.rejects(finalizeOwnedTrial(origin, p.directory, p.identity, p.task, p.baseline));
  assert.equal(p.fake.removed.size, 0);
});
test('registered retained audit rejects storage identity replacement', async t => {
  const p = await preparation(t); await submitInertProducerCreate(p.attempt, p.fake.launch);
  const origin = await issueRegisteredFinalizationOrigin(p.deployment, p.attempt, p.storage);
  const result = await finalizeOwnedTrial(origin, p.directory, p.identity, p.task, p.baseline);
  const root = join(p.data.retention.trialParent, '.finalization', p.identity.trialId);
  await rename(root, root + '-old'); await mkdir(root, { mode: 0o700 });
  await rename(join(root + '-old', 'artifact'), join(root, 'artifact'));
  await rename(join(root + '-old', 'finalization.json'), join(root, 'finalization.json'));
  await assert.rejects(auditRetainedFinalization(p.directory, p.identity, p.task, p.baseline, result.finalization));
});
test('preflight failure consumes reservation without claiming a submitted create', async t => {
  const p = await preparation(t);
  await writeFile(join(p.data.producer.root, 'evaluation/src/native-preload.ts'), 'altered');
  await assert.rejects(submitInertProducerCreate(p.attempt, p.fake.launch));
  assert.equal(producerAttemptState(p.attempt), 'consumed');
  assert.equal(p.fake.calls.length, 0);
  await assert.rejects(submitInertProducerCreate(p.attempt, p.fake.launch));
});
test('registered create vocabulary cannot be rebound to another daemon', async t => {
  const p = await preparation(t);
  const { inertDockerBoundary } = await import('../src/grading-docker.ts');
  assert.throws(() => inertDockerBoundary({ ...p.selection.docker, endpoint: 'unix:///other/daemon.sock', producerAttempt: p.attempt }, p.fake.launch));
  assert.equal(p.fake.calls.length, 0);
});
