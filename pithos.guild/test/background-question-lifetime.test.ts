import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BackgroundRunRegistry } from "../src/background-runs.ts";
import { runBackgroundGuildRoleForTest } from "../src/background-runner.ts";

const input = { role: "coder" as const, profile: "typescript" as const, task: "question" };
const fixture = fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url));
const seam = {
 invocation: (args: string[]) => ({ command: process.execPath, args: [fixture, ...args] }),
 limits: { command: 1000, handshake: 2000, run: 4000, question: 40, eof: 500, term: 100, kill: 500 },
};

test("runner deadline settles the registry ask immediately, not at the registry deadline", { timeout: 8000 }, async () => {
 let questionSignal: AbortSignal | undefined;
 let settled = false;
 let statusAtAbort: string | undefined;
 const registry = new BackgroundRunRegistry(({ id, ask, signal }) => runBackgroundGuildRoleForTest({
  ...input, cwd: process.cwd(), projectTrusted: false, signal,
  onQuestion: (text, lifetime) => {
   questionSignal = lifetime;
   signal.addEventListener("abort", () => {
    statusAtAbort = registry.status(id).status;
   });
   return ask(text, lifetime).finally(() => { settled = true; });
  },
 }, seam).then(result => ({ status: result.status })), { questionTimeoutMs: 3000 });
 try {
  const run = registry.start(input);
  assert.equal((await registry.wait(run.id, 2000)).reason, "question");
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(settled, true, "runner deadline must settle ask before registry deadline");
  assert.equal(questionSignal?.aborted, true);
  assert.equal(statusAtAbort, "stopping");
  // Registry's own abort listener may run after this observer; final state must be empty.
  assert.equal(registry.status(run.id).question, undefined);
  if (registry.status(run.id).status === "stopping") await registry.wait(run.id, 2000);
  assert.equal(registry.status(run.id).status, "failed");
  assert.match(registry.status(run.id).error!, /Question lifetime/);
 } finally { await registry.shutdown(); }
});

// These pins cover both deadline orderings and lifecycle paths using real child fixtures.
for (const scenario of ["registry-first", "cancel", "ui-timeout", "close", "reject"] as const) {
 test(`question lifetime composition: ${scenario}`, { timeout: 8000 }, async () => {
  let lifetime: AbortSignal | undefined;
  let askSettled = false;
  let callbackStarted!: () => void;
  const started = new Promise<void>(resolve => { callbackStarted = resolve; });
  const registry = new BackgroundRunRegistry(({ ask, signal }) => runBackgroundGuildRoleForTest({
   ...input, task: scenario === "ui-timeout" ? "question-ui-timeout" : scenario === "close" ? "question-close" : "question",
   cwd: process.cwd(), projectTrusted: false, signal,
   onQuestion(text, questionSignal) {
    lifetime = questionSignal;
    const answer = ask(text, questionSignal).finally(() => { askSettled = true; });
    void answer.catch(() => {});
    callbackStarted();
    return scenario === "reject" ? Promise.reject(new Error("callback rejected")) : answer;
   },
  }, { ...seam, limits: { ...seam.limits, question: 2000 } }).then(result => ({ status: result.status })),
  { questionTimeoutMs: scenario === "registry-first" ? 40 : 3000 });
  try {
   const run = registry.start(input);
   await started;
   if (scenario === "cancel") await registry.cancel(run.id);
   else {
    // wait() intentionally wakes on pending questions; poll only while one exists.
    for (let n = 0; n < 200 && registry.status(run.id).question; n++) await new Promise(resolve => setTimeout(resolve, 5));
    await registry.wait(run.id, 2000);
   }
   assert.equal(lifetime?.aborted, true);
   assert.equal(askSettled, true);
   assert.equal(registry.status(run.id).question, undefined);
   assert.equal(registry.status(run.id).status, scenario === "cancel" ? "cancelled" : "failed");
   if (scenario === "registry-first") assert.match(registry.status(run.id).error!, /Question timeout/);
  } finally { await registry.shutdown(); }
 });
}

test("standalone abandoned callbacks observe timeout, rejection and close without owning cleanup", { timeout: 8000 }, async () => {
 for (const task of ["question", "question-close", "question-ui-timeout", "question-reject"]) {
  let lifetime: AbortSignal | undefined;
  let notified = false;
  const result = await runBackgroundGuildRoleForTest({ ...input, task, cwd: process.cwd(), projectTrusted: false,
   onQuestion(_text, signal) {
    lifetime = signal;
    assert.equal(signal.aborted, false, "callback gets the live lifetime before cancellation");
    signal.addEventListener("abort", () => { notified = true; });
    return task === "question-reject" ? Promise.reject(new Error("rejected")) : new Promise(() => {});
   },
  }, { ...seam, limits: { ...seam.limits, question: task === "question" ? 40 : 2000 } });
  assert.equal(lifetime?.aborted, true, task);
  assert.equal(notified, true, task);
  assert.equal(result.status, task === "question" ? "completed" : "failed", result.errorMessage);
  if (task === "question-ui-timeout") assert.match(result.errorMessage!, /question result/);
 }
});

