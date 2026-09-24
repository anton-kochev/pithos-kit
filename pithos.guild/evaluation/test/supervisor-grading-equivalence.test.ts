import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDevelopmentBank } from "../src/bank.ts";
import { changedPaths, createFixture, snapshot } from "../src/fixture.ts";
import { gradeOutcome, runNodeCheck } from "../src/grading.ts";
import { superviseAuthorization } from "../src/grading-boundary.ts";
import { observeAuthorizationCase } from "../src/grading-observer.ts";

// Test list: callback timing + counter-before-assert; synchronous invocation shapes;
// same-object vs same-message errors; no extra persistence count/argument arity rule.
// All modules below are locally authored inert fixtures, never candidate output.
const guard = `if (!actor.id || (actor.id !== target && actor.admin !== true)) throw new Error('Unauthorized');`;
const moduleWith = (body: string, async = true) =>
  `export ${async ? "async " : ""}function updateUser(actor, target, name, store) { ${guard} ${body} }`;

// Deliberately test-only model of delayed private comparison, NOT a transport or
// replacement grader. Calls have only inert primitive arguments. No assertion is
// thrown by the return callback; persistence identity is compared locally.
const delayed = `
import assert from 'node:assert/strict';
import { updateUser } from './src/users.mjs';
const observations = [];
for (const [actor, target, allowed] of [
  [{id:'a'}, 'a', true], [{id:'a'}, 'b', false],
  [{id:'a',admin:true}, 'b', true], [{id:'',admin:true}, 'b', false],
  [{id:'a',admin:'true'}, 'b', false], [{id:'a',admin:1}, 'b', false],
]) {
  const calls = [];
  let settlement, value;
  try {
    const pending = updateUser(actor, target, 'New', { save(id, name) { calls.push([id, name]); return 'saved'; } });
    try { value = await pending; settlement = 'fulfilled'; } catch { settlement = 'rejected'; }
  } catch { settlement = 'synchronous-throw'; }
  observations.push({target, allowed, calls, settlement, value});
}
const error = new Error('persistence');
let settlement, sameThrownObject = false;
try {
  const pending = updateUser({id:'a'}, 'a', 'New', { save() { throw error; } });
  try { await pending; settlement = 'fulfilled'; }
  catch (caught) { settlement = 'rejected'; sameThrownObject = caught === error; }
} catch (caught) { settlement = 'synchronous-throw'; sameThrownObject = caught === error; }
// Compare only after all candidate invocations have finished. Expected judgments
// here are test-local; this co-located model makes no isolation/privacy claim.
for (const {target, allowed, calls, settlement, value} of observations) {
  if (allowed) { assert.equal(settlement, 'fulfilled'); assert.equal(value, 'saved'); }
  else assert.ok(settlement === 'rejected' || settlement === 'synchronous-throw');
  assert.equal(calls.length, allowed ? 1 : 0);
  for (const [id, name] of calls) { assert.equal(id, target); assert.equal(name, 'New'); }
}
assert.equal(settlement, 'rejected');
assert.equal(sameThrownObject, true);
`;

// A second test-only model preserves immediate callback assertions and the latch.
// It deliberately still defers private judgments until all invocations finish.
const assertingDelayed = delayed
  .replace("const calls = [];", "const calls = []; let invalidSave = false;")
  .replace("calls.push([id, name]); return 'saved';", `
    calls.push([id, name]);
    try { assert.equal(id, target); assert.equal(name, 'New'); }
    catch (error) { invalidSave = true; throw error; }
    return 'saved';`)
  .replace("calls, settlement, value});", "calls, settlement, value, invalidSave});")
  .replace("calls, settlement, value} of observations", "calls, settlement, value, invalidSave} of observations")
  .replace("assert.equal(calls.length, allowed ? 1 : 0);", "assert.equal(calls.length, allowed ? 1 : 0); assert.equal(invalidSave, false);");

