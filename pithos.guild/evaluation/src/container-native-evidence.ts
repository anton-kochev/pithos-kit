// Cooperative, fixture-only namespace observations. Not a native origin, kernel
// ancestry, SDK execution or provider authentication attestation.
import { isDeepStrictEqual as same } from 'node:util';
import { digest } from './manifest.ts';
import { deploymentCheck as check, exactKeys } from './producer-deployment.ts';
import type { containerAttemptBinding } from './producer-launcher.ts';
import type { ScopedAuthIdentity } from './scoped-auth-identity.ts';
export type ContainerBinding = ReturnType<typeof containerAttemptBinding>;
export interface ScopedProcess { namespace: string; pid: number }
export interface ContainerExpectation {
  binding: ContainerBinding;
  hostSupervisor: ScopedProcess; dockerClient: ScopedProcess;
  creator: ScopedProcess; parent: ScopedProcess; children: ScopedProcess[];
}
export interface ContainerEnvelope {
  version: 1; kind: 'container-native-diagnostic-envelope'; bindingDigest: string;
  runtime: { node: 'v24.20.0'; pi: '0.87.0'; piAi: '0.87.0' };
  processes: { process: ScopedProcess; parent: ScopedProcess; actor: 'parent' | 'child'; events: ['start', 'end'] }[];
}
export interface DiagnosticEvidence {
  version: 1; kind: 'synthetic-diagnostic-auth-lifecycle'; expected: ContainerExpectation;
  envelope: ContainerEnvelope; hostAuth: ScopedAuthIdentity; localAuth: ScopedAuthIdentity;
  authBinding: string; observedAt: number; transitions: string[];
  cleanup: { account: 'released'; source: 'deleted'; lease: 'revoked'; transit: 'released'; localFile: 'deleted'; endpoint: 'closed'; ownerId: string };
}
export const diagnosticTransitions = ['prepared', 'bound', 'committed', 'provisioned', 'observed', 'running', 'revoking', 'cleanup-pending', 'closed'];
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function processIdentity(p: ScopedProcess) {
  exactKeys(p, ['namespace', 'pid']); check(sha(p.namespace) && Number.isSafeInteger(p.pid) && p.pid > 0 && p.pid <= 2147483647);
}
function authIdentity(a: ScopedAuthIdentity) {
  exactKeys(a, ['version', 'kind', 'dev', 'ino', 'uid', 'fileDigest', 'accountDigest', 'expires']);
  check(a.version === 1 && a.kind === 'scoped-codex-auth-file-observation' && /^\d+$/.test(a.dev) && /^\d+$/.test(a.ino)
    && Number.isSafeInteger(a.uid) && a.uid >= 0 && sha(a.fileDigest) && sha(a.accountDigest) && Number.isSafeInteger(a.expires) && a.expires > 0);
}
// Same bounded rederivation at fresh finalization and retained audit. No success
// boolean is accepted, and current token freshness is deliberately not required
// when re-auditing historical, already revoked evidence.
export function auditContainerDiagnostic(e: DiagnosticEvidence, trusted: ContainerExpectation) {
  check(Buffer.byteLength(JSON.stringify(e)) <= 64 * 1024);
  exactKeys(e, ['version', 'kind', 'expected', 'envelope', 'hostAuth', 'localAuth', 'authBinding', 'observedAt', 'transitions', 'cleanup']);
  check(e.version === 1 && e.kind === 'synthetic-diagnostic-auth-lifecycle' && same(e.expected, trusted));
  exactKeys(trusted, ['binding', 'hostSupervisor', 'dockerClient', 'creator', 'parent', 'children']);
  const b = trusted.binding;
  exactKeys(b, ['version', 'kind', 'identity', 'deploymentDigest', 'producer', 'daemon', 'endpoint', 'namespace', 'intentDigest', 'receiver', 'timeoutMs', 'forbiddenRoots']);
  check(b.version === 1 && b.kind === 'container-diagnostic-launch-v1' && sha(b.deploymentDigest) && sha(b.daemon) && sha(b.namespace)
    && sha(b.intentDigest) && b.endpoint.startsWith('unix:///') && b.timeoutMs > 0 && b.timeoutMs <= 300000
    && b.receiver === `/tmp/guild-auth/${b.identity.trialId}/auth.json`);
  exactKeys(b.identity, ['trialId', 'requestDigest', 'baselineDigest', 'campaignDigest', 'admissionDigest', 'launchDigest']);
  check(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(b.identity.trialId)
    && Object.entries(b.identity).every(([k, v]) => k === 'trialId' || sha(v)));
  check(Array.isArray(b.forbiddenRoots) && b.forbiddenRoots.length === 5 && new Set(b.forbiddenRoots).size === 5
    && b.forbiddenRoots.every(p => typeof p === 'string' && p.startsWith('/') && p.length <= 4096));
  exactKeys(b.producer, ['id', 'name', 'image']); check(sha(b.producer.id) && /^sha256:[a-f0-9]{64}$/.test(b.producer.image));
  check(Array.isArray(trusted.children) && trusted.children.length > 0 && trusted.children.length <= 62);
  const local = [trusted.creator, trusted.parent, ...trusted.children], host = [trusted.hostSupervisor, trusted.dockerClient];
  [...local, ...host].forEach(processIdentity);
  check(local.every(p => p.namespace === b.namespace) && new Set(local.map(p => p.pid)).size === local.length
    && host.every(p => p.namespace !== b.namespace && p.namespace === host[0].namespace) && host[0].pid !== host[1].pid);
  exactKeys(e.envelope, ['version', 'kind', 'bindingDigest', 'runtime', 'processes']);
  check(same(e.envelope.runtime, { node: 'v24.20.0', pi: '0.87.0', piAi: '0.87.0' }));
  check(e.envelope.version === 1 && e.envelope.kind === 'container-native-diagnostic-envelope' && e.envelope.bindingDigest === digest(trusted)
    && Array.isArray(e.envelope.processes) && e.envelope.processes.length === local.length - 1);
  for (const [i, row] of e.envelope.processes.entries()) {
    exactKeys(row, ['process', 'parent', 'actor', 'events']);
    check(same(row.process, local[i + 1]) && same(row.parent, i === 0 ? trusted.creator : trusted.parent)
      && row.actor === (i === 0 ? 'parent' : 'child') && same(row.events, ['start', 'end']));
  }
  authIdentity(e.hostAuth); authIdentity(e.localAuth);
  check(Number.isSafeInteger(e.observedAt) && e.observedAt > 0 && e.hostAuth.expires > e.observedAt + b.timeoutMs + 360000);
  check(e.hostAuth.fileDigest === e.localAuth.fileDigest && e.hostAuth.accountDigest === e.localAuth.accountDigest && e.hostAuth.expires === e.localAuth.expires
    && e.authBinding === digest({ intent: b.intentDigest, host: e.hostAuth, local: e.localAuth, receiver: b.receiver, namespace: b.namespace })
    && same(e.transitions, diagnosticTransitions));
  exactKeys(e.cleanup, ['account', 'source', 'lease', 'transit', 'localFile', 'endpoint', 'ownerId']);
  check(same(e.cleanup, { account: 'released', source: 'deleted', lease: 'revoked', transit: 'released', localFile: 'deleted', endpoint: 'closed', ownerId: b.producer.id }));
  return digest(e);
}
