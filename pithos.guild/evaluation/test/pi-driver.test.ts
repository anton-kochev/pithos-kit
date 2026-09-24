import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { access, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPiDriver } from "../src/pi-driver.ts";
import { loadDevelopmentBank } from "../src/bank.ts";
import { runTrial } from "../src/runner.ts";
import { digest } from "../src/manifest.ts";

test("native request observation rejects unreviewed runtime before credential access", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-native-admission-test-"));
  try {
    const piPackageJson = join(root, "package.json");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "main-only", repetition: 1,
      cohort: { model: "openai-codex/gpt-6-astra", thinking: "high" }, timeoutMs: 1000 }, createPiDriver({
      approval: "explicit-model-run-approval", piEntry: join(root, "dist/cli.js"), piPackageJson, guildRoot: resolve("."), credentials: {},
      codexAuth: { sourceFile: join(root, "must-not-read-auth.json"), temporaryRoot: root },
      nativeRequestGate: { version: 1, model: "openai-codex/gpt-6-astra", api: "openai-codex-responses", serviceTier: "base", cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
    } as any));
    assert.match(run.error ?? "", /Native request observation requires/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects missing, changed or cross-directory runner identity before CLI entry or artifact recording", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-driver-identity-rejection-"));
  try {
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs"), marker = join(root, "entered");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'entered'); console.log(JSON.stringify({type:'agent_end'}));`);
    const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} });
    for (const change of [
      (c: any) => c.trialIdentity = undefined,
      (c: any) => c.trialIdentity.version++,
      (c: any) => c.trialIdentity.id = "00000000-0000-4000-8000-000000000001",
      (c: any) => c.trialIdentity.requestDigest = "0".repeat(64),
      (c: any) => c.trialIdentity.extra = "synthetic-sensitive",
      (c: any) => c.trialIdentity = Object.assign([], c.trialIdentity),
      (c: any) => c.artifactDirectory += "/other",
      (c: any) => c.request.task.prompt += " changed",
    ]) {
      const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "main-only", repetition: 1,
        cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 1000 }, async context => {
        const altered = { ...context, trialIdentity: { ...context.trialIdentity } }; change(altered); return driver(altered);
      });
      assert.equal(run.status, "driver_error");
      assert.equal(run.error, "Error: Driver trial identity mismatch");
      await assert.rejects(access(marker));
      await assert.rejects(access(join(root, run.id, "invocation.json")));
      await assert.rejects(access(join(root, run.id, "agent")));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("snapshots driver request and identity before asynchronous preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-driver-snapshot-test-"));
  try {
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, `console.log(JSON.stringify({type:'agent_end'}));`);
    const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} });
    const task = loadDevelopmentBank().tasks[0], originalPrompt = task.prompt;
    const run = await runTrial(root, { task, arm: "main-only", repetition: 1, cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 1000 }, async context => {
      const altered = { ...context, trialIdentity: { ...context.trialIdentity } };
      const pending = driver(altered);
      altered.request.task.prompt += " changed during preflight";
      altered.trialIdentity.id = "changed-during-preflight";
      return pending;
    });
    assert.equal(run.exitCode, 0, run.error);
    const saved = JSON.parse(await readFile(join(root, run.id, "invocation.json"), "utf8"));
    assert.equal(saved.args.at(-1), originalPrompt);
    assert.deepEqual(saved.trialIdentity, { version: 1, id: run.id, requestDigest: run.requestDigest });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retains the driver's actual spawn identity, not a producer-selected PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-supervisor-test-"));
  try {
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.PI_CODING_AGENT_DIR + '/pid.json', JSON.stringify({pid:process.pid,ppid:process.ppid}));
console.log(JSON.stringify({type:'process_start',pid:99999999})); console.log(JSON.stringify({type:'agent_end'}));`);
    const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} });
    let outcome: any;
    const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "main-only", repetition: 1,
      cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 2000 }, async context => outcome = await driver(context));
    assert.equal(run.exitCode, 0, run.error);
    assert.ok(outcome.supervisor, "driver must return its in-memory spawn observation");
    const directory = join(root, run.id), actual = JSON.parse(await readFile(join(directory, "agent/pid.json"), "utf8"));
    const invocation = JSON.parse(await readFile(join(directory, "invocation.json"), "utf8"));
    const expected = { version: 1, kind: "guild-eval-supervisor-spawn", trialIdentity: invocation.trialIdentity,
      invocationDigest: digest({ version: 1, trialIdentity: invocation.trialIdentity, command: invocation.command, args: invocation.args, cwd: invocation.cwd }),
      configurationSha256: null, supervisorPid: process.pid, parentPid: actual.pid };
    assert.equal(actual.ppid, process.pid);
    assert.deepEqual(outcome.supervisor, expected);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "supervisor.json"), "utf8")), expected);
    assert.equal((await stat(join(directory, "supervisor.json"))).mode & 0o777, 0o600);
    assert.ok(Object.isFrozen(outcome.supervisor)); assert.ok(Object.isFrozen(outcome.supervisor.trialIdentity));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("supervisor evidence collision blocks spawn without replacing retained bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-supervisor-collision-"));
  try {
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs"), marker = join(root, "entered");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'entered');`);
    const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} });
    const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "main-only", repetition: 1,
      cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 2000 }, async context => {
      await writeFile(join(context.artifactDirectory, "supervisor.json"), "preserved original", { mode: 0o600 });
      return driver(context);
    });
    assert.equal(run.status, "driver_error");
    assert.equal(await readFile(join(root, run.id, "supervisor.json"), "utf8"), "preserved original");
    await assert.rejects(access(marker));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("supervisor write failure rejects after stopping the spawned process", async t => {
  const root = await mkdtemp(join(tmpdir(), "guild-supervisor-write-failure-"));
  const write = t.mock.method(fs, "writeFileSync", () => { throw Error("private-write-error"); });
  syncBuiltinESMExports();
  try {
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs"), marker = join(root, "late");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, `import {writeFileSync} from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'orphan'), 500);`);
    const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "main-only", repetition: 1,
      cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 2000 }, createPiDriver({
      approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} }));
    assert.equal(write.mock.callCount(), 1);
    assert.equal(run.error, "Error: Supervisor spawn observation failed");
    assert.equal(run.status, "driver_error");
    assert.equal(await readFile(join(root, run.id, "supervisor.json"), "utf8"), "");
    await delay(600); await assert.rejects(access(marker));
  } finally { write.mock.restore(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

test("failed spawn leaves no invented parent identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-supervisor-spawn-failure-"));
  try {
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, 'throw Error("must not enter");');
    const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} });
    const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "main-only", repetition: 1,
      cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 2000 }, context => driver({ ...context, cwd: join(root, "missing-cwd") }));
    assert.equal(run.status, "driver_error"); assert.equal(run.exitCode, undefined);
    assert.equal(await readFile(join(root, run.id, "supervisor.json"), "utf8"), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["nonzero", "cancelled"]) test(`spawn observation survives ${mode} termination`, async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-supervisor-termination-"));
  try {
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, mode === "nonzero" ? 'process.exitCode = 7;' : 'console.log("READY"); setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} });
    let outcome: any;
    const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "main-only", repetition: 1,
      cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 2000 }, async context => outcome = await driver({ ...context,
        emit: chunk => { context.emit(chunk); if (chunk.includes("READY")) controller.abort(); },
      }), controller.signal);
    assert.equal(run.status, mode === "nonzero" ? "process_error" : "cancelled");
    assert.ok(outcome.supervisor.parentPid > 1);
    assert.deepEqual(JSON.parse(await readFile(join(root, run.id, "supervisor.json"), "utf8")), outcome.supervisor);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("requires explicit live-run acknowledgement before constructing the native driver", () => {
  assert.throws(() => createPiDriver({} as any), /approval/);
});

