import assert from "node:assert/strict";
import { it } from "node:test";
import { buildTask, validateInput, validateTask } from "../src/protocol.ts";
import { createGuildBackgroundRuntime } from "../src/background-runtime.ts";
import { GuildRunTracker } from "../src/visibility.ts";
import { LiveTranscriptStore } from "../src/live-transcript.ts";
import { createInlineGuildPanel } from "../src/inline-panel.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createLiveTranscriptInspector } from "../src/live-transcript-ui.ts";

// Behaviors: host-only summary; compact identity/task; observed activity; raw details.
it("copies optional display summaries through admission without changing the child envelope", async () => {
 const input = {role: "coder", profile: "typescript", task: " full\n instructions ", taskSummary: "Verify\n the display."};
 const canonical = validateInput(input);
 assert.equal(canonical.taskSummary, input.taskSummary);
 assert.equal(canonical.task, input.task);
 const task = buildTask({...canonical, runId: "run", taskId: "task"});
 assert.equal(task.task, input.task);
 assert.equal("taskSummary" in task, false);
 assert.deepEqual(validateTask(task), task);
 assert.throws(() => validateTask({...task, taskSummary: "forbidden"}));
 for (const taskSummary of ["", " \n", "bad\0text", "界".repeat(171), 42]) assert.throws(() => validateInput({...input, taskSummary}));
 assert.equal(validateInput({...input, taskSummary: "界".repeat(170)}).taskSummary?.length, 170);
 assert.equal(validateInput({role: "coder", profile: "typescript", task: input.task}).taskSummary, undefined);
 const changes: any[] = [];
 const runtime = createGuildBackgroundRuntime({bus: {emit() {}}, parentEnvironment: {PITHOS_GUILD_PLAN_MODE: "standalone"}, onChange: change => { changes.push(change); }});
 const owner = runtime.activate();
 let release!: () => void;
 const hold = runtime.runExclusive(owner, () => new Promise<void>(resolve => { release = resolve; }));
 await new Promise(resolve => setTimeout(resolve, 0));
 try {
  runtime.start(owner, input, {cwd: process.cwd(), projectTrusted: false, getBranch: () => []});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(changes[0].taskSummary, input.taskSummary);
 } finally { const stop = runtime.shutdown(); release(); await hold; await stop; }
});

it("renders compact session-local labels and a separate bounded parent task sentence", () => {
 const tracker = new GuildRunTracker();
 for (const id of ["old", "older"]) { tracker.start({id, member: "legacy", startedAt: 0}); tracker.finish(id); }
 const run = {id: "uuid-private:42", role: "coder" as const, profile: "typescript" as const, task: "Full instructions", taskSummary: "Verify\n\x1b[31m display.", phase: "running" as const, startedAt: 0, turns: 25};
 tracker.start(run);
 assert.equal(tracker.formatLines(475000)[1], "• coder/typescript • running #3 • 7m 55s • 25 turns");
 const store = new LiveTranscriptStore(); store.start(run);
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 30}}, {fg: (_: string, text: string) => text} as any, () => () => {}, () => {}, () => "", () => true);
 panel.update(tracker.formatLines(475000), [run.id]);
 const lines = panel.render(100).map(stripTerminalSequences);
 assert.ok(lines.some(line => line.includes("Task: Verify display.")));
 assert.doesNotMatch(lines.join("\n"), /uuid-private|Full instructions/);
 assert.ok(lines.every(line => visibleWidth(line) <= 100));
 panel.dispose();
});

