// Supervisor-private. Operational issuance is deliberately unavailable.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { digest, type EvalTask } from './manifest.ts';
import { changedPaths, type Snapshot } from './fixture.ts';
import { inertGradingOwner, readTree, treeDigest, type GradingSelection, type OwnedSnapshotEvidence, type Tree } from './grading-owner.ts';
import { approvedGitDigest } from './grading-snapshot.ts';
import { superviseAuthorization } from './grading-boundary.ts';
import { consumeProducerAttempt, type ProducerAttempt } from './producer-launcher.ts';
import type { ProducerDeployment } from './producer-deployment.ts';
import { consumeFinalizationStorage, recheckFinalizationStorage, type FinalizationStorage, type FinalizationStorageEvidence } from './finalization-storage.ts';
import { inertDockerGradingOwner } from './grading-composition.ts';
import { consumeDiagnosticAuth } from './diagnostic-auth-transport.ts';
import { auditContainerDiagnostic, type ContainerExpectation, type DiagnosticEvidence } from './container-native-evidence.ts';

export interface FinalizationIdentity {
  trialId: string; requestDigest: string; baselineDigest: string;
  campaignDigest: string; admissionDigest: string; launchDigest: string;
}
type TrialBinding = Pick<FinalizationIdentity, 'trialId' | 'requestDigest' | 'baselineDigest'>;
export type Finalization = { version: 1; state: 'pending'; reason: 'confined-snapshot-evidence-required' }
  | { version: 1; state: 'completed'; recordDigest: string }
  | { version: 2; state: 'completed'; recordDigest: string; containerBindingDigest: string };
