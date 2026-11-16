import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import * as protocol from "../src/protocol.ts";
import { registerChildProtocol } from "../src/child-protocol.ts";
import { ResultStream } from "../src/result-stream.ts";
import { buildTask, report } from "./protocol-fixtures.ts";

const capability = "guild-background/1";
const ask = "guild_ask_parent";
function harness(role: import("../src/agents.ts").GuildRole = "coder", mode = "rpc", tools?: string[]) {
 const task = buildTask({role, profile: "general", task: "Work"});
 const hooks = new Map<string, Function>();
 const registered = new Map<string, any>();
 const controller = new AbortController();
 let aborted = 0;
 const ctx = {mode, hasUI: true, signal: controller.signal, abort() {aborted++; controller.abort();}, ui: {input: async (..._args: any[]): Promise<string | undefined> => "Answer"}};
 const pi = {on: (name: string, fn: Function) => hooks.set(name, fn), registerTool: (tool: any) => registered.set(tool.name, tool), getActiveTools: () => tools ?? protocol.childTools(role, capability)};
 registerChildProtocol(pi as any, task, {capability});
 const stream = new ResultStream(task, capability);
 const emit = (type: string, data: any = {}) => {
  const event = {type, ...data};
  const result = hooks.get(type)?.(event, ctx);
  stream.event(event);
  return result;
 };
 const ready = () => {
  hooks.get("session_start")!({}, ctx);
  const result = hooks.get("before_agent_start")!({systemPrompt: "base"}, ctx);
  emit("message_end", {message: {role: "custom", ...result.message}});
  return result;
 };
 const batch = (id: string, name = ask, args: unknown = {question: "Why?"}, extra: any[] = []) => emit("message_end", {message: {role: "assistant", content: [{type: "toolCall", id, name, arguments: args}, ...extra]}});
 return {task, hooks, registered, ctx, controller, stream, emit, ready, batch, get aborted() {return aborted;}};
}
it("opts in every canonical role with exact RPC handshake, modes and tools", () => {
 assert.equal(protocol.BACKGROUND_CAPABILITY, capability);
 assert.equal(protocol.ASK_TOOL, ask);
 for (const role of ["coder", "reviewer", "writer", "architect", "explorer"] as const) {
  assert.deepEqual(protocol.childTools(role, capability), [...protocol.childTools(role), ask]);
  const h = harness(role);
  assert.deepEqual(h.ready().message.details, {protocol: "guild/2", version: 2, runId: h.task.runId, taskId: h.task.taskId, tools: protocol.childTools(role, capability), capability});
  assert.equal(h.aborted, 0);
  assert.equal(h.stream.failure, undefined);
  const legacy = new ResultStream(h.task);
  legacy.event({type: "message_end", message: {role: "custom", ...h.ready().message}});
  assert.match(legacy.failure!, /handshake/);
 }
 assert.throws(() => protocol.childTools("unknown" as any, capability), /role/i);
 for (const option of [null, "wrong", {}]) assert.throws(() => protocol.childTools("coder", option as any), /capability/i);
 for (const mode of ["json", "tui", "print"]) {
  const h = harness("coder", mode);
  assert.throws(() => h.ready());
  assert.ok(h.aborted);
 }
 const h = harness("coder", "rpc", protocol.childTools("coder"));
 assert.throws(() => h.ready());
 assert.ok(h.aborted);
 const task = buildTask({role: "coder", profile: "general", task: "Work"});
 for (const options of [{}, {capability, extra: true}, {capability: "wrong"}, null]) assert.throws(() => registerChildProtocol({} as any, task, options as any));
});

