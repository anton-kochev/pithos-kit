import { createBackgroundNotifications, type NotificationBatch, type NotificationValidation } from "./background-notifications.ts";

export interface BackgroundContinuationOptions {
 readonly epoch: object;
 readonly context: { readonly parentContinuation?: unknown };
 /** Trusted pure synchronous local fence, not a host callout. */
 readonly isCurrent: () => boolean;
 readonly validateContextAndPlan: () => boolean;
 readonly canDeliver: (batch: NotificationBatch) => NotificationValidation;
 readonly onStatus?: (status: BackgroundContinuationStatus) => void;
}
export type BackgroundContinuationStatus = "available" | "unavailable" | "closed" | "recovery-required";
type Method = (...args: unknown[]) => unknown;
function object(value: unknown): Record<string, unknown> {
 if (!value || (typeof value !== "object" && typeof value !== "function")) throw Error("Invalid host resource");
 return value as Record<string, unknown>;
}
function method(value: unknown): Method {
 if (typeof value !== "function") throw Error("Invalid host method");
 return value as Method;
}

/** Standalone, non-owning model delivery with its own buffer, independent of UI acknowledgments.
 * Consumers validate canonical context/Plan and batch state; previews confer no authority.
 * isCurrent MUST be a trusted pure local read. All other host reads/calls may invalidate it.
 * This cooperative contract is not a hostile Proxy security attestation.
 * close/dispose fence and close synchronously; their join belongs to the outer lifecycle.
 * Never await that join from a hook which the owned continuation itself awaits.
 */