declare const brand: unique symbol;
export type FinalizationOrigin = { readonly [brand]: true };
const origins = new WeakMap<FinalizationOrigin, {
  directory: string; identity: FinalizationIdentity; selection: GradingSelection;
  owner: ReturnType<typeof inertGradingOwner>; used: boolean;
  storage?: FinalizationStorageEvidence; producerCommitment?: string;
  diagnostic?: ReturnType<typeof consumeDiagnosticAuth>;
}>();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pending = (): Finalization => ({ version: 1, state: 'pending', reason: 'confined-snapshot-evidence-required' });
function check(value: unknown): asserts value { if (!value) throw new Error('Confined final snapshot evidence is required: finalization mismatch'); }
function privateRoot(directory: string) {
  check(resolve(directory) === directory && /^[a-f0-9-]{36}$/.test(basename(directory)));
  return join(dirname(directory), '.finalization', basename(directory));
}
async function privateDirectory(directory: string) {
  const root = privateRoot(directory);
  let current = '/';
  for (const part of root.split('/').filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    check(info.isDirectory() && !info.isSymbolicLink());
    if (current === root || current === dirname(root)) check(info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700);
  }
}
async function readRecord(directory: string, signal?: AbortSignal) {
  await privateDirectory(directory);
  const root = privateRoot(directory), entries = await opendir(root, { bufferSize: 1 });
  const names: string[] = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const entry = await entries.read();
      if (!entry) break;
      names.push(entry.name); check(names.length <= 2);
    }
  } finally { await entries.close(); }
  check(names.sort().join(',') === 'artifact,finalization.json');
  const file = await open(join(root, 'finalization.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    check(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.() && (before.mode & 0o777) === 0o600 && before.size <= 16 * 1024 * 1024);
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await file.stat(), leaf = await lstat(join(root, 'finalization.json'));
    check(size === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
      && before.dev === leaf.dev && before.ino === leaf.ino && leaf.nlink === 1);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally { await file.close(); }
}
// Authored test fixtures only; NODE_TEST_CONTEXT is not hostile-code authority.
// No caller-owned connection/receipt registration API is provided.
export function issueInertFinalizationOrigin(directory: string, identity: FinalizationIdentity,
  selection: GradingSelection, boundary: Parameters<typeof inertGradingOwner>[1]): FinalizationOrigin {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Inert finalization origin is test-only');
  check(identity.trialId === basename(directory) && Object.keys(identity).sort().join(',') === 'admissionDigest,baselineDigest,campaignDigest,launchDigest,requestDigest,trialId'
    && Object.entries(identity).every(([k, v]) => k === 'trialId' || /^[a-f0-9]{64}$/.test(v)));
  const retained = join(privateRoot(directory), 'artifact');
  check(selection.producer === join(directory, 'repo') && selection.snapshotGitDigest !== undefined);
  const s = structuredClone({ ...selection, retained });
  // Private storage may never be nested in code, producer or grader exchange.
  check([s.code, s.producer, s.exchange].every(p => p !== dirname(retained) && !retained.startsWith(p + '/') && !p.startsWith(dirname(retained) + '/')));
  const origin = Object.freeze({}) as FinalizationOrigin;
  origins.set(origin, { directory, identity: structuredClone(identity), selection: s, owner: inertGradingOwner(s, boundary), used: false });
  return origin;
}
// Only the internal registered launch route can supply the original attempt and
// its exclusive storage. No caller owner, callback, observation or receipt input.
export async function issueRegisteredFinalizationOrigin(deployment: ProducerDeployment, attempt: ProducerAttempt, storage: FinalizationStorage): Promise<FinalizationOrigin> {
  const held = consumeProducerAttempt(attempt, deployment);
  const diagnostic = held.mode === 'container-diagnostic-launch-v1' ? consumeDiagnosticAuth(attempt) : undefined;
  if (diagnostic) check(digest(diagnostic.expected.binding.identity) === digest(held.identity)
    && digest(diagnostic.expected.binding.producer) === digest(held.selection.grading.producerIdentity));
  const evidence = consumeFinalizationStorage(storage, deployment, held.directory, attempt);
  await recheckFinalizationStorage(evidence);
  const origin = Object.freeze({}) as FinalizationOrigin;
  origins.set(origin, { directory: held.directory, identity: held.identity, selection: held.selection.grading,
    owner: inertDockerGradingOwner(held.selection, held.spawn, attempt), used: false, storage: evidence, producerCommitment: held.commitment, diagnostic });
  return origin;
}
function derive(task: EvalTask, baseline: Snapshot, final: Snapshot, passed: boolean) {
  const changed = changedPaths(baseline, final), indexPreserved = baseline.index === final.index;
  return { behavior: passed, checkCancelled: false, scope: indexPreserved && changed.every(p => task.allowedChanges.includes(p)), changed,
    indexPreserved, diagnostic: 'Owned authorization comparator completed.', checkerMutated: false,
    review: 'pending' as const, taskSuccess: null, final };
}
interface RecordEvidence {
  version: 1 | 2; identity: FinalizationIdentity; ownership: Pick<GradingSelection, 'image' | 'uid' | 'gid' | 'sources' | 'imageFiles' | 'producerIdentity'>;
  comparator: Awaited<ReturnType<typeof superviseAuthorization>>; evidence: OwnedSnapshotEvidence;
  storage?: FinalizationStorageEvidence; producerCommitment?: string;
  container?: { expected: ContainerExpectation; evidence: DiagnosticEvidence; observedAuth: ReturnType<typeof consumeDiagnosticAuth>['observedAuth'] };
}
async function validateRecord(record: RecordEvidence, directory: string, identity: FinalizationIdentity, task: EvalTask, baseline: Snapshot, signal?: AbortSignal) {
  check((record.version === 1 || record.version === 2) && identity.trialId === basename(directory) && digest(record.identity) === digest(identity)
    && digest(baseline) === identity.baselineDigest && task.grader === 'authorization');
  if (record.version === 2) {
    check(record.storage && record.container);
    const { expected, evidence, observedAuth } = record.container;
    check(digest(observedAuth) === digest({ host: evidence.hostAuth, local: evidence.localAuth, observedAt: evidence.observedAt }));
    check(digest(expected.binding.identity) === digest(identity)
      && digest(expected.binding.producer) === digest(record.ownership.producerIdentity)
      && expected.binding.producer.image === record.ownership.image);
    auditContainerDiagnostic(evidence, expected);
  } else check(record.container === undefined);
  if (record.storage) {
    check(record.storage.directory === directory && record.storage.root === privateRoot(directory)
      && typeof record.producerCommitment === 'string' && /^[a-f0-9]{64}$/.test(record.producerCommitment));
    await recheckFinalizationStorage(record.storage);
  }
  const e = record.evidence, c = record.comparator;
  check(e.version === 1 && ['passed', 'rejected'].includes(c.state) && c.passed === (c.state === 'passed')
    && c.binding !== null && digest(c.binding) === digest(e.binding) && e.binding.attemptId === identity.trialId
    && e.binding.observerDigest === hash(JSON.stringify(record.ownership.sources))
    // Owner snapshotDigest uses raw JSON order, unlike manifest.digest.
    && e.snapshotDigest === hash(JSON.stringify(e.snapshot)));
  const artifact = join(privateRoot(directory), 'artifact'), info = await lstat(artifact);
  check(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700);
  const tree = await readTree(artifact, signal);
  check(treeDigest(tree) === e.materializationDigest && e.manifest.length === tree.size);
  const original: Tree = new Map();
  for (const [i, [path, entry]] of [...tree].entries()) {
    const m = e.manifest[i];
    check(m.path === path && m.kind === entry.kind && Number.isInteger(m.mode) && m.mode >= 0 && m.mode <= 0o777
      && (entry.kind !== 'file' || m.digest === hash(entry.bytes)));
    original.set(path, { ...entry, mode: m.mode });
  }
  check(treeDigest(original) === e.binding.artifactDigest && approvedGitDigest(original) === e.gitDigest);
  const files: Snapshot['files'] = Object.create(null);
  for (const [path, entry] of original) if (entry.kind === 'file' && !path.startsWith('.git/')) files[path] = { kind: 'file', digest: hash(entry.bytes), mode: entry.mode };
  check(digest(files) === digest(e.snapshot.files) && ['index', 'status', 'diff'].every(k => typeof e.snapshot[k as keyof Snapshot] === 'string'));
  // Preserve the owner's raw JSON snapshot hash when retaining the record.
  // Protocol decoding and reconstructed file maps may have different key order.
  return derive(task, baseline, { ...e.snapshot, files }, c.passed);
}
export async function finalizeOwnedTrial(origin: FinalizationOrigin, directory: string, identity: TrialBinding, task: EvalTask, baseline: Snapshot, signal?: AbortSignal) {
  const held = origins.get(origin);
  check(held && !held.used);
  held.used = true;
  check(held.directory === directory && task.grader === 'authorization' && digest(baseline) === identity.baselineDigest
    && held.identity.trialId === identity.trialId && held.identity.requestDigest === identity.requestDigest
    && held.identity.baselineDigest === identity.baselineDigest
    && Object.entries(identity).every(([k, v]) => held.identity[k as keyof FinalizationIdentity] === v));
  if (held.storage) await recheckFinalizationStorage(held.storage);
  else await mkdir(privateRoot(directory), { recursive: true, mode: 0o700 });
  await privateDirectory(directory);
  const comparator = await superviseAuthorization({ attemptId: identity.trialId, gradingRunId: randomUUID(), artifactDigest: '0'.repeat(64), observerDigest: '0'.repeat(64) }, held.owner, signal);
  if (!['passed', 'rejected'].includes(comparator.state) || !held.owner.snapshotEvidence) return { finalization: pending(), grade: undefined };
  const evidence = await held.owner.snapshotEvidence(signal);
  check(evidence.gitDigest === held.selection.snapshotGitDigest && digest(evidence.binding) === digest(comparator.binding));
  const { image, uid, gid, sources, imageFiles, producerIdentity } = held.selection;
  // The concrete owner reached a comparator outcome only AFTER full-ID producer
  // destruction with policy reinspection and confirmed empty enumeration.
  const container = held.diagnostic ? { expected: held.diagnostic.expected, observedAuth: held.diagnostic.observedAuth, evidence: held.diagnostic.completeAfterOwnedDestruction() } : undefined;
  const record: RecordEvidence = { version: container ? 2 : 1, ...(container ? { container } : {}), identity: held.identity, ownership: { image, uid, gid, sources, imageFiles, producerIdentity }, comparator, evidence,
    ...(held.storage ? { storage: held.storage, producerCommitment: held.producerCommitment } : {}) };
  const grade = await validateRecord(record, directory, held.identity, task, baseline, signal);
  const raw = JSON.stringify(record);
  check(Buffer.byteLength(raw) <= 16 * 1024 * 1024);
  signal?.throwIfAborted();
  await writeFile(join(privateRoot(directory), 'finalization.json'), raw, { flag: 'wx', mode: 0o600, signal });
  return { finalization: (container
    ? { version: 2, state: 'completed', recordDigest: hash(raw), containerBindingDigest: digest({ expected: container.expected, observedAuth: container.observedAuth }) }
    : { version: 1, state: 'completed', recordDigest: hash(raw) }) as Finalization, grade };
}
export async function auditRetainedFinalization(directory: string, identity: FinalizationIdentity, task: EvalTask, baseline: Snapshot, finalization: Finalization | undefined, signal?: AbortSignal) {
  check((finalization?.version === 1 || finalization?.version === 2) && finalization.state === 'completed');
  const raw = await readRecord(directory, signal);
  check(hash(raw) === finalization.recordDigest);
  const record: RecordEvidence = JSON.parse(raw);
  check(record.version === finalization.version);
  if (finalization.version === 2) check(record.container
    && digest({ expected: record.container.expected, observedAuth: record.container.observedAuth }) === finalization.containerBindingDigest);
  const grade = await validateRecord(record, directory, identity, task, baseline, signal);
  return { grade, raw };
}
