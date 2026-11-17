import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { LiveTranscriptStore, LiveEntry, LiveRunSnapshot } from "./live-transcript.ts";
import { guildPanelAnsi } from "./ui.ts";
import { taskPreview } from "./visibility.ts";

interface InspectorTui { requestRender(): void; terminal: { rows: number }; }
interface InspectorKeys { matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel" | "tui.select.pageUp" | "tui.select.pageDown"): boolean; }
export interface LiveTranscriptInspector extends Component { handleInput(data: string): void; close(): void; dispose(): void; }

// The viewer owns IDs and offsets, never snapshots. Its only effect is rendering.
export function createLiveTranscriptInspector(store: LiveTranscriptStore, tui: InspectorTui, theme: Theme, keys: InspectorKeys, done: () => void, initialId?: string, initialExpanded = false, inline = false, taskVisible: () => boolean = () => false): LiveTranscriptInspector {
 let selected: string | undefined = initialId ?? store.list().active[0]?.id;
 let expanded = initialExpanded;
 let raw = false;
 let disposed = false;
 let follow = true;
 let offset = 0;
 let maximum = 0;
 let page = 1;
 let scrollPage = 1;
 type Position = { id: string; part: string; line: number; character: number };
 let anchor: Position | undefined;
 let renderedPositions: Position[] = [];
 let anchorNotice = "";
 let mouseRows: (string | undefined)[] = [];
 let timer: ReturnType<typeof setTimeout> | undefined;
 const request = () => {
  if (disposed || timer) return;
  timer = setTimeout(() => { timer = undefined; if (!disposed) tui.requestRender(); }, 100);
  timer.unref?.();
 };
 const unsubscribe = store.subscribe(request);
 const ids = () => {
  const active = store.list().active.map(run => run.id);
  if (selected && !active.includes(selected)) active.push(selected);
  return active;
 };
 const dispose = () => {
  if (disposed) return;
  disposed = true; unsubscribe(); if (timer) clearTimeout(timer); timer = undefined;
  selected = undefined; anchor = undefined; renderedPositions = []; mouseRows = [];
 };
 const close = () => { if (disposed) return; dispose(); done(); };
 const select = (id: string | undefined) => { if (id !== selected) { selected = id; follow = true; offset = 0; anchor = undefined; renderedPositions = []; anchorNotice = ""; } };
 const safe = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\t/g, "  ");
 return {
  invalidate() {}, dispose, close,
  handleMouse(event) {
   if (disposed || expanded || event.type !== "click" || event.button !== "left") return;
   const id = mouseRows[event.y]; if (!id) return;
   select(id); request(); return {handled: true, focus: true, render: false};
  },
  handleInput(data) {
   if (disposed) return;
   if (matchesKey(data, "f6")) { close(); return; }
   if (keys.matches(data, "tui.select.cancel")) { if (expanded) expanded = false; else { close(); return; } }
   else if (expanded && matchesKey(data, "tab")) { raw = !raw; follow = true; anchor = undefined; anchorNotice = ""; }
   else if (keys.matches(data, "tui.select.confirm")) expanded = true;
   else if (!expanded) {
    const roster = ids(); const index = roster.indexOf(selected ?? "");
    if (keys.matches(data, "tui.select.up")) select(roster[Math.max(0, index - 1)]);
    if (keys.matches(data, "tui.select.down")) select(roster[Math.min(roster.length - 1, index + 1)]);
   } else {
    if (matchesKey(data, "end")) { follow = true; anchor = undefined; anchorNotice = ""; }
    else if (matchesKey(data, "home")) { follow = false; offset = 0; anchor = renderedPositions[offset]; anchorNotice = ""; }
    else {
     const delta = keys.matches(data, "tui.select.up") ? -1 : keys.matches(data, "tui.select.down") ? 1 : keys.matches(data, "tui.select.pageUp") ? -scrollPage : keys.matches(data, "tui.select.pageDown") ? scrollPage : 0;
     if (delta) {
      follow = false; offset = Math.max(0, Math.min(maximum, offset + delta));
      anchor = renderedPositions[offset]; anchorNotice = "";
     }
    }
   }
   request();
  },
  render(width) {
   if (disposed || width <= 0) return [];
   if (!inline) width = Math.min(width, 108);
   const padding = inline && width >= 8 ? 2 : 1;
   const contentWidth = Math.max(1, width - 2 - padding * 2);
   const height = Math.max(1, Math.min(inline ? 40 : 24, tui.terminal.rows - 2));
   const listing = store.list();
   const truncated = [...listing.active, ...listing.recent].filter(run => run.truncated).length;
   const notice = !expanded ? [
    ...(listing.omittedRuns ? [`${listing.omittedRuns} runs omitted/evicted`] : []),
    ...(truncated ? [`${truncated} transcripts truncated`] : []),
   ].join(" · ") : "";
   const run = selected ? store.get(selected) : undefined;
   const header = theme.fg("accent", inline ? "✦ Session" : `Guild${expanded && run ? ` · ${safe(run.role)}/${safe(run.profile)} · ${run.phase}` : " inspector"}`);
   const preview = expanded && run && height >= 5 && !taskVisible() ? theme.fg("accent", "Task · ") + theme.fg("text", taskPreview(run.taskSummary) ?? taskPreview(run.task) ?? "unavailable") : undefined;
   const section = inline && expanded && height >= 7;
   const footerGap = inline && height >= 7;
   page = Math.max(0, height - 2 - (notice ? 1 : 0) - (preview ? 1 : 0) - (section ? 1 : 0) - (footerGap ? 1 : 0));
   let body: string[];
   mouseRows = [];
   if (expanded) {
    const wrapped: string[] = [];
    const positions: Position[] = [];
    const runningRows: string[] = [];
    const add = (id: string, part: string, text: string, color: Parameters<Theme["fg"]>[0] = part === "header" ? "accent" : part === "args" ? "muted" : "text") => {
     safe(text).split("\n").forEach((line, logicalLine) => {
      let character = 0;
      wrapTextWithAnsi(line, contentWidth).forEach(row => {
       // Wrapping may discard boundary whitespace; locate each plain row in
       // the logical line rather than assuming terminal columns equal characters.
       const start = row ? line.indexOf(row, character) : character;
       const column = Math.max(character, start);
       wrapped.push(theme.fg(color, row)); positions.push({id, part, line: logicalLine, character: column});
       character = column + row.length;
      });
     });
    };
    if (run) {
     if (raw) add("", "identity", `Run ID: ${run.id}`);
     const executing = !raw && !["completed", "failed", "cancelled"].includes(run.phase)
      ? run.entries.filter(entry => entry.kind === "tool" && entry.status === "running") : [];
     for (const entry of run.entries) {
      if (executing.includes(entry)) continue;
      if (!raw) { add(entry.id, "activity", activityLine(entry, run), activityColor(entry, run)); continue; }
      if (entry !== run.entries[0]) add(entry.id, "spacing", "");
      if (entry.kind === "tool") {
       const submission = entry.toolName === "guild_submit_result";
       add(entry.id, "header", submission ? "Submission · child report" : `Tool · ${entry.toolName ?? "tool"} · ${entry.status ?? "running"}`);
       if (entry.args) add(entry.id, "args", `Input · ${entry.args}`);
       if (entry.content) add(entry.id, "content", `${submission ? "" : "Output · "}${entry.content}`);
      } else {
       add(entry.id, "header", "Assistant");
       add(entry.id, "content", entry.content);
      }
     }
     if (!raw) {
      const current = run.phase === "running" && executing.length ? undefined : currentActivity(run);
      if (current) add("", "current", truncateToWidth(safe(current), contentWidth, "…"), run.phase === "failed" ? "error" : run.phase === "completed" ? "success" : ["queued", "cancelled"].includes(run.phase) ? "muted" : "warning");
      // Running rows are a pinned, single-line group, not scrollable history.
      // Reserve a history row where possible; overflow counts never claim completion.
      if (executing.length && page) {
       const budget = Math.max(1, page - 1);
       const separator = budget >= 3 ? 1 : 0;
       const slots = budget - separator;
       const shown = executing.length <= slots ? executing.length : Math.max(0, slots - 1);
       if (separator) runningRows.push("");
       for (const entry of executing.slice(0, shown)) runningRows.push(theme.fg(activityColor(entry, run), truncateToWidth(safe(activityLine(entry, run)), contentWidth, "…")));
       if (shown < executing.length) runningRows.push(theme.fg("warning", truncateToWidth(`${executing.length - shown} more executing · Tab details`, contentWidth, "…")));
      }
     }
     if (run.diagnostic) add("", "diagnostic", run.diagnostic, "error");
     if (run.truncated) add("", "truncated", "[transcript truncated]", "muted");
    } else add("", "unavailable", "Selected run unavailable (evicted)");
    const historyPage = Math.max(0, page - runningRows.length);
    // Page navigation follows the last visible history, excluding pinned work.
    scrollPage = Math.max(1, historyPage);
    maximum = Math.max(0, wrapped.length - historyPage);
    if (follow) { offset = maximum; anchor = positions[offset]; }
    else {
     let found = anchor ? -1 : offset;
     if (anchor) positions.forEach((position, index) => {
      if (position.id === anchor!.id && position.part === anchor!.part && position.line === anchor!.line && position.character <= anchor!.character) found = index;
     });
     if (anchor && found < 0) {
      const evicted = anchor.id && !run?.entries.some(entry => entry.id === anchor!.id);
      anchorNotice = `${evicted ? "anchor evicted" : "anchor unavailable"} · remaining start`;
     }
     offset = Math.max(0, found);
     // Keep the original character across resize round trips, even if a wider
     // row starts before it. Only explicit navigation establishes a new anchor.
     if (!anchor || found < 0) anchor = positions[offset];
    }
    // Navigation uses only IDs/numbers from the last displayed layout, never
    // snapshots or old text, so updates between input and render cannot shift it.
    renderedPositions = positions;
    body = [...wrapped.slice(offset, offset + historyPage), ...runningRows];
   } else {
    const roster = ids(); const index = roster.indexOf(selected ?? "");
    const top = Math.max(0, index - page + 1);
    const visibleIds = roster.slice(top, top + page);
    mouseRows = [undefined, ...visibleIds];
    body = visibleIds.map(id => {
     const item = store.get(id);
     const preview = taskPreview(item?.task);
     return `${id === selected ? "›" : " "} ${truncateToWidth(safe(id), 16, "…")} · ${item ? `${safe(item.role)}/${safe(item.profile)} · ${item.phase}${preview ? ` · ${preview}` : ""}` : "unavailable (evicted)"}`;
    });
    if (!roster.length && page) body = ["No active Guild runs"];
   }
   const footer = theme.fg("dim", expanded ? `${follow ? "live" : anchorNotice || "paused"} · Tab ${raw ? "activity" : "details"} · ↑↓/Pg scroll · End live · Esc back · F6 ${initialExpanded ? "back" : "close"}` : "↑↓ select · Enter inspect · Esc close · F6 close");
   const { background } = guildPanelAnsi(theme);
   const pad = (text: string, columns: number) => {
    const clipped = truncateToWidth(text, Math.max(0, columns), "…");
    return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
   };
   const border = (text: string) => theme.fg("borderAccent", text);
   const controls = (text: string) => inline ? text.replace(/ · F6 (?:back|close)/g, "").replace(/Esc\/F6/g, "Esc") : text;
   const frame = (text: string) => width >= 4
    ? border("│") + " ".repeat(padding) + pad(text, width - 2 - padding * 2) + " ".repeat(padding) + border("│")
    : pad(text, width);
   const edge = (left: string, text: string, right: string) => width >= 4
    ? inline
     ? border(left + "─") + pad(` ${text} `, width - 4) + border("─" + right)
     : border(left) + pad(text, width - 2) + border(right)
    : pad(text, width);
   const shortFooter = theme.fg("dim", `${expanded ? follow ? "live" : anchorNotice || "paused" : "Enter inspect"} · Esc ${expanded ? "back" : "close"} · F6 ${initialExpanded ? "back" : "close"}`);
   const compactControl = theme.fg("dim", `Esc ${expanded ? "back" : "close"} · F6 ${initialExpanded ? "back" : "close"}`);
   const inlineFooter = theme.fg("dim", `← collapse · ${follow ? "live" : anchorNotice || "paused"} · Tab ${raw ? "activity" : "details"} · ↑↓/Pg scroll · End live`);
   const fittedFooter = inline ? (contentWidth < 14 ? "← collapse" : inlineFooter)
    : controls(visibleWidth(controls(footer)) <= contentWidth ? footer : contentWidth < 28 ? compactControl : shortFooter);
   const lines = height === 1 ? [frame(notice ? controls(`${notice} · Esc/F6 close`) : fittedFooter)]
    : height === 2 && notice ? [frame(notice), frame(fittedFooter)]
    : [edge("╭", header, "╮"), ...(preview ? [frame(preview)] : []), ...(section ? [edge("├", theme.fg("muted", raw ? "Raw details" : "Activity"), "┤")] : []), ...body.map(frame), ...(notice && height > 2 ? [frame(theme.fg("muted", notice))] : []), ...(footerGap ? [frame("")] : []), edge("╰", fittedFooter, "╯")];
   return lines.map(line => `${background}${pad(line, width)}\x1b[49m`);
  },
 };
}

