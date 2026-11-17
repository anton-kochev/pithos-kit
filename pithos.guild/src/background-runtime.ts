import type { ConcurrentRunQueueOptions } from "./concurrent-run-queue.ts";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { createGuildBackgroundAdmission, readPersistedPlanState, type BackgroundAdmissionContext } from "./background-admission.ts";
import { BackgroundRunRegistry, copyResult, type BackgroundSnapshot, type BackgroundLifecycleChange, type BackgroundLimits } from "./background-runs.ts";
import { GuildExecutionAuthority, type GuildOwner } from "./execution-authority.ts";
import { runBackgroundGuildRole, type RunBackgroundGuildRoleOptions, type BackgroundControl } from "./background-runner.ts";
import { projectBackgroundResult, type BackgroundTerminalResult } from "./background-result.ts";
import { buildTask, type GuildInput } from "./protocol.ts";
import { discoverPlan, revalidatePlan, type CoordinationBus, type PlanReadiness } from "./plan-coordination.ts";
import { planBoundaryFor } from "./safety.ts";
import type { GuildParsedEvent, RunUsage } from "./runner.ts";

export interface BackgroundRunMetadata {
 readonly owner: GuildOwner;
 readonly runId: string;
 readonly taskId: string;
 readonly role: GuildInput["role"];
 readonly profile: GuildInput["profile"];
 /** At most 160 UTF-8 bytes, without splitting a Unicode code point. */
 readonly taskPreview: string;
 readonly taskSummary?: string;
 readonly cwd: string;
 readonly model?: string;
 readonly thinkingLevel?: string;
 readonly projectTrusted: boolean;
}
export interface BackgroundRunSummary {
 readonly usage: Readonly<Partial<RunUsage>>;
 readonly activity?: string;
 readonly activityTool?: string;
 readonly status?: string;
}
function preview(text: string): string {
 let result = "";
 for (const character of text) {
  if (Buffer.byteLength(result + character, "utf8") > 160) break;
  result += character;
 }
 return result;
}
function summarize(update: Parameters<NonNullable<RunBackgroundGuildRoleOptions["onUpdate"]>>[0]): BackgroundRunSummary {
 const usage: Partial<RunUsage> = {};
 for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns"] as const) {
  const value = update.usage?.[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
 }
 const strings: { activity?: string; activityTool?: string; status?: string } = {};
 for (const key of ["activity", "activityTool", "status"] as const) {
  if (typeof update[key] === "string") strings[key] = preview(update[key]);
 }
 return Object.freeze({ ...strings, usage: Object.freeze(usage) });
}

class EventObservationLimit extends Error {}

function observationEvent(event: GuildParsedEvent): GuildParsedEvent {
 const cap = 64 * 1024;
 let remaining = cap, nodes = 4096;
 const seen = new Set<object>();
 const charge = (bytes: number) => { if ((remaining -= bytes) < 0) throw new EventObservationLimit(); };
 // Bound traversal and serialization before copyResult; never stringify an oversized payload.
 const measure = (value: unknown, depth = 0): void => {
  if (--nodes < 0 || depth > 32) throw new EventObservationLimit();
  if (typeof value === "string") {
   if (value.length > remaining) throw new EventObservationLimit();
   charge(Buffer.byteLength(JSON.stringify(value))); return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") { charge(32); return; }
  if (!value || typeof value !== "object" || types.isProxy(value)) throw new Error("Invalid event observation.");
  if (seen.has(value)) throw new Error("Repeated event object.");
  seen.add(value);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("Invalid event prototype.");
  if (array && value.length > nodes) throw new EventObservationLimit();
  charge(2);
  for (const key in value) {
   const descriptor = Object.getOwnPropertyDescriptor(value, key);
   if (!descriptor || !("value" in descriptor)) throw new Error("Invalid event property.");
   measure(key, depth + 1); charge(2); measure(descriptor.value, depth + 1);
  }
 };
 try {
  measure(event);
  return copyResult(event, cap) as GuildParsedEvent;
 } catch (error) {
  if (!(error instanceof EventObservationLimit)) throw error;
  // Dropping a large terminal event would leave its delivered start running forever.
  // Project only lifecycle scalars; output/arguments remain omitted, not retained aliases.
  const field = (object: unknown, key: string): unknown => object && typeof object === "object" && !types.isProxy(object)
   ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
  const type = field(event, "type");
  const message = type === "message_end" ? field(event, "message") : undefined;
  const source = type === "tool_execution_end" ? event : field(message, "role") === "toolResult" ? message : undefined;
  const toolCallId = field(source, "toolCallId"), toolName = field(source, "toolName");
  if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 256 || Buffer.byteLength(toolCallId) > 256 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(toolCallId)) throw error;
  const name = typeof toolName === "string" && toolName.length <= 128 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(toolName) ? toolName : undefined;
  return copyResult({type: "tool_execution_end", toolCallId, ...(name ? {toolName: name} : {}), isError: field(source, "isError") === true,
   result: {content: [{type: "text", text: "[tool output omitted: observation limit]"}]}}, cap) as GuildParsedEvent;
 }
}

