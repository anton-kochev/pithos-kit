import { randomUUID } from "node:crypto";
import { matchesBasePricing, type BasePricing } from "./pricing.ts";

const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const count = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
export function responseMeter(event: unknown) {
  const e = object(event);
  if (!["response.completed", "response.done", "response.incomplete", "response.failed"].includes(e.type)) return undefined;
  const r = object(e.response), u = object(r.usage), details = object(u.input_tokens_details);
  return {
    responseId: typeof r.id === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(r.id) ? r.id : null,
    model: typeof r.model === "string" && /^[a-zA-Z0-9_.-]{1,256}$/.test(r.model) ? r.model : null,
    status: ["completed", "incomplete", "failed", "cancelled"].includes(r.status) ? r.status as string : null,
    serviceTier: ["default", "auto", "scale", "flex", "priority"].includes(r.service_tier) ? r.service_tier as string : null,
    input: count(u.input_tokens), output: count(u.output_tokens), total: count(u.total_tokens),
    cacheRead: count(details.cached_tokens), cacheWrite: count(details.cache_write_tokens),
  };
}
type Payload = { type: "start" } | { type: "response"; meter: NonNullable<ReturnType<typeof responseMeter>> }
  | { type: "end"; reason: "eof" | "terminal" | "cancelled" | "error" | "no_body" | "closed" }
  | { type: "observation_error" };
