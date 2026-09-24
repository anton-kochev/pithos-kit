import { isDeepStrictEqual } from "node:util";
import { verifyResponseMeters } from "./response-observer.ts";
import { analyzeTrace } from "./trace.ts";
import type { BasePricing } from "./pricing.ts";

export function validateSyntheticGuild(e: any, pricing: BasePricing) {
  try {
    const trace = analyzeTrace(e.parent.map((r: any) => JSON.stringify(r)).join("\n"), e.children, pricing);
    if (!trace.complete || trace.parentTurns !== 2 || trace.childRuns.length !== 2 || trace.childRuns.some(r => r.turns !== 1)) throw Error();
    const targets = ["explorer/typescript", "coder/typescript"];
    if (!isDeepStrictEqual(trace.childRuns.map(r => `${r.role}/${r.profile}`), targets)
      || e.outcome.status !== 0 || e.outcome.signal !== null || e.outcome.timedOut !== false || e.outcome.limited !== false || e.outcome.captureFailed !== false
      || e.native.length !== 3 || e.transports.length !== 3) throw Error();
    const used = new Set<string>(), pids = new Set<number>();
    const unique = (kind: string, id: string) => { if (typeof id !== "string" || !id.length || used.has(`${kind}:${id}`)) throw Error(); used.add(`${kind}:${id}`); };
    const observations = e.children.split("\n").filter(Boolean).map((line: string) => JSON.parse(line));
    let active: string | undefined;
    for (const r of observations) {
      if (r.type === "start") { if (active !== undefined) throw Error(); active = r.childId; }
      if (r.type === "end") { if (active !== r.childId) throw Error(); active = undefined; }
    }
    if (active !== undefined) throw Error();
    const assistants = (events: any[]) => events.filter(r => r.type === "message_end" && r.message?.role === "assistant").map(r => r.message);
    const parentMessages = assistants(e.parent);
    const terminal = (events: any[], messages: any[]) => {
      const last = messages.at(-1);
      if (events.filter(r => r.type === "agent_settled").length !== 1 || last?.stopReason !== "stop" || last.content.length !== 1
        || last.content[0].type !== "text" || last.content[0].text !== "Synthetic offline result") throw Error();
    };
    terminal(e.parent, parentMessages);
    if (parentMessages[0].stopReason !== "toolUse" || parentMessages[0].content.length !== 2 || !isDeepStrictEqual(trace.childReported, trace.childObserved)) throw Error();
    const starts = e.parent.filter((r: any) => r.type === "tool_execution_start"), ends = e.parent.filter((r: any) => r.type === "tool_execution_end");
    if (starts.length !== 2 || ends.length !== 2 || e.parent.some((r: any) => r.type.startsWith("tool_") && r.toolName !== "guild_handover")) throw Error();
    parentMessages[0].content.forEach((call: any, i: number) => {
      if (call.type !== "toolCall" || call.name !== "guild_handover" || call.arguments.role !== targets[i].split("/")[0] || call.arguments.profile !== "typescript"
        || starts[i].toolCallId !== call.id || !isDeepStrictEqual(starts[i].args, call.arguments)) throw Error();
      const end = ends.filter((r: any) => r.toolCallId === call.id);
      if (end.length !== 1 || end[0].isError !== false || !isDeepStrictEqual(end[0].result.content, [{ type: "text", text: "Synthetic offline result" }])) throw Error();
      const run = trace.childRuns.find(r => r.runId === call.id);
      if (!run || Object.entries(run.usage).some(([key, value]) => end[0].result.details.usage[key] !== value)) throw Error();
    });
    const spawns: any[] = [];
    function producer(pid: number, target: string | null, messages: any[]) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === e.parentPid || pids.has(pid)) throw Error(); pids.add(pid);
      const records = e.native.filter((r: any[]) => r[0]?.pid === pid);
      const transports = e.transports.filter((r: any) => r.pid === pid);
      if (records.length !== 1 || transports.length !== 1) throw Error();
      const rows = records[0], actor = target ? "child" : "parent", ppid = target ? e.outcome.pid : e.parentPid;
      const t = transports[0];
      if (t.version !== 1 || t.actor !== actor || t.ppid !== ppid || t.namespace !== e.isolation.namespace || t.uid !== e.isolation.uid
        || !isDeepStrictEqual(t.stats, { version: 1, sockets: 1, sends: messages.length, fetches: 0, rejected: 0, ...(!target ? { handoffs: 2 } : {}) })) throw Error();
      rows.forEach((r: any, sequence: number) => { if (r.version !== 1 || r.pid !== pid || r.ppid !== ppid || r.actor !== actor || r.sequence !== sequence) throw Error(); });
      let cursor = 0, prompt: string | undefined;
      const next = (type: string) => { const r = rows[cursor++]; if (r?.type !== type) throw Error(); return r; };
      const context = () => {
        const r = next("context");
        const tools = target === "explorer/typescript" ? ["find", "grep", "ls", "read"] : ["bash", "edit", "find", "grep", "ls", "read", "write", ...(!target ? ["guild_handover"] : [])].sort();
        if (r.target !== target || r.model !== pricing.model || r.thinking !== "high" || !isDeepStrictEqual(r.tools, tools)
          || !/^[a-f0-9]{64}$/.test(r.systemPromptDigest) || (prompt !== undefined && r.systemPromptDigest !== prompt)) throw Error();
        prompt = r.systemPromptDigest;
      };
      const start = next("process_start"); if (start.node !== "v24.20.0" || start.piVersion !== "0.85.1") throw Error(); context();
      for (let i = 0; i < messages.length; i++) {
        if (!target && i === 1) spawns.push(next("child_spawn"), next("child_spawn"));
        const request = next("request_start").requestId; unique("request", request);
        context(); context();
        const payload = next("payload");
        if (payload.requestId !== request || payload.final.model !== "gpt-6-astra" || payload.final.thinking !== "high" || !["omitted", "default"].includes(payload.final.serviceTier)) throw Error();
        const meters = [next("transport"), next("transport"), next("transport")];
        if (meters.some(r => r.requestId !== request || r.record.transport !== "websocket") || !verifyResponseMeters(meters.map(r => r.record), [messages[i]], pricing)) throw Error();
        unique("attempt", meters[0].record.attemptId); unique("response", messages[i].responseId);
        const end = next("request_end"); if (end.requestId !== request || end.complete !== true) throw Error();
      }
      if (next("process_end").exitCode !== 0 || cursor !== rows.length) throw Error();
    }
    producer(e.outcome.pid, null, parentMessages);
    trace.childRuns.forEach((run, i) => {
      const spawn = spawns.filter(r => r.childId === run.childId);
      if (spawn.length !== 1) throw Error();
      const raw = Buffer.concat(observations.filter((r: any) => r.childId === run.childId && r.type === "stdout").map((r: any) => Buffer.from(r.base64, "base64"))).toString("utf8");
      const child = raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
      const messages = assistants(child); terminal(child, messages);
      if (child.some(r => r.type.startsWith("tool_") || r.message?.role === "toolResult")) throw Error();
      producer(spawn[0].childPid, targets[i], messages);
    });
    return { requests: 4, processes: 3, targets, usage: trace.totalObserved };
  } catch { throw new Error("Synthetic Guild evidence mismatch"); }
}