test("native CLI cancellation and early parent exit stop ordinary descendant writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-process-test-"));
  try {
    const piPackageJson = join(root, "package.json");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    for (const exitEarly of [false, true]) {
      const marker = join(root, `late-${exitEarly}.txt`);
      const cli = join(root, `fake-${exitEarly}.mjs`);
      const descendant = `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'); }, 500);`;
      await writeFile(cli, `import {spawn} from 'node:child_process';\nspawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'});\n${exitEarly ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'}\n`);
      const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "main-only", repetition: 1, cohort: { model: "test/fake", thinking: "off" }, timeoutMs: exitEarly ? 2000 : 200 }, createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} }));
      assert.equal(run.status, exitEarly ? "incomplete_trace" : "timeout");
      await delay(600);
      await assert.rejects(access(marker));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("captures the real runner's child events on success, provider failure, and cancellation without a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-runner-observer-test-"));
  try {
    const piPackageJson = join(root, "package.json");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    for (const outcome of ["success", "error", "abort"]) {
      const cli = join(root, `${outcome}.mjs`);
      await writeFile(cli, `
const outcome = ${JSON.stringify(outcome)};
const usage = {input:3,output:2,cacheRead:0,cacheWrite:0,cost:{total:0.01}};
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
const message = stopReason => ({type:'message_end',message:{role:'assistant',provider:'test',model:'fake',stopReason,usage,content:[{type:'text',text:'Offline fixture report'}]}});
if (process.argv.includes('--system-prompt')) {
  const { readFileSync } = await import('node:fs');
  const { task: taskText, ...header } = JSON.parse(readFileSync(process.env.GUILD_TASK_FILE, 'utf8'));
  const tools = process.argv[process.argv.indexOf('--tools') + 1].split(',');
  emit({type:'message_end',message:{role:'custom',customType:'guild-protocol-ready',details:{protocol:header.protocol,version:header.version,runId:header.runId,taskId:header.taskId,tools}}});
  // Let the initial handshake's throttled update window expire before the
  // assistant usage update that deterministically triggers parent cancellation.
  if (outcome === 'abort') { process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); await new Promise(resolve => setTimeout(resolve, 150)); emit(message('toolUse')); }
  emit({type:'tool_execution_start',toolName:'read',toolCallId:'read-1',args:{path:'README.md'}});
  emit({type:'tool_execution_end',toolName:'read',toolCallId:'read-1',result:{content:[{type:'text',text:'Scripted result'}]}});
  process.stderr.write('scripted child diagnostic\\n');
  if (outcome === 'success') {
    const report = {...header,summary:'Offline fixture report',blockers:[],limitations:[],payload:{changes:[],verification:[]}};
    const submission = message('toolUse');
    submission.message.content = [{type:'toolCall',name:'guild_submit_result',id:'submit-1',arguments:report}];
    emit(submission);
    emit({type:'tool_execution_start',toolName:'guild_submit_result',toolCallId:'submit-1',args:report});
    emit({type:'tool_execution_end',toolName:'guild_submit_result',toolCallId:'submit-1',isError:false,result:{details:report,content:[{type:'text',text:'Guild result recorded.'}]}});
  } else if (outcome === 'error') emit(message('error'));
  if (outcome !== 'abort') { emit({type:'agent_end'}); emit({type:'agent_settled'}); process.exitCode = outcome === 'error' ? 1 : 0; }
} else {
  // tsx loads the production runner's existing extensionless imports. This is
  // an inert CLI transport test, NOT production Pi/provider integration.
  const { tsImport } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))});
  const { runGuildRole, getRunFailure } = await tsImport(${JSON.stringify(resolve("src/runner.ts"))}, import.meta.url);
  const controller = new AbortController();
  const args = {role:'coder',profile:'general',task:'Offline runner observation'};
  emit({type:'tool_execution_start',toolName:'guild_handover',toolCallId:'call-1',args});
  try {
    const result = await runGuildRole({...args,runId:'call-1',cwd:process.cwd(),projectTrusted:true,model:'test/fake',signal:controller.signal,
      onUpdate: partial => { if(outcome === 'abort' && partial.usage.turns) controller.abort(); }});
    if (getRunFailure(result)) throw Error('Scripted child failure');
    emit({type:'tool_execution_end',toolName:'guild_handover',toolCallId:'call-1',result:{details:{usage:result.usage,status:result.status},content:[{type:'text',text:result.output}]}});
  } catch {
    emit({type:'tool_execution_end',toolName:'guild_handover',toolCallId:'call-1',isError:true,result:{content:[{type:'text',text:'Child failed'}]}});
  }
  emit(message('stop')); emit({type:'agent_end'});
}
`);
      const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "guild-available", repetition: 1, cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 3000 }, createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} }));
      assert.equal(run.trace.childRuns.length, 1, JSON.stringify(run));
      assert.equal(run.trace.childRuns[0].runId, "call-1");
      assert.equal(run.trace.childObserved.cost, 0.01);
      // The dormant evaluator still requires prose plus a terminal stop; a valid
      // Phase 2 submission ends at toolUse. Preserve this known incompatibility
      // instead of fabricating a post-submission assistant turn or enabling E1.
      assert.equal(run.trace.complete, false, run.trace.issues.join(","));
      assert.equal(run.trace.totalObserved.cost, null);
      assert.equal(run.status, outcome === "error" ? "provider_error" : "incomplete_trace");
      const parentEvents = (await readFile(join(root, run.id, "parent.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const handover = parentEvents.find(event => event.type === "tool_execution_end" && event.toolName === "guild_handover");
      if (outcome === "success") {
        assert.equal(handover?.result?.details?.status, "completed");
        assert.deepEqual(run.trace.issues, ["child_missing_final_text", "child_missing_terminal_stop"]);
      } else assert.equal(handover?.isError, true);
      const records = (await readFile(join(root, run.id, "children.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(records.find(e => e.type === "end")?.aborted, outcome === "abort");
      const decoded = (type: string) => Buffer.concat(records.filter(e => e.type === type).map(e => Buffer.from(e.base64, "base64"))).toString("utf8");
      assert.match(decoded("stdout"), /tool_execution_end/);
      assert.match(decoded("stderr"), /scripted child diagnostic/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bounds private child capture and marks truncation incomplete without changing parent output", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-observer-limit-test-"));
  try {
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, `import { channel } from 'node:diagnostics_channel';
channel('pithos.guild.child').publish({version:1,type:'stdout',base64:'x'.repeat(17 * 1024 * 1024)});
console.log(JSON.stringify({type:'agent_end'}));`);
    const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "guild-available", repetition: 1, cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 2000 }, createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} }));
    assert.ok((await stat(join(root, run.id, "children.jsonl"))).size <= 16 * 1024 * 1024);
    assert.match(await readFile(join(root, run.id, "children.jsonl"), "utf8"), /observer_output_limit/);
    assert.equal(run.trace.complete, false);
    assert.equal(run.trace.totalObserved.cost, null);
    assert.equal(run.exitCode, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native observer records a private child stream without contaminating parent stdout", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-observer-test-"));
  try {
    const piPackageJson = join(root, "package.json"), cli = join(root, "fake-cli.mjs");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    await writeFile(cli, `import { channel } from 'node:diagnostics_channel';
channel('pithos.guild.child').publish({version:1,type:'start',runId:'call-1',childId:'child-1',role:'coder',profile:'general',sequence:0});
console.log(JSON.stringify({type:'agent_end'}));`);
    const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, piPackageJson, guildRoot: resolve("."), credentials: {} });
    const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm: "guild-available", repetition: 1, cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 1000 }, driver);
    const raw = await readFile(join(root, run.id, "children.jsonl"), "utf8");
    const events = raw.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(e => e.type), ["observer_ready", "start", "observer_end"]);
    assert.equal(events[1].runId, "call-1");
    assert.equal(run.trace.childRuns[0]?.runId, "call-1");
    assert.ok(run.trace.issues.includes("unfinished_child_run"));
    assert.equal(run.trace.totalObserved.cost, null);
    assert.doesNotMatch(await readFile(join(root, run.id, "parent.jsonl"), "utf8"), /child-1|observer_ready/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native CLI boundary has identical parent settings except real Guild extension/tool availability", async () => {
  const root = await mkdtemp(join(tmpdir(), "guild-pi-adapter-test-"));
  try {
    const cli = join(root, "fake-cli.mjs");
    const piPackageJson = join(root, "package.json");
    await writeFile(piPackageJson, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }));
    // No Pi/provider imports: this executable tests only the OS/CLI boundary, offline.
    await writeFile(cli, `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.PI_CODING_AGENT_DIR + '/observed.json', JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,nodeOptions:process.env.NODE_OPTIONS}));
console.log(JSON.stringify({type:'agent_end'}));\n`);
    for (const arm of ["main-only", "guild-available"] as const) {
      const driver = createPiDriver({ approval: "explicit-model-run-approval", piEntry: cli, guildRoot: resolve("."), piPackageJson, credentials: {} });
      const run = await runTrial(root, { task: loadDevelopmentBank().tasks[0], arm, repetition: 1, cohort: { model: "test/fake", thinking: "off" }, timeoutMs: 1000 }, driver);
      const observed = JSON.parse(await readFile(join(root, run.id, "agent", "observed.json"), "utf8"));
      for (const flag of ["--mode", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--model", "--thinking"]) assert.ok(observed.args.includes(flag), flag);
      assert.equal(observed.args.includes("--extension"), arm === "guild-available");
      const tools = observed.args[observed.args.indexOf("--tools") + 1];
      assert.equal(tools.includes("guild_handover"), arm === "guild-available");
      assert.equal(tools.includes("create_commit"), false);
      assert.equal(observed.nodeOptions, undefined);
      assert.equal(observed.home, join(root, run.id, "agent"));
      const provenance = JSON.parse(await readFile(join(root, run.id, "invocation.json"), "utf8"));
      assert.deepEqual(provenance.trialIdentity, { version: 1, id: run.id, requestDigest: run.requestDigest });
      assert.match(provenance.implementationDigest, /^[a-f0-9]{64}$/);
      assert.equal(provenance.piVersion, "0.83.0");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
