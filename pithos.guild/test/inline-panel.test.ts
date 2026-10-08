import assert from "node:assert/strict";
import { it } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createInlineGuildPanel } from "../src/inline-panel.ts";
import { LiveTranscriptStore } from "../src/live-transcript.ts";
const inverse = (text: string) => `\x1b[7m${text}\x1b[27m`;
const theme = {fg: (_: string, text: string) => text, inverse} as any;
const start = (store: LiveTranscriptStore, id: string) => store.start({id, role: "coder", profile: "typescript", task: id, phase: "running", startedAt: 0});
it("uses the full available width for inline detail and rewraps on resize", () => {
 const store = new LiveTranscriptStore(); start(store, "wide");
 const text = "界".repeat(70) + " tail";
 store.ingest("wide", {type: "message_end", message: {role: "assistant", content: [{type: "text", text}]}});
 let capture: any;
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 40}}, theme,
  handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild · 1 active", "⏳ coder/typescript · running · wide"], ["wide"]);
 capture("\x1b[A"); capture("\r");
 for (const width of [200, 80, 320]) {
  const output = panel.render(width).map(stripTerminalSequences);
  const top = output.findIndex(line => line.startsWith("╭"));
  const bottom = output.findIndex(line => line.startsWith("╰"));
  assert.ok(top >= 0 && bottom > top);
  assert.ok(output.slice(top, bottom + 1).every(line => visibleWidth(line) === width), `detail must fill ${width} columns`);
  assert.ok(output.every(line => visibleWidth(line) <= width));
  if (width > 108) assert.ok(output.some(line => line.includes(text)), "wide detail must not wrap at the old cap");
 }
 panel.dispose();
});