export type MeterRecord = { attemptId: string; transport: "sse" | "websocket" } & Payload;
type Report = (record: MeterRecord) => void;
// Reconciliation is not an attestation: the native driver must bind the actual
// producer, request context and raw evidence to these inputs before using it.
export function verifyResponseMeters(records: unknown[], messages: any[], pricing: BasePricing): boolean {
  const exact = (v: any, keys: string[]) => v && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
  try {
    if (!Array.isArray(records) || !Array.isArray(messages) || !messages.length || records.length > 4096) return false;
    const runs = new Map<string, { transport: string; meter?: any; ended: boolean }>();
    for (const raw of records) {
      const r = object(raw), keys = ["attemptId", "transport", "type"];
      if (r.type === "response") keys.push("meter"); else if (r.type === "end") keys.push("reason");
      if (!exact(r, keys) || typeof r.attemptId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.attemptId)
        || !["sse", "websocket"].includes(r.transport)) return false;
      const run = runs.get(r.attemptId);
      if (r.type === "start") {
        if (run) return false;
        runs.set(r.attemptId, { transport: r.transport, ended: false });
      } else {
        if (!run || run.ended || run.transport !== r.transport) return false;
        if (r.type === "response") {
          if (run.meter) return false;
          run.meter = r.meter;
        } else if (r.type === "end") {
          if (!run.meter || !(r.transport === "sse" ? ["eof", "cancelled"] : ["terminal"]).includes(r.reason)) return false;
          run.ended = true;
        } else return false;
      }
    }
    if (runs.size !== messages.length) return false;
    const seen = new Set<string>();
    for (const run of runs.values()) {
      const m = run.meter;
      const legacyKeys = ["responseId", "status", "serviceTier", "input", "output", "total", "cacheRead", "cacheWrite"];
      if (!run.ended || !(exact(m, legacyKeys) || exact(m, [...legacyKeys, "model"]))
        || (Object.hasOwn(m, "model") && m.model !== null && m.model !== messages.find(message => message?.responseId === m.responseId)?.model)
        || typeof m.responseId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(m.responseId) || seen.has(m.responseId)
        || m.status !== "completed" || m.serviceTier !== "default") return false;
      seen.add(m.responseId);
      if (![m.input, m.output, m.total, m.cacheRead, m.cacheWrite].every(n => count(n) !== null)
        || !Number.isSafeInteger(m.input + m.output) || m.input + m.output !== m.total || m.cacheRead + m.cacheWrite > m.input) return false;
      const matches = messages.filter(message => message?.responseId === m.responseId);
      if (matches.length !== 1) return false;
      const message = matches[0], u = message.usage;
      if (message.role !== "assistant" || !["stop", "toolUse"].includes(message.stopReason) || !matchesBasePricing(pricing, message)
        || u.input !== m.input - m.cacheRead - m.cacheWrite || u.output !== m.output || u.totalTokens !== m.total
        || u.cacheRead !== m.cacheRead || u.cacheWrite !== m.cacheWrite) return false;
    }
    return true;
  } catch { return false; }
}
function attempt(transport: MeterRecord["transport"], report: Report) {
  const attemptId = randomUUID();
  let ended = false, failed = false;
  const emit = (record: Payload) => {
    try { report({ attemptId, transport, ...record }); }
    catch { throw new Error("Response observation failed"); }
  };
  emit({ type: "start" });
  return {
    fail() { if (!failed) { failed = true; emit({ type: "observation_error" }); } },
    event(value: unknown) { const meter = responseMeter(value); if (meter && !failed) emit({ type: "response", meter }); return meter !== undefined; },
    end(reason: Extract<Payload, { type: "end" }>["reason"]) { if (!ended) { ended = true; emit({ type: "end", reason }); } },
  };
}
const MAX_FRAME = 1024 * 1024, MAX_STREAM = 16 * 1024 * 1024;
function sse(record: ReturnType<typeof attempt>) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", bytes = 0, failed = false;
  return (value?: Uint8Array) => {
    if (failed) return;
    const events: unknown[] = [];
    try {
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_STREAM) throw Error();
      pending += value ? decoder.decode(value, { stream: true }) : decoder.decode();
      if (!value && pending.trim()) pending += "\n\n";
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        if (Buffer.byteLength(frame) > MAX_FRAME) throw Error();
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n").trim();
        if (data && data !== "[DONE]") events.push(JSON.parse(data));
      }
      if (Buffer.byteLength(pending) > MAX_FRAME) throw Error();
    } catch { failed = true; pending = ""; }
    for (const event of events) record.event(event);
    if (failed) record.fail();
  };
}
export function observeWebSocket(Base: typeof WebSocket, report: Report): typeof WebSocket {
  return class extends Base {
    private observation?: ReturnType<typeof attempt>;
    private bytes = 0;
    private invalid = false;
    private end(reason: Extract<Payload, { type: "end" }>["reason"]) {
      const current = this.observation; this.observation = undefined; current?.end(reason);
    }
    private guarded(action: () => void) {
      try { action(); }
      catch { this.observation = undefined; try { this.close(1008, "Response observation failed"); } catch { /* retained partial evidence is incomplete */ } }
    }
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener("close", () => this.guarded(() => this.end("closed")));
      this.addEventListener("error", () => this.guarded(() => this.end("error")));
      this.addEventListener("message", event => this.guarded(() => {
        if (!this.observation || this.invalid) return;
        let parsed: unknown;
        try {
          const value = event.data;
          if (typeof value !== "string" && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) throw Error();
          const size = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
          this.bytes += size;
          if (size > MAX_FRAME || this.bytes > MAX_STREAM) throw Error();
          parsed = JSON.parse(typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value));
        } catch { this.invalid = true; this.observation.fail(); return; }
        if (this.observation.event(parsed)) this.end("terminal");
        else if (object(parsed).type === "error") this.end("error");
      }));
    }
    override send(data: Parameters<WebSocket["send"]>[0]) {
      if (this.observation) {
        try { this.observation.fail(); } finally { this.end("error"); }
        throw new Error("Overlapping WebSocket observation is unsupported");
      }
      this.bytes = 0; this.invalid = false;
      this.observation = attempt("websocket", report);
      try { super.send(data); } catch (error) { this.end("error"); throw error; }
    }
  };
}
// This wrapper observes only response consumption. It never inspects request headers/body.
export function observeFetch(delegate: typeof fetch, report: Report): typeof fetch {
  return async (input, init) => {
    const record = attempt("sse", report);
    let response: Response;
    try { response = await delegate(input, init); }
    catch (error) { record.end("error"); throw error; }
    if (!response.body) { record.end("no_body"); return response; }
    const reader = response.body.getReader(), consume = sse(record);
    const observed = new Response(new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { consume(); record.end("eof"); controller.close(); reader.releaseLock(); }
          else { consume(value); controller.enqueue(value); }
        } catch (error) {
          try { await reader.cancel(); } finally { record.end("error"); controller.error(error); }
        }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { record.end("cancelled"); } },
    }, { highWaterMark: 0 }), { status: response.status, statusText: response.statusText, headers: response.headers });
    for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(observed, key, { value: response[key] });
    return observed;
  };
}
