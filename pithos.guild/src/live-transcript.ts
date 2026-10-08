export type LivePhase = "queued" | "running" | "completed" | "failed" | "cancelled";
export type LiveRunStart = Readonly<{
  id: string; role: string; profile: string; task: string;
  phase: "queued" | "running"; startedAt: number;
}>;
export type LiveEntry = Readonly<{
  id: string; kind: "text" | "tool"; content: string;
  toolCallId?: string; toolName?: string; args?: string;
  status?: "running" | "completed" | "failed";
}>;
export type LiveRunSnapshot = Readonly<Omit<LiveRunStart, "phase"> & {
  phase: LivePhase; version: number; diagnostic?: string;
  entries: readonly LiveEntry[]; truncated: boolean; retainedBytes: number;
}>;

export const LIVE_TRANSCRIPT_LIMITS = Object.freeze({
  maxRunBytes: 256 * 1024, maxEntries: 500, maxStringBytes: 16 * 1024,
  maxTaskBytes: 4 * 1024, maxIdBytes: 256,
  maxRuns: 64, maxTotalBytes: 4 * 1024 * 1024,
  maxRecentRuns: 10, maxRecentBytes: 2 * 1024 * 1024,
});
export type LiveTranscriptLimits = { readonly [Key in keyof typeof LIVE_TRANSCRIPT_LIMITS]: number };

/**
 * Session-local, observational state; supply session-unique run IDs and ordered parsed events.
 * Nothing here admits, rejects, cancels or influences runner work.
 *
 * get() returns a cached frozen snapshot (unchanged entries are shared), so renderers can
 * compare version/reference rather than clone transcripts. Render all strings as untrusted
 * plain text. `truncated` means text/history was omitted; list().omittedRuns means entire
 * snapshots were omitted/evicted. An absent selected ID stays absent: never select a neighbor
 * implicitly. Callers must release old snapshots; their own retained references are not owned
 * by this store. Limits account UTF-8 strings; entry/run caps bound fixed object overhead.
 */
export class LiveTranscriptStore {
  private runs = new Map<string, LiveRunSnapshot>();
  private cursors = new Map<string, number>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private version = 0;
  private omittedRuns = 0;
  readonly limits: LiveTranscriptLimits;

