import assert from "node:assert/strict";
import { it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { LiveTranscriptStore } from "../src/live-transcript.ts";
import { createLiveTranscriptInspector } from "../src/live-transcript-ui.ts";
const theme = { fg: (_: string, text: string) => text } as any;
// Layout-independent content assertion: ignore only the card's framing/padding.
const rowText = (row: string) => stripTerminalSequences(row).replace(/^[│╭╰] ?/, "").replace(/[│╮╯]$/, "").trimEnd();
const seek = (ui: ReturnType<typeof createLiveTranscriptInspector>, text: string, width = 80) => {
 ui.handleInput("\x1b[H");
 for (let i = 0; i < 100; i++) {
  if (rowText(ui.render(width)[1]) === text) return;
  ui.handleInput("tui.select.down");
 }
 assert.fail(`Missing scroll anchor: ${text}`);
};
const keys = { matches: (data: string, binding: string) => data === binding };
const start = (store: LiveTranscriptStore, id: string) => store.start({id, role: "coder", profile: "typescript", task: `Task ${id}`, phase: "queued", startedAt: 0});
it("keeps selected IDs through completion and eviction, then backs out without child cancellation", () => {
 const store = new LiveTranscriptStore({maxRecentRuns: 1}); start(store, "a"); start(store, "b");
 let closed = 0;
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 20}}, theme, keys, () => closed++);
 ui.handleInput("tui.select.down"); ui.handleInput("tui.select.confirm");
 assert.match(ui.render(80).join("\n"), /Task b/);
 store.finish("b", "failed", "failure detail");
 assert.match(ui.render(80).join("\n"), /failed/);
 assert.match(ui.render(80).join("\n"), /failure detail/);
 store.finish("a", "completed");
 assert.match(ui.render(80).join("\n"), /unavailable/);
 ui.handleInput("tui.select.cancel"); assert.equal(closed, 0);
 assert.match(ui.render(80).join("\n"), /b.*unavailable/);
 ui.handleInput("tui.select.cancel"); assert.equal(closed, 1);
 ui.handleInput("tui.select.cancel"); assert.equal(closed, 1); assert.deepEqual(ui.render(80), []);
});
it("wraps plain text/tools within responsive height and preserves manual scroll until End", () => {
 const store = new LiveTranscriptStore(); start(store, "a");
 const emit = (text: string) => store.ingest("a", {type: "message_end", message: {role: "assistant", content: [{type: "text", text}]}});
 emit(Array.from({length: 30}, (_, i) => `line ${i} 中文👨‍👩‍👧‍👦`).join("\n"));
 const tui = {requestRender() {}, terminal: {rows: 12}};
 const ui = createLiveTranscriptInspector(store, tui, theme, keys, () => {});
 ui.handleInput("tui.select.confirm");
 let lines = ui.render(40); assert.ok(lines.length <= 10); assert.match(lines.join("\n"), /line 29/);
 ui.handleInput("\x1b[H"); lines = ui.render(40); assert.match(lines.join("\n"), /line 0/); assert.match(lines.at(-1)!, /paused/);
 emit(Array.from({length: 35}, (_, i) => `line ${i} 中文`).join("\n"));
 assert.match(ui.render(40).join("\n"), /line 0/); assert.doesNotMatch(ui.render(40).join("\n"), /line 34/);
 ui.handleInput("\x1b[F"); assert.match(ui.render(40).join("\n"), /line 34/);
 store.ingest("a", {type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {path: "safe"}});
 store.ingest("a", {type: "tool_execution_end", toolCallId: "t", result: {content: [{type: "text", text: "result\x1b[31m\x07"}]}});
 assert.match(ui.render(80).join("\n"), /read.*completed/); assert.match(ui.render(80).join("\n"), /path.*safe/);
 for (const rows of [1, 2, 3, 6, 12]) for (const width of [0, 1, 2, 5, 20]) {
  tui.terminal.rows = rows; const output = ui.render(width);
  assert.ok(output.length <= Math.max(1, rows - 2)); assert.ok(output.every(line => visibleWidth(line) <= width));
 }
 ui.dispose();
});
it("coalesces updates to at most ten renders/second and removes subscription/timer on close", async () => {
 const store = new LiveTranscriptStore(); start(store, "a"); let renders = 0; let closes = 0; let subscriptions = 0;
 const subscribe = store.subscribe.bind(store);
 store.subscribe = listener => { subscriptions++; const off = subscribe(listener); return () => {subscriptions--; off();}; };
 const ui = createLiveTranscriptInspector(store, {requestRender() {renders++;}, terminal: {rows: 20}}, theme, keys, () => closes++);
 for (let i = 0; i < 100; i++) store.updatePhase("a", "running");
 assert.equal(renders, 0); await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(renders, 1);
 store.finish("a", "completed"); ui.close(); ui.close(); assert.equal(subscriptions, 0); assert.equal(closes, 1);
 await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(renders, 1);
 ui.handleInput("tui.select.confirm"); assert.equal(renders, 1);
});
it("selects fullscreen mouse rows by rendered ID, including a scrolled roster", () => {
 const store = new LiveTranscriptStore(); for (let i = 0; i < 12; i++) start(store, `id-${i}`);
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 10}}, theme, keys, () => {}, "id-10");
 const lines = ui.render(80); const row = lines.findIndex(line => line.includes("id-10")); assert.ok(row > 0);
 const event = {type: "click", button: "left", x: 2, y: row} as any;
 assert.deepEqual(ui.handleMouse!(event), {handled: true, focus: true, render: false});
 ui.handleInput("tui.select.confirm"); assert.match(ui.render(80).join("\n"), /Task id-10/); ui.close();
});
it("roster distinguishes same-role tasks with sanitized bounded previews before long IDs", () => {
 const store = new LiveTranscriptStore();
 for (const [id, task] of [["a".repeat(100), "First\n\x1b[31m task\x07"], ["b".repeat(100), "Second 中文 task " + "界".repeat(100)]]) {
  store.start({id, role: "coder", profile: "typescript", task, phase: "running", startedAt: 0});
 }
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 10}}, theme, keys, () => {});
 const lines = ui.render(120); const text = lines.join("\n");
 assert.match(text, /First task/); assert.match(text, /Second 中文 task/);
 assert.doesNotMatch(text, /\x1b\[31m|\x07|a{30}|b{30}/);
 assert.ok(lines.every(line => visibleWidth(line) <= 120));
 ui.handleMouse!({type: "click", button: "left", x: 2, y: 2} as any);
 ui.handleInput("tui.select.confirm"); assert.match(ui.render(80).join("\n"), /Second 中文 task/);
 ui.dispose();
});
it("roster reserves omission/truncation notices with no selected run and keeps click IDs exact", () => {
 const empty = new LiveTranscriptStore({maxRecentRuns: 0}); start(empty, "gone"); empty.finish("gone", "completed");
 const tui = {requestRender() {}, terminal: {rows: 8}};
 const ui = createLiveTranscriptInspector(empty, tui, theme, keys, () => {});
 assert.match(ui.render(80).join("\n"), /1 runs omitted\/evicted/);
 ui.dispose();
 const store = new LiveTranscriptStore({maxEntries: 0}); start(store, "first"); start(store, "second");
 store.ingest("first", {type: "message_end", message: {role: "assistant", content: [{type: "text", text: "omitted"}]}});
 const roster = createLiveTranscriptInspector(store, tui, theme, keys, () => {});
 let lines = roster.render(100); assert.match(lines.join("\n"), /1 transcripts truncated/);
 const row = lines.findIndex(line => line.includes("second")); assert.ok(row > 0);
 roster.handleMouse!({type: "click", button: "left", x: 0, y: row} as any);
 roster.handleInput("tui.select.confirm"); assert.match(roster.render(100).join("\n"), /Task second/);
 roster.handleInput("tui.select.cancel");
 for (const rows of [1, 2, 3, 4, 5, 8]) {
  tui.terminal.rows = rows;
  lines = roster.render(100);
  assert.ok(lines.length <= Math.max(1, rows - 2));
  assert.match(lines.join("\n"), /truncated/);
  assert.match(lines.at(-1)!, /Esc/);
  for (const width of [0, 1, 2, 5, 20]) assert.ok(roster.render(width).every(line => visibleWidth(line) <= width));
 }
 roster.dispose();
});