type ActivityDescription = [requested: string, running: string, completed: string];

function commandDescription(command: unknown): ActivityDescription | undefined {
 if (typeof command !== "string" || command.length > 4096) return undefined;
 // Only simple, unconditional inspection lists qualify. Shell syntax is not parsed
 // speculatively: conditionals, substitutions and scripts must not become claimed work.
 const parts = command.trim().split(/;\s*/);
 if (parts.length === 1) {
  if (/^npm (?:test|run test)(?: -- [\w./= -]+)?$/.test(command)) return ["Run tests.", "Running tests.", "Finished running tests."];
  if (/^npm run typecheck$/.test(command)) return ["Run the type check.", "Running the type check.", "Finished running the type check."];
  if (/^git diff(?: --(?:stat|shortstat|cached|staged|name-only))*$/.test(command)) return ["Inspect changes.", "Inspecting changes.", "Inspected changes."];
  if (/^git log(?: --oneline)?(?: -\d+)?$/.test(command)) return toolDescription("git_read", {subcommand: "log"});
  if (/^ls(?: -[la]+)?$/.test(command)) return toolDescription("ls", {});
  const read = /^cat ([\w./-]+)$/.exec(command);
  if (read && !read[1].startsWith("-") && !/^(?:\.\/)?(?:AGENTS\.md|package\.json)$/.test(read[1])) return fileDescription("read", taskPreview(read[1]));
 }
 if (parts.length > 3) return undefined;
 const subjects: string[] = [];
 for (const part of parts) {
  if (/^cat (?:\.\/)?AGENTS\.md$/.test(part)) subjects.push("repository instructions");
  else if (/^git status(?: --short)?$/.test(part)) subjects.push("the working tree");
  else if (/^cat (?:\.\/)?package\.json$/.test(part)) subjects.push("package metadata");
  else return undefined;
 }
 const subject = subjects.length < 3 ? subjects.join(" and ") : `${subjects[0]}, ${subjects[1]}, and ${subjects[2]}`;
 // A successful semicolon list only establishes the final command's exit status.
 return [`Inspect ${subject}.`, `Inspecting ${subject}.`, parts.length > 1 ? "Finished inspection commands." : `Inspected ${subject}.`];
}