it("removes terminal eviction, leaves neighboring runs collapsed, and bounds tiny Unicode inline geometry", () => {
 const store = new LiveTranscriptStore({maxRecentRuns: 0}); start(store, "中文🧪"); start(store, "neighbor");
 let capture: any; let listeners = 0;
 const tui = {requestRender() {}, terminal: {rows: 24}};
 const panel = createInlineGuildPanel(store, tui, theme, handler => {capture = handler; listeners++; return () => {listeners--;};}, () => {}, () => "", () => true);
 panel.update(["Guild · 2 active", "⏳ coder/typescript · running · 0s · 中文🧪", "⏳ coder/typescript · running · 0s · neighbor"], ["中文🧪", "neighbor"]);
 capture("\x1b[A"); capture("\x1b[A"); capture("\r");
 const expanded = panel.render(80);
 assert.match(expanded.join("\n"), /Task · 中文🧪/); assert.doesNotMatch(expanded.join("\n"), /F6|inspector/);
 // Detail should advertise expansion/navigation rather than duplicate a modal list.
 assert.match(expanded[1], /← collapse/);
 assert.match(expanded[2], /\x1b\[7m● coder\/typescript\x1b\[27m/);
 store.finish("中文🧪", "completed");
 panel.update(["Guild · 1 active", "⏳ coder/typescript · running · 0s · neighbor"], ["neighbor"]);
 assert.doesNotMatch(panel.render(80).join("\n"), /unavailable|中文🧪|Task ·/);
 assert.doesNotMatch(panel.render(80).join("\n"), /Task · neighbor/);
 for (const rows of [1, 2, 3, 4, 6, 10, 24]) for (const width of [0, 1, 2, 4, 5, 10, 20, 108, 200]) {
  tui.terminal.rows = rows;
  const output = panel.render(width);
  assert.ok(output.length <= Math.max(1, Math.min(24, Math.floor(rows / 2))));
  assert.ok(output.every(line => visibleWidth(line) <= width));
  assert.doesNotMatch(output.join("\n"), /F6/);
 }
 capture("\x1b"); capture("\x1b"); assert.equal(listeners, 1);
 assert.equal(panel.navigating, false);
 panel.dispose(); assert.deepEqual(panel.render(80), []);
});
it("marks the selected row with real ANSI themes, not just unstyled fixtures", () => {
 const store = new LiveTranscriptStore(); start(store, "a");
 let capture: any;
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 24}},
  {fg: (_: string, text: string) => `\x1b[32m${text}\x1b[39m`, inverse} as any, handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild · 1 active", "⏳ coder/typescript · running · 0s"], ["a"]);
 capture("\x1b[A"); assert.match(panel.render(80)[2], /\x1b\[7m.*coder\/typescript.*\x1b\[27m/); panel.dispose();
});

// Behavior list: nearest activation, draft/history passthrough, bottom boundary,
// Esc back/release, typing passthrough, ownership transitions, observer lifecycle.
it("activates only empty eligible editors at the nearest row and consumes the bottom boundary once", () => {
 const store = new LiveTranscriptStore(); start(store, "first"); start(store, "last");
 let capture: any; let listeners = 0; let registrations = 0; let draft = ""; let eligible = true;
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 35}}, theme,
  handler => {capture = handler; listeners++; registrations++; return () => {listeners--;};}, () => {}, () => draft, () => eligible);
 panel.update(["Guild · 2 active", "⏳ coder/typescript · running · first", "⏳ coder/typescript · queued · last"], ["first", "last"]);
 assert.equal(listeners, 1); assert.equal(panel.navigating, false);
 for (const text of ["draft", " ", "\n", " \n"]) {
  draft = text;
  assert.equal(capture("\x1b[A"), undefined); assert.equal(capture("\x1b[B"), undefined);
  assert.equal(draft, text); assert.equal(panel.navigating, false);
 }
 draft = ""; eligible = false; assert.equal(capture("\x1b[A"), undefined);
 eligible = true; assert.equal(capture("\x1b[B"), undefined);
 assert.deepEqual(capture("\x1b[A"), {consume: true});
 assert.match(panel.render(100).find(line => line.includes("last"))!, /\x1b\[7m○ coder\/typescript\x1b\[27m/);
 assert.doesNotMatch(panel.render(100).find(line => line.includes("first"))!, /\x1b\[7m/);
 assert.deepEqual(capture("\r"), {consume: true}); assert.match(panel.render(100).join("\n"), /Task · last/);
 assert.deepEqual(capture("\x1b[A"), {consume: true}); // detail scroll, not roster selection
 assert.deepEqual(capture("\x1b"), {consume: true});
 assert.deepEqual(capture("\x1b[B"), {consume: true}); assert.equal(panel.navigating, false);
 assert.equal(capture("\x1b[B"), undefined);
 capture("\x1b[A"); capture("\x1b[A");
 assert.match(panel.render(100).find(line => line.includes("first"))!, /\x1b\[7m● coder\/typescript\x1b\[27m/);
 assert.doesNotMatch(panel.render(100).find(line => line.includes("last"))!, /\x1b\[7m/);
 assert.equal(capture("x"), undefined); assert.equal(panel.navigating, false);
 assert.doesNotMatch(panel.render(100).join("\n"), /\x1b\[7m/);
 capture("\x1b[A"); eligible = false;
 assert.equal(capture("\x1b"), undefined); assert.equal(panel.navigating, false);
 eligible = true; capture("\x1b[A"); draft = " ";
 assert.equal(capture("\x1b[B"), undefined); assert.equal(panel.navigating, false);
 draft = ""; capture("\x1b[A"); capture("\x1b");
 panel.update(["Guild · 0 active"], []); assert.equal(capture("\x1b[A"), undefined);
 assert.equal(registrations, 1); assert.equal(listeners, 1);
 panel.dispose(); assert.equal(listeners, 0); assert.equal(capture("\x1b[A"), undefined);
});
it("reactivates at the nearest row without showing another row's retained detail", () => {
 const store = new LiveTranscriptStore(); start(store, "first"); start(store, "last"); let capture: any;
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 35}}, theme,
  handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild · 2 active", "⏳ coder/typescript · running · first", "⏳ coder/typescript · queued · last"], ["first", "last"]);
 capture("\x1b[A"); capture("\x1b[A"); capture("\r");
 assert.match(panel.render(100).join("\n"), /Task · first/);
 capture("x"); capture("\x1b[A"); capture("\r");
 assert.match(panel.render(100).join("\n"), /Task · last/);
 assert.doesNotMatch(panel.render(100).join("\n"), /Task · first/); panel.dispose();
});

it("Right opens one session idempotently and Left collapses without cancelling or releasing selection", () => {
 const store = new LiveTranscriptStore(); start(store, "first"); start(store, "last");
 let capture: any; let subscriptions = 0; let peak = 0;
 const subscribe = store.subscribe.bind(store);
 store.subscribe = listener => { subscriptions++; peak = Math.max(peak, subscriptions); const off = subscribe(listener); return () => {subscriptions--; off();}; };
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 48}}, theme,
  handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild · 2 active", "⏳ coder/typescript · running · first", "⏳ coder/typescript · running · last"], ["first", "last"]);
 capture("\x1b[A"); assert.deepEqual(capture("\x1b[D"), {consume: true}); assert.equal(panel.navigating, true);
 assert.deepEqual(capture("\x1b[C"), {consume: true}); assert.equal(subscriptions, 1);
 capture("\x1b[H"); const paused = panel.render(120);
 capture("\x1b[C"); capture("\r"); assert.deepEqual(panel.render(120), paused); assert.equal(subscriptions, 1);
 // A click on the row after the inserted session must replace, not stack, detail.
 const row = paused.findIndex(line => line.includes("first")); assert.ok(row >= 0);
 panel.handleMouse!({type: "click", button: "left", x: 2, y: row} as any);
 const switched = panel.render(120); assert.match(switched.join("\n"), /Task · first/); assert.doesNotMatch(switched.join("\n"), /Task · last/);
 panel.handleMouse!({type: "click", button: "left", x: 2, y: switched.findIndex(line => line.includes("last"))} as any);
 assert.match(panel.render(120).join("\n"), /Task · last/); assert.equal(peak, 1);
 capture("\x1b[D"); assert.equal(subscriptions, 0); assert.equal(panel.navigating, true);
 assert.doesNotMatch(panel.render(120).join("\n"), /Task ·/);
 assert.equal(store.get("first")?.phase, "running"); assert.equal(store.get("last")?.phase, "running");
 capture("\x1b[C"); capture("\x1b"); assert.equal(subscriptions, 0); assert.equal(panel.navigating, true);
 capture("\x1b"); assert.equal(panel.navigating, false); panel.dispose(); assert.equal(subscriptions, 0);
});
it("separates inline sessions with opaque breathing room, padded sections and a reserved collapse footer", () => {
 const store = new LiveTranscriptStore(); start(store, "first"); start(store, "last");
 store.ingest("first", {type: "message_end", message: {role: "assistant", content: [{type: "text", text: Array.from({length: 40}, (_, i) => `line ${i} 中文🧪`).join("\n")}]}});
 let capture: any;
 const tui = {requestRender() {}, terminal: {rows: 48}};
 const ansiTheme = {fg: (_: string, text: string) => `\x1b[32m${text}\x1b[39m`, inverse, name: "light", getColorMode: () => "256color"} as any;
 const panel = createInlineGuildPanel(store, tui, ansiTheme, handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild · 2 active", "⏳ coder/typescript · running · first", "⏳ coder/typescript · running · last"], ["first", "last"]);
 capture("\x1b[A"); capture("\x1b[A"); capture("\r");
 const output = panel.render(100); const plain = output.map(stripTerminalSequences);
 const selected = output.findIndex(line => line.includes("\x1b[7m")); const title = plain.findIndex(line => /╭.*Session/.test(line));
 assert.equal(title, selected + 2, "opaque gap before session delimiter"); assert.equal(plain[selected + 1].trim(), "");
 assert.match(plain[title], /╭─.*✦ Session.*─╮/); assert.doesNotMatch(plain[title], /coder\/typescript|running/);
 assert.match(plain[title + 1], /^│  Task · first/); assert.match(plain[title + 2], /^├─.*Transcript.*─┤/);
 const footer = plain.findIndex(line => line.includes("← collapse") && line.includes("live")); assert.ok(footer > title);
 assert.match(plain[footer - 1], /^│ +│$/); assert.match(plain[footer], /^╰─.*← collapse.*─╯/);
 assert.ok(output.slice(selected + 1, footer + 1).every(line => line.startsWith("\x1b[48;5;189m") && visibleWidth(line) === 100));
 const other = plain.findIndex(line => line.includes("last")); assert.ok(other > footer);
 panel.handleMouse!({type: "click", button: "left", x: 2, y: other} as any);
 assert.match(panel.render(100).join("\n"), /Task · last/); assert.doesNotMatch(panel.render(100).join("\n"), /Task · first/);
 for (const rows of [1, 2, 4, 6, 8, 10, 12, 20, 48]) for (const width of [1, 2, 4, 6, 10, 20, 100, 200]) {
  tui.terminal.rows = rows; const lines = panel.render(width);
  assert.ok(lines.length <= Math.max(1, Math.min(24, Math.floor(rows / 2))));
  assert.ok(lines.every(line => visibleWidth(line) <= width));
  if (width >= 20) assert.match(lines.join("\n"), /← collapse/, `${rows} rows keep collapse control`);
 }
 panel.dispose();
});

// Pins for the retained content-anchor contract and real Pi color implementation.
it("inline paused anchors survive resize/preceding eviction and repeated Right; End follows", () => {
 const store = new LiveTranscriptStore({maxEntries: 3}); start(store, "a");
 const append = (text: string) => {
  store.ingest("a", {type: "message_start", message: {role: "assistant"}});
  store.ingest("a", {type: "message_end", message: {role: "assistant", content: [{type: "text", text}]}});
 };
 append("earlier"); append(Array.from({length: 40}, (_, i) => `anchor ${i} 中文`).join("\n")); append("later");
 let capture: any;
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 48}}, theme,
  handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild · 1 active", "⏳ coder/typescript · running · a"], ["a"]);
 capture("\x1b[A"); capture("\x1b[C"); panel.render(100); capture("\x1b[H");
 const firstBody = (width: number) => {
  const lines = panel.render(width).map(stripTerminalSequences);
  return lines[lines.findIndex(line => line.includes("Transcript")) + 1].replace(/^│ +/, "").replace(/ +│$/, "");
 };
 for (let i = 0; firstBody(100) !== "anchor 0 中文" && i < 20; i++) capture("\x1b[B");
 assert.equal(firstBody(100), "anchor 0 中文");
 append("newest"); assert.equal(firstBody(100), "anchor 0 中文");
 assert.equal(firstBody(40), "anchor 0 中文"); assert.equal(firstBody(200), "anchor 0 中文");
 const paused = panel.render(100); capture("\x1b[C"); assert.deepEqual(panel.render(100), paused);
 capture("\x1b[F"); assert.match(panel.render(100).join("\n"), /newest/);
 append("latest"); assert.match(panel.render(100).join("\n"), /latest/); panel.dispose();
});
it("renders a uniformly colored selected identity and opaque session with actual Pi Theme ANSI in light/dark modes", () => {
 const colors = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url), "utf8")).colors;
 for (const name of ["light", "dark"]) for (const mode of ["truecolor", "256color"] as const) {
  const palette = Object.fromEntries(Object.keys(colors).map(key => [key, name === "light" ? "#303030" : "#dddddd"]));
  const realTheme = new Theme(palette as any, {...palette, toolPendingBg: name === "light" ? "#eeeeee" : "#222222"} as any, mode, {name});
  const store = new LiveTranscriptStore(); start(store, "a"); let capture: any;
  const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 48}}, realTheme,
   handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
  panel.update(["Guild · 1 active", "⏳ coder/typescript · running · a"], ["a"]);
  capture("\x1b[A"); capture("\x1b[C");
  const lines = panel.render(80); assert.match(stripTerminalSequences(lines[2]), /^ ● coder\/typescript · running/);
  const identity = realTheme.fg("accent", "● coder/typescript");
  assert.ok(lines[2].includes(realTheme.inverse(identity) + realTheme.fg("dim", " · running · a")));
  assert.doesNotMatch(lines.join("\n"), /›/);
  assert.ok(lines.every(line => visibleWidth(line) === 80));
  const card = lines.find(line => line.includes("Session"))!;
  assert.ok(card.startsWith(mode === "256color" ? `\x1b[48;5;${name === "light" ? 189 : 236}m` : `\x1b[48;2;${name === "light" ? "233;221;242" : "45;37;56"}m`));
  panel.dispose();
 }
});
it("reserves the detail footer instead of slicing it off at the five-row boundary", () => {
 const store = new LiveTranscriptStore(); start(store, "a"); let capture: any;
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 10}}, theme,
  handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild · 1 active", "⏳ coder/typescript · running · a"], ["a"]);
 capture("\x1b[A"); capture("\x1b[C");
 const lines = panel.render(80).map(stripTerminalSequences);
 assert.ok(lines.length <= 5); assert.match(lines.at(-1)!, /^╰.*← collapse/); panel.dispose();
});

