import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { ConcurrentRunQueue, type ConcurrentRunQueueOptions } from "./concurrent-run-queue.ts";
import { validateInput, type GuildInput } from "./protocol.ts";

export type BackgroundStatus = "queued" | "running" | "waiting" | "stopping" | "completed" | "failed" | "cancelled";
export interface BackgroundLifecycleChange {
  readonly id: string;
  readonly revision: number;
  readonly kind: "admission" | "state" | "question" | "terminal";
  readonly status: BackgroundStatus;
  readonly question?: Readonly<{ id: string; text: string }>;
  readonly error?: string;
}
export interface BackgroundSnapshot {
  readonly id: string;
  readonly status: BackgroundStatus;
  readonly consumed: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly question?: Readonly<{ id: string; text: string }>;
}
export type BackgroundContextArgs<C> = [C] extends [undefined] ? [context?: C] : [context: C];
export interface BackgroundRequest<C = undefined> {
  readonly context: C;
  readonly id: string;
  readonly input: GuildInput;
  readonly signal: AbortSignal;
  /** Cancellation of this question lifetime is a hard failure while its ask is pending. */
  readonly ask: (text: string, questionSignal?: AbortSignal) => Promise<string>;
}
/**
 * Settle only after owned cleanup. Rejection means failure; a fulfilled object's
 * failed/cancelled status is also respected (compatible with GuildRoleRunResult).
 * Other fulfilled JSON values mean transport completion, NOT a validated Guild report.
 * Process kill deadlines and report validation remain the adapter's responsibility.
 */
export type BackgroundOperation<C = undefined> = (request: BackgroundRequest<C>) => unknown | PromiseLike<unknown>;
export interface BackgroundLifecycle<C> {
  /** Deferred, non-owning observation. Intermediate state coalesces; admission and terminal survive. */
  onChange?(change: BackgroundLifecycleChange, context: C): void;
  /** Synchronous durable reservation; throwing prevents scheduling. */
  beforeSchedule?(request: Readonly<{ id: string; input: GuildInput; context: C }>): void;
  /** Observation only. Never await this registry's cancel/shutdown from this callback. */
  onTerminal?(snapshot: BackgroundSnapshot, context: C): void | PromiseLike<void>;
}
interface RecordState {
  change?: (kind: BackgroundLifecycleChange["kind"]) => void;
  id: string;
  status: BackgroundStatus;
  controller: AbortController;
  done: Promise<void>;
  questions: number;
  consumed: boolean;
  result?: unknown;
  error?: string;
  failure?: string;
  lifetime?: ReturnType<typeof setTimeout>;
  operationEnded?: boolean;
  frozen?: boolean;
  publicationFault?: boolean;
  pending?: { id: string; text: string; settle: (answer: string) => void; reject: (error: Error) => void };
}

export type PlanHoldResult =
  | { readonly kind: "held"; readonly lease: Readonly<{ release(): void }> }
  | { readonly kind: "busy"; readonly outstanding: number }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface BackgroundLimits {
  /** Retained records, including unconsumed terminal results. Default 16; no eviction. */
  records?: number;
  /** Strict JSON result cap, default 64 KiB; non-JSON/lossy values fail, except a void return. */
  resultBytes?: number;
  /** Per-question deadline, default five minutes; includes time awaiting parent input. */
  questionTimeoutMs?: number;
  /** Admission-to-cleanup deadline, default thirty minutes; aborts but still joins cleanup. */
  lifetimeMs?: number;
}

/**
 * Session-owned, memory-only registry with three active background slots and eight
 * queued background slots; blocking exclusive operations retain an unbounded FIFO backlog.
 * Each run permits eight questions, one pending at a time; question/reply text is
 * nonblank, NUL-free and at most 8 KiB UTF-8. Waiting/stopping work holds its slot.
 * Session-local identities are intentionally not recoverable across replacement.
 * Limits bound retained data, not the adapter's transient allocations or heap.
 */
export class BackgroundRunRegistry<C = undefined> {
  private readonly owner = randomUUID();
  private sequence = 0;
  private readonly queue = new ConcurrentRunQueue({ unboundedExclusivePending: true });
  private readonly records = new Map<string, RecordState>();
  private closed = false;
  private closing?: Promise<void>;
  private reserving = false;
  private reservationReentered = false;
  private exclusiveOutstanding = 0;
  private readonly planHolds = new Map<object, Readonly<{ release(): void }>>();
  private readonly waiters = new Set<() => void>();

  private readonly limits: Required<BackgroundLimits>;
  constructor(private readonly execute: BackgroundOperation<C>, limits: BackgroundLimits = {}, private readonly lifecycle: BackgroundLifecycle<C> = {}) {
    this.limits = { records: 16, resultBytes: 64 * 1024, questionTimeoutMs: 300_000, lifetimeMs: 1_800_000, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new RangeError(`Invalid ${name}.`);
    }
  }