  constructor(limits: Partial<LiveTranscriptLimits> = {}) {
    this.limits = Object.freeze({ ...LIVE_TRANSCRIPT_LIMITS, ...limits });
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid transcript limit");
    }
  }

  /** Tasks are copied only into a bounded display string, never retained verbatim elsewhere. */
  start(input: LiveRunStart): void {
    if (this.disposed || this.runs.has(input.id)) return;
    if (!this.validId(input.id)) { this.omittedRuns++; this.changed(); return; }
    const role = this.text(input.role, 128);
    const profile = this.text(input.profile, 128);
    const task = this.text(input.task, this.limits.maxTaskBytes);
    const snapshot = { id: input.id, role: role.value, profile: profile.value,
      task: task.value, phase: input.phase, startedAt: input.startedAt,
      entries: Object.freeze([]), truncated: role.truncated || profile.truncated || task.truncated,
      retainedBytes: 0, version: 1 };
    this.retain(input.id, snapshot);
    this.changed();
  }
  updatePhase(id: string, phase: "queued" | "running"): void {
    const run = this.runs.get(id);
    if (run && active(run)) this.update(id, { phase });
  }
  finish(id: string, phase: "completed" | "failed" | "cancelled", diagnostic?: string): void {
    const run = this.runs.get(id);
    if (!run || !active(run)) return;
    // Completion order is retention order; no separate history index.
    this.runs.delete(id);
    this.runs.set(id, run);
    this.update(id, { phase, diagnostic: diagnostic === undefined ? undefined : this.text(diagnostic).value,
      truncated: this.runs.get(id)?.truncated || (diagnostic !== undefined && this.text(diagnostic).truncated) });
  }
  ingest(id: string, event: unknown): void {
    const run = this.runs.get(id);
    const value = record(event);
    if (!run || !active(run) || !value || this.disposed) return;
    const message = record(value.message);
    if (value.type === "message_start" && message?.role === "assistant") {
      this.cursors.set(id, (this.cursors.get(id) ?? 0) + 1);
      if (!Array.isArray(message.content)) return;
    }
    if (typeof value.type === "string" && value.type.startsWith("tool_execution_")) {
      if (!["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(value.type)) return;
      this.update(id, this.tool(run, value.toolCallId, value.toolName, value.args,
        value.type === "tool_execution_start" ? undefined : value.result ?? value.partialResult,
        value.type === "tool_execution_end" ? (value.isError === true ? "failed" : "completed") : "running"));
      return;
    }
    if (!["message_start", "message_update", "message_end"].includes(value.type as string)) return;
    if (message?.role === "toolResult" && value.type === "message_end") {
      this.update(id, this.tool(run, message.toolCallId, message.toolName, undefined, message,
        message.isError === true ? "failed" : "completed"));
      return;
    }
    if (message && message.role !== "assistant") return;
    const delta = record(value.assistantMessageEvent);
    const hasSnapshot = Array.isArray(message?.content);
    if (!hasSnapshot && (delta?.type !== "text_delta" || typeof delta.delta !== "string" ||
      (delta.contentIndex !== undefined && (!Number.isSafeInteger(delta.contentIndex) || (delta.contentIndex as number) < 0)))) return;
    const cursor = this.cursors.get(id) ?? 1;
    this.cursors.set(id, cursor);
    let entries = [...run.entries];
    const visibleTextIds = new Set<string>();
    let truncated = run.truncated;
    const put = (index: number, text: string, append = false) => {
      const entryId = `m${cursor}:${index}`;
      visibleTextIds.add(entryId);
      const old = entries.findIndex(entry => entry.id === entryId);
      const chunk = this.text(text);
      const bounded = this.text((append && old >= 0 ? entries[old].content : "") + chunk.value);
      truncated ||= chunk.truncated || bounded.truncated;
      const entry = Object.freeze({ id: entryId, kind: "text" as const, content: bounded.value });
      if (old < 0) entries.push(entry); else entries[old] = entry;
    };
    if (Array.isArray(message?.content)) {
      if (message.content.length > this.limits.maxEntries) truncated = true;
      message.content.slice(0, this.limits.maxEntries).forEach((part, index) => {
        const block = record(part);
        if (block?.type === "text" && typeof block.text === "string") put(index, block.text);
        if (block?.type === "toolCall") {
          const tools = this.tool({ ...run, entries, truncated }, block.id, block.name, block.arguments, undefined, "running");
          entries = [...tools.entries];
          truncated ||= tools.truncated;
        }
        if (block?.type === "image") put(index, "[unsupported image content]");
      });
    } else {
      if (delta?.type === "text_delta" && typeof delta.delta === "string") {
        put(Number.isSafeInteger(delta.contentIndex) ? delta.contentIndex as number : 0, delta.delta, true);
      }
    }
    if (hasSnapshot) {
      entries = entries.filter(entry => entry.kind !== "text" ||
        !entry.id.startsWith(`m${cursor}:`) || visibleTextIds.has(entry.id));
    }
    if (entries.length || run.entries.length || truncated !== run.truncated) {
      this.update(id, { entries: Object.freeze(entries), truncated });
    }
  }
  /** Undefined means unavailable (unknown, omitted, evicted, or disposed), not another run. */
  get(id: string): LiveRunSnapshot | undefined { return this.runs.get(id); }
  /** Active admission order; recent oldest completion first. Only small lists are copied. */
  list() {
    const runs = [...this.runs.values()];
    return Object.freeze({ version: this.version, omittedRuns: this.omittedRuns,
      retainedBytes: runs.reduce((sum, run) => sum + run.retainedBytes, 0),
      active: Object.freeze(runs.filter(run => run.phase === "queued" || run.phase === "running")),
      recent: Object.freeze(runs.filter(run => run.phase !== "queued" && run.phase !== "running")),
    });
  }
  /** Synchronous change notification; observer exceptions cannot escape. Returns unsubscribe. */
  subscribe(listener: () => void): () => void {
    if (!this.disposed) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.runs.clear();
    this.cursors.clear();
    this.omittedRuns = 0;
    this.version++;
  }
  private tool(run: LiveRunSnapshot, callId: unknown, name: unknown, args: unknown, result: unknown,
    status: "running" | "completed" | "failed"): Pick<LiveRunSnapshot, "entries" | "truncated"> {
    if (typeof callId !== "string" || !callId) return run;
    if (!this.validId(callId)) return { entries: run.entries, truncated: true };
    const entries = [...run.entries];
    const index = entries.findIndex(entry => entry.kind === "tool" && entry.toolCallId === callId);
    const previous = index < 0 ? undefined : entries[index];
    if (previous?.status !== undefined && previous.status !== "running" && status === "running") return run;
    const toolName = typeof name === "string" ? this.text(name, 128) : undefined;
    const submission = (toolName?.value ?? previous?.toolName) === "guild_submit_result";
    const argument = submission || args === undefined ? undefined : argumentText(args, this.limits.maxStringBytes);
    const summary = submissionSummary(args) ?? submissionSummary(record(result)?.details);
    const output = this.text(submission
      ? `${status === "running" ? "Report submission" : "Report submitted"} · not host-validated${summary ? ` — ${summary}` : previous?.content.includes(" — ") ? ` — ${previous.content.split(" — ").slice(1).join(" — ")}` : ""}`
      : result === undefined ? previous?.content ?? "" : content(record(result)?.content, this.limits.maxStringBytes, this.limits.maxEntries));
    const entry: LiveEntry = Object.freeze({ id: previous?.id ?? `t:${callId}`, kind: "tool", toolCallId: callId as string,
      toolName: toolName?.value ?? previous?.toolName,
      args: submission ? undefined : argument?.value ?? previous?.args,
      content: output.value, status });
    if (index < 0) entries.push(entry); else entries[index] = entry;
    return { entries: Object.freeze(entries), truncated: run.truncated ||
      toolName?.truncated === true || argument?.truncated === true || output.truncated };
  }
  private validId(id: string): boolean {
    return !!id && Buffer.byteLength(id) <= this.limits.maxIdBytes && safe(id) === id;
  }
  private text(value: string, limit = this.limits.maxStringBytes) {
    const capped = value.slice(0, limit * 2);
    const cleaned = safe(capped);
    const result = clip(cleaned, limit);
    return { value: result, truncated: capped.length < value.length || result.length < cleaned.length };
  }
  private retain(id: string, input: LiveRunSnapshot): void {
    let run = { ...input, entries: [...input.entries] };
    while (run.entries.length > this.limits.maxEntries ||
      (bytes(run) > this.limits.maxRunBytes && run.entries.length)) {
      run.entries.shift(); run.truncated = true;
    }
    for (const key of ["task", "diagnostic"] as const) {
      const value = run[key];
      const excess = bytes(run) - this.limits.maxRunBytes;
      if (value !== undefined && excess > 0) {
        run[key] = clip(value, Math.max(0, Buffer.byteLength(value) - excess));
        run.truncated = true;
      }
    }
    if (bytes(run) > this.limits.maxRunBytes) {
      this.runs.delete(id); this.cursors.delete(id); this.omittedRuns++; return;
    }
    this.runs.set(id, Object.freeze({ ...run, entries: Object.freeze(run.entries), retainedBytes: bytes(run) }));
  }
  private update(id: string, patch: Partial<LiveRunSnapshot>): void {
    const run = this.runs.get(id);
    if (!run || this.disposed) return;
    if (patch.entries && sameEntries(run.entries, patch.entries)) patch = { ...patch, entries: run.entries };
    if (Object.entries(patch).every(([key, value]) => run[key as keyof LiveRunSnapshot] === value)) return;
    this.retain(id, { ...run, ...patch, truncated: run.truncated || patch.truncated === true, version: run.version + 1 });
    this.changed();
  }
  private enforceGlobal(): void {
    const evict = (run: LiveRunSnapshot) => {
      this.runs.delete(run.id);
      this.cursors.delete(run.id);
      this.omittedRuns++;
    };
    const recent = [...this.runs.values()].filter(run => !active(run));
    let recentBytes = recent.reduce((sum, run) => sum + run.retainedBytes, 0);
    while (recent.length > this.limits.maxRecentRuns || recentBytes > this.limits.maxRecentBytes) {
      const run = recent.shift()!;
      recentBytes -= run.retainedBytes;
      evict(run);
    }
    const candidates = [...recent, ...[...this.runs.values()].filter(active)];
    let total = [...this.runs.values()].reduce((sum, run) => sum + run.retainedBytes, 0);
    while (this.runs.size > this.limits.maxRuns || total > this.limits.maxTotalBytes) {
      const run = candidates.shift()!;
      total -= run.retainedBytes;
      evict(run);
    }
  }
  private changed(): void {
    this.enforceGlobal();
    this.version++;
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* Observational only. */ } }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function content(value: unknown, limit: number, maxBlocks: number): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  let length = 0;
  let truncated = value.length > maxBlocks;
  for (const part of value.slice(0, maxBlocks)) {
    const block = record(part);
    let text: string | undefined;
    if (block?.type === "text" && typeof block.text === "string") text = block.text;
    else if (["image", "audio", "binary", "file", "video"].includes(block?.type as string)) {
      text = `[unsupported ${block!.type} content]`;
    }
    if (text === undefined) continue;
    const bounded = safe(text.slice(0, limit * 2));
    parts.push(bounded.slice(0, Math.max(0, limit * 2 - length)));
    length += bounded.length + 1;
    if (text.length > limit * 2 || length > limit * 2) { truncated = true; break; }
  }
  const joined = parts.join("\n");
  // The extra marker ensures the normalizer sets the visible truncation flag.
  return truncated ? joined.padEnd(limit + 1, " ") + "[content truncated]" : joined;
}