for (const role of ["coder", "reviewer", "explorer", "architect", "writer"] as const) it(`limits ${role} clarification permission to the background parent channel`, () => {
 const reviewer = readFileSync(new URL(`../agents/roles/${role}.md`, import.meta.url), "utf8");
 const h = harness(role);
 const background = h.hooks.get("before_agent_start")!({systemPrompt: reviewer}, h.ctx).systemPrompt;
 assert.ok(background.startsWith(reviewer));
 const appended = background.slice(reviewer.length);
 assert.match(appended, /may ask.*guild_ask_parent/i);
 assert.match(appended, /supersedes.*prohibitions.*asking questions/i);
 assert.match(appended, /delegation remains prohibited/i);
 const hooks = new Map<string, Function>();
 registerChildProtocol({on: (name: string, fn: Function) => hooks.set(name, fn), registerTool() {}} as any, h.task);
 const blocking = hooks.get("before_agent_start")!({systemPrompt: reviewer}, h.ctx).systemPrompt;
 assert.ok(blocking.startsWith(reviewer));
 assert.doesNotMatch(blocking.slice(reviewer.length), /may ask.*guild_ask_parent/i);
});

it("does not re-abort a disposed background context during cancelled question settlement", () => {
 const h = harness(); h.ready(); h.batch("cancelled-question");
 h.emit("tool_execution_start", {toolName: ask, toolCallId: "cancelled-question", args: {question: "Why?"}});
 h.controller.abort();
 h.ctx.abort = () => { throw new Error("stale context must not be used after abort"); };
 assert.doesNotThrow(() => h.hooks.get("agent_before_settle")!({outcome: "aborted", entries: []}, h.ctx));
 assert.doesNotThrow(() => h.hooks.get("agent_settled")!({type: "agent_settled"}, h.ctx));
});

it("keeps each question pending until its UI reply and retains one final repair budget", async () => {
 const h = harness();
 h.ready();
 const tool = h.registered.get(ask);
 assert.ok(tool, "background ask tool registered");
 for (let n = 0; n < 2; n++) {
  const id = `q${n}`;
  const args = {question: `Question ${n}?`};
  let resolve!: (value: string) => void;
  let title: any, options: any;
  h.ctx.ui.input = async (value, _placeholder, opts) => {title = JSON.parse(value); options = opts; return new Promise<string>(done => {resolve = done;});};
  h.batch(id, ask, args);
  h.emit("tool_execution_start", {toolName: ask, toolCallId: id, args});
  let done = false;
  const pending = tool.execute(id, tool.prepareArguments(args), h.ctx.signal, undefined, h.ctx).then((value: any) => {done = true; return value;});
  await Promise.resolve();
  assert.equal(done, false);
  assert.deepEqual(title, {protocol: capability, runId: h.task.runId, taskId: h.task.taskId, toolCallId: id, question: args.question});
  assert.equal(options.timeout, 300000);
  assert.ok(options.signal instanceof AbortSignal);
  resolve(`Answer ${n}`);
  const result = await pending;
  assert.deepEqual(result.details, {outcome: "answered", answer: `Answer ${n}`});
  h.emit("tool_execution_end", {toolName: ask, toolCallId: id, isError: false, result});
  assert.equal(h.stream.failure, undefined);
 }
 h.batch("bad", protocol.SUBMIT_TOOL, {});
 h.emit("tool_execution_start", {toolName: protocol.SUBMIT_TOOL, toolCallId: "bad", args: {}});
 h.emit("tool_execution_end", {toolName: protocol.SUBMIT_TOOL, toolCallId: "bad", isError: true});
 assert.equal(h.aborted, 0);
 h.batch("final", protocol.SUBMIT_TOOL, report(h.task));
 h.emit("tool_execution_start", {toolName: protocol.SUBMIT_TOOL, toolCallId: "final", args: report(h.task)});
 const result = await h.registered.get(protocol.SUBMIT_TOOL).execute("final", report(h.task), undefined, undefined, h.ctx);
 h.emit("tool_execution_end", {toolName: protocol.SUBMIT_TOOL, toolCallId: "final", isError: false, result});
 h.emit("agent_settled");
 assert.equal(h.stream.finish(0, false).status, "completed");
});

