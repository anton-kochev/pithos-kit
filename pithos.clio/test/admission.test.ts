import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eligibleRun, Lease } from '../src/admission.ts';
const user = {type: 'message', id: 'u1', message: {role: 'user', content: 'Investigate cache behavior'}};
const call = {type: 'message', id: 'a1', message: {role: 'assistant', content: [{type: 'toolCall', id: 'r1', name: 'read', arguments: {path: 'src/cache.ts'}}, {type: 'toolCall', id: 'r2', name: 'read', arguments: {path: 'test/cache.ts'}}]}};
const results = ['r1', 'r2'].map(toolCallId => ({type: 'message', message: {role: 'toolResult', toolCallId, toolName: 'read', isError: false}}));
const branch = [user, call, ...results];
test('branch-owned scheduling fails closed and leases reject unsolicited, duplicate, mixed and newer work', () => {
  assert.deepEqual(eligibleRun(branch), {runId: 'u1', paths: ['src/cache.ts', 'test/cache.ts']});
  assert.equal(eligibleRun([user]), undefined);
  const nested = {type: 'message', message: {role: 'toolResult', toolName: 'codemode', isError: false, nestedCalls: {complete: true, calls: [{name: 'edit', status: 'ok', arguments: {path: 'src/cache.ts'}}]}}};
  assert.deepEqual(eligibleRun([user, nested]), {runId: 'u1', paths: ['src/cache.ts']});
  for (const active of [true, 'unknown', undefined]) assert.equal(eligibleRun([...branch, {type: 'custom', customType: 'plan-theme-state', data: {active}}]), undefined);
  assert.ok(eligibleRun([...branch, {type: 'custom', customType: 'plan-theme-state', data: {active: false}}]));
  assert.equal(eligibleRun([...branch, {type: 'custom', customType: 'clio-attempt', data: {runId: 'u1'}}]), undefined);
  assert.equal(eligibleRun([{...user, message: {...user.message, content: 'Read-only: investigate, do not edit'}}, call, ...results]), undefined);
  const lease = new Lease();
  assert.throws(() => lease.claim('unsolicited', 's', 'u1', ['clio_capture']), /stale/);
  const nonce = lease.schedule('s', 'u1');
  assert.throws(() => lease.claim(nonce, 's', 'u1', ['read', 'clio_capture']), /batch/);
  lease.claim(nonce, 's', 'u1', ['clio_capture']);
  assert.throws(() => lease.claim(nonce, 's', 'u1', ['clio_capture']), /stale/);
  const newer = lease.schedule('s', 'u1');
  lease.invalidate();
  assert.throws(() => lease.claim(newer, 's', 'u1', ['clio_capture']), /stale/);
  const fork = lease.schedule('s', 'u1');
  assert.throws(() => lease.claim(fork, 'other', 'u1', ['clio_capture']), /stale/);
});

test('prior persistent user restrictions remain binding after a later investigative task', () => {
  for (const instruction of ['For this entire session: read-only.', 'Never edit files in this project.', 'Always ask before modifying any files.', 'Do not make changes unless I explicitly approve.']) {
    const prior = {type: 'message', id: 'u-prior', message: {role: 'user', content: instruction}};
    assert.equal(eligibleRun([prior, ...branch]), undefined, instruction);
  }
  // Assistant speculation is not a user-imposed restriction.
  assert.ok(eligibleRun([{type: 'message', id: 'a-prior', message: {role: 'assistant', content: 'read-only?'}}, ...branch]));
});