it("shows chronological observed actions, separates requested tools, and toggles retained raw details", () => {
 const store = new LiveTranscriptStore();
 store.start({id: "full-private-id", role: "coder", profile: "typescript", task: "Full task", taskSummary: "Verify display.", phase: "running", startedAt: 0});
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 40}}, {fg: (_: string, text: string) => text} as any, {matches: (a: string, b: string) => a === b}, () => {}, "full-private-id", true);
 store.ingest("full-private-id", {type: "message_end", message: {role: "assistant", content: [{type: "toolCall", id: "r", name: "read", arguments: {path: "src/a.ts"}}]}});
 assert.equal(store.get("full-private-id")!.entries[0].status, "requested");
 assert.match(ui.render(100).join("\n"), /Requested: Read src\/a.ts/);
 store.ingest("full-private-id", {type: "tool_execution_start", toolCallId: "r", toolName: "read", args: {path: "src/a.ts"}});
 assert.match(ui.render(100).join("\n"), /→ Reading src\/a.ts/);
 store.ingest("full-private-id", {type: "tool_execution_end", toolCallId: "r", result: {content: [{type: "text", text: "secret raw output"}]}});
 store.ingest("full-private-id", {type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: {command: "npm test"}});
 let text = ui.render(100).join("\n");
 assert.match(text, /✓ Read src\/a.ts[\s\S]*→ Running npm test/);
 assert.doesNotMatch(text, /secret raw output|"path"|full-private-id/);
 ui.handleInput("\t"); ui.handleInput("\x1b[H");
 text = ui.render(100).join("\n");
 assert.match(text, /full-private-id/); assert.match(text, /secret raw output/); assert.match(text, /"path"/);
 ui.handleInput("\t");
 store.ingest("full-private-id", {type: "tool_execution_end", toolCallId: "b", isError: true, result: {content: []}});
 assert.match(ui.render(100).join("\n"), /✗ Command failed: npm test/);
 assert.doesNotMatch(ui.render(100).join("\n"), /tests passed|✓.*npm test/);
 ui.dispose();
});
it("keeps one task sentence in expanded panels, falls back on tiny screens, and scopes Tab capture", () => {
 const store = new LiveTranscriptStore(); store.start({id: "opaque-id", role: "coder", profile: "typescript", task: "Full", taskSummary: "Verify display.", phase: "running", startedAt: 0});
 let capture: any; const tui = {requestRender() {}, terminal: {rows: 48}};
 const panel = createInlineGuildPanel(store, tui, {fg: (_: string, text: string) => text, inverse: (s: string) => s} as any, handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild", "• coder/typescript • running #1 • 0s • 0 turns"], ["opaque-id"]);
 assert.equal(capture("\t"), undefined);
 capture("\x1b[A"); capture("\x1b[C");
 assert.equal(panel.render(100).join("\n").match(/Verify display\./g)?.length, 1);
 assert.deepEqual(capture("\t"), {consume: true});
 assert.match(panel.render(100).join("\n"), /Run ID: opaque-id/);
 assert.equal(capture("typing"), undefined); assert.equal(capture("\t"), undefined);
 tui.terminal.rows = 10;
 assert.match(panel.render(100).join("\n"), /Verify display\./);
 panel.dispose();
});
it("renders unknown tools literally with malformed arguments and advertises details at normal widths", () => {
 const store = new LiveTranscriptStore();
 store.start({id: "a", role: "coder", profile: "typescript", task: "Task", phase: "running", startedAt: 0});
 store.ingest("a", {type: "tool_execution_start", toolCallId: "odd", toolName: "constructor", args: "not json"});
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 24}}, {fg: (_: string, s: string) => s} as any, {matches: (a: string, b: string) => a === b}, () => {}, "a", true);
 assert.match(ui.render(80).join("\n"), /→ constructor/);
 assert.match(ui.render(80).at(-1)!, /Tab details/);
 ui.dispose();
});
it("retains bounded sanitized summary metadata and falls back when its display text is empty", () => {
 const store = new LiveTranscriptStore({maxRunBytes: 700});
 const run = {id: "a", role: "coder", profile: "typescript", task: "Original\n instructions", taskSummary: "\x1b]52;c;hidden\x07\u202e" + "界".repeat(200), phase: "queued" as const, startedAt: 0};
 store.start(run);
 const snapshot = store.get("a")!;
 assert.ok(snapshot.retainedBytes <= 700); assert.ok(Buffer.byteLength(snapshot.taskSummary!) <= 512);
 assert.doesNotMatch(snapshot.taskSummary!, /hidden|\x1b|\u202e/); assert.equal(snapshot.truncated, true);
 store.start({...run, id: "b", taskSummary: "\x1b]52;c;hidden\x07"});
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 20}}, {fg: (_: string, s: string) => s} as any, {matches: (a: string, b: string) => a === b}, () => {}, "b", true);
 assert.match(ui.render(80).join("\n"), /Task · Original instructions/);
 assert.match(ui.render(80).join("\n"), /Queued; no child execution yet/);
 ui.dispose(); store.dispose(); assert.equal(store.list().retainedBytes, 0); assert.equal(store.get("a"), undefined);
});
it("tracks parallel tools without replay downgrades and keeps lifecycle/report outcomes explicit", () => {
 const store = new LiveTranscriptStore(); store.start({id: "a", role: "coder", profile: "typescript", task: "Work", phase: "running", startedAt: 0});
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 40}}, {fg: (_: string, s: string) => s} as any, {matches: (a: string, b: string) => a === b}, () => {}, "a", true);
 for (const id of ["one", "two"]) store.ingest("a", {type: "tool_execution_start", toolCallId: id, toolName: "read", args: {path: id}});
 store.ingest("a", {type: "message_end", message: {role: "assistant", content: [{type: "toolCall", id: "one", name: "read", arguments: {path: "one"}}]}});
 assert.equal(store.get("a")!.entries[0].status, "running");
 assert.match(ui.render(100).join("\n"), /→ Reading one[\s\S]*→ Reading two/);
 store.ingest("a", {type: "tool_execution_end", toolCallId: "two", isError: false});
 store.ingest("a", {type: "tool_execution_start", toolCallId: "two", toolName: "read"});
 assert.equal(store.get("a")!.entries[1].status, "completed");
 store.updatePhase("a", "waiting"); assert.match(ui.render(100).join("\n"), /Waiting for parent/);
 store.updatePhase("a", "stopping"); assert.match(ui.render(100).join("\n"), /awaiting cleanup/);
 store.ingest("a", {type: "tool_execution_end", toolCallId: "submit", toolName: "guild_submit_result", isError: true, result: {details: {summary: "Claimed success", protocol: "private"}}});
 assert.match(ui.render(100).join("\n"), /Report submission failed · not host-validated/);
 store.finish("a", "cancelled");
 const text = ui.render(100).join("\n"); assert.match(text, /Unfinished: Read one/); assert.doesNotMatch(text, /→ Reading|private/); assert.match(text, /Run cancelled/);
 ui.dispose();
});

