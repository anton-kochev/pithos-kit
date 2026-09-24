import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fixture, backend } from './inert-finalization-fixture.ts';
import { createFixture, snapshot } from '../src/fixture.ts';
import { approvedGitDigest } from '../src/grading-snapshot.ts';
import { readTree } from '../src/grading-owner.ts';
import { digest } from '../src/manifest.ts';
import { loadDevelopmentBank } from '../src/bank.ts';
import { issueInertFinalizationOrigin, finalizeOwnedTrial, auditRetainedFinalization } from '../src/trial-finalization.ts';
// List: positive, negative comparator, identity/clone/replay, cancellation/cleanup,
// record, binding, original modes, index and byte tampering; runner and V3 receipt.
export async function preparation(t: Parameters<typeof fixture>[0], pass = true) {
  const { root, selection } = await fixture(t);
  const task = loadDevelopmentBank().tasks.find(t => t.grader === 'authorization')!;
  const directory = join(root, '00000000-0000-4000-8000-000000000001');
  await mkdir(directory);
  selection.producer = join(directory, 'repo');
  selection.retained = join(root, '.finalization', '00000000-0000-4000-8000-000000000001', 'artifact');
  await createFixture(selection.producer, task.fixture);
  const baseline = await snapshot(selection.producer);
  selection.snapshotGitDigest = approvedGitDigest(await readTree(selection.producer));
  await writeFile(join(selection.producer, 'src/users.mjs'), 'authored inert bytes');
  await chmod(join(selection.producer, 'src/users.mjs'), 0o755);
  const identity = { trialId: directory.split('/').at(-1)!, requestDigest: digest('request'), baselineDigest: digest(baseline),
    campaignDigest: digest('campaign'), admissionDigest: digest('admission'), launchDigest: digest('launch') };
  const origin = issueInertFinalizationOrigin(directory, identity, selection, backend(selection, { pass }).boundary);
  return { directory, identity, origin, task, baseline };
}
test('owned finalization retains a rederivable grade with no success claim', async t => {
  const p = await preparation(t);
  const result = await finalizeOwnedTrial(p.origin, p.directory, p.identity, p.task, p.baseline);
  assert.equal(result.grade?.behavior, true);
  assert.equal(result.grade?.review, 'pending');
  assert.equal(result.grade?.taskSuccess, null);
  assert.equal(result.grade?.final.files['src/users.mjs'].mode, 0o755);
  const audit = await auditRetainedFinalization(p.directory, p.identity, p.task, p.baseline, result.finalization);
  assert.deepEqual(audit.grade, result.grade);
  const record = JSON.parse(audit.raw);
  assert.notEqual(record.evidence.snapshotDigest, digest(record.evidence.snapshot), 'raw owner hash is not the canonical manifest digest');
  assert.deepEqual(await auditRetainedFinalization(p.directory, p.identity, p.task, p.baseline, result.finalization), audit);
});

import { runTrial, type TrialControls } from '../src/runner.ts';
import { chmod } from 'node:fs/promises';
for (const pass of [true, false]) test(`runner consumes inert authority, comparator pass=${pass}`, async t => {
  const { root, selection } = await fixture(t);
  const task = loadDevelopmentBank().tasks.find(t => t.grader === 'authorization')!;
  const request = { task, arm: 'main-only' as const, repetition: 1, cohort: { model: 'test/fake', thinking: 'high' }, timeoutMs: 5000 };
  const controls: TrialControls = { finalization: 'confined-required', id: '00000000-0000-4000-8000-000000000002' };
  const result = await runTrial(root, request, async context => {
    assert.equal('finalizationOrigin' in context, false);
    const baseline = await snapshot(context.cwd);
    selection.producer = context.cwd;
    selection.retained = join(root, '.finalization', context.trialIdentity.id, 'artifact');
    selection.snapshotGitDigest = approvedGitDigest(await readTree(context.cwd));
    controls.finalizationOrigin = issueInertFinalizationOrigin(context.artifactDirectory, {
      trialId: context.trialIdentity.id, requestDigest: digest(request), baselineDigest: digest(baseline),
      campaignDigest: digest('campaign'), admissionDigest: digest('admission'), launchDigest: digest('launch'),
    }, selection, backend(selection, { pass }).boundary);
    await writeFile(join(context.cwd, 'src/users.mjs'), 'authored inert bytes');
    context.emit('{"type":"message_end","message":{"role":"assistant","provider":"test","model":"fake","stopReason":"stop","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}},"content":[{"type":"text","text":"Inert report"}]}}\n{"type":"agent_end"}\n');
    return { exitCode: 0 };
  }, undefined, controls);
  assert.equal(result.status, 'recorded');
  assert.equal(result.finalization?.state, 'completed');
  assert.equal(result.grade?.behavior, pass);
});

