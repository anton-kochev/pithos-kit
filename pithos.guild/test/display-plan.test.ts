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
 assert.match(text, /✓ Read src\/a.ts[\s\S]*→ Running tests\./);
 assert.doesNotMatch(text, /secret raw output|"path"|full-private-id/);
 ui.handleInput("\t"); ui.handleInput("\x1b[H");
 text = ui.render(100).join("\n");
 assert.match(text, /full-private-id/); assert.match(text, /secret raw output/); assert.match(text, /"path"/);
 ui.handleInput("\t");
 store.ingest("full-private-id", {type: "tool_execution_end", toolCallId: "b", isError: true, result: {content: []}});
 assert.match(ui.render(100).join("\n"), /✗ Failed to run tests\./);
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
it("renders unknown tools generically with malformed arguments and advertises details at normal widths", () => {
 const store = new LiveTranscriptStore();
 store.start({id: "a", role: "coder", profile: "typescript", task: "Task", phase: "running", startedAt: 0});
 store.ingest("a", {type: "tool_execution_start", toolCallId: "odd", toolName: "constructor", args: "not json"});
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 24}}, {fg: (_: string, s: string) => s} as any, {matches: (a: string, b: string) => a === b}, () => {}, "a", true);
 assert.match(ui.render(80).join("\n"), /→ Using a tool\./);
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
  assert.match(lines.join("\n"), /→ Reading file-0.ts/);
  assert.match(lines.join("\n"), /Requested: Read file-29.ts/);
  assert.ok(lines.length <= 16); assert.ok(lines.every(line => visibleWidth(line) <= 100));
  capture("\x1b[H");
  const paused = panel.render(100).map(stripTerminalSequences).join("\n");
  assert.match(paused, /Requested: Read file-1.ts[\s\S]*Reading file-0.ts/);
  store.ingest("a", {type: "tool_execution_end", toolCallId: "call-29", result: {content: []}});
  assert.equal(panel.render(100).map(stripTerminalSequences).join("\n"), paused);
  capture("\x1b[F");
  assert.match(panel.render(100).join("\n"), /→ Reading file-0.ts/);
 } finally { panel.dispose(); store.dispose(); }
});

it("groups early parallel execution after later calls complete without expanding the live tail", () => {
 const store = new LiveTranscriptStore();
 store.start({id: "a", role: "coder", profile: "typescript", task: "Work", phase: "running", startedAt: 0});
 for (let i = 0; i < 30; i++) {
  store.ingest("a", {type: "tool_execution_start", toolCallId: `call-${i}`, toolName: "bash", args: {command: i === 0 ? "npm test" : i === 1 ? "opaque\n\x1b[31m" + "界".repeat(100) : `command-${i}`}});
  if (i > 1) store.ingest("a", {type: "tool_execution_end", toolCallId: `call-${i}`, result: {content: [{type: "text", text: "raw result"}]}});
 }
 let capture: any;
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 24}}, {fg: (_: string, s: string) => s, inverse: (s: string) => s} as any, handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild", "• coder/typescript • running #1"], ["a"]);
 capture("\x1b[A"); capture("\x1b[C");
 try {
  const lines = panel.render(80).map(stripTerminalSequences);
  assert.match(lines.join("\n"), /→ Running tests\./);
  assert.match(lines.join("\n"), /Finished shell command: command-/);
  assert.equal(lines.filter(line => line.includes("Running tests.")).length, 1);
  assert.equal(lines.filter(line => line.includes("Running shell command: opaque")).length, 1);
  assert.doesNotMatch(lines.join("\n"), /Current/);
  assert.ok(lines.length <= 16); assert.ok(lines.every(line => visibleWidth(line) <= 80));
  assert.doesNotMatch(lines.join("\n"), /\x1b|raw result|tests passed/);
  store.ingest("a", {type: "tool_execution_end", toolCallId: "call-1", result: {content: []}});
  assert.match(panel.render(80).join("\n"), /→ Running tests\./);
  capture("\t");
  assert.match(panel.render(80).join("\n"), /raw result/);
  assert.doesNotMatch(panel.render(80).join("\n"), /Current/);
  capture("\t"); store.finish("a", "cancelled");
  assert.doesNotMatch(panel.render(80).join("\n"), /Current|→ Running/);
  assert.match(panel.render(80).join("\n"), /Run cancelled/);
 } finally { panel.dispose(); store.dispose(); }
});