function fileDescription(name: string, path: string | undefined): ActivityDescription {
 const target = path ? /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(path) ? `tests in ${path}` : path : "a file";
 if (name === "edit") return [`Update ${target}.`, `Updating ${target}.`, `Updated ${target}.`];
 if (name === "write") return [`Write ${target}.`, `Writing ${target}.`, `Wrote ${target}.`];
 return [`Read ${target}.`, `Reading ${target}.`, `Read ${target}.`];
}

function toolDescription(name: string | undefined, args: Record<string, unknown>): ActivityDescription {
 const path = typeof args.path === "string" ? taskPreview(args.path) : undefined;
 if (name === "bash") {
  const description = commandDescription(args.command);
  if (description) return description;
  const command = typeof args.command === "string" ? taskPreview(args.command) : undefined;
  return command ? [`Run shell command: ${command}`, `Running shell command: ${command}`, `Finished shell command: ${command}`]
   : ["Run a shell command.", "Running a shell command.", "Finished a shell command."];
 }
 if (name === "read") {
  const offset = typeof args.offset === "number" && Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 1;
  const limit = typeof args.limit === "number" && Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : undefined;
  const end = limit === undefined ? undefined : offset + limit - 1;
  const range = end !== undefined && Number.isSafeInteger(end) ? `lines ${offset}–${end}` : offset > 1 ? `from line ${offset}` : undefined;
  const description = fileDescription(name, path);
  return range ? description.map(label => `${label.slice(0, -1)} (${range}).`) as ActivityDescription : description;
 }
 if (name === "edit" || name === "write") return fileDescription(name, path);
 const location = path ? ` in ${path}` : "";
 if (name === "grep") return [`Search file contents${location}.`, `Searching file contents${location}.`, `Searched file contents${location}.`];
 if (name === "find") return [`Find files${location}.`, `Finding files${location}.`, `Searched for files${location}.`];
 if (name === "ls") return [`List files${location}.`, `Listing files${location}.`, `Listed files${location}.`];
 if (name === "git_read") {
  if (args.subcommand === "status") return ["Check the working tree.", "Checking the working tree.", "Checked the working tree."];
  if (args.subcommand === "log") return ["Inspect commit history.", "Inspecting commit history.", "Inspected commit history."];
  return ["Inspect repository information.", "Inspecting repository information.", "Inspected repository information."];
 }
 if (name === "guild_ask_parent") return ["Ask the parent for clarification.", "Asking the parent for clarification.", "Finished the parent exchange."];
 return ["Use a tool.", "Using a tool.", "Finished a tool call."];
}

