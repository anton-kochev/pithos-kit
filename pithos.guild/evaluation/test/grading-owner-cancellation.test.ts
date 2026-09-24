import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { superviseAuthorization } from '../src/grading-boundary.ts';
import type { OwnedGradingConnection } from '../src/grading-owner.ts';
const binding = { attemptId: 'attempt', gradingRunId: 'grade', artifactDigest: 'a'.repeat(64), observerDigest: 'b'.repeat(64) };

test('aborted owned preparation cannot release a case; lost owner remains cleanup-pending', async () => {
  const controller = new AbortController();
  let opens = 0, closes = 0;
  const owner: OwnedGradingConnection = {
    open: async () => { opens++; controller.abort(); return new Promise(() => {}); },
    close: async () => { closes++; return 'uncertain'; },
  };
  assert.equal((await superviseAuthorization(binding, owner, controller.signal)).state, 'cleanup-pending');
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

test('changed attempt identity from owned preparation is not a valid observation binding', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let requests = 0, cleanups = 0;
  stdin.on('data', () => requests++);
  const owner: OwnedGradingConnection = {
    open: async () => ({ binding: { ...binding, attemptId: 'other' }, transport: { stdin, stdout, stderr, terminate: async () => { cleanups++; return 'confirmed'; } } }),
    close: async () => 'confirmed',
  };
  assert.equal((await superviseAuthorization(binding, owner)).state, 'inconclusive');
  assert.equal(requests, 0);
  assert.equal(cleanups, 1);
});