test('cloned, forged and replayed origins fail closed', async t => {
  const p = await preparation(t);
  for (const origin of [{}, structuredClone(p.origin)]) await assert.rejects(finalizeOwnedTrial(origin as typeof p.origin, p.directory, p.identity, p.task, p.baseline));
  await finalizeOwnedTrial(p.origin, p.directory, p.identity, p.task, p.baseline);
  await assert.rejects(finalizeOwnedTrial(p.origin, p.directory, p.identity, p.task, p.baseline));
});
for (const kind of ['bytes', 'mode', 'index', 'record', 'comparator', 'manifest', 'snapshot'] as const) test(`retained audit rejects ${kind} tampering`, async t => {
  const p = await preparation(t);
  const result = await finalizeOwnedTrial(p.origin, p.directory, p.identity, p.task, p.baseline);
  const root = join(p.directory, '..', '.finalization', p.identity.trialId);
  if (kind === 'bytes') await writeFile(join(root, 'artifact/src/users.mjs'), 'altered');
  else if (kind === 'mode') await chmod(join(root, 'artifact/src/users.mjs'), 0o755);
  else if (kind === 'index') await writeFile(join(root, 'artifact/.git/index'), 'altered');
  else {
    const path = join(root, 'finalization.json'), record = JSON.parse(await readFile(path, 'utf8'));
    if (kind === 'record') record.identity.launchDigest = digest('other');
    if (kind === 'comparator') record.comparator.binding.artifactDigest = digest('other');
    if (kind === 'manifest') record.evidence.manifest[0].mode ^= 1;
    if (kind === 'snapshot') record.evidence.snapshot.index = 'invented';
    const raw = JSON.stringify(record);
    await writeFile(path, raw);
    if (result.finalization.state === 'completed') result.finalization.recordDigest = createHash('sha256').update(raw).digest('hex');
  }
  await assert.rejects(auditRetainedFinalization(p.directory, p.identity, p.task, p.baseline, result.finalization));
});

test('issuer is unavailable outside Node test context', async t => {
  const p = await preparation(t);
  const context = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    assert.throws(() => issueInertFinalizationOrigin(p.directory, p.identity, {} as never, {} as never), /test-only/);
  } finally { process.env.NODE_TEST_CONTEXT = context; }
});
test('identity mismatch consumes authority before any grading', async t => {
  const p = await preparation(t);
  await assert.rejects(finalizeOwnedTrial(p.origin, p.directory, { ...p.identity, baselineDigest: digest('wrong') }, p.task, p.baseline));
  await assert.rejects(finalizeOwnedTrial(p.origin, p.directory, p.identity, p.task, p.baseline));
});
for (const failure of ['uncertain', 'launchFailure', 'cancel', 'driver', 'timeout', 'forged'] as const) test(`runner finalization preserves fail-closed ${failure}`, async t => {
  const { root, selection } = await fixture(t);
  const task = loadDevelopmentBank().tasks.find(t => t.grader === 'authorization')!;
  const request = { task, arm: 'main-only' as const, repetition: 1, cohort: { model: 'test/fake', thinking: 'high' }, timeoutMs: 5000 };
  const controls: TrialControls = { finalization: 'confined-required' };
  const abort = new AbortController(), workflow = new AbortController();
  controls.workflowSignal = workflow.signal;
  const result = await runTrial(root, request, async context => {
    const baseline = await snapshot(context.cwd);
    selection.producer = context.cwd;
    selection.retained = join(root, '.finalization', context.trialIdentity.id, 'artifact');
    selection.snapshotGitDigest = approvedGitDigest(await readTree(context.cwd));
    controls.finalizationOrigin = failure === 'forged' ? {} as never : issueInertFinalizationOrigin(context.artifactDirectory, {
      trialId: context.trialIdentity.id, requestDigest: digest(request), baselineDigest: digest(baseline),
      campaignDigest: digest('campaign'), admissionDigest: digest('admission'), launchDigest: digest('launch'),
    }, selection, backend(selection, { pass: true, [failure]: true }).boundary);
    await writeFile(join(context.cwd, 'src/users.mjs'), 'authored inert bytes');
    if (failure === 'cancel') abort.abort();
    if (failure === 'timeout') workflow.abort();
    if (failure === 'driver') throw new Error('original driver failure');
    return { exitCode: 0 };
  }, abort.signal, controls);
  assert.equal(result.status, failure === 'driver' ? 'driver_error' : failure === 'cancel' ? 'cancelled' : failure === 'timeout' ? 'timeout' : 'finalization_pending');
  if (failure === 'driver') assert.match(result.error!, /original driver failure/);
  else { assert.equal(result.grade, undefined); assert.equal(result.finalization?.state, 'pending'); }
});

test('private retention permissions are audited, not just the record hash', async t => {
  const p = await preparation(t);
  const result = await finalizeOwnedTrial(p.origin, p.directory, p.identity, p.task, p.baseline);
  await chmod(join(p.directory, '..', '.finalization', p.identity.trialId), 0o755);
  await assert.rejects(auditRetainedFinalization(p.directory, p.identity, p.task, p.baseline, result.finalization));
});

test('artifact root must remain private on re-audit', async t => {
  const p = await preparation(t);
  const result = await finalizeOwnedTrial(p.origin, p.directory, p.identity, p.task, p.baseline);
  await chmod(join(p.directory, '..', '.finalization', p.identity.trialId, 'artifact'), 0o755);
  await assert.rejects(auditRetainedFinalization(p.directory, p.identity, p.task, p.baseline, result.finalization));
});

test('finalization requires every runner identity field, not a matching subset', async t => {
  const p = await preparation(t);
  const { requestDigest: _missing, ...partial } = p.identity;
  await assert.rejects(finalizeOwnedTrial(p.origin, p.directory, partial as typeof p.identity, p.task, p.baseline));
});
