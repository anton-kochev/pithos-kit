/** Local structural contract: the development SDK does not provide this capability. */
export interface SemanticInterruptV1 {
 readonly protocol: "pi-semantic-interrupt-v1";
 subscribe(onInterrupt: () => void | Promise<void>, onRetire: (reason: SemanticInterruptRetireReason) => void): () => void;
}
export type SemanticInterruptRetireReason = "ui-reset" | "ui-stop" | "runner-rebind" | "runner-invalidate";
export type SemanticInterruptFault = "cleanup-failed" | "interrupt-callback-failed" | "retire-callback-failed";
/** Callbacks must close caller authority in their synchronous prefix, before awaiting.
 * onError must synchronously latch failure; its own throws/rejections are contained.
 */
export interface SemanticInterruptCallbacks {
 onInterrupt(): void | Promise<void>;
 onRetire(reason: SemanticInterruptRetireReason): void;
 onError(reason: SemanticInterruptFault): void;
}
export interface SemanticInterruptBinding {
 isActive(): boolean;
 /** Silent, idempotent invalidation. Cleanup faults go to onError and getFault. */
 dispose(): void;
 /** First fault, including asynchronous cleanup/callback rejection; never a raw host error. */
 getFault(): SemanticInterruptFault | undefined;
}
/** cleanup resolves (never rejects) after invalidation, registration return/failure,
 * and owned host disposal, with cleanup faults reported first. It remains pending
 * while bound/live and never joins owner callback tails (which may await cleanup).
 * Access it on the result, including unavailable results, not on the binding.
 */
export type SemanticInterruptBindingResult =
 | { readonly kind: "bound"; readonly binding: SemanticInterruptBinding; readonly cleanup: Promise<void> }
 | { readonly kind: "unavailable"; readonly reason: "unsupported-capability" | "registration-failed" | "retired-during-registration"; readonly cleanup: Promise<void> };

function readable(value: unknown): value is Record<string, unknown> {
 return value !== null && (typeof value === "object" || typeof value === "function");
}

/** Binds a single caller-owned intent; this is not runtime execution authority.
 * Stock hosts without the qualified capability are unavailable. No fallback hook is used.
 * Notifications consume the binding even during registration. Fresh intent needs a new binding.
 * Host access/registration failures return bounded reasons; cleanup and caller failures are
 * contained and reported to onError. A provider that throws without returning a disposer
 * still owns its resource; retained callbacks are fenced but cannot be physically removed here.
 */
export function createSemanticInterruptBinding(context: unknown, callbacks: SemanticInterruptCallbacks): SemanticInterruptBindingResult {
 // Pending and committed subscriptions share this fence, installed before any host getter.
 let live = true;
 let registrationDone = false;
 let pendingResources = 0;
 let settle!: () => void;
 const cleanup = new Promise<void>(resolve => { settle = resolve; });
 const maybeSettle = () => {
  if (!live && registrationDone && pendingResources === 0) settle();
 };
 let failure: "unsupported-capability" | "registration-failed" = "unsupported-capability";
 try {
  const { onInterrupt, onRetire, onError } = callbacks;
  if (!readable(context) || context.mode !== "tui" || context.hasUI !== true) return { cleanup, kind: "unavailable", reason: "unsupported-capability" };
  const ui = context.ui;
  const capability = readable(ui) ? ui.semanticInterrupt : undefined;
  if (!readable(capability) || capability.protocol !== "pi-semantic-interrupt-v1") return { cleanup, kind: "unavailable", reason: "unsupported-capability" };
  const subscribe = capability.subscribe;
  if (typeof subscribe !== "function") return { cleanup, kind: "unavailable", reason: "unsupported-capability" };
  let fault: SemanticInterruptFault | undefined;
  const report = (reason: SemanticInterruptFault) => {
   fault ??= reason;
   try { void Promise.resolve(onError.call(callbacks, reason)).catch(() => {}); }
   catch { /* The original fault remains queryable even if the observer fails. */ }
  };
  const invoke = (callback: () => unknown, reason: SemanticInterruptFault) => {
   try { return Promise.resolve(callback()).then(() => {}, () => { report(reason); }); }
   catch { report(reason); }
  };
  let disposer: (() => void) | undefined;
  const consume = () => {
   live = false;
   const release = disposer;
   disposer = undefined;
   return release;
  };
  const release = (resource: (() => void) | undefined) => {
   if (resource) {
    void Promise.resolve(invoke(resource, "cleanup-failed")).then(() => {
     pendingResources--;
     maybeSettle();
    });
   }
   maybeSettle();
  };
  const dispose = () => { release(consume()); };
  const interrupt = () => {
   if (!live) return;
   const resource = consume();
   // Fence caller authority before host cleanup; detach first so reentrant dispose is inert.
   try { return invoke(() => onInterrupt.call(callbacks), "interrupt-callback-failed"); }
   finally { release(resource); }
  };
  const retire = (reason: SemanticInterruptRetireReason) => {
   if (!live) return;
   const resource = consume();
   try { void invoke(() => onRetire.call(callbacks, reason), "retire-callback-failed"); }
   finally { release(resource); }
  };
  failure = "registration-failed";
  const resource = subscribe.call(capability, interrupt, retire);
  if (typeof resource !== "function") {
   live = false;
   // Invalid async registration never qualifies. Join it and drain any eventual
   // disposer; a provider that never settles deliberately keeps retirement blocked.
   pendingResources++;
   void Promise.resolve(resource).then(value => {
    if (typeof value === "function") {
     pendingResources++;
     release(value as () => void);
    }
   }, () => {}).then(() => {
    pendingResources--;
    maybeSettle();
   });
   return { cleanup, kind: "unavailable", reason: "registration-failed" };
  }
  pendingResources++;
  disposer = resource as () => void;
  if (!live) { dispose(); return { cleanup, kind: "unavailable", reason: "retired-during-registration" }; }
  return { cleanup, kind: "bound", binding: { isActive: () => live, dispose, getFault: () => fault } };
 } catch { live = false; return { cleanup, kind: "unavailable", reason: failure }; }
 finally {
  registrationDone = true;
  // Unsupported paths have no owned resource and cannot remain live.
  if (failure === "unsupported-capability") live = false;
  maybeSettle();
 }
}
