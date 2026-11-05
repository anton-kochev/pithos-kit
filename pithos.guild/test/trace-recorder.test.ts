import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBackgroundGuildRoleForTest } from "../src/background-runner.ts";
import { it } from "node:test";
import { createGuildTraceRecorder } from "../src/trace-recorder.ts";

const telemetry = channel("pithos.guild.child");
const enabled = { PITHOS_GUILD_TRACE: "1" };

function publisher(runId: string, childId = `${runId}-child`) {
 let sequence = 0;
 return (event: Record<string, unknown>) => telemetry.publish({version: 1, childId, runId, role: "coder", profile: "general", sequence: sequence++, ...event});
}

function chunk(text: string) {
 return {type: "stdout", base64: Buffer.from(text).toString("base64")};
}

function lines(file: string) {
 return readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

it("records nothing unless PITHOS_GUILD_TRACE is exactly 1", () => {
 assert.equal(createGuildTraceRecorder({env: {}}), undefined);
 assert.equal(createGuildTraceRecorder({env: {PITHOS_GUILD_TRACE: "true"}}), undefined);
});

it("records a bound child as header, finalized events, stderr and end in private files", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-"));
 const recorder = createGuildTraceRecorder({env: enabled, now: () => 1000})!;
 try {
  recorder.bind("run-1", {sessionDir: root, sessionId: "session-1", sessionFile: join(root, "s.jsonl"), model: "provider/model", thinkingLevel: "high", repoState: {state: "run-1.state", head: "abc", dirty: true, complete: true}});
  const publish = publisher("run-1");
  publish({type: "start"});
  publish(chunk('{"type":"message_start"}\n{"type":"message_upd'));
  publish(chunk('ate","message":{"content":"partial"}}\nnot json\n{"type":"message_end","message":{"role":"assistant"}}\n'));
  publish({type: "stderr", base64: Buffer.from("warning").toString("base64")});
  publish({type: "end", exitCode: 0, aborted: false, selectedSkills: [{id: "tdd"}]});
  const file = join(root, "guild", "session-1", "run-1-child.jsonl");
  assert.deepEqual(lines(file), [
   {kind: "header", version: 1, runId: "run-1", childId: "run-1-child", role: "coder", profile: "general", parentSessionId: "session-1", parentSessionFile: join(root, "s.jsonl"), parentModel: "provider/model", thinkingLevel: "high", repoState: {state: "run-1.state", head: "abc", dirty: true, complete: true}, startedAt: 1000},
   {kind: "event", event: {type: "message_start"}},
   {kind: "stdout", text: "not json"},
   {kind: "event", event: {type: "message_end", message: {role: "assistant"}}},
   {kind: "stderr", text: "warning"},
   {kind: "end", exitCode: 0, aborted: false, selectedSkills: [{id: "tdd"}], endedAt: 1000},
  ]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "guild", "session-1")).mode & 0o777, 0o700);
 } finally {
  recorder.dispose();
 }
});

it("ignores unbound runs and stops after dispose or unbind", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-"));
 const recorder = createGuildTraceRecorder({env: enabled})!;
 publisher("unbound")({type: "start"});
 const unbind = recorder.bind("unbound-later", {sessionDir: root, sessionId: "s"});
 unbind();
 publisher("unbound-later")({type: "start"});
 recorder.bind("disposed", {sessionDir: root, sessionId: "s"});
 recorder.dispose();
 publisher("disposed")({type: "start"});
 assert.equal(existsSync(join(root, "guild")), false);
});

it("writes one truncation marker at the byte cap and still records the end", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-"));
 const recorder = createGuildTraceRecorder({env: enabled, maxBytes: 600})!;
 try {
  recorder.bind("run-cap", {sessionDir: root, sessionId: "s"});
  const publish = publisher("run-cap");
  publish({type: "start"});
  for (let index = 0; index < 20; index++) publish(chunk(`{"type":"tool_execution_end","result":"${"x".repeat(100)}"}\n`));
  publish({type: "end", exitCode: 1, aborted: true, selectedSkills: []});
  const kinds = lines(join(root, "guild", "s", "run-cap-child.jsonl")).map(line => line.kind);
  assert.equal(kinds.filter(kind => kind === "truncated").length, 1);
  assert.equal(kinds.at(-1), "end");
  assert.ok(kinds.filter(kind => kind === "event").length < 20);
 } finally {
  recorder.dispose();
 }
});

