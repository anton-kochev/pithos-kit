import { BackgroundRunRegistry, type BackgroundContextArgs, type BackgroundWait, type PlanHoldResult } from "./background-runs.ts";
import type { ConcurrentRunQueueOptions } from "./concurrent-run-queue.ts";

declare const ownerBrand: unique symbol;
export type GuildOwner = Readonly<{ [ownerBrand]: true }>;
const claimedRegistries = new WeakSet<object>();
type Scope<C> = { owner: GuildOwner; registry: BackgroundRunRegistry<C>; invalidated: AbortController };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Internal activation authority, not a host session/branch or Plan-policy adapter. */
export class GuildExecutionAuthority<C = undefined> {
  private state: "inactive" | "activating" | "active" | "retiring" | "closed" = "inactive";
  private scope?: Scope<C>;
  private retirement?: { owner: GuildOwner; promise: Promise<void> };
  private closing?: Promise<void>;
  private activation?: ReturnType<typeof deferred>;
  private readonly holds = new Map<object, Readonly<{ release(): void }>>();
  private readonly bridgeOwner = Object.freeze({});
  private bridge?: Readonly<{ release(): void }>;
  readonly planParticipant = Object.freeze({
    instance: Object.freeze({}),
    tryAcquire: (owner: object): PlanHoldResult => this.acquirePlan(owner),
  });

  private acquirePlan(owner: object): PlanHoldResult {
    if (this.isClosed()) return { kind: "unavailable", reason: "Authority is closed." };
    const existing = this.holds.get(owner);
    if (existing) return { kind: "held", lease: existing };
    if (this.state === "activating" || this.state === "retiring") return { kind: "unavailable", reason: `Authority is ${this.state}.` };
    if (this.scope && !this.bridge) {
      const result = this.scope.registry.tryAcquirePlanHold(this.bridgeOwner);
      if (result.kind !== "held") return result;
      this.bridge = result.lease;
    }
    const lease = Object.freeze({ release: () => {
      if (this.holds.get(owner) !== lease) return;
      this.holds.delete(owner);
      // A retired bridge stays in place until its registry has actually drained.
      if (!this.holds.size && this.state === "active") {
        this.bridge?.release();
        this.bridge = undefined;
      }
    } });
    this.holds.set(owner, lease);
    return { kind: "held", lease };
  }

  /** Factory transfers a fresh, unused registry exclusively and synchronously.
   * It must not retain a production bypass; resources not returned remain its responsibility.
   */
  constructor(private readonly createRegistry: () => BackgroundRunRegistry<C>) {}

  activate(): GuildOwner {
    if (this.state !== "inactive") throw new Error(`Authority is ${this.state}.`);
    this.state = "activating";
    this.retirement = undefined;
    const activation = this.activation = deferred();
    // Failed activation can start asynchronous cleanup before a caller requests its join.
    void activation.promise.catch(() => {});
    let transferred: BackgroundRunRegistry<C> | undefined;
    try {
      const registry = this.createRegistry();
      if (!(registry instanceof BackgroundRunRegistry)) throw new Error("Factory must return a fresh registry synchronously.");
      if (claimedRegistries.has(registry)) throw new Error("Registry was already claimed.");
      claimedRegistries.add(registry);
      transferred = registry;
      if ("then" in registry) throw new Error("Factory must return a registry, not a thenable.");
      const bootstrap = registry.tryAcquirePlanHold(this.bridgeOwner);
      if (bootstrap.kind !== "held" || registry.list().length) throw new Error("Factory registry must be fresh, idle and not closed or record-containing.");
      if (this.isClosed()) throw new Error("Authority is closed.");
      const owner = Object.freeze({}) as GuildOwner;
      this.scope = { owner, registry, invalidated: new AbortController() };
      this.state = "active";
      if (this.holds.size) this.bridge = bootstrap.lease;
      else bootstrap.lease.release();
      this.activation = undefined;
      activation.resolve();
      return owner;
    } catch (error) {
      this.state = "closed";
      this.closing ??= activation.promise;
      try {
        const drain = transferred?.shutdown() ?? Promise.resolve();
        void drain.then(activation.resolve, activation.reject);
      } catch (failure) { activation.reject(failure); }
      throw error;
    }
  }

  private isClosed(): boolean { return this.state === "closed"; }

  isCurrent(owner: GuildOwner): boolean { return this.state === "active" && this.scope?.owner === owner; }
  private require(owner: GuildOwner): Scope<C> {
    if (!this.isCurrent(owner)) throw new Error(this.isClosed() ? "Guild owner has shut down." : "Invalid or stale Guild owner.");
    return this.scope!;
  }

  /** Never await this join from an operation or callback whose cleanup it owns. */
  retire(owner: GuildOwner): Promise<void> {
    if (this.retirement?.owner === owner) return this.retirement.promise;
    const scope = this.require(owner);
    const join = deferred();
    this.retirement = { owner, promise: join.promise };
    this.state = "retiring";
    scope.invalidated.abort();
    void this.drain(scope.registry).then(() => {
      this.bridge?.release();
      this.bridge = undefined;
      this.scope = undefined;
      if (this.state !== "closed") this.state = "inactive";
      join.resolve();
    }, error => { this.state = "closed"; join.reject(error); });
    return join.promise;
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    const join = deferred();
    this.closing = join.promise;
    const scope = this.scope;
    this.state = "closed";
    scope?.invalidated.abort();
    const drain = this.activation?.promise ?? this.retirement?.promise ?? (scope ? this.drain(scope.registry) : Promise.resolve());
    void drain.then(join.resolve, join.reject);
    return join.promise;
  }

  private drain(registry: BackgroundRunRegistry<C>): Promise<void> {
    try { return registry.shutdown(); }
    catch (error) { return Promise.reject(error); }
  }

  start(owner: GuildOwner, input: unknown, ...binding: BackgroundContextArgs<C>) { return this.require(owner).registry.start(input, ...binding); }
  status(owner: GuildOwner, id: string) { return this.require(owner).registry.status(id); }
  list(owner: GuildOwner) { return this.require(owner).registry.list(); }
  reply(owner: GuildOwner, id: string, questionId: string, text: string): void { this.require(owner).registry.reply(id, questionId, text); }
  collect(owner: GuildOwner, id: string) { return this.require(owner).registry.collect(id); }
  release(owner: GuildOwner, id: string): void { this.require(owner).registry.release(id); }
  cancel(owner: GuildOwner, id: string): Promise<void> { return this.require(owner).registry.cancel(id); }
  async wait(owner: GuildOwner, id: string, timeoutMs: number, signal?: AbortSignal): Promise<BackgroundWait> {
    const scope = this.require(owner);
    const combined = new AbortController();
    const abort = () => combined.abort();
    scope.invalidated.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted || scope.invalidated.signal.aborted) abort();
      const result = await scope.registry.wait(id, timeoutMs, combined.signal);
      this.require(owner);
      return result;
    } finally {
      scope.invalidated.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    }
  }
  runExclusive<T>(owner: GuildOwner, operation: (signal: AbortSignal) => T | PromiseLike<T>, signal?: AbortSignal, onPhase?: ConcurrentRunQueueOptions["onPhase"]): Promise<T> {
    try {
      return this.require(owner).registry.runExclusive(operation, signal, phase => { if (this.isCurrent(owner)) onPhase?.(phase); });
    } catch (error) { return Promise.reject(error); }
  }
}