/** Non-owning UI state; intermediate changes may coalesce, never a transcript or report. */
export interface BackgroundChange extends Omit<BackgroundLifecycleChange, "id"> {
 readonly owner: GuildOwner;
 readonly runId: string;
 readonly taskId: string;
 readonly role: GuildInput["role"];
 readonly profile: GuildInput["profile"];
 /** At most 160 UTF-8 bytes, without splitting a Unicode code point. */
 readonly taskPreview: string;
 readonly taskSummary?: string;
}

export interface BackgroundAdmissionObservation {
 readonly id: string;
 readonly taskId: string;
 readonly input: GuildInput;
 readonly capturedContext: unknown;
}
export interface BackgroundTerminalObservation {
 readonly admission: BackgroundAdmissionObservation;
 readonly token: unknown;
 readonly snapshot: BackgroundSnapshot;
 readonly result: Readonly<BackgroundTerminalResult>;
}
export interface BackgroundObserver {
 /** Bounded JSON copied and deeply frozen at start, never a live SDK context. */
 capturedContext: unknown;
 /** Synchronous reservation. A throw prevents child launch; a written marker may remain interrupted. */
 reserve(admission: BackgroundAdmissionObservation): unknown;
 /** Awaited observation capability survives retirement. Never await own cancel/retire/shutdown here. */
 onTerminal(observation: BackgroundTerminalObservation): void | PromiseLike<void>;
}

export interface GuildBackgroundContext extends BackgroundAdmissionContext {
 /** Effectful host validation runs before Plan reads/discovery. Public adapters supply both guards. */
 validateCurrent?(): boolean;
 /** Trusted host predicate: read-only, with no coordination, UI, persistence or observable mutation.
  * Check immutable owner/session/epoch/capability/cwd/trust after all effectful callouts.
  * Read-only SDK predicates are permitted; function presence is not purity attestation.
  * Both guards may be absent only for legacy internal fixtures.
  */
 isContextCurrent?(): boolean;
 observation?: BackgroundObserver;
 cwd: string;
 model?: string;
 thinkingLevel?: string;
 projectTrusted: boolean;
 /** Synchronous observers only; asynchronous host side effects cannot be fenced. */
 onEvent?: RunBackgroundGuildRoleOptions["onEvent"];
 onUpdate?: RunBackgroundGuildRoleOptions["onUpdate"];
}
type Binding = Readonly<Omit<GuildBackgroundContext, "getBranch" | "observation"> & {
 owner: GuildOwner; taskId: string;
 readonly metadata: BackgroundRunMetadata;
 check(): void;
 checkCurrent(): void;
 beforeSchedule(id: string, input: GuildInput): void;
 onChange(change: BackgroundLifecycleChange): void;
 onTerminal(snapshot: BackgroundSnapshot): void | PromiseLike<void>;
}>;