const append = (store: LiveTranscriptStore, text: string) => {
 store.ingest("a", {type: "message_start", message: {role: "assistant"}});
 store.ingest("a", {type: "message_end", message: {role: "assistant", content: [{type: "text", text}]}});
};
it("paused anchor survives preceding entry eviction", () => {
 const store = new LiveTranscriptStore({maxEntries: 3}); start(store, "a");
 append(store, "earlier"); append(store, "anchor\nsecond\nthird\nfourth\nfifth"); append(store, "later");
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 6}}, theme, keys, () => {}, "a", true);
 ui.render(80); ui.handleInput("\x1b[H"); ui.render(80);
 seek(ui, "anchor"); assert.equal(rowText(ui.render(80)[1]), "anchor");
 append(store, "newest");
 assert.equal(rowText(ui.render(80)[1]), "anchor");
 assert.match(ui.render(80).at(-1)!, /paused/); ui.dispose();
});
it("paused anchor survives logical line and character rewrapping", () => {
 const store = new LiveTranscriptStore(); start(store, "a");
 append(store, "prefix".repeat(8) + "\n" + "abcdefghijklmnopqrstuvwx" + "\ntail\ntail\ntail\ntail");
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 6}}, theme, keys, () => {}, "a", true);
 seek(ui, "mnopqrstuvwx", 16);
 assert.equal(rowText(ui.render(16)[1]), "mnopqrstuvwx");
 assert.equal(rowText(ui.render(10)[1]), "mnopqr");
 assert.equal(rowText(ui.render(28)[1]), "abcdefghijklmnopqrstuvwx");
 assert.equal(rowText(ui.render(10)[1]), "mnopqr"); ui.dispose();
});
it("evicted paused anchor reports loss at remaining start until End resumes live", () => {
 const store = new LiveTranscriptStore({maxEntries: 2}); start(store, "a");
 append(store, "old\nold2\nold3"); append(store, "remaining\nremaining2\nremaining3");
 const tui = {requestRender() {}, terminal: {rows: 6}};
 const ui = createLiveTranscriptInspector(store, tui, theme, keys, () => {}, "a", true);
 seek(ui, "old", 100); assert.equal(rowText(ui.render(100)[1]), "old");
 append(store, "new\nnew2\nnew3");
 let lines = ui.render(100); assert.equal(rowText(lines[1]), "Assistant");
 assert.match(lines.join("\n"), /remaining/);
 assert.match(lines.at(-1)!, /anchor evicted.*remaining start/); assert.doesNotMatch(lines.at(-1)!, /paused/);
 assert.match(ui.render(100).at(-1)!, /anchor evicted/);
 for (const rows of [1, 2, 3, 4, 6]) for (const width of [1, 2, 5, 20, 100]) {
  tui.terminal.rows = rows; lines = ui.render(width);
  assert.ok(lines.length <= Math.max(1, rows - 2)); assert.ok(lines.every(line => visibleWidth(line) <= width));
  if (width === 100) assert.match(lines.at(-1)!, /anchor evicted/);
 }
 tui.terminal.rows = 6; ui.handleInput("\x1b[F");
 lines = ui.render(100); assert.match(rowText(lines.at(-1)!), /^live/); assert.match(lines.join("\n"), /new3/);
 append(store, "latest\nlatest2\nlatest3"); assert.match(ui.render(100).join("\n"), /latest3/);
 ui.dispose();
});
it("captures pause against the last rendered content before an intervening eviction and resets on selection", () => {
 const store = new LiveTranscriptStore({maxEntries: 3}); start(store, "a"); start(store, "b");
 append(store, "earlier"); append(store, "anchor\nsecond\nthird"); append(store, "later");
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 6}}, theme, keys, () => {}, "a", true);
 seek(ui, "Assistant");
 // Move to the second entry's text using its last displayed layout.
 for (let i = 0; i < 3; i++) { ui.handleInput("tui.select.down"); ui.render(80); }
 ui.handleInput("tui.select.down"); // No render before the store update.
 append(store, "newest");
 assert.equal(rowText(ui.render(80)[1]), "anchor");
 ui.handleInput("tui.select.cancel"); ui.handleInput("tui.select.down"); ui.handleInput("tui.select.confirm");
 assert.match(rowText(ui.render(80).at(-1)!), /^live/);
 assert.match(ui.render(80)[0], /coder\/typescript/);
 ui.dispose();
});