  /** Synchronous idle admission lease; release affects only this owner and registry instance. */
  tryAcquirePlanHold(owner: object): PlanHoldResult {
    if (this.closed) return { kind: "unavailable", reason: "Registry has shut down." };
    const outstanding = this.exclusiveOutstanding + [...this.records.values()].filter(record => !isTerminal(record.status)).length;
    if (outstanding) return { kind: "busy", outstanding };
    let lease = this.planHolds.get(owner);
    if (!lease) {
      lease = Object.freeze({ release: () => {
        if (this.planHolds.get(owner) === lease) this.planHolds.delete(owner);
      } });
      this.planHolds.set(owner, lease);
    }
    return { kind: "held", lease };
  }

  private assertAdmission(): void {
    if (this.closed) throw new Error("Registry has shut down.");
    if (this.planHolds.size) throw new Error("Registry admission is blocked by a Plan hold.");
  }

  start(value: unknown, ...binding: BackgroundContextArgs<C>): BackgroundSnapshot {
    if (this.reserving) { this.reservationReentered = true; throw new Error("Reentrant background reservation."); }
    const context = binding[0] as C;
    this.assertAdmission();
    if (!value || typeof value !== "object" || Object.hasOwn(value, "member")) throw new Error("Expected canonical input.");
    const input = validateInput(value);
    // Input getters can reenter the registry while validation copies the canonical input.
    this.assertAdmission();
    if (this.records.size >= this.limits.records) throw new Error("Registry record capacity exceeded.");
    this.queue.assertAdmission();
    const id = `${this.owner}:${++this.sequence}`;
    const record: RecordState = { id, status: "queued", controller: new AbortController(), questions: 0, consumed: false, done: Promise.resolve() };
    this.records.set(id, record);
    this.reserving = true;
    this.reservationReentered = false;
    try {
      this.lifecycle.beforeSchedule?.(Object.freeze({ id, input: copyResult(input, 64 * 1024) as GuildInput, context }));
      this.assertAdmission();
      if (this.reservationReentered) throw new Error("Reentrant background reservation.");
    } catch (error) { this.records.delete(id); throw error; }
    finally { this.reserving = false; }
    const onChange = this.lifecycle.onChange;
    if (onChange) {
      let revision = 0, scheduled = false;
      const pending = new Map<string, BackgroundLifecycleChange>();
      record.change = kind => {
        const snapshot: BackgroundLifecycleChange = Object.freeze({ id, revision: ++revision, kind, status: record.status,
          ...(record.pending ? { question: Object.freeze({ id: record.pending.id, text: record.pending.text }) } : {}),
          ...(record.error ? { error: record.error } : {}) });
        // Three slots per run, not a history: preserve admission and terminal while
        // replacing intermediate state with the latest (including its current question).
        pending.set(kind === "admission" || kind === "terminal" ? kind : "current", snapshot);
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          const batch = [...pending.values()].sort((a, b) => a.revision - b.revision);
          pending.clear(); scheduled = false;
          for (const change of batch) {
            try { void Promise.resolve(onChange(change, context)).catch(() => {}); }
            catch { /* Observation never owns execution or publication. */ }
          }
        });
      };
      record.change("admission");
    }
    record.lifetime = setTimeout(() => this.fail(record, "Run lifetime timeout."), this.limits.lifetimeMs);
    let finalization: Promise<void> | undefined;
    let terminalStatus: BackgroundStatus = "failed";
    const finalize = (result?: unknown, error?: unknown): Promise<void> => {
      if (finalization) return finalization;
      // Freeze cancellation at transport cleanup, before copying/publication. Publication
      // keeps ownership but cannot retroactively change an already persisted outcome.
      record.frozen = true;
      clearTimeout(record.lifetime);
      if (error !== undefined) record.error = errorText(error);
      else {
        try { record.result = copyResult(result, this.limits.resultBytes); }
        catch { record.error = "Result is not bounded serializable JSON."; }
      }
      record.error = record.failure ?? record.error;
      const runnerStatus = record.result && typeof record.result === "object" && "status" in record.result ? record.result.status : undefined;
      const status: BackgroundStatus = record.failure ? "failed" : record.controller.signal.aborted ? "cancelled"
        : record.error || runnerStatus === "failed" ? "failed" : runnerStatus === "cancelled" ? "cancelled" : "completed";
      const snapshot = Object.freeze({ ...this.status(id), status });
      finalization = Promise.resolve().then(async () => {
        try {
          await this.lifecycle.onTerminal?.(snapshot, context);
          terminalStatus = status;
        } catch (failure) {
          record.publicationFault = true;
          terminalStatus = "failed";
          record.error = errorText(`Terminal persistence fault: ${errorText(failure)}`);
          // Close and signal synchronously before queue settlement can launch a waiter.
          // The shared join includes this publication, so own it without self-awaiting.
          void this.shutdown();
          throw new Error(record.error);
        }
      });
      return finalization;
    };
    record.done = this.queue.enqueue(async signal => {
      let result: unknown, failure: unknown;
      try { result = await this.execute({ id, input, signal, context, ask: (text, questionSignal) => this.ask(record, text, signal, questionSignal) }); }
      catch (error) { failure = error ?? new Error("Operation failed."); }
      finally {
        record.operationEnded = true;
        if (record.pending) this.fail(record, "Operation ended with a pending question.");
      }
      await finalize(result, failure);
    }, {
      signal: record.controller.signal,
      onPendingCancel: error => finalize(undefined, error),
      onPhase: phase => { record.status = phase; record.change?.("state"); },
    }).then(() => undefined, error => finalize(undefined, error)).finally(() => {
      record.status = terminalStatus;
      record.change?.("terminal");
      this.notify();
    });
    // Observation failures remain on done for cancel/shutdown, but are always owned.
    void record.done.catch(() => {});
    return this.status(id);
  }

  status(id: string): BackgroundSnapshot {
    const record = this.records.get(id);
    if (!record) throw new Error("Unknown run ID.");
    return Object.freeze({ id, status: record.status, consumed: record.consumed, result: record.result, error: record.error, ...(record.pending ? { question: Object.freeze({ id: record.pending.id, text: record.pending.text }) } : {}) });
  }

  list(): readonly BackgroundSnapshot[] { return Object.freeze([...this.records.keys()].map(id => this.status(id))); }

  private notify(): void { for (const wake of this.waiters) wake(); }

  private ask(record: RecordState, text: string, signal: AbortSignal, questionSignal?: AbortSignal): Promise<string> {
    let promise: Promise<string>;
    try {
      if (record.operationEnded || isTerminal(record.status)) throw new Error("Operation already ended.");
      signal.throwIfAborted();
      questionSignal?.throwIfAborted();
      validateText(text);
      if (record.pending) throw new Error("A question is already pending.");
      if (record.questions >= 8) throw new Error("Question count limit exceeded.");
      const id = `${record.id}:q${++record.questions}`;
      promise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => this.fail(record, "Question timeout."), this.limits.questionTimeoutMs);
        const clear = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          questionSignal?.removeEventListener("abort", expire);
          record.pending = undefined;
          record.status = record.controller.signal.aborted ? "stopping" : "running";
          record.change?.("question");
          this.notify();
        };
        const abort = () => { clear(); reject(new Error("Question aborted.")); };
        const expire = () => {
          // Runner stop can expire the question before ask's operation-abort listener runs.
          if (!signal.aborted && !record.controller.signal.aborted && record.pending?.id === id) this.fail(record, "Question lifetime cancelled.");
        };
        record.pending = { id, text, settle: answer => { clear(); resolve(answer); }, reject: error => { clear(); reject(error); } };
        signal.addEventListener("abort", abort, { once: true });
        record.status = "waiting";
        questionSignal?.addEventListener("abort", expire, { once: true });
        if (questionSignal?.aborted) expire();
        record.change?.("question");
        this.notify();
      });
    } catch (error) {
      if (!record.operationEnded && !record.controller.signal.aborted) this.fail(record, errorText(error));
      promise = Promise.reject(error);
    }
    // A misbehaving adapter may neglect to await ask; registry-owned rejection is still observed.
    void promise.catch(() => {});
    return promise;
  }

  reply(id: string, questionId: string, text: string): void {
    this.assertAdmission();
    validateText(text);
    const pending = this.records.get(id)?.pending;
    if (!pending || pending.id !== questionId) throw new Error("Unknown pending question.");
    pending.settle(text);
  }

  /** Wake for this terminal run OR any owned question; caller cancellation never cancels work. */
  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<BackgroundWait> {
    this.status(id);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) throw new RangeError("Invalid wait timeout.");
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (reason: BackgroundWait["reason"]) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener("abort", abort);
        resolve(Object.freeze({ reason, runs: this.list() }));
      };
      const abort = () => finish("aborted");
      const check = () => {
        if (signal?.aborted) finish("aborted");
        else if (isTerminal(this.status(id).status)) finish("terminal");
        else if ([...this.records.values()].some(record => record.pending)) finish("question");
      };
      this.waiters.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish("timeout"), timeoutMs);
      check();
    });
  }

  /** Atomic memory-only claim for future usage attribution; does not itself account usage. */
  collect(id: string): Readonly<{ claimed: boolean; snapshot: BackgroundSnapshot }> {
    const record = this.records.get(id);
    if (!record || !isTerminal(record.status)) throw new Error("Run is not terminal.");
    if (record.publicationFault) throw new Error("Terminal persistence fault prevents collection.");
    const claimed = !record.consumed;
    record.consumed = true;
    return Object.freeze({ claimed, snapshot: this.status(id) });
  }

  release(id: string): void {
    const record = this.records.get(id);
    if (!record || !isTerminal(record.status) || !record.consumed) throw new Error("Only terminal consumed runs can be released.");
    this.records.delete(id);
  }

  private fail(record: RecordState, message: string): void {
    if (record.frozen || isTerminal(record.status) || record.controller.signal.aborted) return;
    record.failure = message;
    record.status = "stopping";
    record.controller.abort(new Error(message));
    record.change?.("state");
    this.notify();
  }

  /** Signal immediately and join this run's cleanup, not siblings; do not self-join from execute. */
  cancel(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error("Unknown run ID.");
    if (!record.frozen && !isTerminal(record.status)) {
      record.status = "stopping";
      record.controller.abort(new Error("Run cancelled."));
      record.change?.("state");
      this.notify();
    }
    // Defer the lookup for cancellation reentered synchronously during start's enqueue.
    return Promise.resolve().then(() => record.done);
  }

  /** Blocking adapters share this scheduler; they may not enter while background work is live. */
  runExclusive<T>(operation: (signal: AbortSignal) => T | PromiseLike<T>, signal?: AbortSignal, onPhase?: ConcurrentRunQueueOptions["onPhase"]): Promise<T> {
    try { this.assertAdmission(); }
    catch (error) { return Promise.reject(error); }
    if ([...this.records.values()].some(record => !isTerminal(record.status))) return Promise.reject(new Error("Background work is still active."));
    // Both phase observers and the operation can reenter synchronously; own admission first.
    this.exclusiveOutstanding++;
    return this.queue.enqueue(operation, { exclusive: true, signal, onPhase }).finally(() => { this.exclusiveOutstanding--; });
  }

  /** Close admission before signalling, then join all jobs and exclusive-operation cleanup. */
  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Latch before abort listeners can reenter shutdown; defer only the joins.
    this.closing = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled([drained, ...jobs]);
      const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason), "Background terminal publication failed.");
    });
    void this.closing.catch(() => {});
    const drained = this.queue.shutdown();
    const jobs = [...this.records.keys()].map(id => this.cancel(id));
    for (const job of jobs) void job.catch(() => {});
    return this.closing;
  }
}

