// Supervisor-private: never include in the producer/disposable-grader roster.
import type { CaseObservation, GradingBinding, PublicCase } from "./grading-observer.ts";
import { gradingTransportSession, type GradingProcessTransport } from './grading-transport.ts';
import { confinedGradingOwner, type OwnedGradingConnection } from './grading-owner.ts';

// Prepared interface; the fixed byte transport also accepts the inert owned
// preparation lifecycle. No operational confined owner is installed.
// exchange must bound stdout+stderr to 64 KiB, use one candidate instance, and
// abort I/O on signal. close must independently confirm environment/descendant
// destruction, not merely acknowledge a client exit. No candidate paths/callbacks.
export interface GradingSession {
  exchange(request: PublicCase, signal: AbortSignal): Promise<string>;
  close(): Promise<'confirmed' | 'uncertain'>;
}
const cases: Array<[PublicCase['actor'], string, boolean]> = [
  [{id:'a'}, 'a', true], [{id:'a'}, 'b', false],
  [{id:'a',admin:true}, 'b', true], [{id:'',admin:true}, 'b', false],
  [{id:'a',admin:'true'}, 'b', false], [{id:'a',admin:1}, 'b', false],
];
const keys = ['version', 'caseId', 'attemptId', 'gradingRunId', 'artifactDigest', 'observerDigest',
  'saves', 'invalidSave', 'settlement', 'sameThrownObject', 'overflow'].sort().join(',');
function parse(frame: string, request: PublicCase): CaseObservation {
  if (typeof frame !== 'string' || Buffer.byteLength(frame) > 4096) throw new Error('Frame limit');
  const value = JSON.parse(frame);
  // One canonical JSON record; rejects duplicate keys, trailing framing and
  // noncanonical encodings rather than letting JSON's last-key-wins mask replay.
  if (JSON.stringify(value) !== frame) throw new Error('Noncanonical frame');
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys
    || value.version !== 1 || value.caseId !== request.caseId
    || value.attemptId !== request.attemptId || value.gradingRunId !== request.gradingRunId
    || value.artifactDigest !== request.artifactDigest || value.observerDigest !== request.observerDigest
    || !Number.isSafeInteger(value.saves) || value.saves < 0 || value.saves > 64
    || typeof value.invalidSave !== 'boolean' || typeof value.sameThrownObject !== 'boolean'
    || typeof value.overflow !== 'boolean' || value.overflow
    || !['saved', 'other', 'rejected', 'synchronous-throw'].includes(value.settlement)) throw new Error('Invalid observation');
  return value;
}
function validBinding(binding: GradingBinding): boolean {
  return Object.keys(binding).sort().join(',') === 'artifactDigest,attemptId,gradingRunId,observerDigest'
    && [binding.attemptId, binding.gradingRunId].every(v => typeof v === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(v))
    && [binding.artifactDigest, binding.observerDigest].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v));
}
export async function superviseAuthorization(binding: GradingBinding, connection: GradingSession | GradingProcessTransport | OwnedGradingConnection, signal?: AbortSignal) {
  const owner = 'open' in connection ? connection : undefined;
  let session: GradingSession = owner ? { exchange: async () => { throw new Error('Owner not opened'); }, close: () => owner.close() }
    : 'exchange' in connection ? connection : gradingTransportSession(connection as GradingProcessTransport);
  let state: 'passed' | 'rejected' | 'inconclusive' | 'cancelled' | 'cleanup-pending' = 'inconclusive';
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  // Reserve the final 500 ms of the existing five-second window for cleanup.
  const timer = setTimeout(abort, 4500);
  let outputBytes = 0;
  let effectiveBinding: GradingBinding | null = null;
  try {
    if (!validBinding(binding)) throw new Error('Binding');
    binding = { ...binding }; // Do not retain the caller's mutable session identity.
    if (owner) {
      let remove = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        const abort = () => reject(new Error('Owner preparation cancelled'));
        controller.signal.addEventListener('abort', abort, { once: true });
        remove = () => controller.signal.removeEventListener('abort', abort);
        if (controller.signal.aborted) abort();
      });
      try {
        const opened = await Promise.race([owner.open(binding, controller.signal), cancelled]);
        session = gradingTransportSession(opened.transport);
        if (!validBinding(opened.binding) || opened.binding.attemptId !== binding.attemptId || opened.binding.gradingRunId !== binding.gradingRunId) throw new Error('Owned binding mismatch');
        binding = { ...opened.binding };
      } finally { remove(); }
    }
    effectiveBinding = { ...binding };
    for (let caseId = 0; caseId < 7; caseId++) {
      controller.signal.throwIfAborted();
      const [actor, target, allowed] = cases[caseId] ?? [{id:'a'}, 'a', false];
      const request: PublicCase = { ...binding, version: 1, caseId, actor: {...actor}, target, name: 'New', saveBehavior: caseId === 6 ? 'throw' : 'return' };
      let remove = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error('Stopped'));
        controller.signal.addEventListener('abort', onAbort, {once:true});
        remove = () => controller.signal.removeEventListener('abort', onAbort);
      });
      let frame: string;
      try { frame = await Promise.race([session.exchange(structuredClone(request), controller.signal), cancelled]); }
      finally { remove(); }
      controller.signal.throwIfAborted();
      outputBytes += typeof frame === 'string' ? Buffer.byteLength(frame) : 65537;
      if (outputBytes > 65536) throw new Error('Output limit');
      const observed = parse(frame, request);
      const passed = caseId === 6
        ? observed.settlement === 'rejected' && observed.sameThrownObject
        : !observed.invalidSave && observed.saves === (allowed ? 1 : 0)
          && (allowed ? observed.settlement === 'saved' : ['rejected', 'synchronous-throw'].includes(observed.settlement));
      if (!passed) { state = 'rejected'; break; }
      if (caseId === 6) state = 'passed';
      // Only the next public invocation discloses progress. Never send predicates,
      // observed records, detailed failures or final judgments back to candidate.
    }
  } catch { state = signal?.aborted ? 'cancelled' : 'inconclusive'; }
  finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cleanup = await Promise.race([session.close(), new Promise<'uncertain'>(resolve => {
        cleanupTimer = setTimeout(() => resolve('uncertain'), 500);
      })]);
      if (cleanup !== 'confirmed') state = 'cleanup-pending';
    } catch { state = 'cleanup-pending'; }
    finally { clearTimeout(cleanupTimer); }
  }
  if (signal?.aborted && state !== 'cleanup-pending') state = 'cancelled';
  return { passed: state === 'passed', state, binding: effectiveBinding };
}

export function requireConfinedGrading(): never {
  confinedGradingOwner();
  throw new Error('Confined grading gate must remain closed');
}