export function createBackgroundContinuation(options: BackgroundContinuationOptions) {
 const buffer = createBackgroundNotifications(options.epoch);
 let retired = false;
 let scheduled = false;
 let inflight = false;
 let waitingIdle = false;
 let sequence = 0;
 let omittedAnnounced = false;
 const announcedStatuses = new Set<BackgroundContinuationStatus>();
 let status: BackgroundContinuationStatus = "unavailable";
 let lease: Record<string, unknown> | undefined;
 let closeMethod: Method | undefined;
 let acceptMethod: Method | undefined;
 let closeCalled = false;
 let closed: Promise<void> = Promise.resolve();
 let closeFault = false;
 let leaseSettled = false;
 let planClosed = false;
 const current = () => !retired && options.isCurrent();
 function guard() { if (!current()) throw Error("Retired owner"); }
 function read(target: Record<string, unknown>, key: string): unknown {
  const value = target[key];
  guard();
  return value;
 }
 // Capture receivers and invoke via Reflect.apply: a function's own .call may be an accessor.
 function promise(value: unknown, cleanup = false): Promise<unknown> {
  const target = object(value);
  const then = method(target.then);
  if (!cleanup) guard();
  const result = new Promise((resolve, reject) => { Reflect.apply(then, target, [resolve, reject]); });
  void result.catch(() => {});
  if (!cleanup) guard();
  return result;
 }
 function publish(next: BackgroundContinuationStatus) {
  status = next;
  if (announcedStatuses.has(next)) return;
  announcedStatuses.add(next);
  try { void Promise.resolve(options.onStatus?.(next)).catch(() => {}); } catch { /* Observers never own delivery or cleanup. */ }
 }
 function retire(next: BackgroundContinuationStatus): Promise<void> {
  retired = true; // Fence FIRST, before cleanup or observers can reenter.
  status = next;
  if (!closeCalled && closeMethod && lease) {
   closeCalled = true;
   try { Reflect.apply(closeMethod, lease, []); } catch { closeFault = true; status = "unavailable"; }
  }
  publish(status);
  return closed;
 }
 function close(): Promise<void> { return retired ? closed : retire("closed"); }
 function closeForPlan(): boolean {
  if (inflight || closeFault) return false;
  if (retired) return status === "closed" && (planClosed || leaseSettled);
  close();
  planClosed = !closeFault;
  return planClosed;
 }
 function schedule() {
  if (scheduled || !current() || inflight || waitingIdle) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; flush(); });
 }
 function flush() {
  if (!current() || inflight || waitingIdle || !lease || !acceptMethod) return;
  const batch = buffer.reserveBatch();
  if (!batch.items.length && (!batch.omitted || omittedAnnounced)) { buffer.release(batch.token); return; }
  let receipt: Record<string, unknown> | undefined;
  let revoke: Method | undefined;
  try {
   const validate = method(read(object(options), "validateContextAndPlan"));
   const valid = Reflect.apply(validate, options, []); guard();
   if (!valid) { buffer.release(batch.token); return; }
   const canDeliver = method(read(object(options), "canDeliver"));
   const deliver = Reflect.apply(canDeliver, options, [batch]); guard();
   if (deliver !== true) {
    const progress = typeof deliver === "object" && deliver !== null
     ? buffer.discard(batch.token, (deliver as Exclude<NotificationValidation, boolean>).stale) : 0;
    guard();
    buffer.release(batch.token);
    if (progress) schedule();
    return;
   }
   if (!Number.isSafeInteger(sequence + 1)) throw Error("Sequence exhausted");
   waitingIdle = true;
   // The process-local token is not a credential or part of the model notice. Omitting it
   // also leaves room for true -> false when suppressing the sticky overflow announcement.
   const { token: _token, ...payload } = batch;
   const content = JSON.stringify({ ...payload, omitted: batch.omitted && !omittedAnnounced });
   guard();
   inflight = true; // Acceptance owns possible resources before any host call or result getter.
   const acceptingLease = lease;
   const accept = method(read(acceptingLease, "tryAccept"));
   const result = object(Reflect.apply(accept, acceptingLease, [++sequence, content]));
   // A returned resource must be captured for cleanup even if the call retired this owner.
   const resultStatus = result.status;
   if (resultStatus === "accepted") {
    receipt = object(result.receipt);
    revoke = method(receipt.revoke);
   }
   guard();
   if (resultStatus === "busy") { inflight = false; buffer.release(batch.token); return; }
   if (resultStatus !== "accepted" || !receipt) throw Error("Lease refused delivery");
   const committed = promise(read(receipt, "committed")); guard();
   const finished = promise(read(receipt, "finished")); guard();
   const started = promise(read(receipt, "started")); guard();
   inflight = true;
   const ack = (state: unknown) => {
    if (!current()) return;
    if (state !== "none" && state !== "committed" && state !== "unknown") throw Error("Invalid commit state");
    if (current() && (state === "committed" || state === "unknown")) {
     buffer.ack(batch.token);
     if (batch.omitted) omittedAnnounced = true;
     if (state === "unknown") publish("recovery-required");
    }
   };
   void committed.then(ack).catch(() => { retire("unavailable"); });
   void started.then(value => {
    if (current() && typeof value !== "boolean") throw Error("Invalid started state");
   }).catch(() => { retire("unavailable"); });
   void finished.then(value => {
    // Cleanup ownership outlives delivery authority. Do not use the current-owner read guard here.
    const result = object(value);
    const outcome = result.outcome;
    const commitState = result.commitState;
    const didStart = result.started;
    if (!["completed", "revoked", "error"].includes(outcome as string) || typeof didStart !== "boolean"
      || !["none", "committed", "unknown"].includes(commitState as string)) throw Error("Invalid finish state");
    ack(commitState);
    if (current()) buffer.release(batch.token);
    inflight = false;
   }).catch(() => { retire("unavailable"); });
  } catch {
   retire("unavailable");
   if (receipt && revoke) { try { Reflect.apply(revoke, receipt, []); } catch { /* Lease close is the final cleanup fence. */ } }
  }
 }
 try {
  guard();
  const cap = object(options.context.parentContinuation); guard();
  if (read(cap, "protocol") !== "pi-parent-continuation-v1") throw Error("Unavailable protocol");
  const open = method(read(cap, "open")); guard();
  lease = object(Reflect.apply(open, cap, []));
  // Capture the cleanup join even when the close handle faults or open retires the owner.
  inflight = true;
  try { closeMethod = method(lease.close); }
  finally {
   closed = promise(lease.closed, true).then(() => { leaseSettled = true; inflight = false; });
   void closed.catch(() => {});
  }
  guard();
  acceptMethod = method(read(lease, "tryAccept"));
  const onIdle = method(read(lease, "onIdle")); guard();
  Reflect.apply(onIdle, lease, [() => {
   // Let receipts already settled by this host idle edge publish first. An edge observed
   // during unfinished work is discarded, never banked for a later revoked batch.
   queueMicrotask(() => {
    if (!current() || inflight) return;
    waitingIdle = false;
    schedule();
   });
  }]);
  guard();
  void closed.then(() => { if (!retired) retire("closed"); }, () => { retire("unavailable"); });
  inflight = false;
  publish("available"); guard();
 } catch { retire("unavailable"); }
 return {
  get status() { return status; },
  get hasInFlight() { return inflight; },
  get closed() { return closed; },
  closeForPlan,
  observe(epoch: object, event: unknown) {
   if (!current()) return "wrong-epoch" as const;
   const result = buffer.observe(epoch, event);
   if (result === "accepted" || result === "resync-needed") schedule();
   return result;
  },
  close,
  dispose: close,
 };
}