export interface BackgroundWait {
  readonly reason: "terminal" | "question" | "timeout" | "aborted";
  readonly runs: readonly BackgroundSnapshot[];
}
function isTerminal(status: BackgroundStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
function validateText(text: string): void {
  if (typeof text !== "string" || !text.trim() || text.includes("\0") || Buffer.byteLength(text) > 8192) throw new Error("Invalid question/reply text.");
}

export function copyResult(result: unknown, cap: number): unknown {
  if (result === undefined) return undefined;
  const values: unknown[] = [result];
  const visited = new Set<object>();
  while (values.length) {
    const value = values.pop();
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (!value || typeof value !== "object" || types.isProxy(value)) throw new Error("Result must contain only JSON values.");
    if (visited.has(value)) continue;
    visited.add(value);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) || "toJSON" in value) {
      throw new Error("Result must contain only plain JSON values.");
    }
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) throw new Error("Result arrays must be dense and contain only indices.");
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)
        || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) {
        throw new Error("Result contains a property that JSON cannot retain.");
      }
      values.push(descriptor.value);
    }
  }
  const json = JSON.stringify(result);
  if (json === undefined || Buffer.byteLength(json) > cap) throw new Error("Result byte limit exceeded.");
  const copy: unknown = JSON.parse(json);
  const pending = [copy];
  while (pending.length) {
    const value = pending.pop();
    if (value && typeof value === "object") {
      pending.push(...Object.values(value));
      Object.freeze(value);
    }
  }
  return copy;
}
function errorText(error: unknown): string {
  try {
    const text = error instanceof Error ? error.message : String(error);
    // Slice by code points to avoid a malformed UTF-8 boundary.
    let bounded = "";
    for (const char of text) {
      if (Buffer.byteLength(bounded) + Buffer.byteLength(char) > 2048) break;
      bounded += char === "\0" ? "?" : char;
    }
    return bounded || "Operation failed.";
  } catch { return "Operation failed."; }
}