// Plain text only: strip complete and unterminated terminal control strings first.
function safe(value: string): string {
  return value
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function argumentText(value: unknown, limit: number): { value: string; truncated: boolean } {
  let truncated = false;
  let remainingBytes = limit;
  let remainingNodes = 128;
  const bounded = (text: string) => {
    const cleaned = safe(text.slice(0, remainingBytes * 2));
    const result = clip(cleaned, remainingBytes);
    truncated ||= text.length > remainingBytes * 2 || result.length < cleaned.length;
    remainingBytes -= Buffer.byteLength(result);
    return result;
  };
  const visit = (input: unknown, depth: number): unknown => {
    if (--remainingNodes < 0 || depth > 5) { truncated = true; return "[arguments truncated]"; }
    if (typeof input === "string") return bounded(input);
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (Array.isArray(input)) {
      truncated ||= input.length > 32;
      return input.slice(0, 32).map(item => visit(item, depth + 1));
    }
    const object = record(input);
    if (!object) return "[unsupported argument]";
    const pairs: [string, unknown][] = [];
    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;
      if (pairs.length === 32) { truncated = true; break; }
      pairs.push([bounded(key), visit(object[key], depth + 1)]);
    }
    return Object.fromEntries(pairs);
  };
  try {
    const text = typeof value === "string" ? bounded(value) : JSON.stringify(visit(value, 0));
    const result = clip(text, limit);
    return { value: result, truncated: truncated || result.length < text.length };
  } catch { return { value: clip("[unsupported arguments]", limit), truncated: true }; }
}

