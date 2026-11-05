import { spawn } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runBackgroundGuildRoleForTest } from "../src/background-runner.ts";

const fixture = fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url));
const options = {role: "coder" as const, profile: "typescript" as const, task: "Work", cwd: process.cwd(), projectTrusted: false, onQuestion: async () => undefined};
const seam = {invocation: (args: string[]) => ({command: process.execPath, args: [fixture, ...args]}), limits: {command: 1000, handshake: 2000, run: 4000, question: 1000, eof: 500, term: 100, kill: 500}};

test("background RPC completes only after handshake, report, settlement, exit and owned cleanup", {timeout: 8000}, async () => {
 let capture: any;
 const result = await runBackgroundGuildRoleForTest({...options, onEvent(event) {if (event.type === "fixture") capture = event;}}, seam);
 assert.equal(result.status, "completed", result.errorMessage);
 assert.equal(result.report?.summary, "Scripted report");
 assert.equal(result.usage.input, 3);
 assert.equal(existsSync(capture.taskFile), false);
 assert.deepEqual(capture.args.slice(0, 3), ["--mode", "rpc", "--no-session"]);
 assert.ok(!capture.args.includes("-p"));
 assert.ok(!capture.args.includes("Task: Work"));
 assert.ok(capture.args.some((arg: string) => arg.endsWith("background-child-protocol.ts")));
 assert.deepEqual(result.selectedSkills?.map(skill => skill.id), ["code-comments"]);
});

test("accepts clear_queue bookkeeping after settlement but rejects malformed queue updates", {timeout: 8000}, async () => {
 const valid = await runBackgroundGuildRoleForTest({...options, task: "queue-after-settlement"}, seam);
 assert.equal(valid.status, "completed", valid.errorMessage);
 const invalid = await runBackgroundGuildRoleForTest({...options, task: "invalid-queue-update"}, seam);
 assert.equal(invalid.status, "failed");
 assert.match(invalid.errorMessage!, /queue update/i);
});

test("three deferred questions resume their original processes with out-of-order replies", {timeout: 8000}, async () => {
 const replies: Array<() => void> = [];
 const pids = new Set<string>();
 const runs = [0, 1, 2].map(() => runBackgroundGuildRoleForTest({...options, task: 'question', onQuestion(question) {
  const pid = question.split(' ').at(-1)!; pids.add(pid);
  return new Promise<string>(resolve => {replies.push(() => resolve(`Answer for ${pid}`)); if (replies.length === 3) {replies[2](); replies[0](); replies[1]();}});
 }}, seam));
 const results = await Promise.all(runs);
 assert.deepEqual(results.map(result => result.status), ['completed', 'completed', 'completed']);
 assert.equal(pids.size, 3);
 for (const result of results) assert.ok(pids.has(result.report!.summary.split(' ').at(-1)!));
 assert.equal(new Set(results.map(result => result.taskId)).size, 3);
});

test("updates return correlated actual dispositions and reject after terminal submission", {timeout: 8000}, async () => {
 let control: import('../src/background-runner.ts').BackgroundControl | undefined;
 let updates: Promise<string[]> | undefined;
 const result = await runBackgroundGuildRoleForTest({...options, task: 'updates', onReady(value) {
  control = value; updates = Promise.all([value.sendUpdate('one'), value.sendUpdate('two')]);
 }}, seam);
 assert.equal(result.status, 'completed', result.errorMessage);
 assert.deepEqual(await updates, ['queued', 'handled']);
 await assert.rejects(control!.sendUpdate('late'), /not running/);
});

test("queued work starting after submission cannot become apparent success", {timeout: 8000}, async () => {
 const result = await runBackgroundGuildRoleForTest({...options, task: 'post-submit-work'}, seam);
 assert.equal(result.status, 'failed');
 assert.match(result.errorMessage!, /after submission/);
});

// Intentional pins for the transport guards introduced with the lifecycle.
for (const [task, diagnostic] of [
 ['line-limit', /line byte limit/], ['utf8', /encoded data|UTF-8/],
 ['stdout-limit', /stdout byte limit/], ['stderr-limit', /stderr byte limit/],
 ['command-timeout', /RPC prompt timeout/], ['handshake-timeout', /handshake timeout/],
 ['unexpected-exit', /pending RPC|code|Missing Guild|stdin/], ['provider-error', /Scripted provider failed/],
 ['nonzero', /code 7/], ['hang-eof', /EOF shutdown timeout/],
] as const) test(`fails closed: ${task}`, {timeout: 8000}, async () => {
 const result = await runBackgroundGuildRoleForTest({...options, task}, seam);
 assert.equal(result.status, 'failed', task);
 assert.equal(result.report, undefined);
 assert.match(result.errorMessage!, diagnostic);
});

