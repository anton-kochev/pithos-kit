// Supervisor-private DATA contract. Validation is neither approval nor provenance.
import { resolve, join } from 'node:path';
import { digest } from './manifest.ts';
export interface DeploymentRoster { root: string; files: Record<string, string>; inventoryDigest: string }
export interface ProducerDeploymentData {
  version: 1; image: string; uid: number; gid: number;
  runtime: { node: string; pi: string; piAi: string; platform: string; arch: string; files: Record<string, string>; inventoryDigest: string };
  docker: { executable: string; sha256: string; endpoint: string; daemonIdentity: string; namespaceIdentity: string;
    config: DeploymentRoster & { uid: number; gid: number; mode: number } };
  git: { executable: string; version: string; sha256: string };
  producer: DeploymentRoster; grader: DeploymentRoster; exporter: DeploymentRoster;
  exchange: string; mountAliases: string[];
  retention: { trialParent: string; uid: number; gid: number; mode: number };
}
export function deploymentCheck(value: unknown): asserts value { if (!value) throw new Error('Producer deployment mismatch'); }
export function exactKeys(value: any, names: string[]) {
  deploymentCheck(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === names.length && names.every(k => Object.getOwnPropertyDescriptor(value, k)?.value !== undefined)
    && Object.keys(value).sort().join(',') === [...names].sort().join(','));
}
export function deploymentPath(value: unknown): asserts value is string {
  deploymentCheck(typeof value === 'string' && value !== '/' && /^\/[a-zA-Z0-9_./-]+$/.test(value) && resolve(value) === value);
}
export const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const owner = (v: unknown, root = false) => Number.isSafeInteger(v) && Number(v) >= (root ? 0 : 1) && Number(v) <= 2147483647;
function inventory(files: any, expected: unknown, absolute: boolean, names?: string[]) {
  deploymentCheck(files && typeof files === 'object' && !Array.isArray(files) && Object.getPrototypeOf(files) === Object.prototype);
  const keys = Reflect.ownKeys(files);
  deploymentCheck(keys.length > 0 && keys.length <= 256 && keys.every(k => typeof k === 'string'
    && Object.getOwnPropertyDescriptor(files, k)?.value !== undefined && sha(files[k])));
  for (const name of Object.keys(files)) {
    if (absolute) deploymentPath(name);
    else deploymentCheck(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) && !name.split('/').some(p => p === '.' || p === '..'));
  }
  deploymentCheck(sha(expected) && digest(files) === expected);
  if (names) deploymentCheck(Object.keys(files).sort().join(',') === [...names].sort().join(','));
}
export function validateProducerDeployment(input: unknown): ProducerDeploymentData {
  const d = input as ProducerDeploymentData;
  exactKeys(d, ['version', 'image', 'uid', 'gid', 'runtime', 'docker', 'git', 'producer', 'grader', 'exporter', 'exchange', 'mountAliases', 'retention']);
  deploymentCheck(d.version === 1 && typeof d.image === 'string' && /^sha256:[a-f0-9]{64}$/.test(d.image) && owner(d.uid) && owner(d.gid));
  exactKeys(d.runtime, ['node', 'pi', 'piAi', 'platform', 'arch', 'files', 'inventoryDigest']);
  deploymentCheck(d.runtime.node === 'v24.20.0' && d.runtime.pi === '0.87.0' && d.runtime.piAi === '0.87.0' && d.runtime.platform === 'linux' && d.runtime.arch === 'arm64');
  inventory(d.runtime.files, d.runtime.inventoryDigest, true);
  deploymentCheck(sha(d.runtime.files['/usr/bin/env']) && sha(d.runtime.files['/usr/bin/node']));
  exactKeys(d.docker, ['executable', 'sha256', 'endpoint', 'daemonIdentity', 'namespaceIdentity', 'config']);
  deploymentPath(d.docker.executable);
  deploymentCheck(sha(d.docker.sha256) && sha(d.docker.daemonIdentity) && sha(d.docker.namespaceIdentity)
    && typeof d.docker.endpoint === 'string' && d.docker.endpoint.startsWith('unix://'));
  deploymentPath(d.docker.endpoint.slice(7));
  exactKeys(d.docker.config, ['root', 'uid', 'gid', 'mode', 'files', 'inventoryDigest']);
  deploymentPath(d.docker.config.root);
  deploymentCheck(owner(d.docker.config.uid) && owner(d.docker.config.gid) && d.docker.config.mode === 0o700);
  inventory(d.docker.config.files, d.docker.config.inventoryDigest, false, ['config.json']);
  exactKeys(d.git, ['executable', 'version', 'sha256']);
  deploymentCheck(d.git.executable === '/usr/bin/git' && typeof d.git.version === 'string' && /^\d+\.\d+\.\d+$/.test(d.git.version) && sha(d.git.sha256));
  for (const [kind, roster] of Object.entries({ producer: d.producer, grader: d.grader, exporter: d.exporter })) {
    exactKeys(roster, ['root', 'files', 'inventoryDigest']); deploymentPath(roster.root);
    inventory(roster.files, roster.inventoryDigest, false, kind === 'grader' ? ['grading-bootstrap.ts', 'grading-observer.ts']
      : kind === 'exporter' ? ['grading-snapshot-bootstrap.ts', 'grading-snapshot-core.ts', 'grading-snapshot-protocol.ts'] : undefined);
  }
  // No dependency crawler or completeness claim: the selected producer roster is
  // exact data, not an approved native deployment. Private source approval is absent.
  deploymentCheck(sha(d.producer.files['evaluation/src/native-preload.ts']));
  deploymentPath(d.exchange);
  exactKeys(d.retention, ['trialParent', 'uid', 'gid', 'mode']); deploymentPath(d.retention.trialParent);
  deploymentCheck(owner(d.retention.uid, true) && owner(d.retention.gid, true) && d.retention.mode === 0o700);
  const roots = [d.producer.root, d.grader.root, d.exporter.root, d.exchange, d.retention.trialParent];
  deploymentCheck(roots.every((p, i) => roots.every((q, j) => i === j || !overlaps(p, q))));
  deploymentCheck(Array.isArray(d.mountAliases) && d.mountAliases.length <= 64 && new Set(d.mountAliases).size === d.mountAliases.length);
  for (const alias of d.mountAliases) { deploymentPath(alias); deploymentCheck(!overlaps(alias, join(d.retention.trialParent, '.finalization'))); }
  return structuredClone(d);
}
declare const deploymentBrand: unique symbol;
export type ProducerDeployment = { readonly [deploymentBrand]: true };
const deployments = new WeakMap<ProducerDeployment, ProducerDeploymentData>();
export function deploymentData(handle: ProducerDeployment): ProducerDeploymentData {
  const data = deployments.get(handle); deploymentCheck(data); return structuredClone(data);
}
export function installInertProducerDeployment(input: unknown): ProducerDeployment {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('Inert deployment is test-only');
  const data = validateProducerDeployment(input), handle = Object.freeze({}) as ProducerDeployment;
  deployments.set(handle, data); return handle;
}
export function acquireProducerDeployment(_input: unknown): ProducerDeployment {
  throw new Error('CLOSED: operational deployment acquisition, provenance and namespace schema unavailable');
}