it("fails closed on invalid question phases independently in child and parent", async () => {
 const cases = ["mixed", "wrong-start", "changed-args", "duplicate-start", "wrong-end", "duplicate-end", "pending-batch", "limit", "invalid-outcome", "error-end", "postreport", "repair", "raw-extra", "raw-nul", "raw-blank", "raw-bytes"];
 for (const scenario of cases) {
  const h = harness(); h.ready();
  const start = (id = "q", args: unknown = {question: "Why?"}) => h.emit("tool_execution_start", {toolName: ask, toolCallId: id, args});
  const end = (id = "q", details: unknown = {outcome: "answered", answer: "Yes"}, isError = false) => h.emit("tool_execution_end", {toolName: ask, toolCallId: id, isError, result: {details}});
  if (scenario === "postreport") {
   h.batch("final", protocol.SUBMIT_TOOL, report(h.task));
   h.emit("tool_execution_start", {toolName: protocol.SUBMIT_TOOL, toolCallId: "final", args: report(h.task)});
   const result = await h.registered.get(protocol.SUBMIT_TOOL).execute("final", report(h.task), undefined, undefined, h.ctx);
   h.emit("tool_execution_end", {toolName: protocol.SUBMIT_TOOL, toolCallId: "final", isError: false, result});
  }
  if (scenario === "repair") {
   const repair = h.emit("agent_before_settle", {outcome: "completed", entries: []});
   h.emit("entry_appended", {entry: repair.entries[0]});
  }
  const raw: Record<string, unknown> = {"raw-extra": {question: "Why?", extra: true}, "raw-nul": {question: "a\0b"}, "raw-blank": {question: " "}, "raw-bytes": {question: "🙂".repeat(2049)}};
  h.batch("q", ask, raw[scenario] ?? {question: "Why?"}, scenario === "mixed" ? [{type: "toolCall", id: "read", name: "read", arguments: {path: "x"}}] : []);
  if (!["mixed", "postreport", "repair"].includes(scenario) && !scenario.startsWith("raw-")) {
   start(scenario === "wrong-start" ? "wrong" : "q", scenario === "changed-args" ? {question: "Different"} : {question: "Why?"});
   if (scenario === "duplicate-start") start();
   else if (scenario === "pending-batch") h.batch("other");
   else if (scenario === "wrong-end") end("wrong");
   else if (scenario === "invalid-outcome") end("q", {outcome: "answered", answer: " "});
   else if (scenario === "error-end") end("q", undefined, true);
   else if (scenario === "duplicate-end") {end(); end();}
   else if (scenario === "limit") {
    end();
    for (let n = 1; n <= 8; n++) {h.batch(`q${n}`); start(`q${n}`); end(`q${n}`);}
   }
  }
  assert.ok(h.aborted, `child: ${scenario}`);
  assert.ok(h.stream.failure, `parent: ${scenario}`);
 }
});

