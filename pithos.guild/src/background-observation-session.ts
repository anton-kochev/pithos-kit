import { createBackgroundJournal } from "./background-journal.ts";
import { createBackgroundSession } from "./background-session.ts";

type Context = Parameters<typeof createBackgroundJournal>[1] & {readonly cwd: string};
type SessionOptions = Parameters<typeof createBackgroundSession>[0];

/**
 * Session observation survives execution-owner retirement. The caller must drain
 * publication before pausing, and resume only after a fresh safe navigation intent.
 * This helper neither owns execution nor rebinds the captured journal context.
 */
export function createBackgroundObservationSession({pi, context, runtime, onFault}: {
 pi: Parameters<typeof createBackgroundJournal>[0]; context: Context;
 runtime: SessionOptions["runtime"]; onFault?: SessionOptions["onFault"];
}) {
 const manager = context.sessionManager;
 const sessionId = manager.getSessionId();
 const cwd = context.cwd;
 let closed = false;
 let epoch = {};
 let writable = true;
 // Journal's final fences must read only local state, never SDK getters.
 const getEpoch = () => epoch;
 const isWritable = () => writable;
 // Even a repeated pause fences a resume currently inside a host getter.
 function pause() { writable = false; epoch = {}; }
 function matches(ctx: Context) {
  return ctx.sessionManager === manager && manager.getSessionId() === sessionId && ctx.cwd === cwd
   && ctx.sessionManager === manager;
 }
 // Bounded checks for read-only SDK identity getters, with a final local
 // lifecycle fence; this is not a fixed-point loop for arbitrary host mutation.
 function isCurrent(ctx: Context) {
  const before = epoch;
  try {
   return !closed && matches(ctx) && matches(context) && ctx.sessionManager === manager
    && !closed && epoch === before;
  } catch { return false; }
 }
 function resume(ctx: Context) {
  const before = epoch;
  if (!isCurrent(ctx) || closed || epoch !== before) return false;
  writable = true; return true;
 }
 function close() { if (!closed) { closed = true; writable = false; epoch = {}; } }
 const journal = createBackgroundJournal(pi, context, {getEpoch, isWritable, isCurrentSession: () => isCurrent(context)});
 const service = createBackgroundSession({runtime, journal, onFault});
 return Object.freeze({service, getEpoch, isWritable, isCurrent, pause, resume, close});
}
