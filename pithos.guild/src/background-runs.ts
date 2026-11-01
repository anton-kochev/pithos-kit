import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { ConcurrentRunQueue, type ConcurrentRunQueueOptions } from "./concurrent-run-queue.ts";
import { validateInput, type GuildInput } from "./protocol.ts";

export type BackgroundStatus = "queued" | "running" | "waiting" | "stopping" | "completed" | "failed" | "cancelled";
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
interface RecordState {
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
  private exclusiveOutstanding = 0;
  private readonly planHolds = new Map<object, Readonly<{ release(): void }>>();
  private readonly waiters = new Set<() => void>();

  private readonly limits: Required<BackgroundLimits>;
  constructor(private readonly execute: BackgroundOperation<C>, limits: BackgroundLimits = {}) {
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
    const context = binding[0] as C;
    this.assertAdmission();
    if (!value || typeof value !== "object" || Object.hasOwn(value, "member")) throw new Error("Expected canonical input.");
    const input = validateInput(value);
    if (input.role !== "coder" && input.role !== "reviewer") throw new Error("Unsupported background role.");
    // Input getters can reenter the registry while validation copies the canonical input.
    this.assertAdmission();
    if (this.records.size >= this.limits.records) throw new Error("Registry record capacity exceeded.");
    const id = `${this.owner}:${++this.sequence}`;
    const record: RecordState = { id, status: "queued", controller: new AbortController(), questions: 0, consumed: false, done: Promise.resolve() };
    this.records.set(id, record);
    record.lifetime = setTimeout(() => this.fail(record, "Run lifetime timeout."), this.limits.lifetimeMs);
    record.done = this.queue.enqueue(async signal => {
      try { return await this.execute({ id, input, signal, context, ask: (text, questionSignal) => this.ask(record, text, signal, questionSignal) }); }
      finally {
        record.operationEnded = true;
        if (record.pending) this.fail(record, "Operation ended with a pending question.");
      }
    }, {
      signal: record.controller.signal,
      onPhase: phase => { record.status = phase; },
    }).then(result => {
      clearTimeout(record.lifetime);
      try { record.result = copyResult(result, this.limits.resultBytes); }
      catch { record.error = "Result is not bounded serializable JSON."; }
      record.error = record.failure ?? record.error;
      const runnerStatus = record.result && typeof record.result === "object" && "status" in record.result ? record.result.status : undefined;
      record.status = record.failure ? "failed" : record.controller.signal.aborted ? "cancelled"
        : record.error || runnerStatus === "failed" ? "failed" : runnerStatus === "cancelled" ? "cancelled" : "completed";
      this.notify();
    }, error => {
      clearTimeout(record.lifetime);
      record.error = record.failure ?? errorText(error);
      record.status = record.failure ? "failed" : record.controller.signal.aborted ? "cancelled" : "failed";
      this.notify();
    });
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
    if (isTerminal(record.status) || record.controller.signal.aborted) return;
    record.failure = message;
    record.status = "stopping";
    record.controller.abort(new Error(message));
    this.notify();
  }

  /** Signal immediately and join this run's cleanup, not siblings; do not self-join from execute. */
  cancel(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error("Unknown run ID.");
    if (!isTerminal(record.status)) {
      record.status = "stopping";
      record.controller.abort(new Error("Run cancelled."));
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
  async shutdown(): Promise<void> {
    this.closed = true;
    const drained = this.queue.shutdown();
    for (const id of this.records.keys()) this.cancel(id);
    await drained;
    await Promise.all([...this.records.values()].map(record => record.done));
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

function copyResult(result: unknown, cap: number): unknown {
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