it("bounds raw input and replies, exposes UI unavailability, and aborts invalid or cancelled executions", async () => {
 for (const value of ["", " ", "a\0b", "🙂".repeat(2049), 42, null]) {
  const h = harness(); h.ready();
  const tool = h.registered.get(ask);
  assert.throws(() => tool.prepareArguments({question: value}));
  h.batch("q"); h.emit("tool_execution_start", {toolName: ask, toolCallId: "q", args: {question: "Why?"}});
  h.ctx.ui.input = async () => value as any;
  await assert.rejects(tool.execute("q", {question: "Why?"}, h.ctx.signal, undefined, h.ctx));
  assert.ok(h.aborted, "invalid answer aborts, not a repairable tool error");
 }
 for (const value of ["🙂".repeat(2048), undefined]) {
  const h = harness(); h.ready();
  h.batch("q"); h.emit("tool_execution_start", {toolName: ask, toolCallId: "q", args: {question: "Why?"}});
  h.ctx.ui.input = async () => value;
  const result = await h.registered.get(ask).execute("q", {question: "Why?"}, h.ctx.signal, undefined, h.ctx);
  assert.deepEqual(result.details, value === undefined ? {outcome: "unavailable", reason: "cancelled-or-timed-out"} : {outcome: "answered", answer: value});
  h.emit("tool_execution_end", {toolName: ask, toolCallId: "q", isError: false, result});
  assert.equal(h.aborted, 0);
  assert.equal(h.stream.failure, undefined);
 }
 for (const action of ["cancel", "duplicate", "violation", "reject"] as const) {
  const h = harness(); h.ready();
  h.batch("q"); h.emit("tool_execution_start", {toolName: ask, toolCallId: "q", args: {question: "Why?"}});
  let uiSignal: AbortSignal | undefined;
  h.ctx.ui.input = async (_title, _placeholder, opts) => {uiSignal = opts.signal; if (action === "reject") throw new Error("UI failed"); return new Promise(() => {});};
  const tool = h.registered.get(ask);
  const pending = tool.execute("q", {question: "Why?"}, h.ctx.signal, undefined, h.ctx);
  const rejected = assert.rejects(pending);
  if (action === "cancel") h.controller.abort();
  if (action === "duplicate") await assert.rejects(tool.execute("q", {question: "Why?"}, h.ctx.signal, undefined, h.ctx));
  if (action === "violation") h.batch("second");
  await rejected;
  assert.equal(h.ctx.signal.aborted, true, action);
  if (action !== "cancel") assert.ok(h.aborted, action);
  assert.equal(uiSignal?.aborted, true, action);
 }
});

it("rejects sibling execution and settlement while a question is pending", () => {
 for (const event of [
  {type: "tool_execution_start", toolName: "read", toolCallId: "sibling", args: {}},
  {type: "tool_execution_end", toolName: "read", toolCallId: "sibling", result: {}, isError: false},
  {type: "tool_execution_update", toolName: "read", toolCallId: "sibling"},
  {type: "agent_settled"},
 ]) {
  const h = harness(); h.ready(); h.batch("q");
  h.emit("tool_execution_start", {toolName: ask, toolCallId: "q", args: {question: "Why?"}});
  h.emit(event.type, event);
  assert.ok(h.aborted, `child ${event.type}`);
  assert.ok(h.stream.failure, `parent ${event.type}`);
 }
});

it("loads the explicit background entry through the same bounded host task loader", async () => {
 const {default: entry} = await import("../src/background-child-protocol.ts");
 const {mkdtempSync, writeFileSync, rmSync} = await import("node:fs");
 const {tmpdir} = await import("node:os");
 const {join} = await import("node:path");
 const directory = mkdtempSync(join(tmpdir(), "guild-background-"));
 const previous = process.env.GUILD_TASK_FILE;
 const file = join(directory, "task.json");
 process.env.GUILD_TASK_FILE = file;
 try {
  const task = buildTask({role: "coder", profile: "general", task: "Work"});
  const tools: string[] = [];
  const pi = {on() {}, registerTool: (tool: any) => tools.push(tool.name)};
  writeFileSync(file, JSON.stringify(task));
  entry(pi as any);
  assert.ok(tools.includes(ask));
  for (const content of ["x".repeat(48 * 1024 + 1), Buffer.from([0xc3, 0x28]), JSON.stringify({...task, extra: true}), JSON.stringify({...task, role: "unknown"})]) {
   tools.length = 0;
   writeFileSync(file, content);
   assert.throws(() => entry(pi as any));
   assert.equal(tools.length, 0);
  }
 } finally {
  if (previous === undefined) delete process.env.GUILD_TASK_FILE; else process.env.GUILD_TASK_FILE = previous;
  rmSync(directory, {recursive: true, force: true});
 }
});

