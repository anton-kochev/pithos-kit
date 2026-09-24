import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { superviseAuthorization } from '../src/grading-boundary.ts';
import { observeAuthorizationCase, type PublicCase } from '../src/grading-observer.ts';

// Inert byte/process edges only; no launcher or candidate module import.
const binding = { attemptId: 'attempt', gradingRunId: 'run', artifactDigest: 'a'.repeat(64), observerDigest: 'b'.repeat(64) };
async function observation(request: PublicCase) {
  return JSON.stringify(await observeAuthorizationCase(async (actor, target, name, store) => {
    if (!actor.id || (actor.id !== target && actor.admin !== true)) throw new Error('denied');
    return store.save(target, name);
  }, request));
}
function fixture(reply?: (request: PublicCase, stdout: PassThrough, stderr: PassThrough) => Promise<void> | void) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const requests: PublicCase[] = [];
  let closed = 0;
  stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as PublicCase;
    requests.push(request);
    void (async () => {
      if (reply) return reply(request, stdout, stderr);
      const bytes = Buffer.from(await observation(request) + '\n');
      for (const byte of bytes) stdout.write(Buffer.from([byte]));
    })();
  });
  return { requests, get closed() { return closed; },
    transport: { stdin, stdout, stderr, async terminate(): Promise<'confirmed' | 'uncertain'> { closed++; return 'confirmed'; } } };
}

test('sequential grading consumes fixed framed byte transport and independently closes owner', async () => {
  const f = fixture();
  const result = await superviseAuthorization(binding, f.transport);
  assert.equal(result.state, 'passed');
  assert.equal(f.requests.length, 7);
  assert.equal(f.closed, 1);
  assert.ok(f.transport.stdin.destroyed);
});

test('raw framing rejects invalid UTF-8, batched/replayed, oversized and incomplete responses', async () => {
  for (const write of [
    (out: PassThrough) => out.write(Buffer.from([0xff, 10])),
    (out: PassThrough) => out.write('{}\n{}\n'),
    (out: PassThrough) => { out.write('{}\n'); out.write('{}\n'); },
    (out: PassThrough) => out.write('x'.repeat(4097)),
    (out: PassThrough) => out.end('{'),
  ]) {
    const f = fixture((_request, out) => { write(out); });
    const result = await superviseAuthorization(binding, f.transport);
    assert.equal(result.passed, false);
    assert.equal(f.requests.length, 1);
    assert.equal(f.closed, 1);
  }
});

test('combined raw output counts discarded stderr, including output during owner termination', async () => {
  const f = fixture(async (request, out, err) => {
    err.write(Buffer.alloc(65536));
    out.write(await observation(request) + '\n');
  });
  assert.equal((await superviseAuthorization(binding, f.transport)).passed, false);
  assert.equal(f.closed, 1);
  const late = fixture();
  late.transport.terminate = async () => {
    late.transport.stderr.write(Buffer.alloc(65537));
    return 'confirmed';
  };
  assert.equal((await superviseAuthorization(binding, late.transport)).state, 'cleanup-pending');
});

test('transport cancellation closes pipes and owner; exit or observation cannot confirm cleanup', async () => {
  const controller = new AbortController();
  const f = fixture(() => { controller.abort(); });
  assert.equal((await superviseAuthorization(binding, f.transport, controller.signal)).state, 'cancelled');
  assert.equal(f.closed, 1);
  assert.ok(f.transport.stdout.destroyed);
  const uncertain = fixture();
  uncertain.transport.terminate = async () => 'uncertain';
  assert.equal((await superviseAuthorization(binding, uncertain.transport)).state, 'cleanup-pending');
  const lost = fixture();
  lost.transport.terminate = async () => { throw new Error('owner unavailable'); };
  assert.equal((await superviseAuthorization(binding, lost.transport)).state, 'cleanup-pending');
});

test('inert child pipes use supervisor-owned exit confirmation, not a completion field', async () => {
  // Authored fixture only: no candidate import or runtime/provider inspection.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const r = JSON.parse(line);
      const allowed = r.caseId === 0 || r.caseId === 2;
      const {version, caseId, attemptId, gradingRunId, artifactDigest, observerDigest} = r;
      console.log(JSON.stringify({version, caseId, attemptId, gradingRunId, artifactDigest, observerDigest,
        saves: allowed ? 1 : 0, invalidSave: false,
        settlement: allowed ? 'saved' : 'rejected', sameThrownObject: caseId === 6, overflow: false}));
    }
  `], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('close', () => resolve());
    child.once('error', reject);
  });
  let terminated = false;
  try {
    const result = await superviseAuthorization(binding, {
      stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      async terminate() { child.kill('SIGKILL'); await exited; terminated = true; return 'confirmed'; },
    });
    assert.equal(result.state, 'passed');
    assert.equal(terminated, true);
  } finally { child.kill('SIGKILL'); await exited; }
});

test('binding/order and private-field rejection remain on the connected transport consumer', async () => {
  for (const mutate of [
    (value: string) => value.replace('"caseId":0', '"caseId":1'),
    (value: string) => value.replace('"gradingRunId":"run"', '"gradingRunId":"previous"'),
    (value: string) => value.slice(0, -1) + ',"pass":true}',
  ]) {
    const f = fixture(async (request, out) => { out.write(mutate(await observation(request)) + '\n'); });
    assert.equal((await superviseAuthorization(binding, f.transport)).state, 'inconclusive');
    assert.equal(f.requests.length, 1);
    assert.equal(f.closed, 1);
  }
});