for (const task of ['question-identity', 'question-method', 'question-duplicate', 'question-mismatch']) test(`rejects ${task}`, {timeout: 8000}, async () => {
 let called = 0;
 const result = await runBackgroundGuildRoleForTest({...options, task, onQuestion: async question => {called++; return `Answer for ${question.split(' ').at(-1)}`;}}, seam);
 assert.equal(result.status, 'failed');
 assert.match(result.errorMessage!, /question/);
 if (task === 'question-identity' || task === 'question-method') assert.equal(called, 0);
});

test('question callback rejection and invalid text fail; abandoned callback never owns cleanup', {timeout: 8000}, async () => {
 for (const onQuestion of [async () => {throw new Error('parent rejected');}, async () => '\0']) {
  const result = await runBackgroundGuildRoleForTest({...options, task: 'question', onQuestion}, seam);
  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage!, /callback failed|answer text/);
 }
 const controller = new AbortController();
 let taskFile = '';
 const result = await runBackgroundGuildRoleForTest({...options, task: 'question', signal: controller.signal,
  onEvent(event) {if (event.type === 'fixture') taskFile = event.taskFile as string;},
  onQuestion() {controller.abort(); return new Promise(() => {});},
 }, seam);
 assert.equal(result.status, 'cancelled');
 assert.equal(existsSync(taskFile), false);
});

test('question timeout replies unavailable without joining a permanently abandoned parent callback', {timeout: 8000}, async () => {
 const result = await runBackgroundGuildRoleForTest({...options, task: 'question', onQuestion: () => new Promise(() => {})}, {...seam, limits: {...seam.limits, question: 40}});
 assert.equal(result.status, 'completed', result.errorMessage);
});

test('canonical practices, model, thinking, trust and fixed skill selection are inherited', {timeout: 8000}, async () => {
 let args: string[] = [];
 const result = await runBackgroundGuildRoleForTest({...options, model: 'selected/model', thinkingLevel: 'high', practices: [{id: 'tdd', policy: 'required'}], onEvent(event) {if (event.type === 'fixture') args = event.args as string[];}}, seam);
 assert.equal(result.status, 'completed', result.errorMessage);
 assert.equal(result.report?.taskOutcome, 'blocked');
 assert.deepEqual(result.selectedSkills?.map(skill => skill.id), ['tdd', 'code-comments']);
 assert.equal(args[args.indexOf('--model') + 1], 'selected/model');
 assert.equal(args[args.indexOf('--thinking') + 1], 'high');
 assert.ok(args.includes('--no-approve'));
 const reviewer = await runBackgroundGuildRoleForTest({...options, role: 'reviewer'}, seam);
 assert.equal(reviewer.status, 'completed', reviewer.errorMessage);
 assert.deepEqual(reviewer.selectedSkills?.map(skill => skill.id), ['code-review-standards']);
 const unsupported = await runBackgroundGuildRoleForTest({...options, role: 'explorer'}, seam);
 assert.equal(unsupported.status, 'failed');
});

test('question model-facing content cannot contradict the supplied answer', {timeout: 8000}, async () => {
 const result = await runBackgroundGuildRoleForTest({...options, task: 'question-content', onQuestion: async question => `Answer for ${question.split(' ').at(-1)}`}, seam);
 assert.equal(result.status, 'failed');
 assert.match(result.errorMessage!, /question.*content/);
});

test('kill deadlines retain ownership and prompts until actual close', {timeout: 8000}, async () => {
 const child = new EventEmitter() as any;
 child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
 const signals: string[] = [];
 child.kill = (signal: string) => {signals.push(signal); return true;};
 child.unref = () => {};
 let taskFile = '';
 let done = false;
 const running = runBackgroundGuildRoleForTest(options, {...seam, limits: {...seam.limits, handshake: 30, term: 20, kill: 20},
  spawn: (_command: string, _args: string[], settings: any) => {taskFile = settings.env.GUILD_TASK_FILE; return child;},
 } as any).then(result => {done = true; return result;});
 try {
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(done, false, 'deadline is not process-exit evidence');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(existsSync(taskFile), true, 'pending run retains its owned prompt directory');
 } finally {child.emit('close', null);}
 const result = await running;
 assert.equal(result.status, 'failed');
 assert.equal(existsSync(taskFile), false);
});