it("rejects absent UI, uncorrelated updates and pending settlement without consuming repair", async () => {
 const noUI = harness(); noUI.ctx.hasUI = false;
 assert.throws(() => noUI.ready());
 for (const scenario of ["update", "settle", "after-report", "duplicate-batch"] as const) {
  const h = harness(); h.ready();
  if (scenario === "after-report") {
   h.batch("final", protocol.SUBMIT_TOOL, report(h.task));
   h.emit("tool_execution_start", {toolName: protocol.SUBMIT_TOOL, toolCallId: "final", args: report(h.task)});
   const result = await h.registered.get(protocol.SUBMIT_TOOL).execute("final", report(h.task), undefined, undefined, h.ctx);
   h.emit("tool_execution_end", {toolName: protocol.SUBMIT_TOOL, toolCallId: "final", isError: false, result});
  }
  if (scenario === "settle" || scenario === "duplicate-batch") {
   h.batch("q"); h.emit("tool_execution_start", {toolName: ask, toolCallId: "q", args: {question: "Why?"}});
  }
  if (scenario === "duplicate-batch") {
   h.emit("tool_execution_end", {toolName: ask, toolCallId: "q", isError: false, result: {details: {outcome: "unavailable", reason: "cancelled-or-timed-out"}}});
   h.batch("q");
  } else if (scenario === "settle") {
   assert.equal(h.emit("agent_before_settle", {outcome: "completed", entries: []}), undefined);
   h.emit("agent_settled");
  } else h.emit("tool_execution_update", {toolName: ask, toolCallId: "q"});
  assert.ok(h.aborted, scenario);
  assert.ok(h.stream.failure, scenario);
 }
});

it("aborts late background tool events after the final report", async () => {
 for (const type of ["tool_execution_update", "tool_execution_end"]) {
  const h = harness(); h.ready();
  h.batch("final", protocol.SUBMIT_TOOL, report(h.task));
  h.emit("tool_execution_start", {toolName: protocol.SUBMIT_TOOL, toolCallId: "final", args: report(h.task)});
  const result = await h.registered.get(protocol.SUBMIT_TOOL).execute("final", report(h.task), undefined, undefined, h.ctx);
  h.emit("tool_execution_end", {toolName: protocol.SUBMIT_TOOL, toolCallId: "final", isError: false, result});
  h.emit(type, {toolName: "read", toolCallId: "late", isError: false, result: {}});
  assert.ok(h.aborted, type);
  assert.ok(h.stream.failure, type);
 }
});

it("models the supported UI timeout as unavailable, never as an answer", async t => {
 t.mock.timers.enable({apis: ["setTimeout"]});
 const h = harness(); h.ready();
 h.ctx.ui.input = async (_title, _placeholder, opts) => new Promise(resolve => setTimeout(() => resolve(undefined), opts.timeout));
 h.batch("q"); h.emit("tool_execution_start", {toolName: ask, toolCallId: "q", args: {question: "Why?"}});
 let done = false;
 const pending = h.registered.get(ask).execute("q", {question: "Why?"}, h.ctx.signal, undefined, h.ctx).then((value: any) => {done = true; return value;});
 t.mock.timers.tick(299999);
 await Promise.resolve();
 assert.equal(done, false);
 t.mock.timers.tick(1);
 const result = await pending;
 assert.deepEqual(result.details, {outcome: "unavailable", reason: "cancelled-or-timed-out"});
 assert.equal(h.aborted, 0);
});

it("independently rejects missing, unsupported or extra handshake capabilities and tool drift", () => {
 const h = harness(); const details = h.ready().message.details;
 const {capability: _capability, ...legacy} = details;
 for (const bad of [legacy, {...details, capability: "wrong"}, {...details, extra: true}, {...details, tools: protocol.childTools("coder")}, {...details, tools: [...details.tools, ask]}]) {
  const parent = new ResultStream(h.task, capability);
  parent.event({type: "message_end", message: {role: "custom", customType: "guild-protocol-ready", details: bad}});
  assert.match(parent.failure!, /handshake/);
 }
});
