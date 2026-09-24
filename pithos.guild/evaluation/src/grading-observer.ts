// Public disposable-grader code only. Never import bank/comparator here.
// Cooperative observations, not hostile-code attestation. One imported candidate
// instance must serve the entire session; the owner releases one case at a time.
import assert from "node:assert/strict";

export interface GradingBinding {
  attemptId: string;
  gradingRunId: string;
  artifactDigest: string;
  observerDigest: string;
}
export interface PublicCase extends GradingBinding {
  version: 1;
  caseId: number;
  actor: { id: string; admin?: boolean | string | number };
  target: string;
  name: string;
  saveBehavior: 'return' | 'throw';
}
export interface CaseObservation extends GradingBinding {
  version: 1;
  caseId: number;
  saves: number;
  invalidSave: boolean;
  settlement: 'saved' | 'other' | 'rejected' | 'synchronous-throw';
  sameThrownObject: boolean;
  overflow: boolean;
}
export type AuthorizationCandidate = (actor: PublicCase['actor'], target: string, name: string,
  store: { save(id?: unknown, name?: unknown, ...extra: unknown[]): string }) => unknown;

export async function observeAuthorizationCase(candidate: AuthorizationCandidate, request: PublicCase): Promise<CaseObservation> {
  const { version, caseId, attemptId, gradingRunId, artifactDigest, observerDigest } = request;
  const result: CaseObservation = { version, caseId, attemptId, gradingRunId, artifactDigest, observerDigest,
    saves: 0, invalidSave: false, settlement: 'other', sameThrownObject: false, overflow: false };
  const error = new Error('persistence');
  const store = { save(id?: unknown, name?: unknown) {
    // Persistence deliberately has neither argument assertions nor a count rule.
    if (request.saveBehavior === 'throw') throw error;
    result.saves++;
    if (result.saves > 64) { result.overflow = true; throw new Error('Observation limit'); }
    try { assert.equal(id, request.target); assert.equal(name, request.name); }
    catch (caught) { result.invalidSave = true; throw caught; }
    return 'saved';
  } };
  let pending: unknown;
  try { pending = candidate(request.actor, request.target, request.name, store); }
  catch (caught) {
    result.settlement = 'synchronous-throw';
    result.sameThrownObject = caught === error;
    return result;
  }
  if (request.saveBehavior === 'throw') {
    // Retain assert.rejects' runtime promise-shape validation (a then-only object
    // is not accepted). The cast supplies no runtime trust: Node validates it.
    try {
      await assert.rejects(() => pending as Promise<unknown>, caught => {
        result.settlement = 'rejected';
        result.sameThrownObject = caught === error;
        return true;
      });
    } catch { /* fulfilled/unsupported return is not a persistence rejection */ }
    return result;
  }
  try { result.settlement = await pending === 'saved' ? 'saved' : 'other'; }
  catch (caught) { result.settlement = 'rejected'; result.sameThrownObject = caught === error; }
  return result;
}
