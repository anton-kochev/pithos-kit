import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { LiveTranscriptStore } from "./live-transcript.ts";
import { guildPanelAnsi } from "./ui.ts";
import { taskPreview } from "./visibility.ts";

interface InspectorTui { requestRender(): void; terminal: { rows: number }; }
interface InspectorKeys { matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel" | "tui.select.pageUp" | "tui.select.pageDown"): boolean; }
export interface LiveTranscriptInspector extends Component { handleInput(data: string): void; close(): void; dispose(): void; }

// The viewer owns IDs and offsets, never snapshots. Its only effect is rendering.
export function createLiveTranscriptInspector(store: LiveTranscriptStore, tui: InspectorTui, theme: Theme, keys: InspectorKeys, done: () => void, initialId?: string, initialExpanded = false, inline = false): LiveTranscriptInspector {
 let selected: string | undefined = initialId ?? store.list().active[0]?.id;
 let expanded = initialExpanded;
 let disposed = false;
 let follow = true;
 let offset = 0;
 let maximum = 0;
 let page = 1;
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
   else if (keys.matches(data, "tui.select.confirm")) expanded = true;
   else if (!expanded) {
    const roster = ids(); const index = roster.indexOf(selected ?? "");
    if (keys.matches(data, "tui.select.up")) select(roster[Math.max(0, index - 1)]);
    if (keys.matches(data, "tui.select.down")) select(roster[Math.min(roster.length - 1, index + 1)]);
   } else {
    if (matchesKey(data, "end")) { follow = true; anchor = undefined; anchorNotice = ""; }
    else if (matchesKey(data, "home")) { follow = false; offset = 0; anchor = renderedPositions[offset]; anchorNotice = ""; }
    else {
     const delta = keys.matches(data, "tui.select.up") ? -1 : keys.matches(data, "tui.select.down") ? 1 : keys.matches(data, "tui.select.pageUp") ? -page : keys.matches(data, "tui.select.pageDown") ? page : 0;
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
   const height = Math.max(1, Math.min(24, tui.terminal.rows - 2));
   const listing = store.list();
   const truncated = [...listing.active, ...listing.recent].filter(run => run.truncated).length;
   const notice = !expanded ? [
    ...(listing.omittedRuns ? [`${listing.omittedRuns} runs omitted/evicted`] : []),
    ...(truncated ? [`${truncated} transcripts truncated`] : []),
   ].join(" · ") : "";
   const run = selected ? store.get(selected) : undefined;
   const header = theme.fg("accent", inline ? "✦ Session" : `Guild${expanded && run ? ` · ${safe(run.role)}/${safe(run.profile)} · ${run.phase}` : " inspector"}`);
   const preview = expanded && run && height >= 5 ? theme.fg("muted", `Task · ${taskPreview(run.task)}`) : undefined;
   const section = inline && expanded && height >= 7;
   const footerGap = inline && height >= 7;
   page = Math.max(0, height - 2 - (notice ? 1 : 0) - (preview ? 1 : 0) - (section ? 1 : 0) - (footerGap ? 1 : 0));
   let body: string[];
   mouseRows = [];
   if (expanded) {
    const wrapped: string[] = [];
    const positions: Position[] = [];
    const add = (id: string, part: string, text: string) => {
     safe(text).split("\n").forEach((line, logicalLine) => {
      let character = 0;
      wrapTextWithAnsi(line, contentWidth).forEach(row => {
       // Wrapping may discard boundary whitespace; locate each plain row in
       // the logical line rather than assuming terminal columns equal characters.
       const start = row ? line.indexOf(row, character) : character;
       const column = Math.max(character, start);
       wrapped.push(theme.fg(part === "header" ? "accent" : part === "args" ? "muted" : "text", row)); positions.push({id, part, line: logicalLine, character: column});
       character = column + row.length;
      });
     });
    };
    if (run) {
     for (const entry of run.entries) {
      if (wrapped.length) add(entry.id, "spacing", "");
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
     if (run.diagnostic) add("", "diagnostic", run.diagnostic);
     if (run.truncated) add("", "truncated", "[transcript truncated]");
    } else add("", "unavailable", "Selected run unavailable (evicted)");
    maximum = Math.max(0, wrapped.length - page);
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
    body = wrapped.slice(offset, offset + page);
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
   const footer = theme.fg("dim", expanded ? `${follow ? "live" : anchorNotice || "paused"} · ↑↓/Pg scroll · End live · Esc back · F6 ${initialExpanded ? "back" : "close"}` : "↑↓ select · Enter inspect · Esc close · F6 close");
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
   const inlineFooter = theme.fg("dim", `← collapse · ${follow ? "live" : anchorNotice || "paused"} · ↑↓/Pg scroll · End live`);
   const fittedFooter = inline ? (contentWidth < 14 ? "← collapse" : inlineFooter)
    : controls(visibleWidth(controls(footer)) <= contentWidth ? footer : contentWidth < 28 ? compactControl : shortFooter);
   const lines = height === 1 ? [frame(notice ? controls(`${notice} · Esc/F6 close`) : fittedFooter)]
    : height === 2 && notice ? [frame(notice), frame(fittedFooter)]
    : [edge("╭", header, "╮"), ...(preview ? [frame(preview)] : []), ...(section ? [edge("├", theme.fg("muted", "Transcript"), "┤")] : []), ...body.map(frame), ...(notice && height > 2 ? [frame(theme.fg("muted", notice))] : []), ...(footerGap ? [frame("")] : []), edge("╰", fittedFooter, "╯")];
   return lines.map(line => `${background}${pad(line, width)}\x1b[49m`);
  },
 };
}