it("keeps the first executing call visible at the live tail of a normal-height inline panel", () => {
 const store = new LiveTranscriptStore();
 store.start({id: "a", role: "coder", profile: "typescript", task: "Work", phase: "running", startedAt: 0});
 store.ingest("a", {type: "message_end", message: {role: "assistant", content: Array.from({length: 30}, (_, i) => ({type: "toolCall", id: `call-${i}`, name: "read", arguments: {path: `file-${i}.ts`}}))}});
 store.ingest("a", {type: "tool_execution_start", toolCallId: "call-0", toolName: "read", args: {path: "file-0.ts"}});
 let capture: any;
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 24}}, {fg: (_: string, s: string) => s, inverse: (s: string) => s} as any, handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild", "• coder/typescript • running #1"], ["a"]);
 capture("\x1b[A"); capture("\x1b[C");
 try {
  const lines = panel.render(100).map(stripTerminalSequences);
  assert.match(lines.join("\n"), /Current: → Reading file-0.ts/);
  assert.match(lines.join("\n"), /Requested: Read file-29.ts/);
  assert.ok(lines.length <= 16); assert.ok(lines.every(line => visibleWidth(line) <= 100));
  capture("\x1b[H");
  const paused = panel.render(100).map(stripTerminalSequences).join("\n");
  assert.match(paused, /Reading file-0.ts[\s\S]*Requested: Read file-1.ts/);
  store.ingest("a", {type: "tool_execution_end", toolCallId: "call-29", result: {content: []}});
  assert.equal(panel.render(100).map(stripTerminalSequences).join("\n"), paused);
  capture("\x1b[F");
  assert.match(panel.render(100).join("\n"), /Current: → Reading file-0.ts/);
 } finally { panel.dispose(); store.dispose(); }
});

it("summarizes early parallel execution after later calls complete without expanding the live tail", () => {
 const store = new LiveTranscriptStore();
 store.start({id: "a", role: "coder", profile: "typescript", task: "Work", phase: "running", startedAt: 0});
 for (let i = 0; i < 30; i++) {
  store.ingest("a", {type: "tool_execution_start", toolCallId: `call-${i}`, toolName: "bash", args: {command: i === 0 ? "npm test\n\x1b[31m" + "界".repeat(100) : `command-${i}`}});
  if (i > 1) store.ingest("a", {type: "tool_execution_end", toolCallId: `call-${i}`, result: {content: [{type: "text", text: "raw result"}]}});
 }
 let capture: any;
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 24}}, {fg: (_: string, s: string) => s, inverse: (s: string) => s} as any, handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild", "• coder/typescript • running #1"], ["a"]);
 capture("\x1b[A"); capture("\x1b[C");
 try {
  const lines = panel.render(80).map(stripTerminalSequences);
  assert.match(lines.join("\n"), /Current \(2 executing\): → Running npm test/);
  assert.match(lines.join("\n"), /Command finished: command-29/);
  assert.equal(lines.filter(line => line.includes("Current")).length, 1);
  assert.ok(lines.length <= 16); assert.ok(lines.every(line => visibleWidth(line) <= 80));
  assert.doesNotMatch(lines.join("\n"), /\x1b|raw result|tests passed/);
  store.ingest("a", {type: "tool_execution_end", toolCallId: "call-1", result: {content: []}});
  assert.match(panel.render(80).join("\n"), /Current: → Running npm test/);
  capture("\t");
  assert.match(panel.render(80).join("\n"), /raw result/);
  assert.doesNotMatch(panel.render(80).join("\n"), /Current/);
  capture("\t"); store.finish("a", "cancelled");
  assert.doesNotMatch(panel.render(80).join("\n"), /Current|→ Running/);
  assert.match(panel.render(80).join("\n"), /Run cancelled/);
 } finally { panel.dispose(); store.dispose(); }
});