// Description test list: common shell work; file actions; opaque/conditional commands;
// lifecycle wording and raw recovery (existing navigation/geometry tests remain in place).
it("describes compound inspection completion without claiming early failed subcommands succeeded", () => {
 const store = new LiveTranscriptStore();
 store.start({id: "descriptions", role: "coder", profile: "typescript", task: "Work", phase: "running", startedAt: 0});
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 40}}, {fg: (_: string, s: string) => s} as any, {matches: (a: string, b: string) => a === b}, () => {}, "descriptions", true);
 const command = "cat AGENTS.md; git status --short; cat package.json";
 store.ingest("descriptions", {type: "tool_execution_start", toolCallId: "inspect", toolName: "bash", args: {command}});
 assert.match(ui.render(160).join("\n"), /Inspecting repository instructions, the working tree, and package metadata\./);
 // A semicolon list exits successfully when the final cat succeeds, even if earlier commands fail.
 store.ingest("descriptions", {type: "tool_execution_end", toolCallId: "inspect", isError: false, result: {content: [{type: "text", text: 'cat: AGENTS.md: No such file or directory\nfatal: not a git repository\n{"name":"fixture"}'}]}});
 assert.match(ui.render(160).join("\n"), /Finished inspection commands\./);
 assert.doesNotMatch(ui.render(160).join("\n"), /Inspected repository instructions|Inspected the working tree/);
 assert.doesNotMatch(ui.render(160).join("\n"), /cat AGENTS|git status|Command finished/);
 ui.handleInput("\t");
 assert.ok(ui.render(160).join("\n").includes(command));
 ui.dispose(); store.dispose();
});

it("uses bounded honest descriptions for file work, checks, and opaque commands", () => {
 const cases: [string, unknown, string, string][] = [
  ["read", {path: "test/display-plan.test.ts", intent: "Not a shell label"}, "Reading tests in test/display-plan.test.ts.", "Read tests in test/display-plan.test.ts."],
  ["edit", {path: "src/live-transcript-ui.ts"}, "Updating src/live-transcript-ui.ts.", "Updated src/live-transcript-ui.ts."],
  ["write", {path: "test/colors.test.ts"}, "Writing tests in test/colors.test.ts.", "Wrote tests in test/colors.test.ts."],
  ["grep", {pattern: "height", path: "test"}, "Searching file contents in test.", "Searched file contents in test."],
  ["bash", {command: "npm test"}, "Running tests.", "Finished running tests."],
  ["bash", {command: "npm test", intent: " \n\x1b[31m"}, "Running tests.", "Finished running tests."],
  ["bash", {command: "npm test", intent: 42}, "Running tests.", "Finished running tests."],
  ["bash", {command: "npm test", intent: "Inspect " + "x".repeat(100)}, "Inspect " + "x".repeat(71) + "…", "Finished: Inspect " + "x".repeat(71) + "…"],
  ["bash", {command: "npm run typecheck"}, "Running the type check.", "Finished running the type check."],
  ["git_read", {subcommand: "status"}, "Checking the working tree.", "Checked the working tree."],
  ["git_read", {subcommand: "log"}, "Inspecting commit history.", "Inspected commit history."],
  ["bash", {command: "ls -la"}, "Listing files.", "Listed files."],
  ["bash", {command: "cat " + "a".repeat(200)}, "Reading " + "a".repeat(79) + "….", "Read " + "a".repeat(79) + "…."],
  ["bash", {command: "cat README.md"}, "Reading README.md.", "Read README.md."],
  ["bash", {command: "git log --oneline -5"}, "Inspecting commit history.", "Inspected commit history."],
  ["bash", {command: "git diff --stat"}, "Inspecting changes.", "Inspected changes."],
  ["bash", {command: "cat src/panel.ts"}, "Reading src/panel.ts.", "Read src/panel.ts."],
  ["bash", {command: "custom-secret --token hidden"}, "Running shell command: custom-secret --token hidden", "Finished shell command: custom-secret --token hidden"],
  ["bash", {command: "false && npm test"}, "Running shell command: false && npm test", "Finished shell command: false && npm test"],
  ["bash", {command: "echo 'npm test'; cat AGENTS.md"}, "Running shell command: echo 'npm test'; cat AGENTS.md", "Finished shell command: echo 'npm test'; cat AGENTS.md"],
  ["bash", {command: "cat $(evil)"}, "Running shell command: cat $(evil)", "Finished shell command: cat $(evil)"],
  ["constructor", "malformed", "Using a tool.", "Finished a tool call."],
 ];
 for (const [toolName, args, running, completed] of cases) {
  const store = new LiveTranscriptStore();
  store.start({id: "a", role: "coder", profile: "typescript", task: "Work", phase: "running", startedAt: 0});
  const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 40}}, {fg: (_: string, s: string) => s} as any, {matches: (a: string, b: string) => a === b}, () => {}, "a", true);
  store.ingest("a", {type: "tool_execution_start", toolCallId: "one", toolName, args});
  assert.ok(ui.render(120).join("\n").includes(`→ ${running}`), running);
  store.ingest("a", {type: "tool_execution_end", toolCallId: "one", result: {content: [{type: "text", text: "private output"}]}});
  const text = ui.render(120).join("\n");
  assert.ok(text.includes(`✓ ${completed}`), completed);
  assert.doesNotMatch(text, /private output|tests passed/);
  ui.dispose(); store.dispose();
 }
});