test("waiting and stopping registry slots belong to real children until close", { timeout: 8000 }, async () => {
 const waiting: Array<() => void> = [];
 const started = Array.from({ length: 3 }, (_, i) => new Promise<void>(resolve => { waiting[i] = resolve; }));
 let calls = 0;
 const registry = new BackgroundRunRegistry(({ ask, signal }) => runBackgroundGuildRoleForTest({
  ...input, task: "question-hold", cwd: process.cwd(), projectTrusted: false, signal,
  onQuestion(text, lifetime) { waiting[calls++]?.(); return ask(text, lifetime); },
 }, { ...seam, limits: { ...seam.limits, question: 3000, term: 1000 } }).then(result => ({ status: result.status })), { questionTimeoutMs: 3000 });
 try {
  const runs = Array.from({ length: 4 }, () => registry.start(input));
  await Promise.all(started);
  assert.equal(registry.status(runs[3].id).status, "queued");
  const cancelling = registry.cancel(runs[0].id);
  assert.equal(registry.status(runs[0].id).status, "stopping");
  assert.equal(registry.status(runs[0].id).question, undefined);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(registry.status(runs[3].id).status, "queued");
  assert.equal(calls, 3);
  await cancelling;
  assert.equal(registry.status(runs[0].id).status, "cancelled");
  assert.notEqual(registry.status(runs[3].id).status, "queued");
 } finally { await registry.shutdown(); }
});

test("shutdown cancels a pending runner question and joins real child close", { timeout: 8000 }, async () => {
 let lifetime: AbortSignal | undefined;
 let operationSignal: AbortSignal | undefined;
 let askSettled = false;
 let childClosed = false;
 let shutdownSettled = false;
 let questionStarted!: () => void;
 const started = new Promise<void>(resolve => { questionStarted = resolve; });
 const registry = new BackgroundRunRegistry(({ ask, signal }) => {
  operationSignal = signal;
  return runBackgroundGuildRoleForTest({
   ...input, task: "question-hold", cwd: process.cwd(), projectTrusted: false, signal,
   onQuestion(text, questionSignal) {
    lifetime = questionSignal;
    const answer = ask(text, questionSignal).finally(() => { askSettled = true; });
    questionStarted();
    return answer;
   },
  }, { ...seam, limits: { ...seam.limits, question: 3000, term: 1000 },
   spawn: ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    child.once("close", () => { childClosed = true; });
    return child;
   }) as typeof spawn,
  }).then(result => ({ status: result.status }));
 }, { questionTimeoutMs: 3000 });
 try {
  const run = registry.start(input);
  await started;
  assert.ok(registry.status(run.id).question);
  assert.equal(getEventListeners(lifetime!, "abort").length, 1);
  const shutdown = registry.shutdown().then(() => { shutdownSettled = true; });
  assert.equal(registry.status(run.id).status, "stopping");
  assert.equal(registry.status(run.id).question, undefined);
  assert.equal(lifetime?.aborted, true);
  assert.equal(getEventListeners(lifetime!, "abort").length, 0);
  assert.equal(getEventListeners(operationSignal!, "abort").length, 0);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(askSettled, true);
  assert.equal(childClosed, false, "fixture delays close after SIGTERM");
  assert.equal(shutdownSettled, false, "shutdown must join child cleanup");
  assert.equal(registry.status(run.id).status, "stopping");
  assert.throws(() => registry.collect(run.id), /not terminal/);
  await shutdown;
  assert.equal(childClosed, true);
  assert.equal(registry.status(run.id).status, "cancelled");
  assert.equal(registry.status(run.id).error, undefined);
 } finally { await registry.shutdown(); }
});

test("near-simultaneous runner deadline and reply leave no pending question", { timeout: 8000 }, async () => {
 for (const delay of [0, 39, 40, 41]) {
  let replyTimer: ReturnType<typeof setTimeout> | undefined;
  let replied = false;
  let lifetime: AbortSignal | undefined;
  const registry = new BackgroundRunRegistry(({ id, ask, signal }) => runBackgroundGuildRoleForTest({
   ...input, cwd: process.cwd(), projectTrusted: false, signal,
   onQuestion(text, questionSignal) {
    lifetime = questionSignal;
    const answer = ask(text, questionSignal);
    const questionId = registry.status(id).question!.id;
    replyTimer = setTimeout(() => {
     if (!registry.status(id).question) return;
     registry.reply(id, questionId, `Answer for ${text.split(' ').at(-1)}`);
     replied = true;
    }, delay);
    return answer;
   },
  }, seam).then(result => ({ status: result.status })), { questionTimeoutMs: 3000 });
  try {
   const run = registry.start(input);
   await registry.wait(run.id, 2000);
   for (let n = 0; n < 200 && registry.status(run.id).question; n++) await new Promise(resolve => setTimeout(resolve, 5));
   await registry.wait(run.id, 2000);
   assert.equal(registry.status(run.id).question, undefined);
   assert.equal(registry.status(run.id).status, replied ? "completed" : "failed");
   assert.equal(lifetime?.aborted, !replied);
  } finally { clearTimeout(replyTimer); await registry.shutdown(); }
 }
});