it("reports write failures to the log without throwing into the run", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-"));
 const blocked = join(root, "not-a-directory");
 writeFileSync(blocked, "");
 const warnings: Array<[string, unknown]> = [];
 const recorder = createGuildTraceRecorder({env: enabled, log: {warn: (event, metadata) => warnings.push([event, metadata])}})!;
 try {
  recorder.bind("run-fail", {sessionDir: blocked, sessionId: "s"});
  const publish = publisher("run-fail");
  assert.doesNotThrow(() => {
   publish({type: "start"});
   publish(chunk('{"type":"message_end"}\n'));
   publish({type: "end", exitCode: 0, aborted: false, selectedSkills: []});
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "trace.error");
 } finally {
  recorder.dispose();
 }
});

it("records three concurrent background RPC children in independent private traces", {timeout: 8000}, async () => {
 const root = mkdtempSync(join(tmpdir(), "guild-background-trace-"));
 const recorder = createGuildTraceRecorder({env: enabled})!;
 const replies: Array<() => void> = [];
 const ids = ["background-a", "background-b", "background-c"];
 try {
  for (const runId of ids) recorder.bind(runId, {sessionDir: root, sessionId: "s", model: "captured/model", thinkingLevel: "high"});
  const results = await Promise.all(ids.map(runId => runBackgroundGuildRoleForTest({
   role: "coder", profile: "typescript", task: "question", cwd: process.cwd(), projectTrusted: false, runId, taskId: `${runId}-task`,
   onQuestion(question) {return new Promise(resolve => {
    replies.push(() => resolve(`Answer for ${question.split(" ").at(-1)}`));
    if (replies.length === 3) {replies[2](); replies[0](); replies[1]();}
   });},
  }, {invocation: args => ({command: process.execPath, args: [fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url)), ...args]})})));
  assert.deepEqual(results.map(result => result.status), ["completed", "completed", "completed"]);
  const directory = join(root, "guild", "s");
  assert.equal(existsSync(directory), true, "background transport must create bound traces");
  const files = readdirSync(directory);
  assert.equal(files.length, 3);
  const seen = new Set<string>();
  for (const file of files) {
   const records = lines(join(directory, file));
   const header = records[0]; seen.add(header.runId);
   assert.equal(header.role, "coder"); assert.equal(header.profile, "typescript");
   assert.equal(header.parentModel, "captured/model"); assert.equal(header.thinkingLevel, "high");
   assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
   assert.equal(records.at(-1).kind, "end");
   assert.equal(records.filter(record => record.kind === "end").length, 1);
   const reports = records.filter(record => record.event?.type === "tool_execution_start" && record.event.toolName === "guild_submit_result");
   assert.equal(reports.length, 1);
   assert.equal(reports[0].event.args.runId, header.runId);
   assert.equal(reports[0].event.args.taskId, `${header.runId}-task`);
  }
  assert.deepEqual(seen, new Set(ids));
 } finally {recorder.dispose(); rmSync(root, {recursive: true, force: true});}
});

it("contains a throwing recorder warning callback without an uncaught diagnostics exception", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-warning-"));
 const blocked = join(root, "file"); writeFileSync(blocked, "");
 try {
  const script = `
   import { createGuildTraceRecorder } from ${JSON.stringify(new URL("../src/trace-recorder.ts", import.meta.url).href)};
   import { runBackgroundGuildRoleForTest } from ${JSON.stringify(new URL("../src/background-runner.ts", import.meta.url).href)};
   const recorder = createGuildTraceRecorder({env: {PITHOS_GUILD_TRACE: '1'}, log: {warn() {throw new Error('logger failed');}}});
   recorder.bind('warning-run', {sessionDir: ${JSON.stringify(blocked)}, sessionId: 's'});
   try {
    const result = await runBackgroundGuildRoleForTest({role: 'coder', profile: 'typescript', task: 'Work', cwd: process.cwd(), projectTrusted: false, runId: 'warning-run', onQuestion: async () => undefined},
     {invocation: args => ({command: process.execPath, args: [${JSON.stringify(fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url)))}, ...args]})});
    if (result.status !== 'completed') throw new Error(result.errorMessage);
   } finally {recorder.dispose();}
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {encoding: "utf8", timeout: 8000});
  assert.equal(child.status, 0, child.stderr);
 } finally {rmSync(root, {recursive: true, force: true});}
});

it("contains an async rejecting recorder warning while the background child completes", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-warning-"));
 const blocked = join(root, "file"); writeFileSync(blocked, "");
 try {
  const script = `
   import { spawn } from 'node:child_process';
   import { existsSync } from 'node:fs';
   import { dirname } from 'node:path';
   import { createGuildTraceRecorder } from ${JSON.stringify(new URL("../src/trace-recorder.ts", import.meta.url).href)};
   import { runBackgroundGuildRoleForTest } from ${JSON.stringify(new URL("../src/background-runner.ts", import.meta.url).href)};
   const recorder = createGuildTraceRecorder({env: {PITHOS_GUILD_TRACE: '1'}, log: {async warn() {throw new Error('logger failed');}}});
   recorder.bind('warning-run', {sessionDir: ${JSON.stringify(blocked)}, sessionId: 's'});
   try {
    for (const task of ['Work', 'question-hold']) {
    const controller = new AbortController();
    let taskFile;
    const result = await runBackgroundGuildRoleForTest({role: 'coder', profile: 'typescript', task, cwd: process.cwd(), projectTrusted: false, runId: 'warning-run', signal: controller.signal, onQuestion: async () => {controller.abort(); return undefined;}},
     {spawn: (command, args, options) => {taskFile = options.env.GUILD_TASK_FILE; return spawn(command, args, options);}, invocation: args => ({command: process.execPath, args: [${JSON.stringify(fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url)))}, ...args]})});
    if (result.status !== (task === 'Work' ? 'completed' : 'cancelled')) throw new Error(result.errorMessage);
    if (!taskFile || existsSync(dirname(taskFile))) throw new Error('Owned task directory not cleaned');
    }
    await new Promise(resolve => setImmediate(resolve));
   } finally {recorder.dispose();}
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {encoding: "utf8", timeout: 8000});
  assert.equal(child.status, 0, child.stderr);
 } finally {rmSync(root, {recursive: true, force: true});}
});

