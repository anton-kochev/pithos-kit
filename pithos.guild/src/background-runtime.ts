import type { ConcurrentRunQueueOptions } from "./concurrent-run-queue.ts";
import { randomUUID } from "node:crypto";
import { createGuildBackgroundAdmission, type BackgroundAdmissionContext } from "./background-admission.ts";
import { BackgroundRunRegistry, type BackgroundLimits } from "./background-runs.ts";
import { GuildExecutionAuthority, type GuildOwner } from "./execution-authority.ts";
import { runBackgroundGuildRole, type RunBackgroundGuildRoleOptions } from "./background-runner.ts";
import { projectBackgroundResult } from "./background-result.ts";
import { buildTask } from "./protocol.ts";
import type { CoordinationBus } from "./plan-coordination.ts";

export interface GuildBackgroundContext extends BackgroundAdmissionContext {
 cwd: string;
 model?: string;
 thinkingLevel?: string;
 projectTrusted: boolean;
 /** Synchronous observers only; asynchronous host side effects cannot be fenced. */
 onEvent?: RunBackgroundGuildRoleOptions["onEvent"];
 onUpdate?: RunBackgroundGuildRoleOptions["onUpdate"];
}
type Binding = Readonly<Omit<GuildBackgroundContext, "getBranch"> & { owner: GuildOwner; taskId: string }>;

/** Explicitly activated composition shared by blocking registration and internal background admission. */
export function createGuildBackgroundRuntime({ bus, parentEnvironment, runner = runBackgroundGuildRole, limits }: {
 bus: CoordinationBus;
 parentEnvironment?: { readonly PITHOS_GUILD_PLAN_MODE?: unknown };
 runner?: typeof runBackgroundGuildRole;
 limits?: BackgroundLimits;
}) {
 const capturedLimits = { ...limits };
 const authority = new GuildExecutionAuthority<Binding>(() => new BackgroundRunRegistry<Binding>(async request => {
  const binding = request.context;
  let live = true;
  const current = () => live && authority.isCurrent(binding.owner);
  const observe = (callback: (() => unknown)) => {
   if (!current()) return;
   try { void Promise.resolve(callback()).catch(() => {}); } catch { /* Observers do not own transport. */ }
  };
  const task = buildTask({ ...request.input, runId: request.id, taskId: binding.taskId });
  try {
   const result = await runner({
    ...request.input, runId: request.id, taskId: binding.taskId,
    cwd: binding.cwd, model: binding.model, thinkingLevel: binding.thinkingLevel, projectTrusted: binding.projectTrusted,
    signal: request.signal,
    onQuestion(text, questionSignal) {
     if (!current()) return Promise.reject(new Error("Stale Guild question."));
     return request.ask(text, questionSignal);
    },
    onEvent: event => observe(() => binding.onEvent?.(event)),
    onUpdate: update => observe(() => binding.onUpdate?.(update)),
   });
   live = false;
   return projectBackgroundResult(result, task);
  } finally { live = false; }
 }, capturedLimits));
 let starting = false;
 const captureGuard = { reentered: false };
 const admission = createGuildBackgroundAdmission({ authority, bus, parentEnvironment, captureGuard });
 return Object.freeze({
  activate: () => authority.activate(),
  runExclusive: <T>(owner: GuildOwner, operation: (signal: AbortSignal) => T | PromiseLike<T>, signal?: AbortSignal, onPhase?: ConcurrentRunQueueOptions["onPhase"]) => authority.runExclusive(owner, operation, signal, onPhase),
  isCurrent: (owner: GuildOwner) => authority.isCurrent(owner),
  start(owner: GuildOwner, input: unknown, context: GuildBackgroundContext) {
   if (starting) { captureGuard.reentered = true; throw new Error("Reentrant background capture."); }
   starting = true;
   captureGuard.reentered = false;
   try {
    if (!authority.isCurrent(owner)) throw new Error("Invalid or stale Guild owner.");
    const binding = Object.freeze({ owner, taskId: randomUUID(), cwd: context.cwd, model: context.model,
     thinkingLevel: context.thinkingLevel, projectTrusted: context.projectTrusted, onEvent: context.onEvent, onUpdate: context.onUpdate });
    const getBranch = context.getBranch;
    const validText = (value: unknown) => typeof value === "string" && !!value.trim() && !value.includes("\0");
    if (!validText(binding.cwd) || [binding.model, binding.thinkingLevel].some(value => value !== undefined && !validText(value))
     || typeof binding.projectTrusted !== "boolean" || typeof getBranch !== "function"
     || [binding.onEvent, binding.onUpdate].some(value => value !== undefined && typeof value !== "function")) throw new Error("Malformed background context.");
    if (captureGuard.reentered) throw new Error("Reentrant background capture.");
    // Preserve the reader's receiver for synchronous admission only; the queued binding excludes it.
    return admission.start(owner, input, { getBranch: () => getBranch.call(context) }, binding);
   } finally { starting = false; }
  },
  status: (owner: GuildOwner, id: string) => authority.status(owner, id),
  list: (owner: GuildOwner) => authority.list(owner),
  reply: (owner: GuildOwner, id: string, questionId: string, text: string) => authority.reply(owner, id, questionId, text),
  wait: (owner: GuildOwner, id: string, timeoutMs: number, signal?: AbortSignal) => authority.wait(owner, id, timeoutMs, signal),
  collect: (owner: GuildOwner, id: string) => authority.collect(owner, id),
  release: (owner: GuildOwner, id: string) => authority.release(owner, id),
  cancel: (owner: GuildOwner, id: string) => authority.cancel(owner, id),
  retire: (owner: GuildOwner) => authority.retire(owner),
  shutdown: () => authority.shutdown(),
  planParticipant: authority.planParticipant,
 });
}

export type GuildExecutionRuntime = ReturnType<typeof createGuildBackgroundRuntime>;
