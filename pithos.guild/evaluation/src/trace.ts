import { matchesBasePricing, type BasePricing } from "./pricing.ts";

const fields = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;
type Field = typeof fields[number];
export type Totals = Record<Field, number | null>;
const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
function add(target: Totals, raw: unknown, child = false): boolean {
  const usage = record(raw);
  let valid = true;
  for (const field of fields) {
    const value = field === "cost" && !child ? record(usage.cost).total : usage[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      target[field] = null;
      valid = false;
    } else if (target[field] !== null) target[field] += value;
  }
  return valid;
}
function text(content: unknown): string {
  return Array.isArray(content) ? content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("\n") : "";
}
export function analyzeTrace(jsonl: string, childJsonl?: string, pricing?: BasePricing) {
  const parent = zero(), childReported = zero();
  const issues = new Set<string>(), models = new Set<string>();
  const calls = new Map<string, { id: string; role?: string; profile?: string; finished: boolean }>();
  const parentMessages = new Set<string>();
  let finalText = "", parentTurns = 0, ended = false, handoffBytes = 0;
  let lastStop: unknown, assistantPending = false;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, any>;
    try { event = record(JSON.parse(line)); } catch { issues.add("malformed_json"); continue; }
    if (typeof event.type !== "string") { issues.add("malformed_event"); continue; }
    if (event.type === "agent_end") ended = true;
    if (event.type === "error") issues.add("provider_error");
    if (event.type === "compaction_end") issues.add("compaction_usage_unavailable");
    if ((event.type === "message_start" && event.message?.role === "assistant") || event.type === "message_update") assistantPending = true;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      assistantPending = false;
      const identity = JSON.stringify(event.message);
      if (parentMessages.has(identity)) { issues.add("duplicate_parent_message"); continue; }
      parentMessages.add(identity);
      lastStop = event.message.stopReason;
      parentTurns++;
      if (pricing && !matchesBasePricing(pricing, event.message)) issues.add("pricing_mismatch");
      if (!add(parent, event.message.usage)) issues.add("missing_parent_usage");
      finalText = text(event.message.content);
      if (typeof event.message.model === "string" && typeof event.message.provider === "string") models.add(`${event.message.provider}/${event.message.model}`);
      else issues.add("missing_model_identity");
      if (event.message.stopReason === "error") issues.add("provider_error");
      if (event.message.stopReason === "aborted") issues.add("aborted");
      if (!["stop", "toolUse", "length", "error", "aborted"].includes(event.message.stopReason)) issues.add("unknown_stop_reason");
      if (event.message.stopReason === "length") issues.add("output_limit");
    }
    if (event.toolName !== "guild_handover") continue;
    const id = event.toolCallId;
    if (typeof id !== "string") { issues.add("missing_tool_call_id"); continue; }
    if (event.type === "tool_execution_start") {
      if (calls.has(id)) issues.add("duplicate_tool_start");
      else calls.set(id, { id, role: event.args?.role, profile: event.args?.profile, finished: false });
    }
    if (event.type === "tool_execution_end") {
      let call = calls.get(id);
      if (!call) {
        issues.add("missing_tool_start");
        call = { id, finished: false }; calls.set(id, call);
      }
      if (call.finished) { issues.add("duplicate_tool_completion"); continue; }
      call.finished = true;
      if (event.isError) issues.add("handover_error");
      if (!add(childReported, event.result?.details?.usage, true)) issues.add("missing_child_usage");
      // Production Guild supplies aggregates, not per-turn raw child events.
      // Those totals may themselves contain zero defaults. Do not certify them.
      if (childJsonl === undefined) issues.add("child_raw_usage_unavailable");
      handoffBytes += Buffer.byteLength(text(event.result?.content));
    }
  }
  if (assistantPending) issues.add("unfinished_assistant_message");
  if (!ended) issues.add("missing_agent_end");
  if (lastStop !== "stop") issues.add("missing_terminal_stop");
  if (!parentTurns) { add(parent, undefined); issues.add("missing_parent_usage"); }
  for (const call of calls.values()) if (!call.finished) {
    add(childReported, undefined, true); issues.add("unfinished_handover");
  }
  if (!finalText.trim()) issues.add("missing_final_text");
  const observed = childJsonl === undefined ? undefined : analyzeChildren(childJsonl, pricing);
  for (const issue of observed?.issues ?? []) issues.add(issue);
  for (const model of observed?.models ?? []) models.add(model);
  for (const call of calls.values()) {
    const matches = observed?.runs.filter(run => run.runId === call.id) ?? [];
    if (observed && matches.length === 0) issues.add("missing_child_run");
    if (matches.length > 1) issues.add("multiple_child_runs");
    for (const run of matches) if (run.role !== call.role || run.profile !== call.profile) issues.add("child_target_mismatch");
  }
  for (const run of observed?.runs ?? []) if (!calls.has(run.runId)) issues.add("unmatched_child_run");
  const childObserved = issues.has("missing_child_run") ? unknownTotals() : observed?.usage ?? (calls.size ? unknownTotals() : zero());
  const totalReported = sum(parent, childReported);
  // Observed subtotals survive failures; only a complete trace has a known total.
  const totalObserved = issues.size ? unknownTotals() : sum(parent, childObserved);
  return {
    parent, childReported, totalReported, childObserved, totalObserved, childRuns: observed?.runs ?? [],
    parentTurns, models: [...models].sort(),
    finalText, finalBytes: Buffer.byteLength(finalText), handoffBytes,
    delegations: [...calls.values()], issues: [...issues].sort(), complete: issues.size === 0,
    parentContextTokensAdded: null, // Requires observation of the next parent provider call.
  };
}