it("renders an opaque padded bounded Guild inspector with short title and plain hierarchical data", () => {
 const store = new LiveTranscriptStore();
 store.start({id: "a", role: "coder", profile: "typescript", task: "LONG_TASK " + "界".repeat(200), phase: "running", startedAt: 0});
 append(store, "Assistant text\n\n中文 👨‍👩‍👧‍👦");
 store.ingest("a", {type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {path: "safe"}});
 store.ingest("a", {type: "tool_execution_end", toolCallId: "t", result: {content: [{type: "text", text: "# not markdown\n\x1b]52;c;SECRET\x07safe output"}]}});
 const tui = {requestRender() {}, terminal: {rows: 24}};
 const ui = createLiveTranscriptInspector(store, tui, theme, keys, () => {}, "a", true);
 const lines = ui.render(400);
 assert.equal(visibleWidth(lines[0]), 108);
 assert.match(lines[0], /╭.*Guild.*coder\/typescript.*running.*╮/);
 assert.doesNotMatch(lines[0], /LONG_TASK/);
 assert.match(lines[1], /Task · LONG_TASK/);
 assert.match(lines.join("\n"), /Assistant\n|Assistant .*│/);
 assert.match(lines.join("\n"), /Tool · read · completed/);
 assert.match(lines.join("\n"), /Input ·/); assert.match(lines.join("\n"), /Output ·/);
 assert.doesNotMatch(lines.join("\n"), /SECRET/);
 assert.ok(lines.every(line => line.startsWith("\x1b[48;2;45;37;56m") && visibleWidth(line) === 108));
 assert.ok(lines.some(line => /│ +│/.test(line)), "blank rows are also padded and opaque");
 for (const rows of [1, 2, 3, 4, 6, 10, 24]) for (const width of [1, 2, 4, 5, 9, 20, 108, 400]) {
  tui.terminal.rows = rows;
  const output = ui.render(width);
  assert.ok(output.length <= Math.max(1, rows - 2));
  assert.ok(output.every(line => visibleWidth(line) <= Math.min(width, 108)));
  assert.ok(output.every(line => line.startsWith("\x1b[48;2;45;37;56m")));
 }
 ui.dispose();
});
it("labels assistant and ordinary tool input/output separately from an internal submission", () => {
 const store = new LiveTranscriptStore(); start(store, "a"); append(store, "hello");
 store.ingest("a", {type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {path: "safe"}});
 store.ingest("a", {type: "tool_execution_end", toolCallId: "t", result: {content: [{type: "text", text: "done"}]}});
 store.ingest("a", {type: "tool_execution_end", toolCallId: "r", toolName: "guild_submit_result", result: {details: {summary: "Fixed card"}}});
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 24}}, theme, keys, () => {}, "a", true);
 const text = ui.render(108).join("\n");
 assert.match(text, /Assistant/); assert.match(text, /Tool · read/); assert.match(text, /Input ·/); assert.match(text, /Output ·/);
 assert.match(text, /Submission/); assert.match(text, /Report submitted/); assert.doesNotMatch(text, /guild_submit_result.*completed/);
 ui.dispose();
});
it("preserves narrow Unicode tool output as sanitized plain text rather than markdown", () => {
 const store = new LiveTranscriptStore(); start(store, "a");
 const text = "中文界中文界中文界中文界";
 store.ingest("a", {type: "tool_execution_end", toolCallId: "t", toolName: "read", result: {content: [{type: "text", text: text + "\x1b]52;c;secret\x07"}]}});
 const ui = createLiveTranscriptInspector(store, {requestRender() {}, terminal: {rows: 26}}, theme, keys, () => {}, "a", true);
 const lines = ui.render(12);
 assert.ok(lines.every(line => visibleWidth(line) === 12));
 assert.equal(lines.map(rowText).join("").replace(/[^中文界]/g, ""), text);
 assert.doesNotMatch(lines.join("\n"), /secret/);
 ui.dispose();
});
it("keeps the back control visible on a narrow terminal even after anchor eviction", () => {
 const store = new LiveTranscriptStore({maxEntries: 1}); start(store, "a"); append(store, "old\nold2\nold3");
 const tui = {requestRender() {}, terminal: {rows: 6}};
 const ui = createLiveTranscriptInspector(store, tui, theme, keys, () => {}, "a", true);
 seek(ui, "old"); append(store, "new\nnew2\nnew3"); ui.render(80);
 for (const rows of [3, 4, 6, 12]) {
  tui.terminal.rows = rows;
  assert.match(rowText(ui.render(20).at(-1)!), /Esc back/);
 }
 ui.dispose();
});
