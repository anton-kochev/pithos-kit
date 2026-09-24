// Test-owned synthetic account and inert file/channel fixtures ONLY. This does
// not provision a container or issue a native origin. No credential-source input.
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexAuthLease, readCodexAuthLease } from './codex-auth.ts';
import { captureScopedAuth, assertScopedAuth } from './scoped-auth-identity.ts';
import { containerAttemptBinding, type ProducerAttempt } from './producer-launcher.ts';
import { deploymentCheck as check } from './producer-deployment.ts';
import { digest } from './manifest.ts';
import { auditContainerDiagnostic, diagnosticTransitions, type ContainerExpectation, type DiagnosticEvidence } from './container-native-evidence.ts';
type State = 'prepared' | 'bound' | 'committed' | 'provisioned' | 'observed' | 'running' | 'revoking' | 'cleanup-pending' | 'closed';
type Fault = '' | 'scope-missing' | 'scope-reordered' | 'lease-clone' | 'lease-disposed' | 'local-replacement' | 'missing-file-ack' | 'missing-endpoint-ack' | 'cancel';
interface Session {
  state: State; expected: ContainerExpectation; transitions: string[]; used: boolean; failed: boolean;
  evidence?: Omit<DiagnosticEvidence, 'cleanup'>;
}
const sessions = new WeakMap<ProducerAttempt, Session>();
function held(attempt: ProducerAttempt) { const s = sessions.get(attempt); check(s); return s; }
function transition(s: Session, state: State) { s.state = state; s.transitions.push(state); }
export function diagnosticState(attempt: ProducerAttempt): State { return held(attempt).state; }
export async function prepareDiagnosticAuth(attempt: ProducerAttempt) {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Diagnostic transport is test-only');
  check(!sessions.has(attempt));
  const binding = containerAttemptBinding(attempt), host = digest({ hostFixture: binding.deploymentDigest });
  const local = (pid: number) => ({ namespace: binding.namespace, pid });
  // Authored namespace PIDs, never host/process/procfs observations. Docker
  // client's numeric PID deliberately equals creator's: no identity equivalence.
  const expected: ContainerExpectation = { binding, hostSupervisor: { namespace: host, pid: 4100 }, dockerClient: { namespace: host, pid: 4101 },
    creator: local(4101), parent: local(4102), children: [local(4103)] };
  const s: Session = { state: 'prepared', expected, transitions: ['prepared'], used: false, failed: false };
  sessions.set(attempt, s); transition(s, 'bound');
}
export function commitDiagnosticAuth(attempt: ProducerAttempt) {
  const s = held(attempt); check(s.state === 'bound' && digest(containerAttemptBinding(attempt)) === digest(s.expected.binding));
  transition(s, 'committed');
}
// No arbitrary credential, lease, path, observation or successful evidence input.
// Faults are closed authored negative fixtures, not extension callbacks.
export async function runDiagnosticContainer(attempt: ProducerAttempt, fault: Fault = '', signal?: AbortSignal) {
  const s = held(attempt); check(s.state === 'committed');
  check(['', 'scope-missing', 'scope-reordered', 'lease-clone', 'lease-disposed', 'local-replacement', 'missing-file-ack', 'missing-endpoint-ack', 'cancel'].includes(fault));
  transition(s, 'provisioned'); // inert owned channel/file fixture, NOT a container
  let root: string | undefined, lease: Awaited<ReturnType<typeof createCodexAuthLease>> | undefined;
  let transit: Buffer | undefined;
  // Endpoint destruction is explicit, after original-lease revocation; avoid
  // auto-destruction while the receiver consumes the synthetic bytes.
  const endpoint = new PassThrough({ highWaterMark: 1024 * 1024, autoDestroy: false });
  const scope = { timeoutMs: s.expected.binding.timeoutMs, forbiddenRoots: [...s.expected.binding.forbiddenRoots] };
  const deadline = performance.now() + scope.timeoutMs;
  // Keep the original execution deadline; cancellation gets only the existing
  // 500ms owned-cleanup ceiling, never a second trial window. Uncancellable fs
  // awaits stay owned by work below and are cleaned up when they settle.
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined, detached = false;
  const cancel = () => {
    s.failed = true;
    if (!detached) cleanupTimer ??= setTimeout(() => rejectStopped(new Error('Diagnostic run cancelled or timed out')), 500);
  };
  const timer = setTimeout(cancel, scope.timeoutMs);
  const assertActive = () => {
    if (signal?.aborted || performance.now() >= deadline) cancel();
    check(!s.failed);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const work = async () => {
    try {
      assertActive();
      root = await mkdtemp(join(tmpdir(), 'guild-diagnostic-'));
      assertActive();
      const sourceFile = join(root, 'source.json'), localRoot = join(root, 'receiver');
      await mkdir(localRoot, { mode: 0o700 });
      assertActive();
      const accountId = `synthetic-account-${randomUUID()}`, expires = Math.floor(Date.now() / 1000) + 3600;
      const token = [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ exp: expires,
        'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url'), Buffer.from(`synthetic-secret-${randomUUID()}`).toString('base64url')].join('.');
      await writeFile(sourceFile, JSON.stringify({ 'openai-codex': { type: 'oauth', access: token, refresh: '', expires: expires * 1000, accountId } }), { flag: 'wx', mode: 0o600 });
      assertActive();
      lease = await createCodexAuthLease({ sourceFile, temporaryRoot: root, ...scope });
      assertActive();
      if (fault === 'lease-disposed') await lease.dispose();
      const original = fault === 'lease-clone' ? { ...lease } : lease;
      const expectedScope = fault === 'scope-missing' ? { ...scope, forbiddenRoots: [] }
        : fault === 'scope-reordered' ? { ...scope, forbiddenRoots: [...scope.forbiddenRoots].reverse() } : scope;
      const host = readCodexAuthLease(original, expectedScope);
      // Bytes cross only this owned inert channel after original-handle and exact
      // scope freshness checks. Logical tmpfs destination maps to an owned fixture.
      transit = await readFile(join(host.directory, 'auth.json'));
      assertActive();
      readCodexAuthLease(lease, scope);
      const localFile = join(localRoot, 'auth.json');
      endpoint.end(transit);
      const received: Buffer = endpoint.read(); check(Buffer.isBuffer(received) && received.equals(transit));
      await writeFile(localFile, received, { flag: 'wx', mode: 0o600 });
      assertActive();
      const localAuth = captureScopedAuth(localFile, scope.timeoutMs);
      check(localAuth.fileDigest === host.identity.fileDigest && localAuth.accountDigest === host.identity.accountDigest);
      transition(s, 'observed');
      if (fault === 'local-replacement') {
        await rename(localFile, localFile + '.old'); await writeFile(localFile, transit, { flag: 'wx', mode: 0o600 });
      }
      readCodexAuthLease(lease, scope); assertScopedAuth(localFile, localAuth, scope.timeoutMs);
      check(!endpoint.closed); // lifecycle owner, not stream EOF, initiates cleanup
      assertActive(); if (fault === 'cancel') throw new Error('Diagnostic fixture cancelled');
      transition(s, 'running');
      const b = s.expected.binding;
      s.evidence = { version: 1, kind: 'synthetic-diagnostic-auth-lifecycle', expected: structuredClone(s.expected),
        envelope: { version: 1, kind: 'container-native-diagnostic-envelope', bindingDigest: digest(s.expected),
          runtime: { node: 'v24.20.0', pi: '0.87.0', piAi: '0.87.0' }, processes:
          [s.expected.parent, ...s.expected.children].map((process, i) => ({ process, parent: i === 0 ? s.expected.creator : s.expected.parent,
            actor: i === 0 ? 'parent' : 'child', events: ['start', 'end'] })) },
        hostAuth: host.identity, localAuth, observedAt: Date.now(), authBinding: digest({ intent: b.intentDigest, host: host.identity, local: localAuth, receiver: b.receiver, namespace: b.namespace }), transitions: s.transitions };
    } catch (error) { s.failed = true; throw error; }
    finally {
      transition(s, 'revoking');
      // Original issuer revocation precedes ALL source/receiver/channel cleanup.
      // Buffer filling is best effort; no heap-erasure claim for JS strings/copies.
      const failures: Error[] = [];
      const cleanup = async (label: string, action: () => Promise<void>) => {
        try { await action(); }
        catch { s.failed = true; failures.push(new Error(`Diagnostic ${label} cleanup uncertain`)); }
      };
      try {
        await cleanup('lease', async () => { if (lease) await lease.dispose(); });
        await cleanup('revocation', async () => {
          if (lease) { let revoked = false; try { readCodexAuthLease(lease, scope); } catch { revoked = true; } check(revoked); }
        });
        await cleanup('endpoint', async () => {
          if (!endpoint.closed) { const closed = once(endpoint, 'close'); endpoint.destroy(); await closed; }
          check(endpoint.closed);
        });
        await cleanup('transit', async () => { if (transit) transit.fill(0); transit = undefined; });
        await cleanup('files', async () => {
          if (root) { await rm(root, { recursive: true, force: true });
            let absent = false; try { await lstat(root); } catch (e) { absent = (e as NodeJS.ErrnoException).code === 'ENOENT'; } check(absent); }
        });
        await cleanup('acknowledgement', async () => { check(fault !== 'missing-file-ack' && fault !== 'missing-endpoint-ack'); });
        if (failures.length) throw new AggregateError(failures, 'Diagnostic cleanup uncertain');
      }
      finally {
        if (signal?.aborted || performance.now() >= deadline) s.failed = true;
        transition(s, 'cleanup-pending');
      }
      check(!s.failed);
    }
  };
  try { await Promise.race([work(), stopped]); }
  finally {
    detached = true;
    clearTimeout(timer); clearTimeout(cleanupTimer);
    signal?.removeEventListener('abort', cancel);
  }
}
// Internally consumed by registered finalization, never accepts caller evidence.
export function consumeDiagnosticAuth(attempt: ProducerAttempt) {
  const s = held(attempt); check(!s.used); s.used = true;
  check(s.state === 'cleanup-pending' && !s.failed && s.evidence);
  const expected = structuredClone(s.expected);
  const observedAuth = structuredClone({ host: s.evidence.hostAuth, local: s.evidence.localAuth, observedAt: s.evidence.observedAt });
  return { expected, observedAuth, completeAfterOwnedDestruction() {
    check(s.state === 'cleanup-pending' && !s.failed && s.evidence);
    transition(s, 'closed');
    const evidence: DiagnosticEvidence = { ...s.evidence, transitions: [...s.transitions], cleanup: {
      account: 'released', source: 'deleted', lease: 'revoked', transit: 'released', localFile: 'deleted', endpoint: 'closed', ownerId: expected.binding.producer.id } };
    check(s.transitions.join(',') === diagnosticTransitions.join(','));
    auditContainerDiagnostic(evidence, expected); return structuredClone(evidence);
  } };
}
export function provisionDiagnosticAuthTransport(): never { throw new Error('CLOSED: operational diagnostic authentication transport'); }