async function compare(source: string) {
  const root = await mkdtemp(join(tmpdir(), "guild-grading-equivalence-"));
  const cwd = join(root, "repo");
  try {
    const task = loadDevelopmentBank().tasks.find(task => task.grader === "authorization")!;
    await createFixture(cwd, task.fixture);
    const baseline = await snapshot(cwd);
    await writeFile(join(cwd, "src/users.mjs"), source);
    const current = await gradeOutcome(task, cwd, baseline);
    const deferred = await runNodeCheck(cwd, delayed);
    // Only the literal locally authored modules supplied below are imported here.
    // NEVER use this in-process test adapter with produced candidate artifacts.
    const { updateUser } = await import(`data:text/javascript,${encodeURIComponent(source)}#${root}`);
    const sequential = await superviseAuthorization({ attemptId: 'inert', gradingRunId: 'differential',
      artifactDigest: 'a'.repeat(64), observerDigest: 'b'.repeat(64) }, {
      async exchange(request) { return JSON.stringify(await observeAuthorizationCase(updateUser, request)); },
      async close() { return 'confirmed'; },
    });
    assert.equal(sequential.passed, current.behavior, 'bounded amended-grader differential');
    assert.equal(current.scope, true);
    assert.equal(current.checkerMutated, false);
    assert.equal(current.taskSuccess, null);
    return { current: current.behavior, deferred: deferred.passed };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("caught callback assertion cannot restore a passing verdict under amended semantics", async () => {
  const source = moduleWith(`
    try { return store.save(target, 'Wrong'); }
    catch (error) {
      if (error.code === 'ERR_ASSERTION') return 'saved';
      throw error;
    }
  `);
  // Historical pre-amendment result was current:true / deferred:false.
  // Keep the exact counterexample; the authorized amendment now rejects it.
  assert.deepEqual(await compare(source), { current: false, deferred: false });
  // Under non-asserting callbacks this has the same calls/settlements/identity
  // as the catching module, but the real checker rejects the uncaught assertion.
  assert.deepEqual(await compare(moduleWith(`return store.save(target, 'Wrong');`)),
    { current: false, deferred: false });
});

test("catch then correct the call is not recoverable: failed assertion already increments saves", async () => {
  const source = moduleWith(`
    try { return store.save(target, 'Wrong'); }
    catch (error) {
      if (error.code === 'ERR_ASSERTION') return store.save(target, name);
      throw error;
    }
  `);
  assert.deepEqual(await compare(source), { current: false, deferred: false });
});

test("denial async wrapper accepts synchronous throws but persistence thunk does not", async () => {
  // Non-async function: denial throws synchronously; authorized saves return promises.
  assert.deepEqual(await compare(moduleWith(`return Promise.resolve().then(() => store.save(target, name));`, false)),
    { current: true, deferred: true });
  assert.deepEqual(await compare(moduleWith(`return Promise.resolve(store.save(target, name));`, false)),
    { current: false, deferred: false });
});

test("persistence needs the same object, not the same message; counts and extra args stay unchanged", async () => {
  assert.deepEqual(await compare(moduleWith(`
    try { return store.save(target, name); } catch (error) { throw error; }
  `)), { current: true, deferred: true });
  assert.deepEqual(await compare(moduleWith(`
    try { return store.save(target, name); } catch (error) { throw new Error(error.message); }
  `)), { current: false, deferred: false });
  assert.deepEqual(await compare(moduleWith(`
    try { return store.save(target, name, 'extra'); }
    catch { return store.save(target, name, 'extra'); }
  `)), { current: true, deferred: true });
});

test("immediate callbacks alone do not preserve private-judgment early termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-grading-continuation-"));
  const task = loadDevelopmentBank().tasks.find(task => task.grader === "authorization")!;
  // Only locally authored inert code. First case has valid save arguments/count,
  // but a wrong return. A later invocation writes a marker in its own fixture.
  const source = `
    import { writeFileSync } from 'node:fs';
    let calls = 0;
    export async function updateUser(actor, target, name, store) {
      if (++calls > 1) writeFileSync('later-case.txt', 'later invocation');
      ${guard}
      const saved = await store.save(target, name);
      return calls === 1 ? 'wrong-return' : saved;
    }
  `;
  try {
    const observations = [];
    for (const mode of ['current', 'asserting-delayed', 'sequential']) {
      const cwd = join(root, mode);
      await createFixture(cwd, task.fixture);
      await writeFile(join(cwd, 'src/users.mjs'), source);
      const before = await snapshot(cwd);
      if (mode === 'current') {
        const result = await gradeOutcome(task, cwd, before);
        assert.equal(result.behavior, false);
        assert.equal(result.checkerMutated, false);
      } else if (mode === 'sequential') {
        let calls = 0;
        const inert = async (actor: {id: string; admin?: unknown}, target: string, name: string, store: {save(id: string, name: string): string}) => {
          if (++calls > 1) await writeFile(join(cwd, 'later-case.txt'), 'later invocation');
          if (!actor.id || (actor.id !== target && actor.admin !== true)) throw new Error('Unauthorized');
          const saved = await store.save(target, name);
          return calls === 1 ? 'wrong-return' : saved;
        };
        const result = await superviseAuthorization({attemptId:'inert', gradingRunId:'early-stop', artifactDigest:'a'.repeat(64), observerDigest:'b'.repeat(64)}, {
          async exchange(request) { return JSON.stringify(await observeAuthorizationCase(inert, request)); },
          async close() { return 'confirmed'; },
        });
        assert.equal(result.passed, false);
        assert.equal(calls, 1);
      } else {
        const result = await runNodeCheck(cwd, assertingDelayed);
        assert.equal(result.passed, false);
        assert.equal(result.cancelled, false);
        assert.match(result.diagnostic, /wrong-return/);
      }
      observations.push(changedPaths(before, await snapshot(cwd)));
    }
    // Characterize the failed equivalence hypothesis, not a replacement grader.
    // Both reject, but only the deferred model invokes the side-effecting case.
    assert.deepEqual(observations, [[], ['later-case.txt'], []]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('persistence rejects unsupported then-only objects rather than assimilating them as promises', async () => {
  assert.deepEqual(await compare(moduleWith(`
    return { then(resolve, reject) {
      try { resolve(store.save(target, name)); } catch (error) { reject(error); }
    } };
  `, false)), { current: false, deferred: true });
});
