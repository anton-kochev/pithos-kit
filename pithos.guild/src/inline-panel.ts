import type { Theme, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, type Component } from "@earendil-works/pi-tui";
import { createLiveTranscriptInspector, type LiveTranscriptInspector } from "./live-transcript-ui.ts";
import type { LiveTranscriptStore } from "./live-transcript.ts";
import { createGuildPanel, guildPanelAnsi } from "./ui.ts";
import { taskPreview } from "./visibility.ts";

interface PanelTui { requestRender(): void; terminal: { rows: number }; }
export interface InlineGuildPanel extends Component {
 update(lines: string[], ids: string[]): void;
 readonly navigating: boolean;
 dispose(): void;
}

// Logical capture leaves the actual editor component, draft and cursor untouched.
// Only panel actions are consumed. Any other input returns immediately to editor.
export function createInlineGuildPanel(store: LiveTranscriptStore, tui: PanelTui, theme: Theme,
 listen: (handler: TerminalInputHandler) => () => void, changed: () => void,
 getEditorText: () => string, eligible: () => boolean): InlineGuildPanel {
 let lines: string[] = [];
 let ids: string[] = [];
 let selected: string | undefined;
 let focused = false;
 let disposed = false;
 let unsubscribe: (() => void) | undefined;
 let detail: LiveTranscriptInspector | undefined;
 let mouseRows = new Map<number, string>();
 let detailHeight = 1;
 const keys = getKeybindings();
 const roster = () => ids;
 const render = () => { if (!disposed) { tui.requestRender(); changed(); } };
 const collapse = () => { detail?.dispose(); detail = undefined; };
 const release = () => { focused = false; };
 const expand = () => {
  if (!selected || detail) return;
  collapse();
  detail = createLiveTranscriptInspector(store, {
   requestRender: () => { if (!disposed) tui.requestRender(); },
   terminal: { get rows() { return detailHeight + 2; } },
  }, theme, keys, () => {}, selected, true, true);
 };
 const capture: TerminalInputHandler = data => {
  if (disposed) return;
  if (!eligible() || getEditorText() !== "") {
   if (focused) { release(); render(); }
   return;
  }
  if (!focused) {
   if (!ids.length || !matchesKey(data, "up")) return;
   if (selected !== ids.at(-1)) collapse();
   selected = ids.at(-1); focus(); render(); return {consume: true};
  }
  if (keys.matches(data, "tui.select.cancel")) {
   if (detail) collapse(); else release();
  } else if (matchesKey(data, "left")) {
   collapse();
  } else if (matchesKey(data, "right") || keys.matches(data, "tui.select.confirm")) {
   if (!detail) expand();
  } else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
   if (detail) detail.handleInput(data);
   else {
    const available = roster(); const index = available.indexOf(selected ?? "");
    if (keys.matches(data, "tui.select.down") && index === available.length - 1) release();
    else selected = available[Math.max(0, Math.min(available.length - 1, index + (keys.matches(data, "tui.select.up") ? -1 : 1)))];
   }
  } else if (detail && (keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown") || matchesKey(data, "home") || matchesKey(data, "end"))) {
   detail.handleInput(data);
  } else {
   release(); render(); return;
  }
  render(); return {consume: true};
 };
 const focus = () => {
  if (disposed || focused) return;
  selected ??= ids[0];
  focused = true;
 };
 unsubscribe = listen(capture);
 return {
  get navigating() { return !disposed && focused; },
  update(nextLines, nextIds) {
   if (disposed) return;
   const previousIndex = ids.indexOf(selected ?? "");
   if (selected && !nextIds.includes(selected)) {
    collapse();
    // Prefer the next row at the old position, or the preceding final row.
    // Moving selection never opens a neighboring session automatically.
    selected = nextIds[Math.max(0, Math.min(previousIndex, nextIds.length - 1))];
   }
   lines = nextLines; ids = nextIds;
   mouseRows.clear();
   selected ??= ids[0];
   if (!ids.length) release();
   tui.requestRender();
  },
  dispose() { if (disposed) return; disposed = true; unsubscribe?.(); unsubscribe = undefined; release(); collapse(); mouseRows.clear(); lines = []; ids = []; selected = undefined; },
  invalidate() { detail?.invalidate(); },
  handleMouse(event) {
   if (disposed || event.type !== "click" || event.button !== "left") return;
   const id = mouseRows.get(event.y); if (!id || !ids.includes(id)) return;
   if (selected !== id) collapse();
   selected = id; focus(); expand(); render();
   // Do not request actual TUI focus: editor keeps its exact cursor/IME state.
   return {handled: true, render: false};
  },
  render(width) {
   if (disposed || width <= 0) return [];
   const budget = Math.max(1, Math.min(24, Math.floor(tui.terminal.rows / 2)));
   const available = roster();
   const selectedIndex = Math.max(0, available.indexOf(selected ?? ""));
   // On tiny screens prioritize the detail's collapse control over roster chrome.
   if (detail && budget <= 5) {
    mouseRows.clear(); detailHeight = budget;
    return detail.render(width);
   }
   const count = Math.max(1, Math.min(available.length, budget - 3 - (detail ? 8 : 0)));
   const top = Math.max(0, Math.min(selectedIndex, available.length - count));
   const shown = available.slice(top, top + count);
   const rowLines = shown.map(id => {
    const index = ids.indexOf(id); const run = store.get(id);
    const line = index >= 0 ? lines[index + 1] : run
     ? `⏳ ${run.role}/${run.profile} · ${run.phase} · ${taskPreview(run.task) ?? ""}`
     : "Selected run unavailable (evicted)";
    return line ?? "Selected run unavailable (evicted)";
   });
   const hint = detail ? "← collapse · Esc back" : focused ? "↑↓ select · → expand · Esc editor" : "↑ select · → expand";
   const compact = createGuildPanel([lines[0] ?? "Guild · 0 active", ...rowLines], theme, undefined, hint, focused ? shown.indexOf(selected ?? "") : undefined).render(width);
   mouseRows.clear();
   // Insert detail immediately below its row. Later row coordinates include it.
   const output = compact.slice(0, 2);
   shown.forEach((id, index) => {
    mouseRows.set(output.length, id);
    output.push(compact[index + 2]);
    if (detail && id === selected) {
     detailHeight = Math.max(1, budget - compact.length - 1);
     output.push(`${guildPanelAnsi(theme).background}${" ".repeat(width)}\x1b[49m`, ...detail.render(width));
    }
   });
   output.push(compact.at(-1)!);
   return output.slice(0, budget);
  },
 };
}