function unknownTotals(): Totals {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, cost: null };
}
function sum(a: Totals, b: Totals): Totals {
  const result = zero();
  for (const field of fields) result[field] = a[field] === null || b[field] === null ? null : a[field] + b[field];
  return result;
}
interface ChildRun {
  childId: string;
  runId: string;
  role: string;
  profile: string;
  turns: number;
  usage: Totals;
  issues: string[];
}
function analyzeChildren(jsonl: string, pricing?: BasePricing): { usage: Totals; issues: Set<string>; models: Set<string>; runs: ChildRun[] } {
  const streams = new Map<string, { start: Record<string, any>; chunks: Buffer[]; sequence: number; ended: boolean }>();
  const issues = new Set<string>(), models = new Set<string>(), runs: ChildRun[] = [];
  let ready = false, ended = false;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, any>;
    try { event = record(JSON.parse(line)); } catch { issues.add("malformed_child_observation"); continue; }
    if (event.version !== 1) { issues.add("malformed_child_observation"); continue; }
    if (event.type === "observer_ready") {
      if (ready || ended || streams.size) issues.add("malformed_child_observation");
      ready = true; continue;
    }
    if (event.type === "observer_end") {
      if (!ready || ended) issues.add("malformed_child_observation");
      ended = true; continue;
    }
    if (!ready || ended) issues.add("malformed_child_observation");
    if (event.type === "observer_output_limit") { issues.add("child_observer_output_limit"); continue; }
    if (!["start", "stdout", "stderr", "end"].includes(event.type)
      || ![event.childId, event.runId, event.role, event.profile].every(s => typeof s === "string" && s.length > 0)
      || !Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      issues.add("malformed_child_observation"); continue;
    }
    if (event.type === "start") {
      if (streams.has(event.childId)) { issues.add("child_sequence_error"); continue; }
      if (event.sequence !== 0) issues.add("child_sequence_error");
      streams.set(event.childId, { start: event, chunks: [], sequence: 1, ended: false });
      continue;
    }
    const stream = streams.get(event.childId);
    if (!stream) { issues.add("missing_child_start"); continue; }
    if (event.sequence !== stream.sequence || stream.ended) {
      issues.add("child_sequence_error");
      if (event.sequence < stream.sequence || stream.ended) continue;
    }
    stream.sequence = event.sequence + 1;
    if (["runId", "role", "profile"].some(key => event[key] !== stream.start[key])) issues.add("malformed_child_observation");
    if (event.type === "stdout" || event.type === "stderr") {
      if (typeof event.base64 !== "string") { issues.add("malformed_child_observation"); continue; }
      const bytes = Buffer.from(event.base64, "base64");
      if (bytes.toString("base64") !== event.base64) { issues.add("malformed_child_observation"); continue; }
      if (event.type === "stdout") stream.chunks.push(bytes);
    }
    if (event.type === "end") {
      stream.ended = true;
      if (typeof event.aborted !== "boolean" || (event.exitCode !== null && (!Number.isInteger(event.exitCode) || event.exitCode < 0))) issues.add("malformed_child_observation");
      if (event.exitCode !== 0) issues.add("child_process_error");
      if (event.aborted === true) issues.add("child_aborted");
    }
  }
  if (!ready) issues.add("missing_child_observer_ready");
  if (!ended) issues.add("missing_child_observer_end");
  let usage = zero();
  for (const [childId, stream] of streams) {
    if (!stream.ended) issues.add("unfinished_child_run");
    const bytes = Buffer.concat(stream.chunks);
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { issues.add("invalid_child_utf8"); }
    const trace = analyzeTrace(bytes.toString("utf8"), undefined, pricing);
    usage = sum(usage, trace.parent);
    for (const issue of trace.issues) issues.add(`child_${issue}`);
    for (const model of trace.models) models.add(model);
    runs.push({ childId, runId: stream.start.runId, role: stream.start.role, profile: stream.start.profile, turns: trace.parentTurns, usage: trace.parent, issues: trace.issues });
  }
  return { usage, issues, models, runs };
}
