import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixture, snapshot, git } from "../src/fixture.ts";
import { gradeOutcome, runNodeCheck } from "../src/grading.ts";
import { loadDevelopmentBank, referenceFixes } from "../src/bank.ts";

test("never launches a checker after cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-grader-preabort-test-"));
  try {
    const marker = join(root, "unexpected");
    const result = await runNodeCheck(root, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'launched');`, AbortSignal.abort());
    assert.equal(result.cancelled, true);
    assert.equal(result.passed, false);
    await assert.rejects(access(marker));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("checker cancellation stops the active POSIX group and ordinary descendant writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-grader-abort-test-"));
  try {
    const ready = join(root, "ready"), late = join(root, "late");
    const controller = new AbortController();
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'orphan'), 500);`;
    const result = runNodeCheck(root, `import {spawn} from 'node:child_process'; spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); setInterval(() => {}, 1000);`, controller.signal);
    try {
      for (let i = 0; i < 200; i++) {
        if (await access(ready).then(() => true, () => false)) break;
        await delay(10);
      }
      await access(ready);
    } finally { controller.abort(); }
    assert.equal((await result).cancelled, true);
    await delay(600);
    await assert.rejects(access(late));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("known-good alternatives pass authorization outcomes; unchanged and near-miss solutions fail", async () => {
  const task = loadDevelopmentBank().tasks.find(t => t.grader === "authorization")!;
  const root = await mkdtemp(join(tmpdir(), "guild-grader-test-"));
  try {
    const candidates = [task.fixture.files["src/users.mjs"], ...referenceFixes, referenceFixes[0].replace("actor.admin === true", "actor.admin"), "process.exit(0); export function updateUser() {}"];
    for (let i = 0; i < candidates.length; i++) {
      const cwd = join(root, String(i));
      await createFixture(cwd, task.fixture);
      const baseline = await snapshot(cwd);
      await writeFile(join(cwd, "src/users.mjs"), candidates[i]);
      const result = await gradeOutcome(task, cwd, baseline);
      assert.equal(result.behavior, i === 1 || i === 2, `candidate ${i}: ${result.diagnostic}`);
      assert.equal(result.scope, true);
      assert.equal(result.review, "pending");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid save arguments throw immediately and remain failed after the candidate catches them", async () => {
  const task = loadDevelopmentBank().tasks.find(t => t.grader === "authorization")!;
  const root = await mkdtemp(join(tmpdir(), "guild-save-latch-test-"));
  try {
    for (const [i, args] of ["'wrong-id', name", "target, 'Wrong'"].entries()) {
      const cwd = join(root, String(i));
      await createFixture(cwd, task.fixture);
      const baseline = await snapshot(cwd);
      await writeFile(join(cwd, "src/users.mjs"), `
        export async function updateUser(actor, target, name, store) {
          if (!actor.id || (actor.id !== target && actor.admin !== true)) throw new Error('Unauthorized');
          try { return store.save(${args}); }
          catch (error) {
            if (error.code !== 'ERR_ASSERTION') throw error;
            console.log('caught immediate save assertion');
            return 'saved';
          }
        }
      `);
      const result = await gradeOutcome(task, cwd, baseline);
      assert.match(result.diagnostic, /caught immediate save assertion/);
      assert.equal(result.behavior, false);
      assert.equal(result.scope, true);
      assert.equal(result.checkerMutated, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an index-only mutation fails preservation even if all working-tree bytes match", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-index-test-"));
  try {
    const task = loadDevelopmentBank().tasks.find(t => t.id === "dirty-auth-01")!;
    const cwd = join(root, "repo");
    await createFixture(cwd, task.fixture);
    const baseline = await snapshot(cwd);
    await git(cwd, ["add", "notes.md"]);
    const result = await gradeOutcome(task, cwd, baseline);
    assert.deepEqual(result.changed, []);
    assert.equal(result.scope, false);
    assert.equal(result.indexPreserved, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all task fixtures validate and a no-edit baseline passes scope, never self-certifies prose quality", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-bank-test-"));
  try {
    for (const task of loadDevelopmentBank().tasks) {
      const cwd = join(root, task.id);
      await createFixture(cwd, task.fixture);
      const baseline = await snapshot(cwd);
      const result = await gradeOutcome(task, cwd, baseline);
      assert.equal(result.scope, true);
      assert.equal(result.review, "pending");
      if (task.grader === "unchanged") assert.equal(result.behavior, true);
      await writeFile(join(cwd, "UNRELATED.txt"), "unrequested");
      assert.equal((await gradeOutcome(task, cwd, baseline)).scope, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
