import { randomUUID } from "node:crypto";
import { digest } from "./manifest.ts";
import { validateBasePricing, type BasePricing } from "./pricing.ts";
import { observeFetch, observeWebSocket, verifyResponseMeters, type MeterRecord } from "./response-observer.ts";

import { assertScopedAuthAccess, type ScopedAuthIdentity } from "./scoped-auth-identity.ts";

export function verifyNativePreparedAuth(prepared: any, file: string, expected: ScopedAuthIdentity) {
  try {
    if (!new Headers(prepared.options.headers).keys().next().done || !new Headers(prepared.model.headers).keys().next().done
      || (prepared.options.env && Object.keys(prepared.options.env).length)) throw Error();
    return assertScopedAuthAccess(file, expected, prepared.options.apiKey);
  } catch { throw new Error("Native authentication policy mismatch"); }
}

const MAX_REQUEST_BYTES = 1024 * 1024;
function materializeRequest(value: unknown) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw Error();
  return JSON.parse(serialized);
}
// Candidate-only supported JSON body. Unknown transport/options fields are not
// evidence: reject them rather than stripping them and certifying another body.
export function validateCandidateRequestBody(value: any): void {
  const check = (ok: unknown): void => { if (!ok) throw new Error("Candidate request body mismatch"); };
  const record = (v: any, required: string[], optional: string[] = []) => {
    check(v && typeof v === "object" && !Array.isArray(v));
    check(required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, ...optional].includes(k)));
  };
  const text = (v: any) => check(typeof v === "string");
  // Deliberately small JSON-schema vocabulary, not arbitrary provider metadata.
  const schema = (v: any, depth = 0): void => {
    check(depth <= 32);
    record(v, ["type"], ["description", "properties", "required", "additionalProperties", "items", "enum"]);
    check(["object", "array", "string", "number", "integer", "boolean", "null"].includes(v.type));
    if (v.description !== undefined) text(v.description);
    if (v.properties !== undefined) {
      check(v.type === "object" && v.properties && typeof v.properties === "object" && !Array.isArray(v.properties));
      Object.values(v.properties).forEach(child => schema(child, depth + 1));
    }
    if (v.required !== undefined) check(Array.isArray(v.required) && v.required.every((k: any) => typeof k === "string"));
    if (v.additionalProperties !== undefined) check(typeof v.additionalProperties === "boolean");
    if (v.items !== undefined) { check(v.type === "array"); schema(v.items, depth + 1); }
    if (v.enum !== undefined) check(Array.isArray(v.enum) && v.enum.every((x: any) => x === null || ["string", "number", "boolean"].includes(typeof x)));
  };
  record(value, ["model", "reasoning", "instructions", "tools", "input"], ["service_tier"]);
  text(value.model); text(value.instructions);
  record(value.reasoning, ["effort"]); text(value.reasoning.effort);
  check(value.service_tier === undefined || value.service_tier === "default");
  check(Array.isArray(value.tools) && value.tools.length <= 64);
  for (const tool of value.tools) {
    record(tool, ["type", "name"], ["description", "parameters", "strict"]);
    check(tool.type === "function"); text(tool.name);
    if (tool.description !== undefined) text(tool.description);
    if (tool.strict !== undefined) check(typeof tool.strict === "boolean");
    if (tool.parameters !== undefined) schema(tool.parameters);
  }
  check(Array.isArray(value.input) && value.input.length <= 4096);
  for (const item of value.input) {
    if (item?.type === "function_call_output") {
      record(item, ["type", "call_id", "output"]); text(item.call_id); text(item.output);
    } else if (item?.type === "function_call") {
      record(item, ["type", "call_id", "name", "arguments"]); text(item.call_id); text(item.name); text(item.arguments);
    } else {
      record(item, ["role", "content"], ["type"]);
      check(["user", "assistant", "system", "developer"].includes(item.role) && (item.type === undefined || item.type === "message"));
      if (typeof item.content !== "string") {
        check(Array.isArray(item.content) && item.content.length <= 4096);
        for (const part of item.content) { record(part, ["type", "text"]); check(["input_text", "output_text"].includes(part.type)); text(part.text); }
      }
    }
  }
}
function rejectAccessMaterial(value: any, access: string): void {
  if (typeof value === "string" && value.includes(access)) throw Error();
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (key.includes(access)) throw Error();
    rejectAccessMaterial(child, access);
  }
}
export interface LogicalRequestContent { instructions: unknown; tools: unknown; input: unknown }
const logicalContent = (value: any): LogicalRequestContent => ({ instructions: value?.instructions, tools: value?.tools, input: value?.input });
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
type PayloadCallback = (payload: any, ...args: any[]) => unknown | Promise<unknown>;
export interface FinalRequest { model: string; thinking: string; serviceTier: "omitted" | "default" }
export function guardFinalPayload(callback: PayloadCallback | undefined, expected: { model: string; thinking: string }, report: (value: FinalRequest) => void,
  reportContent?: (logical: LogicalRequestContent, outbound: unknown) => void, activeAccess?: string): (payload: any, ...args: any[]) => Promise<unknown> {
  return async (payload, ...args) => {
    let final: any, logical: LogicalRequestContent | undefined, contentMatches = false;
    try {
      const initial = materializeRequest(payload);
      if (reportContent) { validateCandidateRequestBody(initial); if (activeAccess) rejectAccessMaterial(initial, activeAccess); }
      logical = materializeRequest(logicalContent(initial));
      const before = digest(logical);
      const replacement = await callback?.(payload, ...args);
      // Materialize the JSON the SDK will send. Inspecting before toJSON/getters
      // run or returning the original mutable object leaves a policy-check gap.
      final = materializeRequest(replacement === undefined ? payload : replacement);
      if (reportContent) { validateCandidateRequestBody(final); if (activeAccess) rejectAccessMaterial(final, activeAccess); }
      contentMatches = before === digest(materializeRequest(logicalContent(final)));
    } catch { throw new Error("Final request observation failed"); }
    if (!contentMatches || !final || Array.isArray(final) || final.model !== expected.model || final.reasoning?.effort !== expected.thinking
      || (final.service_tier !== undefined && final.service_tier !== "default")) throw new Error("Final request policy mismatch");
    try {
      report({ model: final.model, thinking: final.reasoning.effort, serviceTier: final.service_tier === undefined ? "omitted" : "default" });
      if (reportContent) reportContent(freeze(materializeRequest(logical)), freeze(materializeRequest(final)));
    } catch { throw new Error("Final request observation failed"); }
    return final;
  };
}
export type RequestObservation = { requestId: string | null } & (
  { type: "request_start" } | { type: "payload"; final: FinalRequest }
  | { type: "request_content"; logical: LogicalRequestContent; outbound: unknown }
  | { type: "transport"; record: MeterRecord } | { type: "request_end"; complete: boolean }
);
interface GateOptions {
  pricing: BasePricing;
  thinking: string;
  verifyContext: () => void | Promise<void>;
  verifyPrepared?: (prepared: any, runtime: any) => void | Promise<void>;
  report: (event: RequestObservation) => void;
  requestContentEvidence?: "candidate-native-v2";
  webSocketHost?: { WebSocket?: typeof WebSocket };
}
export function installNativeRequestGate(Runtime: any, options: GateOptions): () => void {
  if (options.requestContentEvidence !== undefined && options.requestContentEvidence !== "candidate-native-v2")
    throw new Error("Native request content evidence mode mismatch");
  options = { ...options, pricing: validateBasePricing(options.pricing) };
  const pricing = options.pricing, original = Runtime.prototype.prepareRequest;
  const host = options.webSocketHost ?? globalThis, socket = host.WebSocket;
  type Run = { id: string; meters: MeterRecord[]; payloads: number; payloadDigest?: string; invalid: boolean; ended: boolean };
  let active: Run | undefined;
  const emit = (event: RequestObservation) => {
    try { options.report(event); } catch { throw new Error("Native request observation failed"); }
  };
  const meter = (run: Run | undefined, record: MeterRecord) => {
    run?.meters.push(record); emit({ type: "transport", requestId: run?.id ?? null, record });
  };
  const checkTransport = (run: Run | undefined) => {
    if (!run || active !== run || run.ended || run.invalid || run.payloads !== 1 || !run.payloadDigest) {
      if (run && active === run && !run.ended) run.invalid = true;
      throw new Error("Transport without a verified final request");
    }
  };
  const checkOutbound = (run: Run, body: unknown, websocket = false) => {
    try {
      if (typeof body !== "string" || Buffer.byteLength(body) > MAX_REQUEST_BYTES
        || Buffer.from(body, "utf8").toString("utf8") !== body) throw Error();
      const parsed = JSON.parse(body);
      const pending: unknown[] = [parsed];
      while (pending.length) {
        const value = pending.pop();
        // JSON.parse accepts overflowing exponents; canonical hashing must not
        // collapse an outbound Infinity to the expected JSON null.
        if (typeof value === "number" && !Number.isFinite(value)) throw Error();
        if (value && typeof value === "object") for (const child of Object.values(value)) pending.push(child);
      }
      if (websocket) {
        if (parsed?.type !== "response.create") throw Error();
        delete parsed.type; // Only this explicitly supported transport envelope differs.
      }
      if (digest(parsed) !== run.payloadDigest) throw Error();
    } catch { run.invalid = true; throw new Error("Outbound request mismatch"); }
  };
  const observedSocket = socket ? observeWebSocket(class extends socket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) { checkTransport(active); super(...args); }
    override send(data: Parameters<WebSocket["send"]>[0]) { checkTransport(active); checkOutbound(active!, data, true); super.send(data); }
  }, record => meter(active, record)) : undefined;
  if (observedSocket) host.WebSocket = observedSocket;
  const end = (run: Run, complete: boolean) => {
    if (run.ended) return;
    run.ended = true; run.payloadDigest = undefined; if (active === run) active = undefined;
    emit({ type: "request_end", requestId: run.id, complete });
  };
  const wrapped = async function (this: any, model: any, supplied: any) {
    if (active) throw new Error("Overlapping native request is unsupported");
    const run: Run = { id: randomUUID(), meters: [], payloads: 0, invalid: false, ended: false };
    active = run;
    try {
      emit({ type: "request_start", requestId: run.id });
      await options.verifyContext();
      const prepared = await original.call(this, model, supplied);
      await options.verifyPrepared?.(prepared, this);
      await options.verifyContext();
      if (`${prepared.model.provider}/${prepared.model.id}` !== pricing.model || prepared.model.api !== pricing.api
        || digest(prepared.model.cost) !== digest(pricing.cost) || prepared.model.baseUrl !== model.baseUrl
        || prepared.options.maxRetries !== 0) throw new Error("Prepared request policy mismatch");
      // The prepared credential stays local to this guard, never in producer
      // records, callback arguments, configuration or independent audit inputs.
      const activeAccess = options.requestContentEvidence === "candidate-native-v2" ? prepared.options.apiKey : undefined;
      if (options.requestContentEvidence === "candidate-native-v2"
        && (typeof activeAccess !== "string" || !activeAccess.length || activeAccess.length > 65536)) throw Error();
      const guardedPayload = guardFinalPayload(prepared.options.onPayload, { model: prepared.model.id, thinking: options.thinking }, final => {
        if (++run.payloads !== 1) throw new Error("Repeated final request payload");
        emit({ type: "payload", requestId: run.id, final });
      }, options.requestContentEvidence === "candidate-native-v2"
        ? (logical, outbound) => emit({ type: "request_content", requestId: run.id, logical, outbound }) : undefined, activeAccess);
      const configured = { ...prepared.options,
        onPayload: async (payload: any, ...args: any[]) => {
          try {
            if (run.invalid || run.ended || active !== run) throw Error();
            const final = await guardedPayload(payload, ...args);
            run.payloadDigest = digest(final); // Process-local only; do not retain request content in v1 records.
            return final;
          } catch { run.invalid = true; throw new Error("Final request observation failed"); }
        },
        fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          checkTransport(run);
          let snapshot: RequestInit;
          try { snapshot = { ...init }; checkOutbound(run, snapshot.body); }
          catch { run.invalid = true; throw new Error("Outbound request mismatch"); }
          return observeFetch(prepared.options.fetch ?? globalThis.fetch, record => meter(run, record))(input, snapshot);
        },
      };
      const provider = { ...prepared.provider };
      for (const name of ["stream", "streamSimple"]) {
        if (typeof provider[name] !== "function") continue;
        provider[name] = function (...args: any[]) {
          let source: any;
          try { source = prepared.provider[name].apply(prepared.provider, args); }
          catch { end(run, false); throw new Error("Native provider stream failed"); }
          return {
            async *[Symbol.asyncIterator]() {
              try {
                for await (const event of source) {
                  if (event.type === "done") {
                    const complete = !run.invalid && !run.ended && run.payloads === 1 && verifyResponseMeters(run.meters, [event.message], pricing);
                    end(run, complete);
                    if (!complete) throw new Error("Native request evidence mismatch");
                  }
                  if (event.type === "error") end(run, false);
                  yield event;
                }
                if (!run.ended) throw new Error("Missing native request completion");
              } finally { end(run, false); }
            },
          };
        };
      }
      return { ...prepared, provider, options: configured };
    } catch { end(run, false); throw new Error("Native request preparation failed"); }
  };
  Runtime.prototype.prepareRequest = wrapped;
  return () => {
    if (active) throw new Error("Cannot dispose an active native request");
    if (Runtime.prototype.prepareRequest !== wrapped || (observedSocket && host.WebSocket !== observedSocket)) throw new Error("Native request observer changed before disposal");
    Runtime.prototype.prepareRequest = original;
    if (observedSocket) host.WebSocket = socket;
  };
}