it("groups executing actions once below history and moves finished calls into history", () => {
 const store = new LiveTranscriptStore();
 store.start({id: "a", role: "coder", profile: "typescript", task: "Work", phase: "running", startedAt: 0});
 const tui = {requestRender() {}, terminal: {rows: 20}};
 const ui = createLiveTranscriptInspector(store, tui, {fg: (_: string, s: string) => s} as any, {matches: (a: string, b: string) => a === b}, () => {}, "a", true);
 for (const id of ["first", "second", "done"]) store.ingest("a", {type: "tool_execution_start", toolCallId: id, toolName: "read", args: {path: id}});
 store.ingest("a", {type: "tool_execution_end", toolCallId: "done", result: {content: []}});
 store.ingest("a", {type: "message_end", message: {role: "assistant", content: [{type: "toolCall", id: "pending", name: "read", arguments: {path: "later"}}]}});
 let text = ui.render(100).map(stripTerminalSequences).join("\n");
 assert.match(text, /✓ Read done\.[\s\S]*Requested: Read later\.[\s\S]*→ Reading first\.[\s\S]*→ Reading second\./);
 assert.equal(text.match(/Reading first/g)?.length, 1); assert.equal(text.match(/Reading second/g)?.length, 1);
 assert.doesNotMatch(text, /Current/);
 ui.handleInput("\x1b[H");
 store.ingest("a", {type: "tool_execution_end", toolCallId: "first", result: {content: []}});
 text = ui.render(100).map(stripTerminalSequences).join("\n");
 assert.match(text, /✓ Read done/); // Paused history stays anchored, despite insertion before it.
 assert.doesNotMatch(text, /Reading first/);
 ui.handleInput("\x1b[F");
 text = ui.render(100).map(stripTerminalSequences).join("\n");
 assert.match(text, /✓ Read first\.[\s\S]*✓ Read done\.[\s\S]*→ Reading second\./);
 for (let i = 0; i < 15; i++) store.ingest("a", {type: "tool_execution_start", toolCallId: `many-${i}`, toolName: "read", args: {path: `many-${i}`}});
 for (const rows of [4, 6, 10]) {
  tui.terminal.rows = rows;
  const lines = ui.render(50).map(stripTerminalSequences);
  assert.ok(lines.length <= Math.max(2, rows - 2));
  assert.ok(lines.every(line => visibleWidth(line) <= 50));
  if (rows >= 6) assert.match(lines.join("\n"), /more executing/);
 }
 ui.handleInput("\t"); tui.terminal.rows = 40; ui.handleInput("\x1b[H");
 assert.match(ui.render(100).join("\n"), /Run ID: a/);
 assert.doesNotMatch(ui.render(100).join("\n"), /more executing/);
 ui.dispose(); store.dispose();
});

it("shows shell intent without converting completion into verified intent and retains raw commands", () => {
 const store = new LiveTranscriptStore();
 store.start({id: "intent", role: "coder", profile: "general", task: "Work", phase: "running", startedAt: 0});
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 40}}, {fg: (_: string, text: string) => text} as any, {matches: (a: string, b: string) => a === b}, () => {}, "intent", true);
 const args = {command: "printf raw-command; exit 0", intent: "  Run\n\x1b[31m AppHost cleanup tests  "};
 const render = () => ui.render(120).join("\n");
 try {
  store.ingest("intent", {type: "message_end", message: {role: "assistant", content: [{type: "toolCall", id: "b", name: "bash", arguments: args}]}});
  assert.match(render(), /○ Requested: Run AppHost cleanup tests/);
  store.ingest("intent", {type: "tool_execution_start", toolCallId: "b", toolName: "bash", args});
  assert.match(render(), /→ Run AppHost cleanup tests/);
  assert.doesNotMatch(render(), /raw-command|Requested:/);
  store.ingest("intent", {type: "tool_execution_end", toolCallId: "b", result: {content: []}});
  assert.match(render(), /✓ Finished: Run AppHost cleanup tests/);
  assert.doesNotMatch(render(), /raw-command|tests passed/);
  ui.handleInput("\t"); ui.handleInput("\x1b[H");
  assert.match(render(), /printf raw-command; exit 0/);
  ui.handleInput("\t");
  store.ingest("intent", {type: "tool_execution_start", toolCallId: "fail", toolName: "bash", args: {...args, command: "exit 7"}});
  store.ingest("intent", {type: "tool_execution_end", toolCallId: "fail", isError: true, result: {content: []}});
  assert.match(render(), /✗ Failed: Run AppHost cleanup tests/);
 } finally { ui.dispose(); store.dispose(); }
});

it("keeps the shell intent visible when the raw arguments exceed the transcript limit", () => {
 const store = new LiveTranscriptStore({maxStringBytes: 128});
 store.start({id: "long-command", role: "coder", profile: "general", task: "Work", phase: "running", startedAt: 0});
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 40}}, {fg: (_: string, text: string) => text} as any, {matches: (a: string, b: string) => a === b}, () => {}, "long-command", true);
 try {
  store.ingest("long-command", {type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: {command: "printf " + "a".repeat(200), intent: "Check generated output"}});
  assert.equal(store.get("long-command")?.truncated, true);
  assert.match(ui.render(100).join("\n"), /Check generated output/);
  store.ingest("long-command", {type: "tool_execution_end", toolCallId: "b", result: {content: []}});
  assert.match(ui.render(100).join("\n"), /Check generated output/);
 } finally { ui.dispose(); store.dispose(); }
});