// Removed active IDs are authoritative; store retention/omission is not lifecycle.
for (const terminal of ["completed", "failed", "cancelled"] as const) for (const sibling of ["queued", "running"] as const) {
 it(`collapses selected ${terminal} beside ${sibling} without expanding its adjacent survivor`, () => {
  const store = new LiveTranscriptStore(); start(store, "before"); start(store, "selected"); start(store, "after");
  store.updatePhase("after", sibling);
  let capture: any; let subscriptions = 0;
  const subscribe = store.subscribe.bind(store);
  store.subscribe = listener => {subscriptions++; const off = subscribe(listener); return () => {subscriptions--; off();};};
  const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 48}}, theme,
   handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
  const rows = (ids: string[]) => [`Guild · ${ids.length} active`, ...ids.map(id => `⏳ coder/typescript · ${store.get(id)?.phase} · ${id}`)];
  panel.update(rows(["before", "selected", "after"]), ["before", "selected", "after"]);
  capture("\x1b[A"); capture("\x1b[A"); capture("\x1b[C"); assert.equal(subscriptions, 1);
  store.finish("selected", terminal); assert.equal(store.get("selected")?.phase, terminal);
  panel.update(rows(["before", "after"]), ["before", "after"]);
  const output = panel.render(120).map(stripTerminalSequences).join("\n");
  assert.equal(subscriptions, 0); assert.doesNotMatch(output, /selected|Task ·|Session/);
  assert.match(output, /coder\/typescript.*after/); assert.match(output, /before/);
  const selectedRow = panel.render(120).find(line => line.includes("after"))!;
  assert.match(selectedRow, /\x1b\[7m.*coder\/typescript.*\x1b\[27m/);
  assert.doesNotMatch(panel.render(120).find(line => line.includes("before"))!, /\x1b\[7m/);
  // Esc racing removal releases compact navigation, rather than opening/cancelling a neighbor.
  assert.deepEqual(capture("\x1b"), {consume: true}); assert.equal(capture("\x1b"), undefined);
  capture("\x1b[A"); capture("\x1b[C"); assert.match(panel.render(120).join("\n"), /Task · after/);
  capture("\x1b[D"); store.updatePhase("after", "running"); panel.update(rows(["before", "after"]), ["before", "after"]);
  assert.equal(subscriptions, 0); assert.doesNotMatch(panel.render(120).join("\n"), /Task ·/);
  assert.equal(store.get("after")?.phase, "running"); panel.dispose();
 });
}
it("labels omitted still-active detail but removes it once its active ID disappears", () => {
 const store = new LiveTranscriptStore({maxRuns: 1}); start(store, "omitted"); start(store, "survivor");
 assert.equal(store.get("omitted"), undefined);
 let capture: any;
 const panel = createInlineGuildPanel(store, {requestRender() {}, terminal: {rows: 48}}, theme,
  handler => {capture = handler; return () => {};}, () => {}, () => "", () => true);
 panel.update(["Guild · 2 active", "⏳ coder/typescript · running · omitted", "⏳ coder/typescript · running · survivor"], ["omitted", "survivor"]);
 capture("\x1b[A"); capture("\x1b[A"); capture("\x1b[C");
 assert.match(panel.render(100).join("\n"), /unavailable/);
 panel.update(["Guild · 1 active", "⏳ coder/typescript · running · survivor"], ["survivor"]);
 assert.doesNotMatch(panel.render(100).join("\n"), /omitted|unavailable|Task ·/); panel.dispose();
});
