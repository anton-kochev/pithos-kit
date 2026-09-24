import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { serveAuthorization } from '../src/grading-bootstrap.ts';

test('public bootstrap frames one instance, never emits judgments and rejects extra fields', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', chunk => chunks.push(chunk));
  let calls = 0;
  const running = serveAuthorization(async (_a, target, name, store) => { calls++; return store.save(target, name); }, input, output);
  const request = { version: 1, caseId: 0, attemptId: 'attempt', gradingRunId: 'grade', artifactDigest: 'a'.repeat(64), observerDigest: 'b'.repeat(64), actor: { id: 'a' }, target: 'a', name: 'New', saveBehavior: 'return' };
  input.end(JSON.stringify(request) + '\n');
  await running;
  assert.equal(calls, 1);
  const response = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(response.settlement, 'saved');
  assert.equal(response.saves, 1);
  assert.equal(response.passed, undefined);
  const bad = new PassThrough();
  bad.end(JSON.stringify({ ...request, privateSentinel: 'private' }) + '\n');
  await assert.rejects(serveAuthorization(async () => undefined, bad, new PassThrough()));
});

test('public bootstrap rejects oversized/invalid UTF8 and incomplete records', async () => {
  for (const value of [Buffer.alloc(4098, 120), Buffer.from([255, 10]), Buffer.from('{}')]) {
    const input = new PassThrough(); input.end(value);
    await assert.rejects(serveAuthorization(async () => undefined, input, new PassThrough()));
  }
});