// Account every retained string field, not just transcript content (UTF-8 bytes).
function bytes(run: LiveRunSnapshot): number {
  const strings = [run.id, run.role, run.profile, run.task, run.phase, run.diagnostic ?? ""];
  for (const entry of run.entries) strings.push(entry.id, entry.kind, entry.content,
    entry.toolCallId ?? "", entry.toolName ?? "", entry.args ?? "", entry.status ?? "");
  return strings.reduce((total, value) => total + Buffer.byteLength(value), 0);
}
function clip(value: string, limit: number): string {
  if (Buffer.byteLength(value) <= limit) return value;
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) break;
    end += character.length;
  }
  return value.slice(0, end);
}

function active(run: LiveRunSnapshot): boolean {
  return run.phase === "queued" || run.phase === "running";
}

function sameEntries(left: readonly LiveEntry[], right: readonly LiveEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return entry.id === other.id && entry.kind === other.kind && entry.content === other.content &&
      entry.toolCallId === other.toolCallId && entry.toolName === other.toolName && entry.args === other.args && entry.status === other.status;
  });
}

// The internal envelope is never serialized or copied into observational state.
function submissionSummary(value: unknown): string | undefined {
  if (typeof value === "string" && value.length <= 64 * 1024) {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  const summary = record(value)?.summary;
  if (typeof summary !== "string") return undefined;
  const text = safe(summary.slice(0, 2048)).replace(/\s+/g, " ").trim();
  return text ? clip(text, 1024) : undefined;
}
