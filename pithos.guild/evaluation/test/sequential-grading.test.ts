import assert from "node:assert/strict";
import { test } from "node:test";
import { superviseAuthorization } from "../src/grading-boundary.ts";
import { observeAuthorizationCase, type PublicCase } from "../src/grading-observer.ts";

const binding = { attemptId: 'attempt', gradingRunId: 'run', artifactDigest: 'a'.repeat(64), observerDigest: 'b'.repeat(64) };
test('sequential supervisor uses one candidate and releases no next case on failure', async () => {
  let calls = 0, closed = 0;
  const candidate = async (_actor: unknown, target: string, name: string, store: {save(id: string, name: string): string}) => {
    calls++;
    store.save(target, name);
    return 'wrong-return';
  };
  const result = await superviseAuthorization(binding, {
    async exchange(request: PublicCase) { return JSON.stringify(await observeAuthorizationCase(candidate, request)); },
    async close() { closed++; return 'confirmed' as const; },
  });
  assert.equal(result.passed, false);
  assert.equal(result.state, 'rejected');
  assert.equal(calls, 1);
  assert.equal(closed, 1);
});

test('connected grade route stops before reading or importing candidate artifacts', async () => {
  const { gradeConnectedOutcome } = await import('../src/grading.ts');
  await assert.rejects(gradeConnectedOutcome({ grader: 'authorization' } as never, '/must-not-be-read', {} as never), /confined transport/);
});

async function run(candidate: Parameters<typeof observeAuthorizationCase>[0], mutate?: (frame: string) => string,
  cleanup: 'confirmed' | 'uncertain' = 'confirmed', signal?: AbortSignal) {
  const requests: PublicCase[] = [];
  const result = await superviseAuthorization(binding, {
    async exchange(request) {
      requests.push(request);
      const frame = JSON.stringify(await observeAuthorizationCase(candidate, request));
      return mutate ? mutate(frame) : frame;
    },
    async close() { return cleanup; },
  }, signal);
  return { result, requests };
}
const good: Parameters<typeof observeAuthorizationCase>[0] = async (actor, target, name, store) => {
  if (!actor.id || (actor.id !== target && actor.admin !== true)) throw new Error('denied');
  return store.save(target, name);
};

test('valid sequential run has seven bounded public requests and no private judgments', async () => {
  const { result, requests } = await run(good);
  assert.equal(result.passed, true);
  assert.equal(requests.length, 7);
  for (const request of requests) {
    assert.deepEqual(Object.keys(request).sort(), ['version','caseId','actor','target','name','saveBehavior', ...Object.keys(binding)].sort());
    assert.equal(JSON.stringify(request).includes('allowed'), false);
  }
});

test('protocol rejects unknown, replayed, oversized, malformed, incomplete and misbound observations', async () => {
  const mutations = [
    (s: string) => s.slice(0, -1) + ',"privateSentinel":"never disclose"}',
    (s: string) => s.replace('"caseId":0', '"caseId":1'),
    (s: string) => s.replace('"gradingRunId":"run"', '"gradingRunId":"other"'),
    (s: string) => s.replace('"artifactDigest":"' + 'a'.repeat(64), '"artifactDigest":"' + 'c'.repeat(64)),
    (s: string) => s.replace('"observerDigest":"' + 'b'.repeat(64), '"observerDigest":"' + 'c'.repeat(64)),
    () => 'x'.repeat(4097), () => '{', () => '{}',
    (s: string) => s.slice(0, -1) + ',"version":1}',
  ];
  for (const mutate of mutations) {
    const {result, requests} = await run(good, mutate);
    assert.equal(result.state, 'inconclusive');
    assert.equal(requests.length, 1);
  }
});

test('cancellation and uncertain cleanup cannot pass; close always runs', async () => {
  assert.equal((await run(good, undefined, 'confirmed', AbortSignal.abort())).result.state, 'cancelled');
  assert.equal((await run(good, undefined, 'uncertain')).result.state, 'cleanup-pending');
  let closed = 0;
  const controller = new AbortController();
  const result = await superviseAuthorization(binding, {
    async exchange() { controller.abort(); return new Promise<string>(() => {}); },
    async close() { closed++; throw new Error('uncertain'); },
  }, controller.signal);
  assert.equal(result.state, 'cleanup-pending');
  assert.equal(closed, 1);
});

test('callback assertions remain immediate, latched and counted; extra args and persistence retries allowed', async () => {
  for (const badId of [true, false]) {
    let caught = false;
    const { result, requests } = await run(async (_actor, target, name, store) => {
      try { store.save(badId ? 'wrong' : target, badId ? name : 'wrong'); }
      catch (error) { caught = (error as {code: string}).code === 'ERR_ASSERTION'; }
      return 'saved';
    });
    assert.equal(caught, true);
    assert.equal(result.state, 'rejected');
    assert.equal(requests.length, 1);
  }
  assert.equal((await run(async (actor, target, name, store) => {
    if (!actor.id || (actor.id !== target && actor.admin !== true)) throw new Error('denied');
    try { return store.save(target, name, 'extra'); }
    catch { return store.save('anything', 'else', 'extra'); }
  })).result.passed, true);
});

test('early stop preserves same-instance history, no later side effect, and ordinary count failures', async () => {
  let invocations = 0, laterMutation = false;
  const result = await run(async (_actor, target, name, store) => {
    if (++invocations > 1) laterMutation = true;
    store.save(target, name);
    return 'wrong-return';
  });
  assert.equal(result.result.passed, false);
  assert.equal(laterMutation, false);
  for (const count of [0, 2, 65]) {
    const observed = await run(async (_actor, target, name, store) => {
      for (let i = 0; i < count; i++) { try { store.save(target, name); } catch {} }
      return 'saved';
    });
    assert.equal(observed.result.passed, false);
    assert.equal(observed.requests.length, 1);
  }
});

test('timeout and nonsettling cleanup fail closed within the bounded owner window', async () => {
  let closed = 0;
  const result = await superviseAuthorization(binding, {
    async exchange() { return new Promise<string>(() => {}); },
    async close() { closed++; return new Promise<'confirmed'>(() => {}); },
  });
  assert.equal(result.state, 'cleanup-pending');
  assert.equal(closed, 1);
});

test('binding rejects private extra fields before releasing any stimulus', async () => {
  let exchanged = false;
  const result = await superviseAuthorization({...binding, secret: 'private sentinel'} as typeof binding, {
    async exchange() { exchanged = true; return '{}'; },
    async close() { return 'confirmed'; },
  });
  assert.equal(exchanged, false);
  assert.equal(result.passed, false);
});

test('cancellation during cleanup never returns a passing verdict', async () => {
  const controller = new AbortController();
  const result = await superviseAuthorization(binding, {
    async exchange(request) { return JSON.stringify(await observeAuthorizationCase(good, request)); },
    async close() { controller.abort(); return 'confirmed'; },
  }, controller.signal);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.passed, false);
});

test('a session cannot replace the frozen run binding between cases', async () => {
  const mutable = {...binding};
  const seen: string[] = [];
  const result = await superviseAuthorization(mutable, {
    async exchange(request) {
      seen.push(request.gradingRunId);
      mutable.gradingRunId = 'substituted';
      return JSON.stringify(await observeAuthorizationCase(good, request));
    },
    async close() { return 'confirmed'; },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(new Set(seen), new Set(['run']));
});