for (const suffix of ['id', 'details', 'content', 'missing', 'duplicate']) test(`rejects question toolResult ${suffix}`, {timeout: 8000}, async () => {
 const result = await runBackgroundGuildRoleForTest({...options, task: `question-message-${suffix}`, onQuestion: async question => `Answer for ${question.split(' ').at(-1)}`}, seam);
 assert.equal(result.status, 'failed');
 assert.match(result.errorMessage!, /question/);
});

for (const pipe of ['stdout', 'stderr'] as const) test(`${pipe} errors fail without releasing ownership before close`, {timeout: 8000}, async () => {
 const child = new EventEmitter() as any;
 child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
 child.kill = () => true;
 let spawned!: () => void;
 const started = new Promise<void>(resolve => {spawned = resolve;});
 const running = runBackgroundGuildRoleForTest(options, {...seam, spawn: () => {spawned(); return child;}} as any);
 await started;
 try {assert.doesNotThrow(() => child[pipe].emit('error', new Error('scripted pipe failure')));}
 finally {child.emit('close', 1);}
 const result = await running;
 assert.equal(result.status, 'failed');
 assert.match(result.errorMessage!, /scripted pipe failure/);
});

test('synchronous rejected update write releases its pending request and timer', {timeout: 8000}, async () => {
 let updates: Promise<unknown> | undefined;
 const result = await runBackgroundGuildRoleForTest({...options, task: 'updates', onReady(control) {
  updates = (async () => {
   await assert.rejects(control.sendUpdate('broken'), /scripted write failure/);
   assert.deepEqual(await Promise.all([control.sendUpdate('one'), control.sendUpdate('two')]), ['queued', 'handled']);
  })();
  void updates.catch(() => {});
 }}, {...seam, spawn: ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args);
  const write = child.stdin!.write.bind(child.stdin!);
  child.stdin!.write = ((chunk: any, ...rest: any[]) => {
   if (String(chunk).includes('"message":"broken"')) throw new Error('scripted write failure');
   return (write as any)(chunk, ...rest);
  }) as NonNullable<typeof child.stdin>["write"];
  return child;
 }) as typeof spawn});
 await updates;
 assert.equal(result.status, 'completed', result.errorMessage);
});

test('background trace ends after real child close and cleanup, including cancellation and startup failure', {timeout: 8000}, async () => {
 const telemetry = channel('pithos.guild.child');
 const events: any[] = [];
 let taskFile = '', closed = false;
 const listener = (message: unknown) => {
  const event = message as any;
  if (event.runId !== 'trace-lifecycle') return;
  events.push({event, closed, exists: taskFile ? existsSync(taskFile) : false, frozen: Object.isFrozen(event)});
 };
 telemetry.subscribe(listener);
 try {
  const controller = new AbortController();
  const result = await runBackgroundGuildRoleForTest({...options, runId: 'trace-lifecycle', task: 'question-hold', signal: controller.signal,
   onEvent(event) {if (event.type === 'fixture') taskFile = event.taskFile as string;},
   onQuestion() {controller.abort(); return new Promise(() => {});},
  }, {...seam, limits: {...seam.limits, term: 1000}, spawn: ((...args: Parameters<typeof spawn>) => {
   const child = spawn(...args); child.on('close', () => {closed = true;}); return child;
  }) as typeof spawn});
  assert.equal(result.status, 'cancelled');
  assert.equal(events.filter(({event}) => event.type === 'start').length, 1);
  const ends = events.filter(({event}) => event.type === 'end');
  assert.equal(ends.length, 1); assert.equal(ends[0].closed, true); assert.equal(ends[0].exists, false);
  assert.equal(ends[0].event.aborted, true);
  assert.ok(events.every(item => item.frozen));
  assert.ok(Object.isFrozen(ends[0].event.selectedSkills[0]));
  events.length = 0;
  await runBackgroundGuildRoleForTest({...options, runId: 'trace-lifecycle', signal: AbortSignal.abort()}, seam);
  assert.equal(events.length, 0, 'never-launched cancellation has no transport');
  const failed = await runBackgroundGuildRoleForTest({...options, runId: 'trace-lifecycle'}, {...seam, invocation: () => {throw new Error('startup failure');}});
  assert.equal(failed.status, 'failed');
  assert.deepEqual(events.map(({event}) => event.type), ['start', 'end']);
  assert.equal(events[1].event.exitCode, null, 'startup failure has no child exit evidence');
 } finally {telemetry.unsubscribe(listener);}
});