// Labels describe observed tool lifecycle, never inferred intent or task success.
function activityLine(entry: LiveEntry, run: LiveRunSnapshot): string {
 if (entry.kind === "text") return `Assistant: ${taskPreview(entry.content) ?? "[empty text]"}`;
 if (entry.toolName === "guild_submit_result") return taskPreview(entry.content) ?? "Report submission · not host-validated";
 let args: Record<string, unknown> = {};
 try { const value = JSON.parse(entry.args ?? "{}"); if (value && typeof value === "object" && !Array.isArray(value)) args = value; } catch { /* Truncated/malformed arguments stay available in raw details. */ }
 const description = toolDescription(entry.toolName, args);
 // Failure and unfinished states describe the attempted action, never completed substeps.
 if (entry.status === "failed") return `✗ Failed to ${description[0][0].toLowerCase()}${description[0].slice(1)}`;
 if (entry.status === "completed") return `✓ ${description[2]}`;
 if (["completed", "failed", "cancelled"].includes(run.phase)) return `— Unfinished: ${description[0]}`;
 return entry.status === "requested" ? `○ Requested: ${description[0]}` : `→ ${description[1]}`;
}
function currentActivity(run: LiveRunSnapshot): string {
 if (run.phase === "queued") return "○ Queued; no child execution yet";
 if (run.phase === "waiting") return "→ Waiting for parent";
 if (run.phase === "stopping") return "→ Stopping; awaiting cleanup";
 if (run.phase !== "running") return `— Run ${run.phase} (transport state)`;
 return run.entries.length ? "→ Awaiting next activity" : "→ Awaiting child events";
}

// Completion colors describe tool execution, not host validation of the task.
function activityColor(entry: LiveEntry, run: LiveRunSnapshot): Parameters<Theme["fg"]>[0] {
 if (entry.kind === "text") return "text";
 if (entry.status === "failed") return "error";
 if (entry.toolName === "guild_submit_result") return "muted";
 if (entry.status === "completed") return "success";
 if (entry.status === "requested" || ["completed", "failed", "cancelled"].includes(run.phase)) return "muted";
 return "warning";
}