/** Explicitly activated composition shared by blocking registration and internal background admission. */
export function createGuildBackgroundRuntime({ bus, parentEnvironment, runner = runBackgroundGuildRole, limits, onChange, onEvent, onUpdate, onRunStart, beforePlanHold }: {
 bus: CoordinationBus;
 beforePlanHold?: (owner: GuildOwner | undefined) => boolean;
 parentEnvironment?: { readonly PITHOS_GUILD_PLAN_MODE?: unknown };
 runner?: typeof runBackgroundGuildRole;
 limits?: BackgroundLimits;
 /** Deferred observer; throws and accidental promise rejections never own run lifetime. */
 onChange?: (change: BackgroundChange) => void;
 /** Trusted functions called without a host receiver; accidental promises never own execution. */
 onEvent?: (metadata: BackgroundRunMetadata, event: GuildParsedEvent) => void;
 onUpdate?: (metadata: BackgroundRunMetadata, summary: BackgroundRunSummary) => void;
 /** Synchronous trace binding. Its disposer runs after runner cleanup, including after retirement.
  * Async returns are unsupported and drained, never awaited or granted cleanup authority. */
 onRunStart?: (metadata: BackgroundRunMetadata) => void | (() => void);
}) {
 const capturedLimits = { ...limits };
 const bindings = new Map<string, Binding>();
 type Updates = { owner: GuildOwner; count: number; inFlight: number; pending: { updateId: string; text: string; accepted: boolean }[]; send?: BackgroundControl["sendUpdate"] };
 // Entries die at cancellation/cleanup; only two pending plus in-flight texts per run.
 const updates = new Map<string, Updates>();
 const discard = (id: string) => { const state = updates.get(id); if (state) { state.pending.length = 0; state.send = undefined; updates.delete(id); } };
 const discardOwner = (owner?: GuildOwner) => { for (const [id, state] of updates) if (!owner || state.owner === owner) discard(id); };
 let checking = false;
 let mode: unknown;
 try { mode = (parentEnvironment ?? process.env).PITHOS_GUILD_PLAN_MODE; }
 catch { mode = "invalid"; }
 const capturedEnvironment = Object.freeze({ PITHOS_GUILD_PLAN_MODE: mode });
 const authority = new GuildExecutionAuthority<Binding>(() => new BackgroundRunRegistry<Binding>(async request => {
  const binding = request.context;
  let live = true;
  const current = () => live && authority.isCurrent(binding.owner);
  const observe = (callback: (() => unknown)) => {
   if (!current()) return;
   try {
    // Each delivery rechecks the pure context predicate: a prior observer can stale it without retiring the owner.
    binding.checkCurrent();
    if (!current()) return;
    void Promise.resolve(callback()).catch(() => {});
   } catch { /* Guards and observers do not own transport. */ }
  };
  let dispose: (() => void) | undefined;
  const task = buildTask({ ...request.input, runId: request.id, taskId: binding.taskId });
  try {
   binding.check();
   request.signal.throwIfAborted();
   if (onRunStart) {
    observe(() => {
     const cleanup = onRunStart(binding.metadata);
     if (typeof cleanup === "function") dispose = cleanup;
     else return cleanup;
    });
    // Binding is an effectful callout: retirement or Plan activation must veto launch.
    binding.check();
    request.signal.throwIfAborted();
    if (!current()) throw new Error("Invalid or stale Guild owner.");
   }
   const result = await runner({
    ...request.input, runId: request.id, taskId: binding.taskId,
    cwd: binding.cwd, model: binding.model, thinkingLevel: binding.thinkingLevel, projectTrusted: binding.projectTrusted,
    signal: request.signal,
    onReady(control) {
     const state = updates.get(request.id);
     if (!current() || request.signal.aborted || !state || state.send) return;
     if (checking) { captureGuard.reentered = true; return; }
     checking = true; captureGuard.reentered = false;
     try {
      const send = control.sendUpdate;
      if (typeof send !== "function" || captureGuard.reentered || !current() || updates.get(request.id) !== state) throw new Error("Invalid background control.");
      state.send = text => send.call(control, text);
     } catch {
      discard(request.id);
      void authority.cancel(binding.owner, request.id).catch(() => {});
      return;
     } finally { checking = false; }
     flushUpdates(request.id, state);
    },
    onQuestion(text, questionSignal) {
     if (!current()) return Promise.reject(new Error("Stale Guild question."));
     return request.ask(text, questionSignal);
    },
    onEvent: event => {
     observe(() => onEvent?.(binding.metadata, observationEvent(event)));
     observe(() => binding.onEvent?.(event));
    },
    onUpdate: update => {
     observe(() => onUpdate?.(binding.metadata, summarize(update)));
     observe(() => binding.onUpdate?.(update));
    },
   });
   live = false;
   return projectBackgroundResult(result, task);
  } finally {
   live = false; discard(request.id);
   // Cleanup belongs to the accepted binding, not to the current UI owner.
   try { void Promise.resolve(dispose?.()).catch(() => {}); } catch { /* Non-owning cleanup. */ }
  }
 }, capturedLimits, {
  beforeSchedule: request => request.context.beforeSchedule(request.id, request.input),
  onTerminal: (snapshot, binding) => binding.onTerminal(snapshot),
  onChange: (change, binding) => binding.onChange(change),
 }), { beforePlanHold });
 let starting = false;
 const captureGuard = { reentered: false };
 async function dispatchUpdate(id: string, state: Updates, update: { updateId: string; text: string }) {
  const binding = bindings.get(id);
  if (!binding || updates.get(id) !== state || !state.send || !authority.isCurrent(state.owner)) throw new Error("Unavailable background control.");
  const snapshot = authority.status(state.owner, id);
  if (snapshot.status !== "running") throw new Error("Background update unavailable while waiting for a question or terminal.");
  binding.check();
  if (updates.get(id) !== state || !state.send || authority.status(state.owner, id).status !== "running") throw new Error("Unavailable background control while waiting for a question or terminal.");
  state.inFlight++;
  try {
   const disposition = await state.send(update.text);
   if (!authority.isCurrent(state.owner) || updates.get(id) !== state) throw new Error("Stale or unavailable background control.");
   binding.checkCurrent();
   if (updates.get(id) !== state) throw new Error("Stale or unavailable background control.");
   if (disposition !== "queued" && disposition !== "handled") throw new Error("Invalid background update disposition.");
   return Object.freeze({ updateId: update.updateId, disposition });
  } finally { state.inFlight--; }
 }
 function flushUpdates(id: string, state: Updates) {
  // Readiness may precede acceptance; only committed texts can cross the RPC boundary.
  while (state.send && state.pending[0]?.accepted) {
   const pending = state.pending.shift()!;
   void dispatchUpdate(id, state, pending).catch(() => {
    if (authority.isCurrent(state.owner)) { discard(id); void authority.cancel(state.owner, id).catch(() => {}); }
   });
  }
 }
 const admission = createGuildBackgroundAdmission({ authority, bus, parentEnvironment: capturedEnvironment, captureGuard });
 return Object.freeze({
  activate: () => authority.activate(),
  runExclusive: <T>(owner: GuildOwner, operation: (signal: AbortSignal) => T | PromiseLike<T>, signal?: AbortSignal, onPhase?: ConcurrentRunQueueOptions["onPhase"]) => authority.runExclusive(owner, operation, signal, onPhase),
  isCurrent: (owner: GuildOwner) => authority.isCurrent(owner),
  start(owner: GuildOwner, input: unknown, context: GuildBackgroundContext) {
   if (starting || checking) { captureGuard.reentered = true; throw new Error("Reentrant background capture."); }
   starting = true;
   let readBranch: (() => readonly unknown[]) | undefined;
   let reservedId: string | undefined;
   captureGuard.reentered = false;
   try {
    if (!authority.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
    const observer = context.observation;
    const reserve = observer?.reserve, publish = observer?.onTerminal;
    const capturedContext = observer ? copyResult(observer.capturedContext, 64 * 1024) : undefined;
    if (observer && (typeof reserve !== "function" || typeof publish !== "function")) throw new Error("Malformed background observer.");
    const validateCurrent = context.validateCurrent;
    const isContextCurrent = context.isContextCurrent;
    if ((validateCurrent !== undefined || isContextCurrent !== undefined)
     && (typeof validateCurrent !== "function" || typeof isContextCurrent !== "function")) throw new Error("Malformed current-context guard pair.");
    const assertCurrent = () => {
     if (!authority.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
     if (validateCurrent && validateCurrent.call(context) !== true) throw new Error("Background context is no longer current.");
     if (!authority.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
    };
    const assertFinalCurrent = () => {
     const wasChecking = checking;
     if (!checking && !starting) captureGuard.reentered = false;
     checking = true;
     try {
      if (isContextCurrent && isContextCurrent.call(context) !== true) throw new Error("Background context is no longer current.");
      if (!authority.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
      if (captureGuard.reentered) throw new Error("Reentrant background control.");
     } finally { checking = wasChecking; }
    };
    const taskId = randomUUID();
    let admitted: BackgroundAdmissionObservation, token: unknown;
    let metadata: BackgroundRunMetadata;
    let admittedPlan: PlanReadiness | undefined;
    const binding: Binding = Object.freeze({ owner, taskId, cwd: context.cwd, model: context.model,
     thinkingLevel: context.thinkingLevel, projectTrusted: context.projectTrusted, onEvent: context.onEvent, onUpdate: context.onUpdate,
     get metadata() { return metadata; },
     checkCurrent: assertFinalCurrent,
     check() {
      if (checking) { captureGuard.reentered = true; throw new Error("Reentrant background control."); }
      checking = true;
      if (!starting) captureGuard.reentered = false;
      try {
       assertCurrent();
       const branch = { getBranch: () => readBranch!() };
       const readiness = discoverPlan(bus, planBoundaryFor(mode === "standalone" ? "standalone" : "required", readPersistedPlanState(branch)), authority.planParticipant);
       if (readiness.kind === "blocked") throw new Error(`Plan admission blocked: ${readiness.reason}`);
       if (admittedPlan?.kind === "ready" && (readiness.provider !== admittedPlan.provider || !revalidatePlan(admittedPlan))) throw new Error("Plan provider changed since admission.");
       assertCurrent();
       if (readPersistedPlanState(branch) !== "inactive" || !revalidatePlan(readiness)) throw new Error("Plan changed before dispatch.");
       assertFinalCurrent();
      } finally { checking = false; }
     },
     beforeSchedule(id: string, input: GuildInput) {
      // Admission discovery has just returned; refuse stale context before reservation.
      assertFinalCurrent();
      assertCurrent();
      admitted = Object.freeze({ id, taskId, input, capturedContext });
      {
       const branch = { getBranch: () => readBranch!() };
       // Pin provider identity/generation for queued launch and later controls.
       // Reservation observers cannot change this baseline and still launch.
       const readiness = discoverPlan(bus, planBoundaryFor(mode === "standalone" ? "standalone" : "required", readPersistedPlanState(branch)), authority.planParticipant);
       if (readiness.kind === "blocked") throw new Error(`Plan admission blocked: ${readiness.reason}`);
       admittedPlan = readiness;
       if (reserve) token = reserve(admitted);
       if (readPersistedPlanState(branch) !== "inactive" || !revalidatePlan(readiness)) throw new Error("Plan changed during reservation.");
      }
      assertFinalCurrent();
      if (captureGuard.reentered) throw new Error("Reentrant background reservation.");
      if (!authority.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
      metadata = Object.freeze({ owner, runId: id, taskId, role: input.role, profile: input.profile,
       taskPreview: preview(input.task), taskSummary: input.taskSummary, cwd: binding.cwd, model: binding.model,
       thinkingLevel: binding.thinkingLevel, projectTrusted: binding.projectTrusted });
      reservedId = id; bindings.set(id, binding);
      updates.set(id, { owner, count: 0, inFlight: 0, pending: [] });
     },
     onChange(change: BackgroundLifecycleChange) {
      const { id, ...state } = change;
      let taskPreview = "";
      for (const character of admitted.input.task) {
       if (Buffer.byteLength(taskPreview + character, "utf8") > 160) break;
       taskPreview += character;
      }
      return onChange?.(Object.freeze({ ...state, owner, runId: id, taskId,
       role: admitted.input.role, profile: admitted.input.profile, taskPreview, taskSummary: admitted.input.taskSummary }));
     },
     onTerminal(snapshot: BackgroundSnapshot) {
      bindings.delete(snapshot.id); discard(snapshot.id);
      if (!publish) return;
      const original = snapshot.result as BackgroundTerminalResult | undefined;
      const result = original ? { ...original, status: snapshot.status } : {
       status: snapshot.status, runId: admitted.id, taskId, role: admitted.input.role, profile: admitted.input.profile,
       exitCode: -1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
       usageKnown: false, usageFields: [], ...(snapshot.error ? { diagnostic: snapshot.error } : {}),
      };
      return publish(Object.freeze({ admission: admitted, token, snapshot,
       result: copyResult(result, 64 * 1024) as BackgroundTerminalResult }));
     },
    });
    const getBranch = context.getBranch;
    readBranch = () => {
     if (!authority.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
     const branch = getBranch.call(context);
     if (!authority.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
     return branch;
    };
    const validText = (value: unknown) => typeof value === "string" && !!value.trim() && !value.includes("\0");
    if (!validText(binding.cwd) || [binding.model, binding.thinkingLevel].some(value => value !== undefined && !validText(value))
     || typeof binding.projectTrusted !== "boolean" || typeof getBranch !== "function"
     || [binding.onEvent, binding.onUpdate].some(value => value !== undefined && typeof value !== "function")) throw new Error("Malformed background context.");
    if (captureGuard.reentered) throw new Error("Reentrant background capture.");
    assertCurrent();
    assertFinalCurrent();
    // Retain only the owner-guarded reader, never a mutable host method lookup.
    return admission.start(owner, input, { getBranch: () => readBranch!() }, binding);
   } catch (error) { if (reservedId) { bindings.delete(reservedId); discard(reservedId); } throw error; }
   finally { starting = false; }
  },
  /** handled means RPC acceptance, not child acknowledgement of a scope change. */
  sendUpdate(owner: GuildOwner, id: string, text: string) {
   const promise = (async () => {
    if (starting || checking) { captureGuard.reentered = true; throw new Error("Reentrant background control."); }
    const snapshot = authority.status(owner, id);
    const state = updates.get(id);
    if (!state || state.owner !== owner || !["queued", "running"].includes(snapshot.status)) throw new Error("Background update unavailable while waiting for a question or terminal.");
    if (typeof text !== "string" || !text.trim() || text.includes("\0") || Buffer.byteLength(text) > 8192) throw new Error("Invalid update text.");
    if (state.count >= 32 || state.pending.length + state.inFlight >= 2) throw new Error("Background update limit exceeded.");
    const update = { updateId: `${id}:update:${++state.count}`, text, accepted: false };
    if (!state.send) {
     state.pending.push(update);
     try {
      // Fence asynchronous delivery, without waiting for a worker or its readiness.
      await Promise.resolve();
      if (!authority.isCurrent(owner) || updates.get(id) !== state) throw new Error("Stale or unavailable background control.");
      const binding = bindings.get(id);
      if (!binding) throw new Error("Unavailable background control.");
      binding.checkCurrent();
      if (!authority.isCurrent(owner) || updates.get(id) !== state) throw new Error("Stale or unavailable background control.");
     } catch (error) {
      const index = state.pending.indexOf(update);
      if (index !== -1) state.pending.splice(index, 1);
      throw error;
     }
     update.accepted = true;
     flushUpdates(id, state);
     return Object.freeze({ updateId: update.updateId, disposition: "queued-for-start" as const });
    }
    return dispatchUpdate(id, state, update);
   })();
   void promise.catch(() => {});
   return promise;
  },
  status: (owner: GuildOwner, id: string) => authority.status(owner, id),
  list: (owner: GuildOwner) => authority.list(owner),
  reply(owner: GuildOwner, id: string, questionId: string, text: string) {
   if (starting || checking) { captureGuard.reentered = true; throw new Error("Reentrant background control."); }
   const snapshot = authority.status(owner, id);
   if (!snapshot.question || snapshot.question.id !== questionId) throw new Error("Unknown pending question.");
   const binding = bindings.get(id);
   if (!binding || binding.owner !== owner) throw new Error("Unavailable background control.");
   binding.check();
   authority.reply(owner, id, questionId, text);
  },
  wait: (owner: GuildOwner, id: string, timeoutMs: number, signal?: AbortSignal) => authority.wait(owner, id, timeoutMs, signal),
  collect: (owner: GuildOwner, id: string) => authority.collect(owner, id),
  release: (owner: GuildOwner, id: string) => authority.release(owner, id),
  cancel(owner: GuildOwner, id: string) { authority.status(owner, id); discard(id); return authority.cancel(owner, id); },
  retire(owner: GuildOwner) { discardOwner(owner); return authority.retire(owner); },
  shutdown() { discardOwner(); return authority.shutdown(); },
  planParticipant: authority.planParticipant,
 });
}

export type GuildExecutionRuntime = ReturnType<typeof createGuildBackgroundRuntime>;