it("preserves split UTF-8 stderr while independently bounding malformed partial stdout", () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-chunks-"));
 const recorder = createGuildTraceRecorder({env: enabled, maxBytes: 600})!;
 try {
  recorder.bind("chunks", {sessionDir: root, sessionId: "s"});
  const publish = publisher("chunks");
  publish({type: "start"});
  const bytes = Buffer.from("warning: €");
  publish({type: "stderr", base64: bytes.subarray(0, -1).toString("base64")});
  publish({type: "stderr", base64: bytes.subarray(-1).toString("base64")});
  publish(chunk("x".repeat(601)));
  publish(chunk('not-json\n'));
  const rpc = Buffer.from('{"type":"response","text":"€"}\n');
  const split = rpc.indexOf(Buffer.from("€")) + 1;
  publish({type: "stdout", base64: rpc.subarray(0, split).toString("base64")});
  publish({type: "stdout", base64: rpc.subarray(split).toString("base64")});
  for (let i = 0; i < 10; i++) publish({type: "stderr", base64: Buffer.from("x".repeat(200)).toString("base64")});
  publish({type: "end", exitCode: 1});
  const file = join(root, "guild", "s", "chunks-child.jsonl");
  const records = lines(file);
  assert.equal(records.filter(record => record.kind === "stderr").slice(0, 2).map(record => record.text).join(""), "warning: €");
  assert.ok(records.some(record => record.kind === "stdout" && record.text === "not-json"));
  assert.ok(records.some(record => record.event?.text === "€"));
  assert.equal(records.filter(record => record.kind === "truncated").length, 1);
  assert.equal(records.at(-1).kind, "end");
  assert.ok(statSync(file).size < 900, "cap permits only truncation and terminal metadata overhead");
 } finally {recorder.dispose(); rmSync(root, {recursive: true, force: true});}
});

it("bounds real malformed background output and creates no files when opted out", {timeout: 8000}, async () => {
 const root = mkdtempSync(join(tmpdir(), "guild-trace-malformed-"));
 const invocation = (args: string[]) => ({command: process.execPath, args: [fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url)), ...args]});
 const options = {role: "coder" as const, profile: "typescript" as const, cwd: process.cwd(), projectTrusted: false, onQuestion: async () => undefined};
 let recorder = createGuildTraceRecorder({env: {PITHOS_GUILD_TRACE: "true"}});
 try {
  recorder?.bind("opt-out", {sessionDir: root, sessionId: "s"});
  assert.equal((await runBackgroundGuildRoleForTest({...options, task: "Work", runId: "opt-out"}, {invocation})).status, "completed");
  assert.deepEqual(readdirSync(root), []);
  recorder = createGuildTraceRecorder({env: enabled, maxBytes: 16000})!;
  for (const task of ["line-limit", "utf8", "stderr-limit"]) {
   recorder.bind(task, {sessionDir: root, sessionId: task});
   const result = await runBackgroundGuildRoleForTest({...options, task, runId: task}, {invocation});
   assert.equal(result.status, "failed");
   const directory = join(root, "guild", task);
   const files = readdirSync(directory); assert.equal(files.length, 1);
   const file = join(directory, files[0]); const records = lines(file);
   assert.equal(records.at(-1).kind, "end");
   assert.equal(records.filter(record => record.kind === "end").length, 1);
   assert.ok(statSync(file).size < 17000);
   if (task === "stderr-limit") assert.ok(records.some(record => record.kind === "truncated"));
  }
 } finally {recorder?.dispose(); rmSync(root, {recursive: true, force: true});}
});
